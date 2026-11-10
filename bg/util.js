// Shared helpers of the service worker.

export const VERSION = chrome.runtime.getManifest().version;

/** A command failure with a machine-readable code the VS Code side maps to a message. */
export class CmdError extends Error {
  constructor(message, code = 'error', data = undefined) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function bytesToB64(bytes) {
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) s += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  return btoa(s);
}

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Tab ids travel as strings ("123"); Chrome wants numbers. */
export function tabIdOf(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).trim().replace(/^tab_?/i, ''));
  if (!Number.isInteger(n) || n < 0) throw new CmdError(`"${v}" is not a tab id: use an id from browser_list_tabs.`, 'no_tab');
  return n;
}

/** Simple per-key mutex so two calls never interleave input on one tab. */
const chains = new Map();
export function serial(key, fn) {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  chains.set(key, tail);
  tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return next;
}
