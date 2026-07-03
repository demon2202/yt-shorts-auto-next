const DEFAULTS = {
  initialized: true,
  enabled: true,
  delayMs: 80,
  endThreshold: 1.15,
  showMiniPanel: true,
  pauseWhenInteracting: true,
  skipMutedAds: true,
  aggressiveBackground: true,
  smoothMode: true
};

let creatingOffscreen = null;
let lastSweepAt = 0;
let lastTabState = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get({ initialized: false });
  if (!existing.initialized) await chrome.storage.sync.set(DEFAULTS);
  else {
    // Keep old user settings, but add new defaults.
    const current = await chrome.storage.sync.get(DEFAULTS);
    await chrome.storage.sync.set({ ...DEFAULTS, ...current, initialized: true });
  }
  await ensureOffscreen();
});

chrome.runtime.onStartup.addListener(() => ensureOffscreen());

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'SAN_BACKGROUND_TICK') backgroundSweep();
  if (message?.type === 'SAN_PING') sendResponse({ ok: true });
  return false;
});

async function ensureOffscreen() {
  if (!chrome.offscreen) return;
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = (async () => {
    try {
      const existing = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL('offscreen.html')]
      });
      if (existing.length) return;
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_SCRAPING'],
        justification: 'Keep a lightweight timer to check background YouTube Shorts tabs.'
      });
    } catch (err) {
      console.warn('Shorts Auto Next offscreen unavailable:', err);
    } finally {
      creatingOffscreen = null;
    }
  })();
  return creatingOffscreen;
}

async function backgroundSweep() {
  const now = Date.now();
  if (now - lastSweepAt < 1100) return;
  lastSweepAt = now;

  const settings = await chrome.storage.sync.get(DEFAULTS);
  if (!settings.enabled || !settings.aggressiveBackground) return;

  const windows = await chrome.windows.getAll({ populate: false }).catch(() => []);
  const focusedWindowIds = new Set(windows.filter(w => w.focused).map(w => w.id));
  const tabs = await chrome.tabs.query({ url: ['*://www.youtube.com/shorts/*', '*://m.youtube.com/shorts/*'] });

  if (tabs.length === 0) return;

  for (const tab of tabs) {
    if (!tab.id || tab.discarded || tab.status === 'loading') continue;

    // Let the content script handle the currently focused Shorts tab. This prevents sluggishness.
    const isFocusedActiveTab = tab.active && focusedWindowIds.has(tab.windowId);
    if (isFocusedActiveTab) continue;

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: backgroundShortsCheck,
        args: [{
          endThreshold: Number(settings.endThreshold) || 1.15,
          delayMs: Number(settings.delayMs) || 0,
          pauseWhenInteracting: Boolean(settings.pauseWhenInteracting),
          smoothMode: Boolean(settings.smoothMode)
        }]
      });
      const value = results?.[0]?.result;
      if (value?.navigateUrl && /^https:\/\/(www\.|m\.)?youtube\.com\/shorts\//.test(value.navigateUrl)) {
        console.log(`[SAN BG] Navigating tab ${tab.id} to ${value.navigateUrl}`);
        await chrome.tabs.update(tab.id, { url: value.navigateUrl });
      }
      lastTabState.set(tab.id, { at: now, value });
    } catch (err) {
      console.error(`[SAN BG] Script injection failed for tab ${tab.id}:`, err);
    }
  }
}

