// The page helper (page-agent.js, the app's own, unchanged) and the agent overlay (overlay.js), both injected on demand
// into the tab's main frame in this extension's ISOLATED world: the page cannot see, call or replace them, and nothing
// the page does is ever executed here — results are plain data.
import { CmdError, sleep } from './util.js';
import { attach, raceDialog } from './cdp.js';

export const AGENT_VERSION = 10;

function injectionError(e) {
  const m = String(e?.message ?? e);
  if (/cannot access|cannot be scripted|extensions gallery|chrome:\/\/|manifest must request permission/i.test(m)) {
    return new CmdError(`This page cannot be read or controlled by extensions (${m}).`, 'cannot_attach');
  }
  if (/error page/i.test(m)) return new CmdError('The tab shows a browser error page (the site could not be loaded). Take a screenshot to see it, or open another URL.', 'error_page');
  if (/No tab with id/i.test(m)) return new CmdError(m, 'no_tab');
  return new CmdError(`Could not run in the page: ${m}`, 'script');
}

/** Runs window.__antigemAgent[fn](...args) in the isolated world (inside the page's main frame). */
function agentCall(fn, args, version) {
  try {
    const a = window.__antigemAgent;
    if (!a || a.version !== version) return { __missing: true };
    const r = a[fn].apply(a, args);
    return r === undefined ? null : JSON.parse(JSON.stringify(r));
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function exec(tabId, details, timeoutMs, what) {
  try {
    const res = await raceDialog(tabId, chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, ...details }), timeoutMs, what);
    return res?.[0]?.result;
  } catch (e) {
    if (e instanceof CmdError) throw e;
    throw injectionError(e);
  }
}

/** Calls the page helper (injecting it when missing: new page, or between documents). */
export async function agent(tabId, fn, args = []) {
  await attach(tabId);
  for (let i = 0; i < 3; i++) {
    const r = await exec(tabId, { func: agentCall, args: [fn, args, AGENT_VERSION] }, 10_000, 'the page helper');
    if (r && !r.__missing) return r;
    await exec(tabId, { files: ['page-agent.js'] }, 10_000, 'the page helper');
    await sleep(100);
  }
  throw new CmdError('Could not load the page helper: the page may be navigating, blocking scripts, or not an HTML page. Try again, or take a screenshot.', 'no_agent');
}

/** Runs a small function in the isolated world of the main frame (upload helpers). */
export function isolated(tabId, func, args, timeoutMs = 10_000) {
  return exec(tabId, { func, args }, timeoutMs, 'the page');
}

// ------------------------------------------------------------------------------------------------ overlay

async function injectOverlay(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['overlay.js'] });
}

/** Sends an overlay message (cursor, caption, lock pill…); injects the overlay when the page has none yet. */
export async function overlay(tabId, msg) {
  const send = () => chrome.tabs.sendMessage(tabId, { antigem: 'overlay', ...msg }, { frameId: 0 });
  try {
    return await withTimeout(send(), 1500);
  } catch {
    try {
      await injectOverlay(tabId);
      return await withTimeout(send(), 1500);
    } catch {
      return null; // pages we cannot script (error pages) simply have no overlay
    }
  }
}

function withTimeout(p, ms) {
  return Promise.race([p, sleep(ms).then(() => Promise.reject(new Error('timeout')))]);
}
