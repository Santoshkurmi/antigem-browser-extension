// AntiGem Browser Bridge — service worker. Wires the native-messaging channel to VS Code (bg/native.js), the command
// set (bg/commands.js), the tab policy (bg/policy.js) and the DevTools sessions (bg/cdp.js).
import * as native from './bg/native.js';
import * as policy from './bg/policy.js';
import * as cdp from './bg/cdp.js';
import { forgetTab, handle, inheritLock, isLocked, restoreOverlay, unlockAll, userUnlock } from './bg/commands.js';
import { VERSION } from './bg/util.js';

void native.start(handle);

chrome.alarms.create('antigem-reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'antigem-reconnect') native.tick();
});
chrome.runtime.onStartup.addListener(() => native.tick());
chrome.runtime.onInstalled.addListener(() => native.tick());

// ------------------------------------------------------------------------------------------------ tabs

chrome.tabs.onCreated.addListener(async (tab) => {
  await policy.load();
  if (tab.openerTabId !== undefined && (await policy.adoptIfOpenedByAgent(tab))) await inheritLock(tab.id, tab.openerTabId);
});

chrome.tabs.onRemoved.addListener((id) => {
  policy.forgetTab(id);
  forgetTab(id);
  void cdp.detach(id);
});

chrome.tabs.onUpdated.addListener(async (id, info, tab) => {
  await policy.load();
  if (info.url && policy.blockedReason(info.url) && cdp.session(id)) {
    // a blocked site: the debugger lets go of the tab, nothing of the page is read
    await cdp.detach(id);
  }
  if (info.groupId !== undefined && cdp.session(id) && !(await policy.isAllowed(tab))) {
    // dragged out of the AntiGem group: the agent lets go of it
    await cdp.detach(id);
    forgetTab(id);
    void chrome.tabs.sendMessage(id, { antigem: 'overlay', op: 'state', locked: false, passthrough: false, active: false }, { frameId: 0 }).catch(() => {});
  }
  if (info.status === 'complete') void restoreOverlay(id);
});

// ------------------------------------------------------------------------------------------------ extension pages

// our own extension pages (the popup, or confirm.html in its popup window); content scripts report the page's URL
const isPage = (sender, name) => typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(name)) && (!sender.origin || sender.origin === location.origin);

async function popupState() {
  const tabs = await policy.allowedTabs();
  return {
    version: VERSION,
    extensionId: chrome.runtime.id,
    hostName: native.HOST,
    connection: native.connectionState(),
    tabs: tabs.map((t) => ({ id: t.id, title: t.title ?? '', url: t.url ?? '', locked: isLocked(t.id) })),
    blocklist: policy.blocklist(),
    defaults: policy.DEFAULT_BLOCKLIST,
  };
}

async function popup(msg) {
  await policy.load();
  switch (msg.op) {
    case 'state':
      return popupState();
    case 'disconnect':
      await unlockAll();
      await cdp.detachAll();
      await native.setPaused(true);
      return popupState();
    case 'connect':
      await native.setPaused(false);
      return popupState();
    case 'setBlocklist':
      await policy.setBlocklist(Array.isArray(msg.list) ? msg.list : []);
      return popupState();
    case 'resetBlocklist':
      await policy.setBlocklist([...policy.DEFAULT_BLOCKLIST]);
      return popupState();
    case 'release':
      await unlockAll();
      await cdp.detachAll();
      return popupState();
    case 'focusTab':
      if (Number.isInteger(msg.tabId)) {
        const t = await chrome.tabs.update(msg.tabId, { active: true }).catch(() => null);
        if (t) await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
      }
      return popupState();
    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // only this extension's own pages and content scripts; never web pages (no externally_connectable)
  if (sender.id !== chrome.runtime.id || !msg || typeof msg !== 'object') return;
  switch (msg.antigem) {
    case 'unlock':
      // the Unlock pill of our overlay: acts only on the tab it runs in
      if (sender.tab?.id !== undefined && sender.frameId === 0) void userUnlock(sender.tab.id);
      return;
    case 'confirm-info':
      if (isPage(sender, 'confirm.html')) reply(policy.confirmInfo(String(msg.id)));
      return;
    case 'confirm-answer':
      if (isPage(sender, 'confirm.html')) policy.confirmAnswer(String(msg.id), msg.allow === true);
      return;
    case 'popup':
      if (!isPage(sender, 'popup.html')) return;
      popup(msg).then(reply, (e) => reply({ error: String(e?.message ?? e) }));
      return true;
    default:
      return;
  }
});

native.onStateChange(() => {
  chrome.action.setBadgeText({ text: native.connectionState().status === 'connected' ? '' : '!' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#D97757' }).catch(() => {});
});
