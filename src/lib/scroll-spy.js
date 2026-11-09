export const SECTION_IDS = ['hero', 'about', 'skills', 'projects', 'certificates', 'timeline', 'lab', 'contact'];

const listeners = new Set();
let snapshot;
let stop;

function start() {
  let offsets = [], docHeight = 0, scrollY = 0, height = 0, width = 0, rafId = 0;

  const measure = () => {
    scrollY = window.scrollY || 0;
    height = window.innerHeight;
    width = window.innerWidth;
    offsets = SECTION_IDS.flatMap(id => {
      const el = document.getElementById(id);
      return el ? [{ id, top: el.getBoundingClientRect().top + scrollY }] : [];
    });
    docHeight = document.documentElement.scrollHeight;
  };

  const update = () => {
    const line = scrollY + height * 0.4;
    let activeSection = SECTION_IDS[0];
    for (const entry of offsets) {
      if (entry.top > line) break;
      activeSection = entry.id;
    }
    if (height + scrollY >= docHeight - 4) activeSection = SECTION_IDS.at(-1);
    snapshot = {
      activeSection, scrollY, width,
      percent: Math.min(100, Math.max(0, Math.round(scrollY / Math.max(1, docHeight - height) * 100))),
    };
  };

  const publish = () => {
    rafId = 0;
    update();
    for (const callback of listeners) callback(snapshot);
  };
  const schedule = () => {
    if (!rafId) rafId = window.requestAnimationFrame(publish);
  };
  const onScroll = () => {
    // Read before the animation frame's Lenis writes; both HUDs share this sample.
    scrollY = window.scrollY || 0;
    schedule();
  };
  const onResize = () => {
    measure();
    schedule();
  };

  measure();
  update();
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
  observer?.observe(document.body);
  // Section sizes can change while the total document height stays the same.
  // ponytail: sections mount synchronously; rebind observers if sections become lazy-mounted.
  for (const id of SECTION_IDS) {
    const el = document.getElementById(id);
    if (el) observer?.observe(el);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize, { passive: true });
  document.fonts?.addEventListener('loadingdone', onResize);

  return () => {
    window.cancelAnimationFrame(rafId);
    observer?.disconnect();
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onResize);
    document.fonts?.removeEventListener('loadingdone', onResize);
    snapshot = undefined;
  };
}

export function subscribeScrollSpy(callback) {
  if (!listeners.size) stop = start();
  listeners.add(callback);
  callback(snapshot);
  return () => {
    listeners.delete(callback);
    if (!listeners.size) {
      stop?.();
      stop = undefined;
    }
  };
}
