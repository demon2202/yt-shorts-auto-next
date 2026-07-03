let intervalMs = 1200;
async function tick() {
  try { await chrome.runtime.sendMessage({ type: 'SAN_BACKGROUND_TICK', at: Date.now() }); } catch (_) {}
}
setInterval(tick, intervalMs);
tick();
