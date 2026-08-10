const $ = (id) => document.getElementById(id);
let hiddenUntilMessageId = 0;

function setStatus(id, value) {
  const el = $(id);
  el.textContent = value || '-';
  el.className = value || '';
}

function setText(id, value) {
  $(id).textContent = value || '-';
}

function setTime(id, value) {
  const el = $(id);
  el.textContent = value || '-';
  el.classList.add('time');
}

function counts(obj) {
  return `${obj.rx || 0} / ${obj.tx || 0}`;
}

function escapeText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function renderMessages(messages) {
  const stream = $('payloadStream');
  const visible = messages
    .filter((message) => message.id > hiddenUntilMessageId)
    .slice()
    .reverse();
  stream.innerHTML = visible.map((message) => `
    <div class="payload-row">
      <div class="payload-meta">
        <span class="time">${escapeText(message.at)}</span>
        <b class="${escapeText(message.direction)}">${escapeText(message.direction)}</b>
        <span>${escapeText(message.topic)}</span>
        <span>${message.bytes || 0} bytes</span>
      </div>
      <pre>${escapeText(message.payload)}</pre>
    </div>
  `).join('');
  stream.scrollTop = 0;
}

function renderDnat(dnat) {
  setStatus('dnatStatus', dnat?.status || 'unknown');
  setTime('dnatChecked', dnat?.lastChecked);
  setText('dnatAction', dnat?.lastAction);
  setText('dnatError', dnat?.lastError);
}

async function loadStatus() {
  const res = await fetch('/api/status');
  const data = await res.json();
  const { state, config } = data;

  setText('summary', `Local control: ${state.device.status === 'connected' && state.internal.status === 'connected' ? 'Available' : 'Check connections'}`);

  setStatus('deviceStatus', state.device.status);
  setText('deviceClient', state.device.clientId);
  setTime('deviceSeen', state.device.lastSeen);
  setText('deviceTopic', state.device.lastTopic);
  setText('deviceCounts', counts(state.device));

  setStatus('manufacturerStatus', state.manufacturer.status);
  setText('manufacturerHost', state.manufacturer.host || '-');
  setTime('manufacturerConnected', state.manufacturer.lastConnected);
  setText('manufacturerError', state.manufacturer.lastError);
  setText('manufacturerCounts', counts(state.manufacturer));

  setStatus('internalStatus', state.internal.status);
  setText('internalHost', config.internalMqtt.host ? `${config.internalMqtt.host}:${config.internalMqtt.port}` : '-');
  setTime('internalConnected', state.internal.lastConnected);
  setText('internalError', state.internal.lastError);
  setText('internalCounts', counts(state.internal));

  setStatus('localControl', state.device.status === 'connected' && state.internal.status === 'connected' ? 'available' : 'limited');
  setText('bridgeHost', state.bridge.host);
  setTime('startedAt', state.startedAt);
  setText('bridgeCounts', counts(state.bridge));
  setText('droppedLoops', String(state.bridge.droppedLoopMessages || 0));
  setText('bridgeError', state.bridge.lastError);
  renderDnat(state.bridge.dnat);
  renderMessages(state.bridge.messages || []);
}

async function loadConfig() {
  const res = await fetch('/api/config');
  const cfg = await res.json();
  $('enabled').checked = Boolean(cfg.internalMqtt.enabled);
  $('host').value = cfg.internalMqtt.host || '';
  $('port').value = cfg.internalMqtt.port || 1883;
  $('username').value = cfg.internalMqtt.username || '';
  $('password').value = '';
  $('clientId').value = cfg.internalMqtt.clientId || 'purethink-bridge';
  $('topic').value = cfg.internalMqtt.topic || '/things/#';

  $('routerHost').value = cfg.routerDnat.host || '';
  $('routerPort').value = cfg.routerDnat.port || 22;
  $('routerUsername').value = cfg.routerDnat.username || '';
  $('routerPassword').value = '';
  $('dnatDeviceIp').value = cfg.routerDnat.deviceIp || '';
  $('dnatManufacturerIp').value = cfg.routerDnat.manufacturerIp || '221.149.135.231';
  $('dnatBridgeIp').value = cfg.routerDnat.bridgeIp || window.location.hostname || '192.168.0.4';
  $('dnatMqttPort').value = cfg.routerDnat.mqttPort || 8885;
}

async function saveConfig(event) {
  event.preventDefault();
  const body = {
    internalMqtt: {
      enabled: $('enabled').checked,
      host: $('host').value.trim(),
      port: Number($('port').value || 1883),
      username: $('username').value,
      password: $('password').value,
      clientId: $('clientId').value.trim() || 'purethink-bridge',
      topic: $('topic').value.trim() || '/things/#'
    },
  };
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  await loadStatus();
}

async function saveDnatConfig(event) {
  event.preventDefault();
  const body = {
    routerDnat: {
      host: $('routerHost').value.trim(),
      port: Number($('routerPort').value || 22),
      username: $('routerUsername').value.trim(),
      password: $('routerPassword').value,
      deviceIp: $('dnatDeviceIp').value.trim(),
      manufacturerIp: $('dnatManufacturerIp').value.trim(),
      bridgeIp: $('dnatBridgeIp').value.trim(),
      mqttPort: Number($('dnatMqttPort').value || 8885)
    }
  };
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  $('routerPassword').value = '';
  await loadStatus();
}

async function post(path) {
  await fetch(path, { method: 'POST' });
  await loadStatus();
}

async function dnatAction(action) {
  const buttons = [$('checkDnat'), $('applyDnat'), $('removeDnat')];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const res = await fetch(`/api/router-dnat/${action}`, { method: 'POST' });
    const data = await res.json();
    renderDnat(data.state);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
    await loadStatus();
  }
}

async function refreshDashboard() {
  await loadStatus();
  await dnatAction('status');
}

$('refresh').addEventListener('click', refreshDashboard);
$('configForm').addEventListener('submit', saveConfig);
$('dnatForm').addEventListener('submit', saveDnatConfig);
$('reconnectManufacturer').addEventListener('click', () => post('/api/reconnect/manufacturer'));
$('reconnectInternal').addEventListener('click', () => post('/api/reconnect/internal'));
$('checkDnat').addEventListener('click', () => dnatAction('status'));
$('applyDnat').addEventListener('click', () => dnatAction('apply'));
$('removeDnat').addEventListener('click', () => dnatAction('remove'));
$('clearPayloads').addEventListener('click', async () => {
  const res = await fetch('/api/status');
  const data = await res.json();
  const messages = data.state.bridge.messages || [];
  hiddenUntilMessageId = messages.at(-1)?.id || 0;
  renderMessages([]);
});

loadConfig().then(refreshDashboard);
setInterval(loadStatus, 3000);
