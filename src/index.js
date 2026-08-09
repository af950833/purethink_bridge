import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

import Aedes from 'aedes';
import express from 'express';
import mqtt from 'mqtt';
import selfsigned from 'selfsigned';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const HTTP_PORT = Number(process.env.HTTP_PORT || 33301);
const DEVICE_MQTT_PORT = Number(process.env.DEVICE_MQTT_PORT || 8885);
const DEVICE_MQTT_HOST = process.env.DEVICE_MQTT_HOST || '0.0.0.0';
const DEVICE_MQTT_DISPLAY_HOST = process.env.DEVICE_MQTT_DISPLAY_HOST || DEVICE_MQTT_HOST;
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const CERT_DIR = path.join(DATA_DIR, 'certs');
const DISPLAY_TIME_ZONE = process.env.TZ || 'Asia/Seoul';

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
    messages: []
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
    internalMqtt: { ...DEFAULT_CONFIG.internalMqtt, ...(loaded.internalMqtt || {}) }
  };
}

function saveConfig(nextConfig) {
  ensureDir(DATA_DIR);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(nextConfig, null, 2));
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
  config = next;
  saveConfig(config);
  connectInternal();
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

app.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`Dashboard listening on 0.0.0.0:${HTTP_PORT}`);
});
