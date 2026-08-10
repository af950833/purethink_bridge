import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

import Aedes from 'aedes';
import express from 'express';
import mqtt from 'mqtt';
import selfsigned from 'selfsigned';
import { Client as SshClient } from 'ssh2';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const HTTP_PORT = Number(process.env.HTTP_PORT || 33301);
const DEVICE_MQTT_PORT = Number(process.env.DEVICE_MQTT_PORT || 8885);
const DEVICE_MQTT_HOST = process.env.DEVICE_MQTT_HOST || '0.0.0.0';
const DEVICE_MQTT_DISPLAY_HOST = process.env.DEVICE_MQTT_DISPLAY_HOST || DEVICE_MQTT_HOST;
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const CERT_DIR = path.join(DATA_DIR, 'certs');
const DISPLAY_TIME_ZONE = process.env.TZ || 'Asia/Seoul';
const DNAT_CHAIN = 'PURETHINK_DNAT';

const MANUFACTURER = {
  host: 'dapt.iptime.org',
  port: 8885,
  protocol: 'mqtts',
  rejectUnauthorized: false
};

const DEFAULT_CONFIG = {
  internalMqtt: {
    enabled: false,
    host: '',
    port: 1883,
    username: '',
    password: '',
    clientId: 'purethink-bridge',
    topic: '/things/#'
  },
  routerDnat: {
    host: '192.168.0.1',
    port: 22,
    username: '',
    password: '',
    deviceIp: '',
    manufacturerIp: '221.149.135.231',
    bridgeIp: DEVICE_MQTT_DISPLAY_HOST === '0.0.0.0' ? '' : DEVICE_MQTT_DISPLAY_HOST,
    mqttPort: DEVICE_MQTT_PORT
  }
};

function displayTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}년 ${Number(value.month)}월 ${Number(value.day)}일\n${value.hour}:${value.minute}:${value.second}`;
}

const state = {
  startedAt: displayTime(),
  device: {
    status: 'offline',
    clientId: null,
    lastSeen: null,
    lastTopic: null,
    rx: 0,
    tx: 0
  },
  manufacturer: {
    status: 'offline',
    host: `${MANUFACTURER.host}:${MANUFACTURER.port}`,
    lastConnected: null,
    lastError: null,
    rx: 0,
    tx: 0
  },
  internal: {
    status: 'disabled',
    lastConnected: null,
    lastError: null,
    rx: 0,
    tx: 0
  },
  bridge: {
    host: `${DEVICE_MQTT_DISPLAY_HOST}:${DEVICE_MQTT_PORT}`,
    rx: 0,
    tx: 0,
    droppedLoopMessages: 0,
    lastError: null,
    messageSeq: 0,
    messages: [],
    dnat: {
      status: 'unknown',
      lastChecked: null,
      lastAction: null,
      lastError: null,
      output: ''
    }
  }
};

let config = DEFAULT_CONFIG;
let manufacturerClient = null;
let internalClient = null;
const recentMirrors = new Map();
const manufacturerSubscriptions = new Set();

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadConfig() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(CONFIG_PATH)) {
    saveConfig(DEFAULT_CONFIG);
  }
  const loaded = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return {
    ...DEFAULT_CONFIG,
    ...loaded,
    internalMqtt: { ...DEFAULT_CONFIG.internalMqtt, ...(loaded.internalMqtt || {}) },
    routerDnat: { ...DEFAULT_CONFIG.routerDnat, ...(loaded.routerDnat || {}) }
  };
}

function saveConfig(nextConfig) {
  ensureDir(DATA_DIR);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(nextConfig, null, 2));
}

function validIPv4(value) {
  if (typeof value !== 'string') return false;
  const parts = value.trim().split('.');
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const num = Number(part);
    return num >= 0 && num <= 255 && String(num) === String(Number(part));
  });
}

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function validateDnatConfig(dnat) {
  const required = [
    ['router host', dnat.host],
    ['device IP', dnat.deviceIp],
    ['manufacturer IP', dnat.manufacturerIp],
    ['bridge IP', dnat.bridgeIp]
  ];
  for (const [label, value] of required) {
    if (!validIPv4(value)) {
      throw new Error(`Invalid ${label}`);
    }
  }
  if (!validPort(dnat.port)) throw new Error('Invalid router SSH port');
  if (!validPort(dnat.mqttPort)) throw new Error('Invalid MQTT port');
  if (!dnat.username) throw new Error('Router username is empty');
  if (!dnat.password) throw new Error('Router password is empty');
}

function dnatRuleArgs(dnat) {
  const mqttPort = Number(dnat.mqttPort);
  return {
    jump: `-j ${DNAT_CHAIN}`,
    prerouting: `-s ${dnat.deviceIp}/32 -d ${dnat.manufacturerIp}/32 -p tcp -m tcp --dport ${mqttPort} -j DNAT --to-destination ${dnat.bridgeIp}:${mqttPort}`,
    preroutingAnyDestination: `-s ${dnat.deviceIp}/32 -p tcp -m tcp --dport ${mqttPort} -j DNAT --to-destination ${dnat.bridgeIp}:${mqttPort}`
  };
}

function routerScript(action, dnat) {
  const rules = dnatRuleArgs(dnat);
  if (action === 'status') {
    return [
      'set -e',
      `if iptables -t nat -S ${DNAT_CHAIN} >/dev/null 2>&1; then echo CHAIN=present; else echo CHAIN=missing; fi`,
      `if iptables -t nat -S PREROUTING | grep -F -- '${rules.jump}' >/dev/null; then echo JUMP=present; else echo JUMP=missing; fi`,
      `if iptables -t nat -S ${DNAT_CHAIN} 2>/dev/null | grep -F -- '${rules.preroutingAnyDestination}' >/dev/null || iptables -t nat -S PREROUTING | grep -F -- '${rules.preroutingAnyDestination}' >/dev/null; then echo DNAT=present; else echo DNAT=missing; fi`
    ].join('\n');
  }
  if (action === 'apply') {
    return [
      'set -e',
      `iptables -t nat -N ${DNAT_CHAIN} 2>/dev/null || true`,
      `iptables -t nat -S PREROUTING | grep -F -- '${rules.jump}' >/dev/null || iptables -t nat -I PREROUTING 1 ${rules.jump}`,
      `iptables -t nat -S ${DNAT_CHAIN} | grep -F -- '${rules.preroutingAnyDestination}' >/dev/null || iptables -t nat -A ${DNAT_CHAIN} ${rules.preroutingAnyDestination}`,
      `conntrack -D -s ${dnat.deviceIp} -p tcp --dport ${Number(dnat.mqttPort)} 2>/dev/null || true`,
      'echo DNAT=applied'
    ].join('\n');
  }
  if (action === 'remove') {
    return [
      'set -e',
      `while iptables -t nat -D PREROUTING ${rules.prerouting} 2>/dev/null; do :; done`,
      `while iptables -t nat -D PREROUTING ${rules.preroutingAnyDestination} 2>/dev/null; do :; done`,
      `while iptables -t nat -D ${DNAT_CHAIN} ${rules.preroutingAnyDestination} 2>/dev/null; do :; done`,
      `while iptables -t nat -D PREROUTING ${rules.jump} 2>/dev/null; do :; done`,
      `iptables -t nat -F ${DNAT_CHAIN} 2>/dev/null || true`,
      `iptables -t nat -X ${DNAT_CHAIN} 2>/dev/null || true`,
      `conntrack -D -s ${dnat.deviceIp} -p tcp --dport ${Number(dnat.mqttPort)} 2>/dev/null || true`,
      'echo DNAT=removed'
    ].join('\n');
  }
  throw new Error('Unknown DNAT action');
}

function runRouterCommand(action) {
  const dnat = config.routerDnat;
  validateDnatConfig(dnat);
  const script = routerScript(action, dnat);
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    let output = '';
    let settled = false;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      client.end();
      if (err) reject(err);
      else resolve(result);
    };

    client.on('ready', () => {
      client.exec(script, (err, stream) => {
        if (err) {
          finish(err);
          return;
        }
        stream.on('close', (code) => {
          if (code === 0) {
            finish(null, output.trim());
            return;
          }
          finish(new Error(output.trim() || `Router command failed with exit code ${code}`));
        });
        stream.on('data', (data) => {
          output += data.toString();
        });
        stream.stderr.on('data', (data) => {
          output += data.toString();
        });
      });
    });
    client.on('error', (err) => finish(err));
    client.connect({
      host: dnat.host,
      port: Number(dnat.port || 22),
      username: dnat.username,
      password: dnat.password,
      readyTimeout: 10000
    });
  });
}

function updateDnatState(action, output, err = null) {
  state.bridge.dnat.lastChecked = displayTime();
  state.bridge.dnat.lastAction = action;
  state.bridge.dnat.lastError = err ? err.message : null;
  state.bridge.dnat.output = output || '';
  if (err) {
    state.bridge.dnat.status = 'error';
  } else if (output.includes('CHAIN=present') && output.includes('JUMP=present') && output.includes('DNAT=present')) {
    state.bridge.dnat.status = 'active';
  } else if (output.includes('DNAT=applied')) {
    state.bridge.dnat.status = 'active';
  } else if (output.includes('DNAT=removed')) {
    state.bridge.dnat.status = 'inactive';
  } else if (output.includes('missing')) {
    state.bridge.dnat.status = 'inactive';
  } else {
    state.bridge.dnat.status = 'unknown';
  }
}

function ensureCertificate() {
  ensureDir(CERT_DIR);
  const keyPath = path.join(CERT_DIR, 'server.key');
  const certPath = path.join(CERT_DIR, 'server.crt');
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    const attrs = [{ name: 'commonName', value: 'dapt.iptime.org' }];
    const pems = selfsigned.generate(attrs, {
      days: 3650,
      keySize: 2048,
      algorithm: 'sha256'
    });
    fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
    fs.writeFileSync(certPath, pems.cert);
  }
  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  };
}

function topicMatchesThings(topic) {
  return topic.startsWith('/things/');
}

function topicForClient(clientId) {
  return `/things/${clientId}/#`;
}

