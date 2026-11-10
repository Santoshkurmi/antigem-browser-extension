// What the agent may touch. Agents act only in tabs of the "AntiGem" tab group (tabs they open go there; the user can
// drag tabs in or out) and in popups those tabs open. Any other tab needs the user's OK in a confirm window, after
// which it joins the group. Sites on the blocklist (banking, payments, password managers… editable in the popup) are
// never opened, read or controlled. Browser pages (chrome://, other extensions, the Web Store) cannot be controlled.
import { CmdError, clip } from './util.js';

export const GROUP_TITLE = 'AntiGem';
const GROUP_COLOR = 'blue';

export const DEFAULT_BLOCKLIST = [
  'file://',
  'paypal.com',
  'venmo.com',
  'chase.com',
  'bankofamerica.com',
  'wellsfargo.com',
  'citi.com',
  'citibank.com',
  'capitalone.com',
  'usbank.com',
  'americanexpress.com',
  'discover.com',
  'schwab.com',
  'fidelity.com',
  'vanguard.com',
  'etrade.com',
  'robinhood.com',
  'hsbc.com',
  'barclays.co.uk',
  'lloydsbank.co.uk',
  'natwest.com',
  'santander.com',
  'revolut.com',
  'wise.com',
  'dashboard.stripe.com',
  'pay.google.com',
  'passwords.google.com',
  'coinbase.com',
  'binance.com',
  'kraken.com',
  '1password.com',
  'bitwarden.com',
  'lastpass.com',
  'dashlane.com',
];

const BROWSER_SCHEMES = new Set(['chrome:', 'chrome-extension:', 'chrome-untrusted:', 'chrome-search:', 'devtools:', 'edge:', 'brave:', 'opera:', 'vivaldi:', 'view-source:', 'about:']);

// ------------------------------------------------------------------------------------------------ persisted state

const mem = { groups: new Set(), adopted: new Set(), lastTab: null, revoked: new Set(), blocklist: null };
let loaded = null;

export function load() {
  if (!loaded) {
    loaded = (async () => {
      const s = await chrome.storage.session.get(['groups', 'adopted', 'lastTab', 'revoked']);
      mem.groups = new Set(s.groups ?? []);
      mem.adopted = new Set(s.adopted ?? []);
      mem.lastTab = s.lastTab ?? null;
      mem.revoked = new Set(s.revoked ?? []);
      const l = await chrome.storage.local.get('blocklist');
      mem.blocklist = Array.isArray(l.blocklist) ? l.blocklist : [...DEFAULT_BLOCKLIST];
    })();
  }
  return loaded;
}

function save() {
  void chrome.storage.session.set({ groups: [...mem.groups], adopted: [...mem.adopted], lastTab: mem.lastTab, revoked: [...mem.revoked] });
}

// ------------------------------------------------------------------------------------------------ blocklist

export function blocklist() {
  return [...(mem.blocklist ?? DEFAULT_BLOCKLIST)];
}

export function normalizeEntry(e) {
  let s = String(e ?? '').trim().toLowerCase();
  if (!s || s.startsWith('#')) return '';
  if (s === 'file:' || s === 'file://' || s === 'file:///') return 'file://';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\*\./, '').replace(/^\./, '');
  s = s.split('/')[0].split('?')[0].split('#')[0].replace(/:\d+$/, '');
  return s;
}

export async function setBlocklist(list) {
  const clean = [...new Set(list.map(normalizeEntry).filter(Boolean))];
  mem.blocklist = clean;
  await chrome.storage.local.set({ blocklist: clean });
  return clean;
}

/** Why the agent may not use this URL (null = allowed). */
export function blockedReason(url) {
  if (!url) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol === 'about:' && (u.href === 'about:blank' || u.href === 'about:srcdoc')) return null;
  if (BROWSER_SCHEMES.has(u.protocol)) return 'browser pages cannot be controlled';
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'javascript:') return null;
  const list = mem.blocklist ?? DEFAULT_BLOCKLIST;
  if (u.protocol === 'file:') return list.includes('file://') ? 'local files (file://) are on the blocklist' : null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'chromewebstore.google.com' || (host === 'chrome.google.com' && u.pathname.startsWith('/webstore'))) return 'the Web Store cannot be controlled';
  for (const e of list) {
    if (!e || e === 'file://') continue;
    if (host === e || host.endsWith(`.${e}`)) return `${e} is on the AntiGem blocklist`;
  }
  return null;
}

