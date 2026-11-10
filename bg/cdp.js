// chrome.debugger (DevTools protocol) per tab: trusted input, screenshots, script runs, console / network recording,
// page dialogs, file inputs and view mode. Attached the first time the agent uses a tab (Chrome shows its "started
// debugging this browser" bar meanwhile) and detached when the tab leaves the AntiGem group or on Disconnect.
import { CmdError, sleep } from './util.js';
import { blockedReason, revoke } from './policy.js';
import { emit } from './native.js';

const MAX_CONSOLE = 1000;
const MAX_NETWORK = 1000;

/** tabId -> session */
const sessions = new Map();

function newSession(tabId) {
  return {
    tabId,
    ready: null,
    console: [],
    consoleTotal: 0,
    net: new Map(),
    netOrder: [],
    dialog: null,
    viewMode: 'desktop',
    chooser: null,
    url: '',
    mainFrame: null,
    docError: null,
  };
}

export function session(tabId) {
  return sessions.get(tabId) ?? null;
}

export function attachedTabs() {
  return [...sessions.keys()];
}

export async function attach(tabId) {
  let s = sessions.get(tabId);
  if (s) {
    await s.ready;
    return s;
  }
  s = newSession(tabId);
  sessions.set(tabId, s);
  s.ready = (async () => {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (e) {
      const m = String(e?.message ?? e);
      if (!/already attached/i.test(m)) throw new CmdError(`This page cannot be controlled: ${m}`, 'cannot_attach');
      // our own session from before a service worker restart: take it over; another extension's cannot be shared
      try {
        await chrome.debugger.detach({ tabId });
        await chrome.debugger.attach({ tabId }, '1.3');
      } catch {
        throw new CmdError('Another debugger is attached to this tab (another extension or automation), so the agent cannot control it.', 'cannot_attach');
      }
    }
    for (const [m, p] of [
      ['Page.enable', {}],
      ['Runtime.enable', {}],
      ['Log.enable', {}],
      ['Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }],
    ]) {
      await chrome.debugger.sendCommand({ tabId }, m, p).catch(() => {});
    }
    s.url = (await chrome.tabs.get(tabId).catch(() => null))?.url ?? '';
    s.mainFrame = (await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree', {}).catch(() => null))?.frameTree?.frame?.id ?? null;
  })();
  try {
    await s.ready;
  } catch (e) {
    sessions.delete(tabId);
    throw e;
  }
  return s;
}

export async function detach(tabId) {
  const s = sessions.get(tabId);
  sessions.delete(tabId);
  if (s) await chrome.debugger.detach({ tabId }).catch(() => {});
}

export async function detachAll() {
  for (const id of [...sessions.keys()]) await detach(id);
}

/** The pending JavaScript dialog of a tab (alert / confirm / prompt / beforeunload), if any. */
export function dialogOf(tabId) {
  return sessions.get(tabId)?.dialog ?? null;
}

export function dialogs() {
  const out = [];
  for (const s of sessions.values()) if (s.dialog) out.push({ tabId: s.tabId, ...s.dialog });
  return out;
}

function dialogError(tabId) {
  const d = dialogOf(tabId);
  return new CmdError('A page dialog opened', 'dialog', { tabId: String(tabId), ...d });
}

/**
 * Waits for `promise` (something that needs the page to answer) but gives up as soon as the page opens a dialog
 * (code 'dialog') or after timeoutMs (code 'timeout').
 */
export function raceDialog(tabId, promise, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearInterval(iv);
      clearTimeout(to);
      fn(v);
    };
    const iv = setInterval(() => {
      if (dialogOf(tabId)) finish(reject, dialogError(tabId));
    }, 60);
    const to = setTimeout(
      () => finish(reject, new CmdError(`The page did not answer ${what} within ${Math.round(timeoutMs / 1000)} s: it may be busy or frozen. Take a screenshot to see it.`, 'timeout')),
      timeoutMs,
    );
    Promise.resolve(promise).then(
      (v) => finish(resolve, v),
      (e) => finish(reject, e),
    );
  });
}

/** Sends one DevTools command (attaching when needed), racing page dialogs. */
export async function call(tabId, method, params = {}, timeoutMs = 10_000) {
  await attach(tabId);
  if (dialogOf(tabId) && !method.startsWith('Page.handleJavaScriptDialog')) throw dialogError(tabId);
  return raceDialog(tabId, chrome.debugger.sendCommand({ tabId }, method, params), timeoutMs, method);
}

// ------------------------------------------------------------------------------------------------ events

function level(t) {
  switch (t) {
    case 'error':
    case 'assert':
      return 'ERROR';
    case 'warning':
    case 'warn':
      return 'WARN';
    case 'info':
      return 'INFO';
    case 'debug':
    case 'verbose':
      return 'DEBUG';
    default:
      return 'LOG';
  }
}