function subscribeManufacturerForClient(clientId) {
  if (!clientId || !manufacturerClient?.connected) return;
  const topic = topicForClient(clientId);
  if (manufacturerSubscriptions.has(topic)) return;
  manufacturerClient.subscribe(topic, { qos: 0 }, (err) => {
    if (err) {
      state.manufacturer.lastError = err.message;
      return;
    }
    manufacturerSubscriptions.add(topic);
  });
}

function payloadKey(topic, payload) {
  return `${topic}\n${Buffer.from(payload).toString('base64')}`;
}

function payloadText(payload) {
  const text = Buffer.from(payload).toString('utf8');
  return text.length > 1000 ? `${text.slice(0, 1000)}...` : text;
}

function recordMessage(direction, topic, payload) {
  state.bridge.messageSeq += 1;
  state.bridge.messages.push({
    id: state.bridge.messageSeq,
    at: displayTime(),
    direction,
    topic,
    bytes: Buffer.byteLength(payload),
    payload: payloadText(payload)
  });
  if (state.bridge.messages.length > 200) {
    state.bridge.messages.splice(0, state.bridge.messages.length - 200);
  }
}

function rememberMirror(target, topic, payload) {
  const key = `${target}:${payloadKey(topic, payload)}`;
  recentMirrors.set(key, Date.now());
  setTimeout(() => recentMirrors.delete(key), 5000).unref();
}

function wasMirroredTo(target, topic, payload) {
  const key = `${target}:${payloadKey(topic, payload)}`;
  if (!recentMirrors.has(key)) return false;
  recentMirrors.delete(key);
  state.bridge.droppedLoopMessages += 1;
  return true;
}

