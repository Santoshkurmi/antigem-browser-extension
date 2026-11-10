// The commands VS Code may send (generic primitives; the browser_mcp tools are built from them on the VS Code side).
// Every command that touches a tab goes through policy.ensureTab (AntiGem tab group or the user's OK, blocklist), and
// raw DevTools access is limited to input events.
import { CmdError, VERSION, b64ToBytes, bytesToB64, clip, sleep, tabIdOf } from './util.js';
import * as policy from './policy.js';
import * as cdp from './cdp.js';
import { agent, isolated, overlay } from './page.js';
import { connectionState, emit } from './native.js';

// ------------------------------------------------------------------------------------------------ agent lock

const lock = { on: false, locked: new Set(), keptOpen: new Map(), userNews: new Set(), running: new Map(), loaded: null };

function loadLock() {
  if (!lock.loaded) {
    lock.loaded = chrome.storage.session.get(['lockOn', 'locked', 'keptOpen']).then((s) => {
      lock.on = !!s.lockOn;
      lock.locked = new Set(s.locked ?? []);
      lock.keptOpen = new Map(s.keptOpen ?? []);
    });
  }
  return lock.loaded;
}

function saveLock() {
  void chrome.storage.session.set({ lockOn: lock.on, locked: [...lock.locked], keptOpen: [...lock.keptOpen] });
}

export function isLocked(tabId) {
  return lock.locked.has(tabId);
}

function overlayState(tabId, extra = {}) {
  return overlay(tabId, { op: 'state', locked: lock.locked.has(tabId), passthrough: (lock.running.get(tabId) ?? 0) > 0, ...extra });
}

/** The user pressed Unlock on a tab (overlay pill). */
export async function userUnlock(tabId) {
  await loadLock();
  lock.locked.delete(tabId);
  lock.keptOpen.set(tabId, true);
  lock.userNews.add(tabId);
  saveLock();
  void overlayState(tabId, { active: false });
  emit('tabUnlocked', { tabId: String(tabId) });
}

/** A tab opened by a locked agent tab is locked like it. */
export async function inheritLock(child, openerId) {
  await loadLock();
  if (lock.on && lock.locked.has(openerId)) {
    lock.locked.add(child);
    saveLock();
  }
}

export async function unlockAll() {
  await loadLock();
  const released = [...lock.locked];
  lock.on = false;
  lock.locked.clear();
  lock.keptOpen.clear();
  saveLock();
  for (const id of released) void overlayState(id, { active: false });
  return released;
}

export function forgetTab(id) {
  lock.locked.delete(id);
  lock.keptOpen.delete(id);
  lock.userNews.delete(id);
  lock.running.delete(id);
  saveLock();
}

/** Re-shows the lock pill after a locked tab loaded a new page. */
export async function restoreOverlay(tabId) {
  await loadLock();
  if (lock.locked.has(tabId)) void overlayState(tabId);
}

// ------------------------------------------------------------------------------------------------ helpers

function tabSummary(t, cur) {
  const c = cdp.counts(t.id);
  const d = cdp.dialogOf(t.id);
  const url = t.url || t.pendingUrl || '';
  return {
    id: String(t.id),
    url,
    title: t.title ?? '',
    status: t.status ?? 'complete',
    active: !!t.active,
    windowId: t.windowId,
    isCurrent: cur === t.id,
    locked: lock.locked.has(t.id),
    viewMode: cdp.viewModeOf(t.id),
    blocked: !!policy.blockedReason(url),
    dialog: d ? { type: d.type, message: clip(d.message, 300), defaultPrompt: d.defaultPrompt } : null,
    consoleErrors: c.consoleErrors,
    networkErrors: c.networkErrors,
  };
}

/** A tab the agent reads or acts on: allowed (or OK'd by the user) and not on the blocklist. */
async function pageTab(p, purpose = 'control') {
  const id = tabIdOf(p.tabId);
  if (id === null) throw new CmdError('tabId is required', 'bad_request');
  const tab = await policy.ensureTab(id, purpose, true);
  policy.setLastTab(id);
  return tab;
}

/** A tab the agent manages without reading it (switch, close, history, wait). */
async function anyTab(p, purpose) {
  const id = tabIdOf(p.tabId);
  if (id === null) throw new CmdError('tabId is required', 'bad_request');
  return policy.ensureTab(id, purpose, false);
}

