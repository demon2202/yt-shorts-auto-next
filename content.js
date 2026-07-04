(() => {
  'use strict';

  const DEFAULTS = {
    enabled: true,
    delayMs: 80,
    endThreshold: 1.15,
    showMiniPanel: true,
    pauseWhenInteracting: true,
    skipMutedAds: true,
    aggressiveBackground: true,
    smoothMode: true
  };

  let settings = { ...DEFAULTS };
  let currentVideo = null;
  let lastPath = '';
  let lastTime = 0;
  let armed = true;
  let advancing = false;
  let lastAdvanceAt = 0;
  let advanceTimer = null;
  let panel = null;
  let mutationQueued = false;

  const clamp = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0));
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  function isShortsPage() { return /^\/shorts\//.test(location.pathname); }
  function currentShortId() { return (location.pathname.match(/^\/shorts\/([^/?#]+)/) || [,''])[1]; }
  function isTyping() {
    const el = document.activeElement;
    const tag = (el?.tagName || '').toLowerCase();
    return !!el && (tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable || !!el.closest?.('[contenteditable="true"]'));
  }
  function visibleArea(el) {
    if (!el?.getBoundingClientRect) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
  }
  function isVisible(el) {
    if (!el?.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }
  function findActiveVideo() {
    const videos = [...document.querySelectorAll('video')];
    if (!videos.length) return null;
    return videos.map(v => {
      const r = v.getBoundingClientRect();
      const center = Math.abs((r.top + r.height / 2) - innerHeight / 2);
      return { v, score: visibleArea(v) + (!v.paused ? 1000000 : 0) - center };
    }).sort((a, b) => b.score - a.score)[0].v;
  }
  function activeReel() {
    const video = currentVideo || findActiveVideo();
    if (!video) return null;
    for (const selector of ['ytd-reel-video-renderer','ytd-shorts-video-renderer','ytd-reel-item-renderer','[data-shorts-video-id]','[is-active]']) {
      const el = video.closest(selector);
      if (el) return el;
    }
    return video.parentElement;
  }
  function normalizeShortUrl(href) {
    try {
      const u = new URL(href, location.origin);
      const m = u.pathname.match(/^\/shorts\/([^/?#]+)/);
      return m ? `${location.origin}/shorts/${m[1]}` : '';
    } catch (_) { return ''; }
  }
  function findNextShortUrl() {
    const current = currentShortId();
    const reel = activeReel();
    if (reel) {
      let node = reel.nextElementSibling;
      for (let i = 0; node && i < 10; i++, node = node.nextElementSibling) {
        // Ensure we are only looking inside actual reel containers
        const isReel = ['ytd-reel-video-renderer','ytd-shorts-video-renderer','ytd-reel-item-renderer','[data-shorts-video-id]','[is-active]'].some(s => node.matches(s));
        if (!isReel) continue;

        for (const a of [...node.querySelectorAll?.('a[href*="/shorts/"]') || []]) {
          const url = normalizeShortUrl(a.getAttribute('href') || a.href);
          if (url && !url.endsWith(`/shorts/${current}`)) return url;
        }
      }
    }
    // Extreme fallback: search the whole page but try to find one that looks like it's in the feed
    const allShorts = [...document.querySelectorAll('a[href*="/shorts/"]')];
    for (const a of allShorts) {
      const url = normalizeShortUrl(a.getAttribute('href') || a.href);
      if (url && !url.endsWith(`/shorts/${current}`)) {
        // Avoid "related" or "suggested" links if possible
        if (!a.closest?.('[aria-label="Related"]') && !a.closest?.('[aria-label="Suggested"]')) {
          return url;
        }
      }
    }
    return '';
  }

  function detach(video) {
    if (!video) return;
    video.removeEventListener('ended', onEnded, true);
    video.removeEventListener('timeupdate', onTimeUpdate, true);
    video.removeEventListener('durationchange', arm, true);
    video.removeEventListener('loadedmetadata', arm, true);
    video.removeEventListener('play', arm, true);
    video.removeEventListener('seeked', onSeeked, true);
  }
  function attach(video) {
    if (!video || video === currentVideo) return;
    detach(currentVideo);
    currentVideo = video;
    lastTime = video.currentTime || 0;
    armed = true;
    advancing = false;
    video.addEventListener('ended', onEnded, true);
    video.addEventListener('timeupdate', onTimeUpdate, true);
    video.addEventListener('durationchange', arm, true);
    video.addEventListener('loadedmetadata', arm, true);
    video.addEventListener('play', arm, true);
    video.addEventListener('seeked', onSeeked, true);
    setStatus('Watching');
  }
  function arm() { armed = true; advancing = false; setStatus(settings.enabled ? 'Watching' : 'Disabled'); }
  function onSeeked() { if (currentVideo && Number.isFinite(currentVideo.duration) && currentVideo.currentTime < currentVideo.duration - 1.5) arm(); }
  function onEnded() { scheduleAdvance('ended'); }
  function onTimeUpdate() { tick('video'); }

  function tick(source = 'tick') {
    if (!settings.enabled || !isShortsPage()) return;
    const v = currentVideo || findActiveVideo();
    if (!v) return;
    if (v !== currentVideo) attach(v);
    const duration = Number(v.duration), time = Number(v.currentTime);
    if (!Number.isFinite(duration) || !Number.isFinite(time) || duration < 1) return;
    const remaining = duration - time;
    const threshold = clamp(settings.endThreshold, 0.25, 3);
    if (armed && time > 0.5 && remaining <= threshold) {
      console.log(`[SAN] Near end threshold (${threshold}s), remaining: ${remaining.toFixed(2)}s`);
      scheduleAdvance(`near end`);
    }
    if (lastTime > duration - 0.7 && time < 0.55) {
      console.log(`[SAN] Loop detected`);
      scheduleAdvance('loop');
    }
    if (armed && v.paused && time > duration - 0.4) {
      console.log(`[SAN] Paused at end`);
      scheduleAdvance('paused end');
    }
    lastTime = time;
  }

  function scheduleAdvance(reason) {
    if (!settings.enabled || !isShortsPage()) return;
    if (settings.pauseWhenInteracting && isTyping()) { setStatus('Paused while typing'); return; }
    const now = Date.now();
    if (advancing || now - lastAdvanceAt < 1200) return;
    armed = false;
    advancing = true;
    clearTimeout(advanceTimer);
    console.log(`[SAN] Scheduling advance. Reason: ${reason}`);
    setStatus(`Moving next`);
    advanceTimer = setTimeout(() => forceNext(reason), clamp(settings.delayMs, 0, 2000));
  }

  function click(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: settings.smoothMode ? 'smooth' : 'instant' }); } catch (_) {}
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
  function findNextButton() {
    const selectors = ['#navigation-button-down button','[id="navigation-button-down"] button','button[aria-label="Next video"]','button[aria-label="Next"]','button[title="Next"]','button[aria-label*="Next" i]','button[aria-label*="Down" i]'];
    for (const selector of selectors) {
      const found = [...document.querySelectorAll(selector)].find(el => !el.disabled && isVisible(el));
      if (found) return found;
    }
    return null;
  }
  function scrollFeed() {
    const reel = activeReel();
    if (reel?.nextElementSibling) {
      try { reel.nextElementSibling.scrollIntoView({ block: 'center', inline: 'nearest', behavior: settings.smoothMode ? 'smooth' : 'instant' }); return; } catch (_) {}
    }
    try { window.scrollBy({ top: Math.max(innerHeight * 0.95, 700), behavior: settings.smoothMode ? 'smooth' : 'instant' }); } catch (_) {}
  }
  async function moved(oldPath) {
    for (let i = 0; i < 5; i++) {
      await wait(180);
      if (location.pathname !== oldPath) return true;
      const v = findActiveVideo();
      if (v && v !== currentVideo) return true;
    }
    return false;
  }
  async function forceNext() {
    if (!settings.enabled || !isShortsPage()) return;
    const oldPath = location.pathname;
    lastAdvanceAt = Date.now();
    console.log(`[SAN] forceNext triggered`);

    // 1. Native Button
    const btn = findNextButton();
    if (btn) {
      console.log(`[SAN] Clicking next button:`, btn);
      click(btn);
      if (await moved(oldPath)) {
        console.log(`[SAN] Moved via button`);
        return afterMove();
      }
    }

    // 2. Keyboard ArrowDown
    console.log(`[SAN] Trying Keyboard ArrowDown`);
    window.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 40, key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { keyCode: 40, key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
    if (await moved(oldPath)) {
      console.log(`[SAN] Moved via keyboard`);
      return afterMove();
    }

    // 3. Scroll Feed
    console.log(`[SAN] Trying scrollFeed`);
    scrollFeed();
    if (await moved(oldPath)) {
      console.log(`[SAN] Moved via scroll`);
      return afterMove();
    }

    // 4. URL Navigation (Last Resort - Refined)
    const url = findNextShortUrl();
    if (url) {
      console.log(`[SAN] Navigating to URL: ${url}`);
      location.assign(url);
      return;
    }

    console.log(`[SAN] All methods failed, final scroll attempt`);
    scrollFeed();
    await wait(500);
    afterMove();
  }
  function afterMove() {
    clearTimeout(advanceTimer);
    detach(currentVideo);
    currentVideo = null;
    lastTime = 0;
    armed = true;
    advancing = false;
    setStatus('Moved');
    setTimeout(refresh, 250);
  }

  function createPanel() {
    if (panel) return panel;
    const style = document.createElement('style');
    style.textContent = `
      #shorts-auto-next-panel{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:188px;box-sizing:border-box;padding:10px;border:1px solid #3a3a3a;border-radius:12px;background:#050505;color:#fff;font-family:Arial,Helvetica,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.42)}
      #shorts-auto-next-panel .san-title{font-size:12px;font-weight:700;margin-bottom:7px;color:#fff}
      #shorts-auto-next-panel .san-row{display:grid;grid-template-columns:1fr 1fr;gap:6px}
      #shorts-auto-next-panel button{border:1px solid #666;border-radius:8px;background:#111;color:#fff;padding:7px 8px;cursor:pointer;font-size:11px;font-weight:700}
      #shorts-auto-next-panel button:hover{background:#222}
      #shorts-auto-next-panel .san-toggle{grid-column:1 / -1}
      #shorts-auto-next-panel .san-status{margin-top:7px;font-size:10.5px;line-height:1.25;color:#bdbdbd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    `;
    document.documentElement.appendChild(style);
    panel = document.createElement('div');
    panel.id = 'shorts-auto-next-panel';
    panel.innerHTML = `<div class="san-title">Shorts Auto Next</div><div class="san-row"><button class="san-toggle" type="button"></button><button class="san-now" type="button">Next</button><button class="san-debug" type="button">Debug</button><button class="san-hide" type="button">Hide</button></div><div class="san-status">Starting</div>`;
    document.documentElement.appendChild(panel);
    panel.querySelector('.san-toggle').addEventListener('click', async () => { settings.enabled = !settings.enabled; await chrome.storage.sync.set({ enabled: settings.enabled }); renderPanel(); setStatus(settings.enabled ? 'Enabled' : 'Disabled'); });
    panel.querySelector('.san-now').addEventListener('click', () => { armed = true; advancing = false; forceNext(); });
    panel.querySelector('.san-debug').addEventListener('click', () => {
      const v = currentVideo || findActiveVideo();
      const debug = `Enabled: ${settings.enabled}\nPath: ${location.pathname}\nVideo: ${v ? 'Found' : 'None'}\nTime: ${v ? v.currentTime.toFixed(2) : 'N/A'}/${v ? v.duration.toFixed(2) : 'N/A'}\nArmed: ${armed}\nAdvancing: ${advancing}`;
      alert(debug);
      console.log('[SAN Debug]', debug);
    });
    panel.querySelector('.san-hide').addEventListener('click', async () => { settings.showMiniPanel = false; await chrome.storage.sync.set({ showMiniPanel: false }); updatePanel(); });
    renderPanel();
    return panel;
  }
  function renderPanel() { if (panel) panel.querySelector('.san-toggle').textContent = settings.enabled ? 'Auto: ON' : 'Auto: OFF'; }
  function setStatus(text) { const el = panel?.querySelector('.san-status'); if (el) el.textContent = text; }
  function updatePanel() { if (isShortsPage() && settings.showMiniPanel) { createPanel(); panel.style.display = 'block'; renderPanel(); } else if (panel) panel.style.display = 'none'; }

  function refresh() {
    updatePanel();
    if (!isShortsPage()) { detach(currentVideo); currentVideo = null; clearTimeout(advanceTimer); return; }
    if (lastPath !== location.pathname) { lastPath = location.pathname; detach(currentVideo); currentVideo = null; lastTime = 0; armed = true; advancing = false; }
    const v = findActiveVideo();
    if (v) attach(v);
    tick('refresh');
  }
  async function loadSettings() { settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) }; settings.delayMs = clamp(settings.delayMs, 0, 2000); settings.endThreshold = clamp(settings.endThreshold, 0.25, 3); refresh(); }

  chrome.storage.onChanged.addListener((changes, area) => { if (area !== 'sync') return; for (const [k,c] of Object.entries(changes)) settings[k] = c.newValue; renderPanel(); refresh(); });

  function hookNav() {
    const fire = () => setTimeout(refresh, 100);
    const push = history.pushState, replace = history.replaceState;
    history.pushState = function(...args){ const r = push.apply(this,args); fire(); return r; };
    history.replaceState = function(...args){ const r = replace.apply(this,args); fire(); return r; };
    window.addEventListener('popstate', fire, true);
    window.addEventListener('yt-navigate-finish', fire, true);
    window.addEventListener('yt-page-data-updated', fire, true);
    window.addEventListener('pageshow', fire, true);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); else tick('hidden'); }, true);
  }
  function startWatchers() {
    new MutationObserver(() => {
      if (mutationQueued || !isShortsPage()) return;
      mutationQueued = true;
      requestAnimationFrame(() => { mutationQueued = false; const v = findActiveVideo(); if (v && v !== currentVideo) attach(v); });
    }).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(() => { if (!document.hidden) tick('interval'); }, 650);
    setInterval(() => { if (!document.hidden) refresh(); }, 2200);
  }

  loadSettings();
  hookNav();
  startWatchers();
})();