function publishToDevice(topic, payload) {
  recordMessage('to-device', topic, payload);
  aedes.publish({ topic, payload, qos: 0, retain: false }, (err) => {
    if (err) {
      state.bridge.lastError = `device publish failed: ${err.message}`;
      return;
    }
    state.device.tx += 1;
    state.bridge.tx += 1;
  });
}

function publishToManufacturer(topic, payload) {
  if (!manufacturerClient?.connected) return;
  recordMessage('to-manufacturer', topic, payload);
  rememberMirror('manufacturer', topic, payload);
  manufacturerClient.publish(topic, payload, { qos: 0, retain: false }, (err) => {
    if (err) {
      state.manufacturer.lastError = err.message;
      return;
    }
    state.manufacturer.tx += 1;
  });
}

function publishToInternal(topic, payload) {
  if (!internalClient?.connected) return;
  recordMessage('to-internal', topic, payload);
  rememberMirror('internal', topic, payload);
  internalClient.publish(topic, payload, { qos: 0, retain: false }, (err) => {
    if (err) {
      state.internal.lastError = err.message;
      return;
    }
    state.internal.tx += 1;
  });
}

function connectManufacturer() {
  if (manufacturerClient) {
    manufacturerClient.end(true);
  }

  state.manufacturer.status = 'reconnecting';
  manufacturerClient = mqtt.connect({
    protocol: MANUFACTURER.protocol,
    host: MANUFACTURER.host,
    port: MANUFACTURER.port,
    rejectUnauthorized: MANUFACTURER.rejectUnauthorized,
    protocolVersion: 4,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
    clean: true
  });

  manufacturerClient.on('connect', () => {
    state.manufacturer.status = 'connected';
    state.manufacturer.lastConnected = displayTime();
    state.manufacturer.lastError = null;
    manufacturerSubscriptions.clear();
    subscribeManufacturerForClient(state.device.clientId);
  });

  manufacturerClient.on('message', (topic, payload) => {
    if (!topicMatchesThings(topic)) return;
    if (wasMirroredTo('manufacturer', topic, payload)) return;
    state.manufacturer.rx += 1;
    recordMessage('from-manufacturer', topic, payload);
    publishToDevice(topic, payload);
  });

  manufacturerClient.on('reconnect', () => {
    state.manufacturer.status = 'reconnecting';
  });

  manufacturerClient.on('close', () => {
    if (state.manufacturer.status !== 'reconnecting') {
      state.manufacturer.status = 'offline';
    }
  });

  manufacturerClient.on('error', (err) => {
    state.manufacturer.status = 'reconnecting';
    state.manufacturer.lastError = err.message;
  });
}

function connectInternal() {
  if (internalClient) {
    internalClient.end(true);
    internalClient = null;
  }

  if (!config.internalMqtt.enabled) {
    state.internal.status = 'disabled';
    return;
  }

  if (!config.internalMqtt.host) {
    state.internal.status = 'misconfigured';
    state.internal.lastError = 'Internal MQTT host is empty';
    return;
  }

  state.internal.status = 'reconnecting';
  const options = {
    protocol: 'mqtt',
    host: config.internalMqtt.host,
    port: Number(config.internalMqtt.port || 1883),
    clientId: config.internalMqtt.clientId || 'purethink-bridge',
    reconnectPeriod: 5000,
    connectTimeout: 10000,
    clean: true
  };
  if (config.internalMqtt.username) options.username = config.internalMqtt.username;
  if (config.internalMqtt.password) options.password = config.internalMqtt.password;

  internalClient = mqtt.connect(options);

  internalClient.on('connect', () => {
    state.internal.status = 'connected';
    state.internal.lastConnected = displayTime();
    state.internal.lastError = null;
    internalClient.subscribe(config.internalMqtt.topic || '/things/#', { qos: 0 });
  });

  internalClient.on('message', (topic, payload) => {
    if (!topicMatchesThings(topic)) return;
    if (wasMirroredTo('internal', topic, payload)) return;
    state.internal.rx += 1;
    recordMessage('from-internal', topic, payload);
    publishToDevice(topic, payload);
  });

  internalClient.on('reconnect', () => {
    state.internal.status = 'reconnecting';
  });

  internalClient.on('close', () => {
    if (state.internal.status !== 'reconnecting') {
      state.internal.status = 'offline';
    }
  });

  internalClient.on('error', (err) => {
    state.internal.status = 'reconnecting';
    state.internal.lastError = err.message;
  });
}