function remoteText(o) {
  if (!o) return '';
  if (o.type === 'string') return String(o.value);
  if ('value' in o) return typeof o.value === 'object' ? JSON.stringify(o.value) : String(o.value);
  if (o.unserializableValue) return o.unserializableValue;
  if (o.preview?.properties && (o.type === 'object')) {
    const props = o.preview.properties.map((p) => `${p.name}: ${p.value ?? p.type}`).join(', ');
    return o.subtype === 'array' ? `[${o.preview.properties.map((p) => p.value ?? p.type).join(', ')}${o.preview.overflow ? ', …' : ''}]` : `{${props}${o.preview.overflow ? ', …' : ''}}`;
  }
  return o.description ?? o.type ?? '';
}

function pushConsole(s, entry) {
  if (blockedReason(s.url)) return;
  s.console.push(entry);
  s.consoleTotal++;
  if (s.console.length > MAX_CONSOLE) s.console.splice(0, s.console.length - MAX_CONSOLE);
}

function netEntry(s, id) {
  let e = s.net.get(id);
  if (!e) {
    e = { id, method: 'GET', url: '', type: 'Other', status: 0, mime: '', bytes: -1, durationMs: -1, fromCache: false, error: null, start: 0, frameId: null };
    s.net.set(id, e);
    s.netOrder.push(id);
    if (s.netOrder.length > MAX_NETWORK) for (const old of s.netOrder.splice(0, s.netOrder.length - MAX_NETWORK)) s.net.delete(old);
  }
  return e;
}

