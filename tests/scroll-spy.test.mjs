import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const file = new URL('../src/lib/scroll-spy.js', import.meta.url);
const ids = ['hero', 'about', 'skills', 'projects', 'certificates', 'timeline', 'lab', 'contact'];

function setup({ observers = true } = {}) {
  assert.ok(existsSync(file), 'shared scroll-spy owner is missing');
  const listeners = new Map(), fontListeners = new Map(), frames = new Map();
  const stats = { scrollReads: 0, rectReads: 0, heightReads: 0, frameReads: 0 };
  let scroll = 0, width = 1440, height = 900, docHeight = 8300, framePhase = false, nextId = 0;
  const positions = Object.fromEntries(ids.map((id, i) => [id, i * 1000]));
  const read = key => { stats[key]++; if (framePhase) stats.frameReads++; };
  const nodes = Object.fromEntries(ids.map(id => [id, { id, getBoundingClientRect() { read('rectReads'); return { top: positions[id] - scroll }; } }]));
  const body = {};
  const window = {
    get scrollY() { read('scrollReads'); return scroll; },
    get innerWidth() { if (framePhase) stats.frameReads++; return width; },
    get innerHeight() { if (framePhase) stats.frameReads++; return height; },
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    requestAnimationFrame(callback) { frames.set(++nextId, callback); return nextId; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  const document = {
    body,
    getElementById: id => nodes[id] || null,
    documentElement: { get scrollHeight() { read('heightReads'); return docHeight; } },
    fonts: {
      addEventListener(name, callback) { fontListeners.set(name, callback); },
      removeEventListener(name, callback) { if (fontListeners.get(name) === callback) fontListeners.delete(name); },
    },
  };
  const resizeObservers = [];
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = new Set(); resizeObservers.push(this); }
    observe(node) { this.targets.add(node); }
    disconnect() { this.targets.clear(); }
  }
  const context = { window, document, Set, ResizeObserver: observers ? ResizeObserver : undefined };
  const { subscribeScrollSpy } = vm.runInNewContext(readFileSync(file, 'utf8').replace(/\bexport /g, '') + '\n({ subscribeScrollSpy });', context);
  return {
    subscribe: subscribeScrollSpy, stats, frames, listeners, fontListeners, resizeObservers, nodes, positions,
    scrollTo(y) { scroll = y; for (const callback of listeners.get('scroll') || []) callback(); },
    resize(w, h) { width = w; height = h; for (const callback of listeners.get('resize') || []) callback(); },
    setHeight(value) { docHeight = value; },
    flush() { framePhase = true; try { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } } finally { framePhase = false; } },
  };
}

test('two scroll consumers share one listener, one geometry pass and one RAF', () => {
  const env = setup(), nav = [], side = [];
  const offNav = env.subscribe(value => nav.push(value));
  const offSide = env.subscribe(value => side.push(value));
  assert.equal(env.listeners.get('scroll').size, 1);
  assert.equal(env.resizeObservers.length, 1);
  assert.equal(env.stats.rectReads, 8);
  assert.equal(env.stats.heightReads, 1);
  const reads = env.stats.scrollReads;
  env.scrollTo(900);
  env.scrollTo(1700);
  assert.equal(env.frames.size, 1);
  assert.equal(env.stats.scrollReads - reads, 2);
  env.flush();
  assert.equal(nav.at(-1).activeSection, 'skills');
  assert.equal(side.at(-1).activeSection, 'skills');
  assert.equal(side.at(-1).percent, 23);
  assert.equal(env.stats.rectReads, 8, 'scroll must reuse cached section positions');
  assert.equal(env.stats.frameReads, 0, 'RAF must not force synchronous geometry reads');
  offNav(); offSide();
});

test('40-percent threshold, bottom tolerance and clamped percentages retain navigation behavior', () => {
  const env = setup(); let value;
  const off = env.subscribe(next => { value = next; });
  for (const [y, active, percent] of [[0, 'hero', 0], [639, 'hero', 9], [640, 'about', 9], [1640, 'skills', 22], [2639, 'skills', 36], [2640, 'projects', 36], [-30, 'hero', 0], [7396, 'contact', 100], [9000, 'contact', 100]]) {
    env.scrollTo(y); env.flush();
    assert.equal(value.activeSection, active, `scroll ${y}`);
    assert.equal(value.percent, percent, `scroll ${y}`);
    assert.equal(value.scrollY, y);
  }
  off();
});

test('resize, section size changes with unchanged total height, and font loads invalidate offsets', () => {
  const env = setup(); let value;
  const off = env.subscribe(next => { value = next; });
  assert.ok(env.resizeObservers[0].targets.has(env.nodes.projects));
  env.scrollTo(1700); env.flush();
  env.positions.skills = 2300;
  env.resizeObservers[0].callback([{ target: env.nodes.about }]);
  env.flush();
  assert.equal(value.activeSection, 'about', 'position cache must not depend on total body height alone');
  env.positions.skills = 2000;
  env.fontListeners.get('loadingdone')(); env.flush();
  assert.equal(value.activeSection, 'skills');
  env.resize(390, 500); env.flush();
  assert.equal(value.width, 390);
  assert.equal(value.activeSection, 'about');
  env.setHeight(4000);
  env.resizeObservers[0].callback([{ target: env.nodes.contact }]); env.flush();
  assert.equal(value.percent, 49);
  off();
});

test('last unsubscribe cancels work and remount discards old geometry', () => {
  const env = setup(); let calls = 0;
  const offOne = env.subscribe(() => calls++);
  const offTwo = env.subscribe(() => calls++);
  env.scrollTo(900);
  offOne();
  assert.equal(env.listeners.get('scroll').size, 1);
  offTwo();
  assert.equal(env.frames.size, 0);
  assert.equal(env.listeners.get('scroll').size, 0);
  assert.equal(env.listeners.get('resize').size, 0);
  assert.equal(env.resizeObservers[0].targets.size, 0);
  assert.equal(env.fontListeners.size, 0);
  env.flush();
  assert.equal(calls, 2);
  env.positions.about = 1600;
  let value; const off = env.subscribe(next => { value = next; });
  assert.equal(value.activeSection, 'hero');
  assert.equal(env.listeners.get('scroll').size, 1);
  off();
});

test('no ResizeObserver still supports scroll and viewport changes; no import-time DOM access', () => {
  assert.ok(existsSync(file), 'shared scroll-spy owner is missing');
  assert.doesNotThrow(() => vm.runInNewContext(readFileSync(file, 'utf8').replace(/\bexport /g, ''), {}));
  const env = setup({ observers: false }); let value;
  const off = env.subscribe(next => { value = next; });
  env.scrollTo(900); env.flush();
  assert.equal(value.activeSection, 'about');
  env.resize(1280, 1200); env.flush();
  assert.equal(value.width, 1280);
  assert.equal(env.stats.frameReads, 0);
  off();
});
