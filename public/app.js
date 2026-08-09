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

async function post(path) {
  await fetch(path, { method: 'POST' });
  await loadStatus();
}

$('refresh').addEventListener('click', loadStatus);
$('configForm').addEventListener('submit', saveConfig);
$('reconnectManufacturer').addEventListener('click', () => post('/api/reconnect/manufacturer'));
$('reconnectInternal').addEventListener('click', () => post('/api/reconnect/internal'));
$('clearPayloads').addEventListener('click', async () => {
  const res = await fetch('/api/status');
  const data = await res.json();
  const messages = data.state.bridge.messages || [];
  hiddenUntilMessageId = messages.at(-1)?.id || 0;
  renderMessages([]);
});

loadConfig().then(loadStatus);
setInterval(loadStatus, 3000);