/** Waits up to `ms` for a navigation to start (status loading or a new URL). */
async function navigationStarted(tabId, beforeUrl, ms = 1500) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return;
    if (t.status === 'loading' || (t.pendingUrl && t.pendingUrl !== beforeUrl) || t.url !== beforeUrl) return;
    await sleep(50);
  }
}

function formatUrl(input) {
  const s = String(input ?? '').trim();
  if (!s) return '';
  if (/^(https?:|file:|about:|data:|javascript:)/i.test(s) || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\]|192\.168\.|10\.)/i.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(s)) return `http://${s}`;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s) && !/\s/.test(s)) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

// ------------------------------------------------------------------------------------------------ screenshots

const PX_PER_TOKEN = 28;
const MAX_PX = 1568;
const MAX_TOKENS = 1568;

/** Largest size with the same aspect that fits model vision: long side <= 1568 px and ~1568 tokens of 28x28 px. */
export function fit(w, h) {
  const tokens = (a, b) => (Math.floor((a - 1) / PX_PER_TOKEN) + 1) * (Math.floor((b - 1) / PX_PER_TOKEN) + 1);
  if (w <= MAX_PX && h <= MAX_PX && tokens(w, h) <= MAX_TOKENS) return [w, h];
  if (h > w) {
    const [a, b] = fit(h, w);
    return [b, a];
  }
  const ratio = w / h;
  let lo = 1;
  let hi = w;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const mh = Math.max(1, Math.round(mid / ratio));
    if (mid <= MAX_PX && tokens(mid, mh) <= MAX_TOKENS) lo = mid;
    else hi = mid;
  }
  return [lo, Math.max(1, Math.round(lo / ratio))];
}

async function capture(tabId) {
  const vp = await agent(tabId, 'viewport');
  await overlay(tabId, { op: 'hide' });
  let shot;
  const params = { format: 'jpeg', quality: 90, fromSurface: true, captureBeyondViewport: false };
  try {
    const tab = await chrome.tabs.get(tabId);
    try {
      shot = await cdp.call(tabId, 'Page.captureScreenshot', params, tab.active ? 8_000 : 3_000);
    } catch (e) {
      // a background tab may draw nothing until it is shown: show it (like browser_switch_tab) and try again
      if (tab.active || e?.code !== 'timeout') throw e;
      await chrome.tabs.update(tabId, { active: true });
      await sleep(300);
      shot = await cdp.call(tabId, 'Page.captureScreenshot', params, 8_000);
    }
  } finally {
    void overlay(tabId, { op: 'show' });
  }
  const bitmap = await createImageBitmap(new Blob([b64ToBytes(shot.data)], { type: 'image/jpeg' }));
  return { bitmap, vp };
}

async function encode(bitmap, sx, sy, sw, sh, ow, oh, quality = 0.75) {
  const canvas = new OffscreenCanvas(ow, oh);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, ow, oh);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return bytesToB64(new Uint8Array(await blob.arrayBuffer()));
}

/**
 * The visible part of the page, sized for model vision. With regionCss [x0, y0, x1, y1] (CSS px of the visible area):
 * that region enlarged up to 3x within the same budget (zoom).
 */
async function screenshot(p) {
  const tab = await pageTab(p, 'take a screenshot of');
  const scale = Number.isFinite(p.scale) ? Math.min(1, Math.max(0.1, p.scale)) : 1;
  const { bitmap, vp } = await capture(tab.id);
  try {
    const rawW = bitmap.width;
    const rawH = bitmap.height;
    if (Array.isArray(p.regionCss) && p.regionCss.length === 4) {
      const [x0, y0, x1, y1] = p.regionCss.map(Number);
      const kx = rawW / vp.w;
      const ky = rawH / vp.h;
      const left = Math.min(Math.max(0, Math.floor(x0 * kx)), rawW - 1);
      const top = Math.min(Math.max(0, Math.floor(y0 * ky)), rawH - 1);
      const width = Math.min(Math.max(1, Math.floor(x1 * kx) - left), rawW - left);
      const height = Math.min(Math.max(1, Math.floor(y1 * ky) - top), rawH - top);
      const [a, b] = fit(Math.min(width * 3, MAX_PX * 4), Math.min(height * 3, MAX_PX * 4));
      const k = Math.min(a / width, b / height);
      const zw = Math.max(1, Math.round(width * k * scale));
      const zh = Math.max(1, Math.round(height * k * scale));
      const data = await encode(bitmap, left, top, width, height, zw, zh);
      return { data, mimeType: 'image/jpeg', outW: zw, outH: zh, rawW, rawH, vp };
    }
    const [fw, fh] = fit(rawW, rawH);
    const ow = Math.max(1, Math.round(fw * scale));
    const oh = Math.max(1, Math.round(fh * scale));
    const data = await encode(bitmap, 0, 0, rawW, rawH, ow, oh);
    return { data, mimeType: 'image/jpeg', fitW: fw, fitH: fh, outW: ow, outH: oh, rawW, rawH, vp };
  } finally {
    bitmap.close();
  }
}