export function assertUrlAllowed(url) {
  const why = blockedReason(url);
  if (why) {
    throw new CmdError(
      `Not allowed: ${clip(url, 120)} — ${why}. The agent may not open, read or control it; the user can change the blocklist in the AntiGem extension popup.`,
      'blocked',
    );
  }
}

// ------------------------------------------------------------------------------------------------ tab group

async function groupInfo(gid) {
  if (gid === undefined || gid === null || gid < 0) return null;
  try {
    return await chrome.tabGroups.get(gid);
  } catch {
    mem.groups.delete(gid);
    return null;
  }
}

export async function isOurGroup(gid) {
  const g = await groupInfo(gid);
  if (!g) return false;
  if (mem.groups.has(gid)) return true;
  // a group the user named AntiGem counts too (e.g. made again after closing ours)
  if ((g.title ?? '').trim().toLowerCase() === GROUP_TITLE.toLowerCase()) {
    mem.groups.add(gid);
    save();
    return true;
  }
  return false;
}

export async function isAllowed(tab) {
  if (!tab) return false;
  if (mem.adopted.has(tab.id)) return true;
  return isOurGroup(tab.groupId);
}

/** The AntiGem group of a window, if any. */
async function groupInWindow(windowId) {
  const groups = await chrome.tabGroups.query({ windowId });
  for (const g of groups) if (mem.groups.has(g.id)) return g.id;
  for (const g of groups) if ((g.title ?? '').trim().toLowerCase() === GROUP_TITLE.toLowerCase()) return g.id;
  return null;
}

/** Puts a tab into the AntiGem group of its window (made when missing); popup windows cannot group: adopted. */
export async function addToGroup(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const win = await chrome.windows.get(tab.windowId);
  if (win.type !== 'normal') {
    mem.adopted.add(tabId);
    save();
    return;
  }
  const existing = await groupInWindow(tab.windowId);
  if (existing !== null) {
    if (tab.groupId !== existing) await chrome.tabs.group({ groupId: existing, tabIds: [tabId] });
    return;
  }
  const gid = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
  await chrome.tabGroups.update(gid, { title: GROUP_TITLE, color: GROUP_COLOR, collapsed: false });
  mem.groups.add(gid);
  save();
}

/** Window new agent tabs open in: the one with the AntiGem group, else the last focused normal window. */
export async function targetWindow() {
  for (const gid of mem.groups) {
    const g = await groupInfo(gid);
    if (g) return g.windowId;
  }
  try {
    const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (w?.id !== undefined) return w.id;
  } catch {
    /* no window */
  }
  return null;
}

/** All tabs the agent may use. */
export async function allowedTabs() {
  const all = await chrome.tabs.query({});
  const out = [];
  for (const t of all) if (await isAllowed(t)) out.push(t);
  return out;
}

export function setLastTab(id) {
  if (mem.lastTab !== id) {
    mem.lastTab = id;
    save();
  }
}

/** The tab tools use when no tab_id is given: the last one the agent used, else the group's visible tab. */
export async function currentTab() {
  if (mem.lastTab !== null) {
    try {
      const t = await chrome.tabs.get(mem.lastTab);
      if (await isAllowed(t)) return t;
    } catch {
      /* closed */
    }
  }
  const tabs = await allowedTabs();
  if (!tabs.length) return null;
  const active = tabs.find((t) => t.active);
  const pick = active ?? tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
  setLastTab(pick.id);
  return pick;
}

export function forgetTab(id) {
  mem.adopted.delete(id);
  mem.revoked.delete(id);
  if (mem.lastTab === id) mem.lastTab = null;
  save();
}

