// The toolbar popup: connection status, Disconnect/Connect, the AntiGem tab group, the blocklist.
const $ = (id) => document.getElementById(id);
const ask = (op, extra = {}) => chrome.runtime.sendMessage({ antigem: 'popup', op, ...extra });

function render(s) {
  if (!s || s.error) {
    $('status').textContent = 'Error';
    $('detail').textContent = s?.error ?? 'No answer from the extension';
    return;
  }
  const c = s.connection;
  const map = {
    connected: ['ok', 'Connected to VS Code', 'Your AntiGem agents can use the AntiGem tabs.'],
    host: ['warn', 'Waiting for VS Code', c.error || 'Open VS Code with the AntiGem extension.'],
    connecting: ['warn', 'Connecting…', ''],
    error: ['err', 'Not connected', c.error || ''],
    off: ['', 'Disconnected', 'You turned the connection off. Agents cannot use this browser.'],
  };
  const [tone, title, detail] = map[c.status] ?? ['err', c.status, c.error];
  $('dot').className = `dot ${tone}`;
  $('status').textContent = title;
  $('detail').textContent = detail;
  $('toggle').textContent = c.paused ? 'Connect' : 'Disconnect';
  $('toggle').className = c.paused ? 'primary' : '';
  const ul = $('tabs');
  ul.textContent = '';
  for (const t of s.tabs) {
    const li = document.createElement('li');
    li.textContent = `${t.title || t.url || 'New tab'}`;
    li.title = t.url;
    li.onclick = () => ask('focusTab', { tabId: t.id });
    ul.appendChild(li);
  }
  if (!s.tabs.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No AntiGem tabs open.';
    ul.appendChild(li);
  }
  if (document.activeElement !== $('blocklist')) $('blocklist').value = s.blocklist.join('\n');
  $('extId').textContent = s.extensionId;
  $('version').textContent = s.version;
}

async function refresh() {
  render(await ask('state'));
}

$('toggle').onclick = async () => render(await ask($('toggle').textContent === 'Connect' ? 'connect' : 'disconnect'));
$('release').onclick = async () => render(await ask('release'));
$('save').onclick = async () => {
  render(await ask('setBlocklist', { list: $('blocklist').value.split('\n') }));
  $('save').textContent = 'Saved';
  setTimeout(() => ($('save').textContent = 'Save'), 1200);
};
$('reset').onclick = async () => {
  $('blocklist').blur();
  render(await ask('resetBlocklist'));
};
void refresh();
setInterval(refresh, 1500);