// ------------------------------------------------------------------------------------------------ uploads

/** Isolated world: finds the upload element (ref, selector, or the page's only file input) and marks it. */
function uploadLocate(ref, selector, nonce) {
  const a = window.__antigemAgent;
  let el = null;
  if (ref) {
    if (!a) return { ok: false, error: 'There are no refs on this page yet: read it first (browser_find or browser_read_page).' };
    let r = String(ref).trim().replace(/^\[|\]$/g, '');
    if (/^\d+$/.test(r)) r = `ref_${r}`;
    const w = a._store.byRef.get(r);
    el = w && w.deref();
    if (!el || !el.isConnected) return { ok: false, error: `No element ${r} on the page any more (it was removed or the page changed). Read the page again for fresh refs.` };
  } else if (selector) {
    try {
      el = document.querySelector(selector);
    } catch (e) {
      return { ok: false, error: `Bad selector: ${e.message}` };
    }
    if (!el) return { ok: false, error: `No element matches ${selector}` };
  } else {
    const inputs = [...document.querySelectorAll('input[type=file]')].filter((i) => !i.disabled);
    const name = (e) => (e.id ? `#${e.id}` : e.name ? `${e.tagName.toLowerCase()}[name="${e.name}"]` : e.tagName.toLowerCase());
    if (!inputs.length) return { ok: false, error: 'No file input on this page. Pass the ref (or selector) of its upload button or drop area.' };
    if (inputs.length > 1) return { ok: false, error: `Several file inputs on this page; pass a ref or selector, e.g. ${inputs.slice(0, 8).map(name).join(', ')}` };
    el = inputs[0];
  }
  const isFile = (x) => !!(x && x.matches && x.matches('input[type=file]'));
  const input = isFile(el) ? el : isFile(el.control) ? el.control : el.querySelector ? el.querySelector('input[type=file]') : null;
  el.setAttribute('data-antigem-upload', nonce);
  if (input) input.setAttribute('data-antigem-upload-input', nonce);
  const st = getComputedStyle(el);
  let r = el.getBoundingClientRect();
  const shown = r.width >= 4 && r.height >= 4 && st.visibility !== 'hidden' && st.display !== 'none';
  if (shown) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    r = el.getBoundingClientRect();
  }
  const v = window.visualViewport;
  const x = r.left + r.width / 2 - (v ? v.offsetLeft : 0);
  const y = r.top + r.height / 2 - (v ? v.offsetTop : 0);
  const vw = v ? v.width : innerWidth;
  const vh = v ? v.height : innerHeight;
  return {
    ok: true,
    tag: el.tagName.toLowerCase(),
    file_input: !!input,
    multiple: !!(input && input.multiple),
    accept: input ? input.accept : '',
    tappable: shown && x >= 0 && x <= vw && y >= 0 && y <= vh,
    x,
    y,
  };
}

