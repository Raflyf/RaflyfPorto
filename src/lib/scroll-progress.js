const subscribers = new Set();
let stopFn = null;
let lastState = { scrollY: 0, progress: 0 };

function start() {
  let scrollY = 0;
  let winH = 0;
  let bodyH = 0;
  let maxScroll = 1;
  let rafId = 0;
  let hasInteracted = false;

  const updateBounds = () => {
    if (!winH) winH = window.innerHeight || 1;
    if (!bodyH) bodyH = document.documentElement.scrollHeight;
    maxScroll = Math.max(1, bodyH - winH);
  };

  const emit = () => {
    rafId = 0;
    if (!hasInteracted) return;
    const progress = Math.min(1, Math.max(0, scrollY / maxScroll));
    lastState = { scrollY, progress };
    for (const fn of subscribers) fn(lastState);
  };

  const schedule = () => {
    if (!rafId) rafId = requestAnimationFrame(emit);
  };

  const onScroll = () => {
    hasInteracted = true;
    scrollY = window.scrollY || 0;
    if (!winH || !bodyH) updateBounds();
    schedule();
  };

  const onResize = () => {
    hasInteracted = true;
    winH = window.innerHeight || 1;
    bodyH = document.documentElement.scrollHeight;
    maxScroll = Math.max(1, bodyH - winH);
    schedule();
  };

  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver((entries) => {
        const h = entries[0]?.contentRect?.height;
        if (typeof h === 'number') {
          bodyH = h;
          if (winH) {
            maxScroll = Math.max(1, bodyH - winH);
          }
          if (hasInteracted) schedule();
        }
      })
    : null;
  if (ro && document.body) ro.observe(document.body);
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize, { passive: true });

  // Handle mid-page reload scroll restoration only when browser sits idle after initial paint.
  const checkRestoredScroll = () => {
    if (hasInteracted) return;
    const currentY = window.scrollY || 0;
    if (currentY > 0) {
      hasInteracted = true;
      scrollY = currentY;
      updateBounds();
      schedule();
    }
  };

  let restoreIdleId = 0;
  let restoreTimer = 0;
  if (typeof window.requestIdleCallback === 'function') {
    restoreIdleId = window.requestIdleCallback(checkRestoredScroll, { timeout: 600 });
  } else {
    restoreTimer = setTimeout(checkRestoredScroll, 400);
  }

  return () => {
    if (restoreIdleId && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(restoreIdleId);
    }
    if (restoreTimer) clearTimeout(restoreTimer);
    if (rafId) cancelAnimationFrame(rafId);
    ro?.disconnect();
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onResize);
  };
}

export function subscribeScrollProgress(callback) {
  if (typeof window === 'undefined') return () => {};
  if (!subscribers.size) stopFn = start();
  subscribers.add(callback);
  if (lastState.scrollY > 0) callback(lastState);
  return () => {
    subscribers.delete(callback);
    if (!subscribers.size) {
      stopFn?.();
      stopFn = null;
    }
  };
}