config = loadConfig();
const aedes = new Aedes();

aedes.on('client', (client) => {
  state.device.status = 'connected';
  state.device.clientId = client?.id || null;
  state.device.lastSeen = displayTime();
  subscribeManufacturerForClient(state.device.clientId);
});

aedes.on('clientDisconnect', (client) => {
  if (state.device.clientId === client?.id) {
    state.device.status = 'offline';
    state.device.lastSeen = displayTime();
  }
});

aedes.on('publish', (packet, client) => {
  if (!client) return;
  if (!topicMatchesThings(packet.topic)) return;
  state.device.status = 'connected';
  state.device.clientId = client.id;
  state.device.lastSeen = displayTime();
  state.device.lastTopic = packet.topic;
  state.device.rx += 1;
  state.bridge.rx += 1;
  recordMessage('from-device', packet.topic, packet.payload);
  publishToManufacturer(packet.topic, packet.payload);
  publishToInternal(packet.topic, packet.payload);
});

const tlsOptions = ensureCertificate();
const mqttServer = tls.createServer(tlsOptions, aedes.handle);
mqttServer.listen(DEVICE_MQTT_PORT, DEVICE_MQTT_HOST, () => {
  console.log(`Device MQTT/TLS listening on ${DEVICE_MQTT_HOST}:${DEVICE_MQTT_PORT}`);
});

connectManufacturer();
connectInternal();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/status', (_req, res) => {
  res.json({
    state,
    config: {
      internalMqtt: {
        ...config.internalMqtt,
        password: config.internalMqtt.password ? '********' : ''
      },
      routerDnat: {
        ...config.routerDnat,
        password: config.routerDnat.password ? '********' : ''
      }
    }
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    ...config,
    internalMqtt: {
      ...config.internalMqtt,
      password: ''
    },
    routerDnat: {
      ...config.routerDnat,
      password: ''
    }
  });
});

app.post('/api/config', (req, res) => {
  const next = {
    ...config,
    internalMqtt: {
      ...config.internalMqtt,
      ...(req.body.internalMqtt || {})
    }
  };
  if (!req.body.internalMqtt?.password && config.internalMqtt.password) {
    next.internalMqtt.password = config.internalMqtt.password;
  }
  if (req.body.routerDnat) {
    next.routerDnat = {
      ...config.routerDnat,
      ...req.body.routerDnat
    };
    if (!req.body.routerDnat.password && config.routerDnat.password) {
      next.routerDnat.password = config.routerDnat.password;
    }
  }
  config = next;
  saveConfig(config);
  if (req.body.internalMqtt) connectInternal();
  res.json({ ok: true });
});

app.post('/api/reconnect/manufacturer', (_req, res) => {
  connectManufacturer();
  res.json({ ok: true });
});

app.post('/api/reconnect/internal', (_req, res) => {
  connectInternal();
  res.json({ ok: true });
});

async function handleDnatAction(req, res) {
  const action = req.params.action;
  try {
    const output = await runRouterCommand(action);
    updateDnatState(action, output);
    res.json({ ok: true, output, state: state.bridge.dnat });
  } catch (err) {
    updateDnatState(action, '', err);
    res.status(400).json({ ok: false, error: err.message, state: state.bridge.dnat });
  }
}

app.post('/api/router-dnat/:action(status|apply|remove)', handleDnatAction);

app.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`Dashboard listening on 0.0.0.0:${HTTP_PORT}`);
});
