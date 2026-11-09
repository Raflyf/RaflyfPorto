import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('homepage does not eagerly import dashboard chart code', () => {
  const html = read('dist/index.html');
  const initial = [...html.matchAll(/(?:src|href)="\/(assets\/[^" ]+\.js)"/g)].map(match => match[1]);
  const seen = new Set();
  function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const code = read(`dist/${file}`);
    assert.ok(!file.includes('vendor-charts'), `chart chunk loaded by ${file}`);
    assert.doesNotMatch(code, /Chart\.js v\d/, `chart code loaded by ${file}`);
    for (const match of code.matchAll(/(?:from\s*|import\s*)["'`]\.\/([^"'`]+\.js)["'`]/g)) visit(`assets/${match[1]}`);
  }
  initial.forEach(visit);
  assert.ok(seen.size > 0);
  assert.ok(readdirSync(new URL('../dist/assets', import.meta.url)).some(name => name.startsWith('Dashboard-')));
});

test('App does not subscribe to per-keystroke terminal state', () => {
  const app = read('src/App.jsx').split('export default function App()')[1];
  assert.ok(app);
  assert.doesNotMatch(app, /useTerminal\(\)/);
  assert.match(app, /<TerminalLauncher t=\{t\}/);
});

for (const file of ['src/stitch-ui/components/StitchNav.jsx', 'src/components/ui/scroll-storyline.jsx']) {
  test(`${file}: scroll RAF reuses event measurements and cancels on teardown`, () => {
    const source = read(file);
    const effect = source.slice(source.lastIndexOf('useEffect(() => {', source.indexOf('let cachedOffsets')), source.indexOf('}, []);', source.indexOf('let cachedOffsets')));
    const pending = new Map();
    const listeners = new Map();
    let id = 0, frameReads = 0, phase = 'event', scroll = 500;
    const window = {
      get scrollY() { if (phase === 'frame') frameReads++; return scroll; },
      get innerHeight() { if (phase === 'frame') frameReads++; return 900; },
      get innerWidth() { if (phase === 'frame') frameReads++; return 1440; },
      requestAnimationFrame(callback) { pending.set(++id, callback); return id; },
      cancelAnimationFrame(key) { pending.delete(key); },
      addEventListener(name, callback) { listeners.set(name, callback); },
      removeEventListener(name) { listeners.delete(name); },
    };
    let active = 'hero', percent = 0;
    const context = {
      window, requestAnimationFrame: window.requestAnimationFrame, cancelAnimationFrame: window.cancelAnimationFrame,
      document: { getElementById: id => ({ getBoundingClientRect: () => ({ top: (id === 'hero' ? 0 : 600) - scroll }) }), documentElement: { scrollHeight: 5000 }, body: {} },
      NAV_ITEMS: [{ id: 'about' }], SECTION_IDS: ['hero', 'about'],
      setActiveSection(value) { active = typeof value === 'function' ? value(active) : value; },
      setPercent(value) { percent = value; },
      useEffect(callback) { context.cleanup = callback(); },
    };
    vm.runInNewContext(effect + '});', context);
    scroll = 900;
    listeners.get('scroll')();
    phase = 'frame';
    for (const [key, callback] of [...pending]) { pending.delete(key); callback(); }
    assert.equal(active, 'about');
    assert.equal(frameReads, 0, 'RAF must not force layout by rereading scroll/viewport');
    phase = 'event';
    listeners.get('scroll')();
    context.cleanup();
    assert.equal(pending.size, 0, 'pending RAF must be canceled');
    assert.equal(listeners.size, 0);
    if (file.includes('storyline')) assert.equal(percent, 22);
  });
}