/** Isolated world: builds the files in the page and assigns / drops them (no file chooser opened). */
function uploadInPage(files, nonce) {
  const el = document.querySelector(`[data-antigem-upload="${nonce}"]`) || (function deep(root) {
    for (const e of root.querySelectorAll('*')) {
      if (e.getAttribute && e.getAttribute('data-antigem-upload') === nonce) return e;
      if (e.shadowRoot) {
        const h = deep(e.shadowRoot);
        if (h) return h;
      }
    }
    return null;
  })(document);
  if (!el || !el.isConnected) return { ok: false, error: 'The upload element is gone' };
  const isFile = (x) => !!(x && x.matches && x.matches('input[type=file]'));
  const input = isFile(el) ? el : isFile(el.control) ? el.control : null;
  const dt = new DataTransfer();
  for (const f of input && !input.multiple ? files.slice(0, 1) : files) {
    const bin = atob(f.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], f.name, { type: f.type, lastModified: Date.now() }));
  }
  if (input) {
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, method: 'assign', given: dt.files.length };
  }
  for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  return { ok: true, method: 'drop', given: dt.files.length };
}

function uploadCleanup(nonce) {
  const clean = (root) => {
    for (const e of root.querySelectorAll(`[data-antigem-upload="${nonce}"],[data-antigem-upload-input="${nonce}"]`)) {
      e.removeAttribute('data-antigem-upload');
      e.removeAttribute('data-antigem-upload-input');
    }
    for (const e of root.querySelectorAll('*')) if (e.shadowRoot) clean(e.shadowRoot);
  };
  clean(document);
  return true;
}

/** Main-world object id of the element marked with `attr=nonce` (shadow roots included). */
async function markedObject(tabId, attr, nonce) {
  const expression = `(() => { const sel = ${JSON.stringify(`[${attr}="${nonce}"]`)}; const find = (root) => { const hit = root.querySelector(sel); if (hit) return hit; for (const e of root.querySelectorAll('*')) if (e.shadowRoot) { const h = find(e.shadowRoot); if (h) return h; } return null; }; return find(document); })()`;
  const r = await cdp.call(tabId, 'Runtime.evaluate', { expression, returnByValue: false });
  const id = r?.result?.objectId;
  if (!id) throw new CmdError('The upload element is gone', 'upload');
  return id;
}

async function mouseClick(tabId, x, y) {
  for (const [type, extra] of [
    ['mouseMoved', {}],
    ['mousePressed', { button: 'left', buttons: 1, clickCount: 1 }],
    ['mouseReleased', { button: 'left', buttons: 0, clickCount: 1 }],
  ]) {
    await cdp.call(tabId, 'Input.dispatchMouseEvent', { type, x, y, button: 'none', buttons: 0, clickCount: 0, modifiers: 0, ...extra });
  }
}

async function upload(p) {
  const tab = await pageTab(p, 'upload files to');
  const tabId = tab.id;
  const files = Array.isArray(p.files) ? p.files : [];
  if (!files.length) throw new CmdError('file_paths is empty', 'bad_request');
  const method = p.method || 'auto';
  if (!['auto', 'chooser', 'drop'].includes(method)) throw new CmdError('method must be auto, chooser or drop', 'bad_request');
  const timeoutMs = Math.min(30, Math.max(1, Number(p.timeoutSeconds) || 10)) * 1000;
  await agent(tabId, 'viewport');
  const nonce = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const loc = await isolated(tabId, uploadLocate, [p.ref || null, p.selector || null, nonce]);
  if (!loc?.ok) throw new CmdError(loc?.error ?? 'Could not find the upload element', 'upload');
  const result = { files: files.map((f) => f.name), target: loc.tag, file_input: loc.file_input };
  const give = (multiple) => (multiple ? files : files.slice(0, 1));
  try {
    if (method !== 'drop') {
      if (loc.file_input) {
        // the input itself: the files go in exactly as if picked in the browser's own file dialog
        const objectId = await markedObject(tabId, 'data-antigem-upload-input', nonce);
        const list = give(loc.multiple);
        await cdp.call(tabId, 'DOM.setFileInputFiles', { files: list.map((f) => f.path), objectId });
        Object.assign(result, { method: 'chooser', given: list.length, multiple: loc.multiple, accept: loc.accept ? loc.accept.split(',').map((s) => s.trim()) : [] });
        if (list.length < files.length) result.note = 'The page takes one file at a time; only the first was given';
        return result;
      }
      if (loc.tappable) {
        const opened = await cdp.interceptChooser(tabId, () => mouseClick(tabId, loc.x, loc.y), timeoutMs);
        if (opened) {
          const multiple = opened.mode === 'selectMultiple';
          const list = give(multiple);
          await cdp.call(tabId, 'DOM.setFileInputFiles', { files: list.map((f) => f.path), backendNodeId: opened.backendNodeId });
          Object.assign(result, { method: 'chooser', given: list.length, multiple });
          if (list.length < files.length) result.note = 'The page takes one file at a time; only the first was given';
          return result;
        }
      }
      if (method === 'chooser') {
        throw new CmdError(
          `The page did not open a file chooser within ${timeoutMs / 1000} s. Point at the element that opens it (its upload button or <input type=file>), or use method "drop" for a drag-and-drop area.`,
          'upload',
        );
      }
    }
    if (!Array.isArray(p.data)) return { needData: true };
    const done = await isolated(tabId, uploadInPage, [p.data, nonce], 30_000);
    if (!done?.ok) throw new CmdError(done?.error || 'In-page upload failed', 'upload');
    Object.assign(result, { method: done.method, given: done.given, note: 'No file chooser opened; the files were built inside the page. Some sites ignore that, so check the page shows them.' });
    return result;
  } finally {
    await isolated(tabId, uploadCleanup, [nonce], 5_000).catch(() => {});
  }
}