function backgroundShortsCheck(options) {
  const now = Date.now();
  const threshold = Math.min(3, Math.max(0.25, Number(options.endThreshold) || 1.15));
  const delayMs = Math.min(2000, Math.max(0, Number(options.delayMs) || 0));

  window.__SAN_BG_STATE = window.__SAN_BG_STATE || { lastTime: 0, lastPath: '', lastAdvanceAt: 0, armed: true, pendingAt: 0 };
  const state = window.__SAN_BG_STATE;

  if (!/^\/shorts\//.test(location.pathname)) return { ok: false, reason: 'not-shorts' };
  if (state.lastPath !== location.pathname) {
    state.lastPath = location.pathname;
    state.lastTime = 0;
    state.lastAdvanceAt = 0;
    state.pendingAt = 0;
    state.armed = true;
  }

  if (options.pauseWhenInteracting) {
    const el = document.activeElement;
    const tag = (el?.tagName || '').toLowerCase();
    if (el && (tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable || el.closest?.('[contenteditable="true"]'))) return { ok: true, reason: 'typing' };
  }

  const videos = [...document.querySelectorAll('video')];
  if (!videos.length) return { ok: false, reason: 'no-video' };
  const video = videos.map(v => {
    const r = v.getBoundingClientRect();
    const visible = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    const center = Math.abs((r.top + r.height / 2) - innerHeight / 2);
    return { v, score: visible + (!v.paused ? 1000000 : 0) - center };
  }).sort((a, b) => b.score - a.score)[0].v;

  const duration = Number(video.duration);
  const time = Number(video.currentTime);
  if (!Number.isFinite(duration) || !Number.isFinite(time) || duration < 1) return { ok: false, reason: 'bad-duration' };

  const remaining = duration - time;
  const looped = state.lastTime > duration - 0.7 && time < 0.55;
  const atEnd = time > 0.5 && remaining <= threshold;
  const stuckEnd = video.paused && time > duration - 0.4;
  state.lastTime = time;

  if (!state.armed && !looped) return { ok: true, reason: 'not-armed', time, duration };
  if (!atEnd && !looped && !stuckEnd) return { ok: true, reason: 'watching', time, duration, remaining };
  if (now - state.lastAdvanceAt < 1500) return { ok: true, reason: 'cooldown' };

  if (delayMs && !state.pendingAt) {
    state.pendingAt = now + delayMs;
    return { ok: true, reason: 'delay-start' };
  }
  if (state.pendingAt && now < state.pendingAt) return { ok: true, reason: 'delay-wait' };

  state.pendingAt = 0;
  state.armed = false;
  state.lastAdvanceAt = now;

  function visible(el) {
    if (!el?.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }
  function click(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: options.smoothMode ? 'smooth' : 'instant' }); } catch (_) {}
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      el.dispatchEvent(new MouseEvent('click', opts));
      el.click?.();
      return true;
    } catch (_) { try { el.click?.(); return true; } catch (_) { return false; } }
  }
  function shortUrl(href) {
    try {
      const u = new URL(href, location.origin);
      const m = u.pathname.match(/^\/shorts\/([^/?#]+)/);
      return m ? `${location.origin}/shorts/${m[1]}` : '';
    } catch (_) { return ''; }
  }
  function currentId() {
    const m = location.pathname.match(/^\/shorts\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }
  function activeReel() {
    for (const selector of ['ytd-reel-video-renderer','ytd-shorts-video-renderer','ytd-reel-item-renderer','[data-shorts-video-id]','[is-active]']) {
      const el = video.closest(selector);
      if (el) return el;
    }
    return video.parentElement;
  }
  function nextUrl() {
    const current = currentId();
    const reel = activeReel();
    if (reel) {
      let node = reel.nextElementSibling;
      for (let i = 0; node && i < 10; i++, node = node.nextElementSibling) {
        for (const a of [...node.querySelectorAll?.('a[href*="/shorts/"]') || []]) {
          const url = shortUrl(a.getAttribute('href') || a.href);
          if (url && !url.endsWith(`/shorts/${current}`)) return url;
        }
      }
    }
    for (const a of [...document.querySelectorAll('a[href*="/shorts/"]')]) {
      const url = shortUrl(a.getAttribute('href') || a.href);
      if (url && !url.endsWith(`/shorts/${current}`)) return url;
    }
    return '';
  }

  const buttonSelectors = ['#navigation-button-down button','[id="navigation-button-down"] button','button[aria-label="Next video"]','button[aria-label="Next"]','button[title="Next"]','button[aria-label*="Next" i]','button[aria-label*="Down" i]'];
  for (const selector of buttonSelectors) {
    const btn = [...document.querySelectorAll(selector)].find(el => !el.disabled && visible(el));
    if (btn) { click(btn); return { ok: true, reason: 'clicked-button' }; }
  }

  const reel = activeReel();
  if (reel?.nextElementSibling) {
    try { reel.nextElementSibling.scrollIntoView({ block: 'center', inline: 'nearest', behavior: options.smoothMode ? 'smooth' : 'instant' }); } catch (_) {}
  }

  const url = nextUrl();
  if (url) return { ok: true, reason: 'navigate', navigateUrl: url };
  try { window.scrollBy({ top: Math.max(innerHeight * 0.95, 700), behavior: options.smoothMode ? 'smooth' : 'instant' }); } catch (_) {}
  return { ok: true, reason: 'scroll-fallback' };
}

ensureOffscreen();
