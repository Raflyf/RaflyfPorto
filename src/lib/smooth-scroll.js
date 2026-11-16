let lenisInstance = null;
let lenisPromise = null;
let rafId = 0;

function startRaf() {
  if (rafId || !lenisInstance) return;
  const raf = (time) => {
    if (!lenisInstance) {
      rafId = 0;
      return;
    }
    if (!document.hidden) {
      lenisInstance.raf(time);
    }
    rafId = requestAnimationFrame(raf);
  };
  rafId = requestAnimationFrame(raf);
}

export async function ensureLenis() {
  if (typeof window === 'undefined') return null;
  if (lenisInstance) return lenisInstance;
  if (!lenisPromise) {
    lenisPromise = Promise.all([
      import('lenis'),
      import('lenis/dist/lenis.css'),
    ]).then(([mod]) => {
      const Lenis = mod.default || mod;
      if (!lenisInstance) {
        lenisInstance = new Lenis({
          duration: 1.2,
          easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
          orientation: 'vertical',
          gestureOrientation: 'vertical',
          smoothWheel: true,
          syncTouch: false,
          touchInertiaMultiplier: 1.0,
          wheelMultiplier: 1.15,
          respectReducedMotion: false,
        });
        window.__lenis = lenisInstance;
        startRaf();
      }
      return lenisInstance;
    }).catch(() => {
      lenisPromise = null;
      return null;
    });
  }
  return lenisPromise;
}

export function initLenisOnDemand() {
  if (typeof window === 'undefined') return () => {};
  const trigger = () => {
    window.removeEventListener('wheel', trigger);
    ensureLenis();
  };
  window.addEventListener('wheel', trigger, { passive: true, once: true });

  return () => {
    window.removeEventListener('wheel', trigger);
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (lenisInstance) {
      lenisInstance.destroy();
      lenisInstance = null;
    }
    lenisPromise = null;
    delete window.__lenis;
  };
}

export function smoothScrollTo(target, { duration = 1.2, offset = 0, immediate = false } = {}) {
  if (typeof window === 'undefined') return;
  if (lenisInstance) {
    lenisInstance.scrollTo(target, { duration, offset, immediate });
    return;
  }

  if (typeof target === 'number') {
    window.scrollTo({ top: target, behavior: immediate ? 'auto' : 'smooth' });
  } else if (target && typeof target.getBoundingClientRect === 'function') {
    const top = target.getBoundingClientRect().top + window.scrollY + offset;
    window.scrollTo({ top, behavior: immediate ? 'auto' : 'smooth' });
  }

  ensureLenis();
}
