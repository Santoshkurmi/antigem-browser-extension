// AntiGem agent overlay (content script, this extension's isolated world, injected on demand into AntiGem tabs).
// Port of the app's BrowserAgentIndicator + BrowserAgentLock overlay: a glowing frame while an agent works, its cursor
// travelling to each click with a ripple and a short caption, and — while the agent holds the lock — a layer that
// keeps the user's mouse and keyboard off the page plus an "AI controls this tab · Unlock" pill.
// The page cannot reach this code (closed shadow root, isolated world); only trusted (real) clicks count on Unlock.
(() => {
  if (window.__antigemOverlay) return;
  window.__antigemOverlay = true;

  const ACCENT = '#D97757';
  const LINGER_MS = 6000;
  const host = document.createElement('antigem-agent-overlay');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block;contain:strict;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .frame { position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity .25s;
    box-shadow: inset 0 0 0 2px ${ACCENT}f2, inset 0 0 0 6px ${ACCENT}55, inset 0 0 18px 8px ${ACCENT}33; border-radius: 6px;
    animation: pulse 2.2s ease-in-out infinite; }
  .on .frame { opacity: 1; }
  @keyframes pulse { 0%,100% { filter: opacity(.6); } 50% { filter: opacity(1); } }
  .block { position: fixed; inset: 0; pointer-events: none; cursor: not-allowed; background: transparent; }
  .blocking .block { pointer-events: auto; }
  .cursor { position: fixed; left: 0; top: 0; width: 22px; height: 26px; pointer-events: none; opacity: 0;
    transition: transform .26s cubic-bezier(.4,0,.2,1), opacity .2s; will-change: transform; }
  .on.pointer .cursor { opacity: 1; }
  .cursor.pressed svg { transform: scale(.9); transform-origin: 0 0; }
  .ripple { position: fixed; left: 0; top: 0; width: 64px; height: 64px; margin: -32px 0 0 -32px; border-radius: 50%;
    border: 2px solid ${ACCENT}; background: ${ACCENT}66; pointer-events: none; opacity: 0; transform: scale(.2); }
  .ripple.go { animation: ripple .48s cubic-bezier(.4,0,.2,1); }
  @keyframes ripple { from { opacity: .9; transform: scale(.2); } to { opacity: 0; transform: scale(1); } }
  .label { position: fixed; left: 0; top: 0; max-width: 60vw; padding: 4px 10px; border-radius: 999px; background: ${ACCENT}f2;
    color: #fff; font-size: 12px; font-weight: 500; line-height: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    pointer-events: none; opacity: 0; transition: opacity .2s; }
  .on .label.has { opacity: 1; }
  .badge { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); max-width: 86vw; padding: 5px 12px; border-radius: 999px;
    background: #202020e6; color: #fff; font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    pointer-events: none; opacity: 0; transition: opacity .2s; }
  .on.nopointer:not(.locked) .badge { opacity: 1; }
  .pill { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); display: none; align-items: center; gap: 6px;
    padding: 3px 4px 3px 6px; border-radius: 999px; background: #202124f2; color: #fff; font-size: 12px; font-weight: 500;
    box-shadow: 0 4px 14px #0006; pointer-events: auto; user-select: none; }
  .locked .pill { display: flex; }
  .passthrough .pill { pointer-events: none; }
  .grip { cursor: grab; opacity: .55; padding: 0 2px; font-size: 14px; letter-spacing: -2px; }
  .pill button { all: unset; cursor: pointer; padding: 5px 10px; border-radius: 999px; color: #FFB74D; font-weight: 600; font-size: 12px; }
  .pill button:hover { background: #ffffff1a; }
  .hidden { display: none !important; }
</style>
<div class="wrap">
  <div class="frame"></div>
  <div class="block"></div>
  <div class="ripple"></div>
  <div class="cursor"><svg width="22" height="26" viewBox="0 0 22 26"><path d="M1.2 1.8 1.2 18.8 5.6 15 8.6 21.4 11.4 20.2 8.5 13.9 13.8 13.9Z" fill="#0000004d" transform="translate(1.2 1.8)"/><path d="M0 0 0 17 4.4 13.2 7.4 19.6 10.2 18.4 7.3 12.1 12.6 12.1Z" fill="#fff" stroke="#1F1F1F" stroke-width="1.4" stroke-linejoin="round"/></svg></div>
  <div class="label"></div>
  <div class="badge">AI is using this tab</div>
  <div class="pill"><span class="grip">⋮⋮</span><span>🔒</span><span>AI controls this tab</span><button type="button">Unlock</button></div>
</div>`;
  const $ = (s) => root.querySelector(s);
  const wrap = $('.wrap');
  const cursor = $('.cursor');
  const ripple = $('.ripple');
  const label = $('.label');
  const badge = $('.badge');
  const pill = $('.pill');
  const button = pill.querySelector('button');

  const st = { locked: false, passthrough: false, active: false, activeUntil: 0, fx: 0.5, fy: 0.5, pointer: false, label: '', pressed: false };
  let lingerTimer = null;
  let pillDx = 0;
  let pillDy = 0;

  function mount() {
    if (!host.isConnected) (document.documentElement || document).appendChild(host);
  }

  function render() {
    const on = st.active && Date.now() < st.activeUntil;
    wrap.classList.toggle('on', on);
    wrap.classList.toggle('locked', st.locked);
    wrap.classList.toggle('passthrough', st.passthrough);
    wrap.classList.toggle('blocking', st.locked && !st.passthrough);
    wrap.classList.toggle('pointer', st.pointer);
    wrap.classList.toggle('nopointer', !st.pointer);
    const x = st.fx * innerWidth;
    const y = st.fy * innerHeight;
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    cursor.classList.toggle('pressed', st.pressed);
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    label.textContent = st.label;
    label.classList.toggle('has', !!st.label && st.pointer);
    badge.textContent = st.label ? `AI · ${st.label}` : 'AI is using this tab';
    // caption below-right of the tip, flipped near the edges, below the lock pill
    const lw = label.offsetWidth || 120;
    const lh = label.offsetHeight || 24;
    let lx = x + 18;
    let ly = y + 22;
    if (lx + lw > innerWidth - 4) lx = x - lw - 4;
    if (ly + lh > innerHeight - 4) ly = y - lh - 4;
    label.style.transform = `translate(${Math.max(4, lx)}px, ${Math.max(st.locked ? 48 : 4, ly)}px)`;
    pill.style.transform = `translate(calc(-50% + ${pillDx}px), ${pillDy}px)`;
    const any = st.locked || on;
    host.style.display = any && !hiddenForShot ? 'block' : 'none';
    if (any) mount();
  }

  function touch() {
    st.active = true;
    st.activeUntil = Date.now() + LINGER_MS;
    clearTimeout(lingerTimer);
    lingerTimer = setTimeout(render, LINGER_MS + 50);
  }

  let hiddenForShot = false;
  const paint = () => new Promise((r) => {
    let done = false;
    const end = () => {
      if (!done) {
        done = true;
        r(true);
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(end));
    setTimeout(end, 80); // background tabs do not run animation frames
  });

  chrome.runtime.onMessage.addListener((m, sender, reply) => {
    if (sender.id !== chrome.runtime.id || !m || m.antigem !== 'overlay') return;
    switch (m.op) {
      case 'state':
        if (typeof m.locked === 'boolean') st.locked = m.locked;
        if (typeof m.passthrough === 'boolean') st.passthrough = m.passthrough;
        if (m.active === true) touch();
        if (m.active === false) {
          st.active = false;
          st.pointer = false;
        }
        if (typeof m.label === 'string') st.label = m.label.slice(0, 60);
        break;
      case 'move':
        st.fx = Math.min(1, Math.max(0, Number(m.fx) || 0));
        st.fy = Math.min(1, Math.max(0, Number(m.fy) || 0));
        st.pointer = true;
        if (typeof m.label === 'string') st.label = m.label.slice(0, 60);
        touch();
        break;
      case 'press':
        st.pressed = !!m.down;
        touch();
        break;
      case 'click':
        st.pressed = false;
        ripple.classList.remove('go');
        void ripple.offsetWidth;
        ripple.classList.add('go');
        touch();
        break;
      case 'activity':
        if (typeof m.label === 'string') st.label = m.label.slice(0, 60);
        touch();
        break;
      case 'hide':
        hiddenForShot = true;
        render();
        paint().then(() => reply(true));
        return true;
      case 'show':
        hiddenForShot = false;
        break;
      default:
        break;
    }
    render();
    reply(true);
  });

  // the user's Unlock (real clicks only; pages cannot click into a closed shadow root, and synthetic events are ignored)
  button.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    e.preventDefault();
    e.stopPropagation();
    st.locked = false;
    st.active = false;
    render();
    chrome.runtime.sendMessage({ antigem: 'unlock' }).catch(() => {});
  });

  // drag the pill out of the way
  pill.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted || e.target === button) return;
    const sx = e.clientX - pillDx;
    const sy = e.clientY - pillDy;
    const move = (ev) => {
      pillDx = ev.clientX - sx;
      pillDy = Math.max(0, ev.clientY - sy);
      render();
    };
    const up = () => {
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
    };
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
  });

  // while locked (and between agent steps) the user's keyboard, wheel and clicks stay off the page
  const BLOCK = ['keydown', 'keyup', 'keypress', 'beforeinput', 'wheel', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'pointerdown', 'pointerup', 'touchstart', 'touchmove', 'paste', 'drop'];
  const inPill = (e) => {
    const p = e.touches?.[0] ?? e;
    if (typeof p.clientX !== 'number') return false;
    const r = pill.getBoundingClientRect();
    return p.clientX >= r.left && p.clientX <= r.right && p.clientY >= r.top && p.clientY <= r.bottom;
  };
  for (const type of BLOCK) {
    addEventListener(
      type,
      (e) => {
        if (!st.locked || st.passthrough || !e.isTrusted) return;
        // the pill (Unlock, drag) keeps working; everything else stops here, before the page sees it
        if (e.target === host && type !== 'wheel' && (inPill(e) || (type.startsWith('key') && root.activeElement === button))) return;
        e.stopImmediatePropagation();
        e.preventDefault();
      },
      { capture: true, passive: false },
    );
  }

  addEventListener('resize', render);
  render();
})();
