// The connection to VS Code: Chrome native messaging to com.antigem.browser_bridge (the AntiGem bridge binary in
// --native-host mode), which relays to the VS Code extension's per-user socket. VS Code sends {id, command, payload}
// and gets {id, success, result | error}; we also send hello, pong and events. Nothing else can reach this channel:
// only extensions listed in the host manifest's allowed_origins may start the host, and this extension has no
// externally_connectable entry, so web pages and other extensions cannot message it.
import { VERSION, b64ToBytes } from './util.js';

export const HOST = 'com.antigem.browser_bridge';

const state = {
  /** 'off' (disconnected by the user) | 'connecting' | 'host' (host runs, VS Code not reachable) | 'connected' | 'error' */
  status: 'connecting',
  error: '',
  hostVersion: null,
  socket: '',
  connectedAt: 0,
  lastMessageAt: 0,
};

let port = null;
let handler = null;
let backoff = 1000;
let retryTimer = null;
let paused = false;
const listeners = new Set();
const chunks = new Map();

export function connectionState() {
  return { ...state, paused };
}

export function onStateChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed() {
  for (const fn of listeners) {
    try {
      fn(connectionState());
    } catch {
      /* listener errors never break the channel */
    }
  }
}

export function post(msg) {
  if (!port) return false;
  try {
    port.postMessage(msg);
    return true;
  } catch {
    return false;
  }
}

/** An event for VS Code (tab unlocked by the user, dialog opened…). */
export function emit(event, data) {
  if (state.status === 'connected') post({ type: 'event', event, data });
}

function hello() {
  post({
    type: 'hello',
    protocol: 1,
    version: VERSION,
    extensionId: chrome.runtime.id,
    browser: navigator.userAgent,
    brands: (navigator.userAgentData?.brands ?? []).map((b) => `${b.brand} ${b.version}`),
  });
}

function schedule() {
  if (paused) return;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 30_000);
}

export function connect() {
  if (port || paused) return;
  clearTimeout(retryTimer);
  state.status = 'connecting';
  state.error = '';
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    port = null;
    state.status = 'error';
    state.error = String(e?.message ?? e);
    changed();
    schedule();
    return;
  }
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message ?? '';
    port = null;
    chunks.clear();
    state.status = paused ? 'off' : 'error';
    state.error = paused ? '' : hostError(err);
    state.connectedAt = 0;
    changed();
    schedule();
  });
  changed();
}

function hostError(err) {
  if (/not found/i.test(err)) return 'The AntiGem native host is not registered for this browser. In VS Code: AntiGem → Settings → Browser → Register with Chrome.';
  if (/forbidden/i.test(err)) return 'The native host does not allow this extension id (re-register from VS Code: Settings → Browser).';
  if (/exited/i.test(err)) return 'The AntiGem native host stopped (is the AntiGem VS Code extension installed? Re-register from Settings → Browser).';
  return err || 'The native host disconnected';
}

/** Popup "Disconnect": stays off until "Connect". */
export async function setPaused(p) {
  paused = p;
  await chrome.storage.local.set({ paused: p });
  if (p) {
    clearTimeout(retryTimer);
    const old = port;
    port = null;
    try {
      old?.disconnect();
    } catch {
      /* already gone */
    }
    state.status = 'off';
    state.error = '';
    state.connectedAt = 0;
    changed();
  } else {
    backoff = 1000;
    connect();
  }
}

async function onMessage(msg) {
  state.lastMessageAt = Date.now();
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'chunk') {
    // a message larger than Chrome's 1 MB host limit, split by the host
    let c = chunks.get(msg.id);
    if (!c) chunks.set(msg.id, (c = { n: msg.n, parts: new Array(msg.n) }));
    c.parts[msg.i] = b64ToBytes(msg.data);
    if (c.parts.filter(Boolean).length < c.n) return;
    chunks.delete(msg.id);
    const total = c.parts.reduce((a, p) => a + p.length, 0);
    const all = new Uint8Array(total);
    let o = 0;
    for (const p of c.parts) {
      all.set(p, o);
      o += p.length;
    }
    try {
      return onMessage(JSON.parse(new TextDecoder().decode(all)));
    } catch {
      return;
    }
  }
  if (msg.type === 'host_status') {
    backoff = 1000;
    state.hostVersion = msg.version ?? null;
    const was = state.status;
    if (msg.connected) {
      state.status = 'connected';
      state.error = '';
      state.socket = msg.socket ?? '';
      state.connectedAt = Date.now();
      hello();
    } else {
      state.status = 'host';
      state.error = msg.error ?? 'VS Code is not connected';
      state.connectedAt = 0;
    }
    if (was !== state.status || !msg.connected) changed();
    return;
  }
  if (msg.type === 'ping') {
    post({ type: 'pong', t: msg.t ?? null });
    return;
  }
  if (msg.id === undefined || typeof msg.command !== 'string') return;
  try {
    const result = await handler(msg.command, msg.payload ?? {});
    post({ id: msg.id, success: true, result: result ?? null });
  } catch (e) {
    post({ id: msg.id, success: false, error: String(e?.message ?? e), code: e?.code ?? 'error', data: e?.data ?? null });
  }
}

export async function start(commandHandler) {
  handler = commandHandler;
  paused = (await chrome.storage.local.get('paused')).paused === true;
  if (paused) {
    state.status = 'off';
    changed();
    return;
  }
  connect();
}

/** Alarm tick: retries when the service worker was asleep. */
export function tick() {
  if (!port && !paused) connect();
}