chrome.debugger.onEvent.addListener((source, method, p) => {
  const tabId = source.tabId;
  const s = tabId === undefined ? null : sessions.get(tabId);
  if (!s) return;
  switch (method) {
    case 'Page.javascriptDialogOpening':
      s.dialog = { type: p.type, message: p.message ?? '', defaultPrompt: p.defaultPrompt ?? '', url: p.url ?? '' };
      emit('dialog', { tabId: String(tabId), ...s.dialog });
      break;
    case 'Page.javascriptDialogClosed':
      s.dialog = null;
      break;
    case 'Page.frameNavigated':
      if (!p.frame?.parentId) {
        s.url = p.frame?.url ?? '';
        if (blockedReason(s.url)) {
          // nothing of a blocked site is kept for the agent
          s.console = [];
          for (const id of s.netOrder) s.net.delete(id);
          s.netOrder = [];
        }
      }
      break;
    case 'Page.fileChooserOpened':
      s.chooser?.(p);
      break;
    case 'Runtime.consoleAPICalled': {
      const top = p.stackTrace?.callFrames?.[0];
      pushConsole(s, {
        level: level(p.type),
        message: (p.args ?? []).map(remoteText).join(' '),
        sourceId: top?.url ?? '',
        lineNumber: top ? top.lineNumber + 1 : 0,
        timestamp: p.timestamp ? Math.round(p.timestamp) : Date.now(),
      });
      break;
    }
    case 'Runtime.exceptionThrown': {
      const d = p.exceptionDetails ?? {};
      pushConsole(s, {
        level: 'ERROR',
        message: `Uncaught ${d.exception?.description ?? d.text ?? 'exception'}`,
        sourceId: d.url ?? '',
        lineNumber: (d.lineNumber ?? -1) + 1,
        timestamp: p.timestamp ? Math.round(p.timestamp) : Date.now(),
      });
      break;
    }
    case 'Log.entryAdded': {
      const e = p.entry ?? {};
      pushConsole(s, { level: level(e.level), message: e.text ?? '', sourceId: e.url ?? '', lineNumber: e.lineNumber ?? 0, timestamp: e.timestamp ? Math.round(e.timestamp) : Date.now() });
      break;
    }
    case 'Network.requestWillBeSent': {
      if (blockedReason(p.request?.url)) break;
      if (p.redirectResponse && s.net.has(p.requestId)) {
        // the redirect hop keeps its own row
        const prev = s.net.get(p.requestId);
        s.net.delete(p.requestId);
        prev.id = `${p.requestId}:${prev.status}`;
        prev.status = p.redirectResponse.status;
        prev.durationMs = Math.round((p.timestamp - prev.start) * 1000);
        s.net.set(prev.id, prev);
        const i = s.netOrder.indexOf(p.requestId);
        if (i >= 0) s.netOrder[i] = prev.id;
      }
      const e = netEntry(s, p.requestId);
      e.method = p.request?.method ?? 'GET';
      e.url = p.request?.url ?? '';
      e.type = p.type ?? 'Other';
      e.start = p.timestamp ?? 0;
      e.frameId = p.frameId ?? null;
      if (e.type === 'Document' && (!s.mainFrame || e.frameId === s.mainFrame)) s.docError = null;
      break;
    }
    case 'Network.requestServedFromCache':
      if (s.net.has(p.requestId)) s.net.get(p.requestId).fromCache = true;
      break;
    case 'Network.responseReceived': {
      const e = s.net.get(p.requestId);
      if (!e) break;
      e.status = p.response?.status ?? 0;
      e.mime = p.response?.mimeType ?? '';
      e.type = p.type ?? e.type;
      if (p.response?.fromDiskCache || p.response?.fromServiceWorker || p.response?.fromPrefetchCache) e.fromCache = true;
      break;
    }
    case 'Network.loadingFinished': {
      const e = s.net.get(p.requestId);
      if (!e) break;
      e.bytes = Math.round(p.encodedDataLength ?? -1);
      if (e.start) e.durationMs = Math.round((p.timestamp - e.start) * 1000);
      break;
    }
    case 'Network.loadingFailed': {
      const e = s.net.get(p.requestId);
      if (!e) break;
      e.error = p.canceled ? 'canceled' : (p.blockedReason ?? p.errorText ?? 'failed');
      if (e.start) e.durationMs = Math.round((p.timestamp - e.start) * 1000);
      if (e.type === 'Document' && !p.canceled && (!s.mainFrame || e.frameId === s.mainFrame)) s.docError = { url: e.url, error: p.errorText ?? e.error };
      break;
    }
    default:
      break;
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  sessions.delete(tabId);
  if (reason === 'canceled_by_user') {
    revoke(tabId);
    emit('debuggerCanceled', { tabId: String(tabId) });
  }
});

export function consoleLog(tabId, clear) {
  const s = sessions.get(tabId);
  if (!s) return { entries: [], total: 0, recording: false };
  const entries = s.console.slice();
  if (clear) s.console = [];
  return { entries, total: entries.length, recording: true };
}

export function networkLog(tabId, clear) {
  const s = sessions.get(tabId);
  if (!s) return { entries: [], total: 0, recording: false };
  const entries = s.netOrder.map((id) => s.net.get(id)).filter(Boolean).map(({ start: _s, id: _i, frameId: _f, ...e }) => e);
  if (clear) {
    s.net.clear();
    s.netOrder = [];
  }
  return { entries, total: entries.length, recording: true };
}

export function counts(tabId) {
  const s = sessions.get(tabId);
  if (!s) return { consoleErrors: 0, networkErrors: 0 };
  let net = 0;
  for (const e of s.net.values()) if (e.error || e.status >= 400) net++;
  return { consoleErrors: s.console.filter((e) => e.level === 'ERROR').length, networkErrors: net };
}

// ------------------------------------------------------------------------------------------------ dialogs

export async function handleDialog(tabId, accept, promptText) {
  const s = sessions.get(tabId);
  const d = s?.dialog;
  if (!d) throw new CmdError(`No page dialog is open on tab ${tabId}.`, 'no_dialog');
  const params = { accept: !!accept };
  if (typeof promptText === 'string') params.promptText = promptText;
  await chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', params);
  if (s.dialog === d) s.dialog = null;
  return d;
}

// ------------------------------------------------------------------------------------------------ view mode

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

export async function setViewMode(tabId, mode) {
  const s = await attach(tabId);
  if (mode === 'mobile') {
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', { width: 412, height: 860, deviceScaleFactor: 2.625, mobile: true });
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setUserAgentOverride', { userAgent: MOBILE_UA, platform: 'Android' });
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }).catch(() => {});
  } else {
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride', {});
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setUserAgentOverride', { userAgent: navigator.userAgent });
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
  }
  s.viewMode = mode === 'mobile' ? 'mobile' : 'desktop';
  return s.viewMode;
}

/** The main document's load error (net::ERR_NAME_NOT_RESOLVED…), when the last navigation failed. */
export function docErrorOf(tabId) {
  return sessions.get(tabId)?.docError?.error ?? null;
}

export function viewModeOf(tabId) {
  return sessions.get(tabId)?.viewMode ?? 'desktop';
}

// ------------------------------------------------------------------------------------------------ file chooser

/** Clicks via `click()` and waits for the page's file chooser; resolves with Page.fileChooserOpened or null. */
export async function interceptChooser(tabId, click, timeoutMs) {
  const s = await attach(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Page.setInterceptFileChooserDialog', { enabled: true });
  try {
    const opened = new Promise((resolve) => {
      s.chooser = resolve;
    });
    await click();
    return await Promise.race([opened, sleep(timeoutMs).then(() => null)]);
  } finally {
    s.chooser = null;
    await chrome.debugger.sendCommand({ tabId }, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
  }
}