/** A tab opened by an agent tab (link with target=_blank, window.open) belongs to the agent too. */
export async function adoptIfOpenedByAgent(tab) {
  if (tab.openerTabId === undefined) return false;
  let opener;
  try {
    opener = await chrome.tabs.get(tab.openerTabId);
  } catch {
    return false;
  }
  if (!(await isAllowed(opener))) return false;
  if (await isAllowed(tab)) return true;
  try {
    await addToGroup(tab.id);
  } catch {
    mem.adopted.add(tab.id);
    save();
  }
  return true;
}

/** The user pressed Cancel on the "started debugging" bar: the agent needs a new OK for that tab. */
export function revoke(id) {
  mem.revoked.add(id);
  save();
}

// ------------------------------------------------------------------------------------------------ user confirmation

const pending = new Map();
let queue = Promise.resolve();

/** Info for confirm.html (only our own page may ask). */
export function confirmInfo(id) {
  return pending.get(id)?.info ?? null;
}

export function confirmAnswer(id, allow) {
  const p = pending.get(id);
  if (p) p.finish(!!allow);
}

/**
 * Asks the user in a small window (one at a time). Resolves false on Deny, on closing the window, or after 2 minutes.
 */
export function askUser(info) {
  const run = () =>
    new Promise((resolve) => {
      const id = crypto.randomUUID();
      let winId = null;
      let done = false;
      const finish = (allow) => {
        if (done) return;
        done = true;
        pending.delete(id);
        clearTimeout(timer);
        chrome.windows.onRemoved.removeListener(onClosed);
        if (winId !== null) chrome.windows.remove(winId).catch(() => {});
        resolve(allow);
      };
      const onClosed = (w) => {
        if (w === winId) finish(false);
      };
      const timer = setTimeout(() => finish(false), 120_000);
      pending.set(id, { info, finish });
      chrome.windows.onRemoved.addListener(onClosed);
      chrome.windows
        .create({ url: chrome.runtime.getURL(`confirm.html#${id}`), type: 'popup', width: 480, height: 340, focused: true })
        .then((w) => {
          winId = w.id ?? null;
          if (done && winId !== null) chrome.windows.remove(winId).catch(() => {});
        })
        .catch(() => finish(false));
    });
  const next = queue.then(run, run);
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * The tab, if the agent may use it for `purpose`: tabs outside the AntiGem group (or revoked ones) need the user's OK,
 * after which they join the group. `page` = the agent reads or acts on the page itself (blocklist applies).
 */
export async function ensureTab(tabId, purpose, page = true) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new CmdError(`No tab with id ${tabId}: it was closed. Use browser_list_tabs for the open AntiGem tabs.`, 'no_tab');
  }
  const ok = await isAllowed(tab);
  if (!ok || mem.revoked.has(tabId)) {
    if (page) assertUrlAllowed(tab.pendingUrl || tab.url);
    const allow = await askUser({
      kind: 'tab',
      title: mem.revoked.has(tabId) ? 'Let the agent control this tab again?' : 'Let the agent use this tab?',
      message: `An AntiGem agent wants to ${purpose} a tab outside the AntiGem tab group. If you allow it, the tab joins the group and the agent can use it until you drag it out of the group.`,
      detail: `${clip(tab.title || 'Untitled', 90)}\n${clip(tab.url || tab.pendingUrl || '', 140)}`,
      allowLabel: 'Allow',
      denyLabel: 'Deny',
    });
    if (!allow) {
      throw new CmdError(
        `The user did not allow the agent to use tab ${tabId} (it is outside the AntiGem tab group). Work in AntiGem tabs: browser_open_url opens pages there.`,
        'denied',
      );
    }
    mem.revoked.delete(tabId);
    save();
    if (!ok) await addToGroup(tabId).catch(() => {
      mem.adopted.add(tabId);
      save();
    });
    tab = await chrome.tabs.get(tabId);
  }
  if (page) assertUrlAllowed(tab.pendingUrl || tab.url);
  return tab;
}