// ------------------------------------------------------------------------------------------------ the commands

const AGENT_FNS = new Set(['tree', 'find', 'resolve', 'hitTest', 'focusInfo', 'viewport', 'scrollIntoViewRef', 'scrollAt', 'pointerEvent', 'insertText', 'formInput', 'pageText']);
const INPUT_METHODS = new Set(['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Input.dispatchTouchEvent']);

export async function handle(command, p) {
  await policy.load();
  await loadLock();
  switch (command) {
    case 'ping':
      return { pong: true, version: VERSION };

    case 'status': {
      const tabs = await policy.allowedTabs();
      return {
        version: VERSION,
        extensionId: chrome.runtime.id,
        connection: connectionState(),
        tabs: tabs.length,
        locked: lock.locked.size,
        attached: cdp.attachedTabs().length,
        blocklist: policy.blocklist(),
      };
    }

    case 'tabs.list': {
      const all = await chrome.tabs.query({});
      const cur = await policy.currentTab();
      const tabs = [];
      for (const t of all) if (await policy.isAllowed(t)) tabs.push(tabSummary(t, cur?.id));
      return { tabs, current: cur ? String(cur.id) : null, others: all.length - tabs.length };
    }

    case 'tabs.current': {
      const cur = await policy.currentTab();
      return { tabId: cur ? String(cur.id) : null };
    }

    case 'tabs.resolve': {
      // the tab a tool works on: the given one (asking the user when it is outside the group) or the current one
      const id = tabIdOf(p.tabId);
      if (id === null) {
        const cur = await policy.currentTab();
        if (!cur) throw new CmdError('No AntiGem tab is open. Open a page with browser_open_url (it opens in the AntiGem tab group).', 'no_tab');
        return tabSummary(cur, cur.id);
      }
      const t = await policy.ensureTab(id, p.purpose || 'use', !!p.page);
      policy.setLastTab(id);
      return tabSummary(t, id);
    }

    case 'tabs.open': {
      const url = formatUrl(p.url);
      if (!url) throw new CmdError('url is empty', 'bad_request');
      if (/^javascript:/i.test(url)) throw new CmdError('javascript: URLs are not opened; run scripts with browser_eval_js.', 'bad_request');
      policy.assertUrlAllowed(url);
      const id = tabIdOf(p.tabId);
      let tabId;
      let before = '';
      if (id !== null) {
        const t = await policy.ensureTab(id, 'open a page in', false);
        tabId = t.id;
        before = t.url;
      } else if (!p.newTab) {
        const cur = await policy.currentTab();
        if (cur) {
          tabId = cur.id;
          before = cur.url;
        }
      }
      let created = false;
      if (tabId === undefined) {
        const windowId = await policy.targetWindow();
        let t;
        if (windowId === null) {
          const w = await chrome.windows.create({ url: 'about:blank', focused: false });
          t = w.tabs[0];
        } else {
          t = await chrome.tabs.create({ windowId, url: 'about:blank', active: true });
        }
        tabId = t.id;
        before = 'about:blank';
        created = true;
        await policy.addToGroup(tabId);
      }
      // attach first, so the load itself is recorded (requests, page errors, dialogs while loading)
      if (!policy.blockedReason(before)) await cdp.attach(tabId).catch(() => {});
      if (p.viewMode === 'mobile' || p.viewMode === 'desktop') await cdp.setViewMode(tabId, p.viewMode).catch(() => {});
      await chrome.tabs.update(tabId, { url });
      policy.setLastTab(tabId);
      await navigationStarted(tabId, before);
      return { tabId: String(tabId), created };
    }

    case 'tabs.history': {
      const t = await anyTab(p, 'move in the history of');
      const before = t.url;
      try {
        if (p.action === 'back') await chrome.tabs.goBack(t.id);
        else if (p.action === 'forward') await chrome.tabs.goForward(t.id);
        else await chrome.tabs.reload(t.id);
      } catch {
        return { moved: false };
      }
      policy.setLastTab(t.id);
      await navigationStarted(t.id, p.action === 'reload' ? '\u0000' : before, 800);
      return { moved: true };
    }

    case 'tabs.wait': {
      const t = await anyTab(p, 'use');
      const until = Date.now() + Math.min(60_000, Math.max(0, Number(p.timeoutMs) || 10_000));
      let cur = t;
      for (;;) {
        cur = await chrome.tabs.get(t.id).catch(() => null);
        if (!cur) throw new CmdError(`Tab ${t.id} was closed`, 'no_tab');
        const d = cdp.dialogOf(t.id);
        if (d) return { loaded: false, url: cur.url, title: cur.title, status: cur.status, dialog: d };
        const error = cdp.docErrorOf(t.id);
        if (cur.status === 'complete') return { loaded: true, url: cur.url, title: cur.title, status: cur.status, ...(error ? { error } : {}) };
        if (Date.now() > until) return { loaded: false, url: cur.url || cur.pendingUrl, title: cur.title, status: cur.status, ...(error ? { error } : {}) };
        await sleep(100);
      }
    }

    case 'tabs.activate': {
      const t = await anyTab(p, 'show');
      await chrome.tabs.update(t.id, { active: true });
      policy.setLastTab(t.id);
      return { tabId: String(t.id) };
    }

    case 'tabs.close': {
      const t = await anyTab(p, 'close');
      await chrome.tabs.remove(t.id);
      return { tabId: String(t.id) };
    }

    case 'tabs.viewMode': {
      const t = await pageTab(p, 'change the view mode of');
      const mode = await cdp.setViewMode(t.id, p.mode === 'mobile' ? 'mobile' : 'desktop');
      const before = t.url;
      await chrome.tabs.reload(t.id);
      await navigationStarted(t.id, before, 800);
      return { mode };
    }

    case 'agent.begin': {
      const t = await pageTab(p, 'control');
      lock.running.set(t.id, (lock.running.get(t.id) ?? 0) + 1);
      if (lock.on && !lock.locked.has(t.id) && !lock.keptOpen.has(t.id)) {
        lock.locked.add(t.id);
        saveLock();
      }
      await cdp.attach(t.id);
      await overlayState(t.id, { active: true, ...(p.label ? { label: String(p.label) } : {}) });
      const userUnlocked = lock.userNews.delete(t.id);
      return { userUnlocked, locked: lock.locked.has(t.id), active: !!t.active, url: t.url, title: t.title };
    }

    case 'agent.end': {
      const id = tabIdOf(p.tabId);
      if (id === null) return null;
      const n = (lock.running.get(id) ?? 1) - 1;
      if (n > 0) lock.running.set(id, n);
      else lock.running.delete(id);
      if (n <= 0) void overlayState(id);
      return null;
    }

    case 'overlay': {
      const id = tabIdOf(p.tabId);
      if (id === null) return null;
      const t = await chrome.tabs.get(id).catch(() => null);
      if (!t || !(await policy.isAllowed(t))) return null;
      const { tabId: _t, ...msg } = p;
      await overlay(id, msg);
      return null;
    }

    case 'lock.set': {
      if (p.locked !== false) {
        const id = tabIdOf(p.tabId);
        let t;
        if (id === null) {
          t = await policy.currentTab();
          if (!t) throw new CmdError('No AntiGem tab is open. Open a page with browser_open_url first.', 'no_tab');
          t = await policy.ensureTab(t.id, 'control', true);
        } else t = await pageTab(p, 'control');
        lock.on = true;
        lock.keptOpen.delete(t.id);
        lock.userNews.delete(t.id);
        lock.locked.add(t.id);
        saveLock();
        await overlayState(t.id, { active: true, ...(p.label ? { label: String(p.label) } : {}) });
        return { tabId: String(t.id), locked: [...lock.locked].map(String) };
      }
      const id = tabIdOf(p.tabId);
      if (id === null) return { released: (await unlockAll()).map(String) };
      const was = lock.locked.delete(id);
      if (lock.on) lock.keptOpen.set(id, false);
      saveLock();
      void overlayState(id, { active: false });
      return { tabId: String(id), was, locked: [...lock.locked].map(String) };
    }

    case 'page.call': {
      if (!AGENT_FNS.has(p.fn)) throw new CmdError(`Unknown page helper function ${p.fn}`, 'bad_request');
      const t = await pageTab(p, 'read');
      return agent(t.id, p.fn, Array.isArray(p.args) ? p.args : []);
    }

    case 'page.eval': {
      const t = await pageTab(p, 'run a script in');
      const timeout = Math.min(120_000, Math.max(1000, Number(p.timeoutMs) || 30_000));
      return cdp.call(
        t.id,
        'Runtime.evaluate',
        { expression: String(p.expression ?? ''), replMode: true, awaitPromise: true, returnByValue: true, userGesture: true, timeout },
        timeout + 2000,
      );
    }

    case 'cdp': {
      const t = await pageTab(p, 'control');
      const list = Array.isArray(p.commands) ? p.commands : [];
      for (const c of list) if (!INPUT_METHODS.has(c?.method)) throw new CmdError(`DevTools method ${c?.method} is not allowed`, 'bad_request');
      const per = Math.min(30_000, Math.max(1000, Number(p.timeoutMs) || 15_000));
      for (const c of list) {
        await cdp.call(t.id, c.method, c.params ?? {}, per);
        if (c.delayMs) await sleep(Math.min(1000, c.delayMs));
      }
      return { count: list.length };
    }

    case 'screenshot':
      return screenshot(p);

    case 'logs.console': {
      const t = await pageTab(p, 'read the console of');
      await cdp.attach(t.id);
      return cdp.consoleLog(t.id, !!p.clear);
    }

    case 'logs.network': {
      const t = await pageTab(p, 'read the network requests of');
      const fresh = !cdp.session(t.id);
      await cdp.attach(t.id);
      return { ...cdp.networkLog(t.id, !!p.clear), justStarted: fresh };
    }

    case 'dialog.list': {
      const out = [];
      for (const d of cdp.dialogs()) {
        const t = await chrome.tabs.get(d.tabId).catch(() => null);
        if (t && (await policy.isAllowed(t))) out.push({ ...d, tabId: String(d.tabId) });
      }
      return { dialogs: out };
    }

    case 'dialog.handle': {
      const t = await anyTab(p, 'answer a dialog in');
      const d = await cdp.handleDialog(t.id, p.accept, p.promptText);
      return { tabId: String(t.id), dialog: d };
    }

    case 'upload':
      return upload(p);

    case 'blocklist.get':
      return { list: policy.blocklist(), defaults: policy.DEFAULT_BLOCKLIST };

    case 'blocklist.set': {
      const wanted = (Array.isArray(p.list) ? p.list : []).map(policy.normalizeEntry).filter(Boolean);
      const removed = policy.blocklist().filter((e) => !wanted.includes(e));
      if (removed.length) {
        // loosening the blocklist from VS Code needs the user's OK in the browser
        const ok = await policy.askUser({
          kind: 'blocklist',
          title: 'Remove sites from the AntiGem blocklist?',
          message: 'AntiGem in VS Code asks to remove these entries from the blocklist. Agents could then open, read and control them.',
          detail: removed.join('\n'),
          allowLabel: 'Remove them',
          denyLabel: 'Keep them blocked',
        });
        if (!ok) throw new CmdError('The user kept the blocklist as it was (removing entries needs an OK in the browser).', 'denied');
      }
      return { list: await policy.setBlocklist(wanted) };
    }

    default:
      throw new CmdError(`Unknown command ${command}`, 'bad_request');
  }
}
