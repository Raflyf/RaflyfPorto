import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';

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
