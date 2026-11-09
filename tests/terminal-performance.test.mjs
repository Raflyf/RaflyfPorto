import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { transformSync } from 'rolldown/utils';
import { createHash } from 'node:crypto';
import { createPortal } from 'react-dom';
import * as icons from 'lucide-react';
import { cn } from '../src/lib/utils.js';
import { PROJECTS_DATA, CERTIFICATES_DATA, DEVELOPER_PROFILE } from '../src/data.js';

const source = readFileSync(new URL('../src/components/terminal/TerminalAI.jsx', import.meta.url), 'utf8');
// Execute production declarations without app imports, effects, network, or a build.
const transformed = transformSync('TerminalAI.jsx', source
  .replace(/^import[^\n]*\r?\n/gm, '')
  .replace('export default function TerminalAI', 'function TerminalAI'), {
  jsx: { runtime: 'classic' },
});
assert.deepEqual(transformed.errors, []);
const load = (projects = PROJECTS_DATA, overrides = {}) => runInNewContext(`${transformed.code}\n({
  commands: COMMAND_REGISTRY,
  Markdown: typeof MessageMarkdown === 'undefined' ? null : MessageMarkdown,
  Terminal: TerminalAI,
});`, { React, ReactMarkdown, remarkGfm, ...icons, cn, createPortal,
  PROJECTS_DATA: projects, CERTIFICATES_DATA, DEVELOPER_PROFILE, ...overrides });

// A removed mapping would restore the stale hand-written catalog and fail these fixtures.
test('/projects reflects source data order, descriptions, and newly appended entries', () => {
  const projects = [
    { title: 'Alpha', description: 'Local first.' },
    { title: 'Beta', description: 'Second project.' },
  ];
  const { commands } = load(projects);
  assert.deepEqual(Array.from(commands.projects()), [
    '--- OPEN SOURCE PROJECTS & RESEARCH ---',
    '1. Alpha - Local first.',
    '2. Beta - Second project.',
    'Cek selengkapnya di GitHub: https://github.com/Raflyf',
  ]);
  projects.push({ title: 'Gamma', description: 'Newly listed.' });
  assert.equal(commands.projects()[3], '3. Gamma - Newly listed.');
});

test('/projects includes every current project exactly once without hardcoded omissions', () => {
  const lines = Array.from(load().commands.projects());
  assert.equal(lines.length, PROJECTS_DATA.length + 2);
  for (const project of PROJECTS_DATA) {
    assert.equal(lines.filter(line => line.includes(`${project.title} - ${project.description}`)).length, 1);
  }
});

// Node verifies leaf output and memo contract; browser render counts remain a separate check.
test('Markdown leaf uses default content-sensitive memoization without an extra DOM wrapper', () => {
  const { Markdown } = load();
  assert.ok(Markdown, 'MessageMarkdown leaf missing');
  assert.equal(Markdown.$$typeof, Symbol.for('react.memo'));
  assert.equal(Markdown.compare, null);
  assert.equal(renderToStaticMarkup(React.createElement(Markdown, { content: '**First** message' })), '<p><strong>First</strong> message</p>');
  assert.equal(renderToStaticMarkup(React.createElement(Markdown, { content: '**Next** message' })), '<p><strong>Next</strong> message</p>');
});

test('memoized Markdown keeps GFM rendering and escapes untrusted HTML', () => {
  const { Markdown } = load();
  assert.ok(Markdown, 'MessageMarkdown leaf missing');
  const render = content => renderToStaticMarkup(React.createElement(Markdown, { content }));
  const table = render('| Name | Value |\n| --- | --- |\n| one | two |');
  assert.match(table, /<table>/);
  assert.match(table, /<td>one<\/td>/);
  assert.match(table, /<td>two<\/td>/);
  const untrusted = render('<script>alert(1)</script>');
  assert.doesNotMatch(untrusted, /<script>/);
  assert.match(untrusted, /&lt;script&gt;/);
});

function harness(messages) {
  const cells = [];
  const storage = new Map();
  const downloads = [];
  const copied = [];
  let cursor = 0;
  let commits = [];
  let clock = '12.00';
  const state = { messages, input: '', effort: 'auto', isLoading: false, historyList: [], isTerminalPopupOpen: false };
  const setters = Object.fromEntries(Object.keys(state).map(key => [
    `set${key[0].toUpperCase()}${key.slice(1)}`,
    value => { state[key] = typeof value === 'function' ? value(state[key]) : value; },
  ]));
  const useState = initial => {
    const index = cursor++;
    if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
    return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value; }];
  };
  const useRef = initial => {
    const index = cursor++;
    return cells[index] ??= { current: initial };
  };
  const useMemo = (calculate, deps) => {
    const index = cursor++;
    if (!cells[index] || deps.some((dep, i) => !Object.is(dep, cells[index].deps[i]))) {
      cells[index] = { deps, value: calculate() };
    }
    return cells[index].value;
  };
  const useEffect = () => { cursor++; };
  const useLayoutEffect = callback => { cursor++; commits.push(callback); };
  const document = {
    body: { appendChild() {}, removeChild() {}, style: {} },
    createElement: () => ({ click() {} }),
  };
  const { Terminal } = load(PROJECTS_DATA, {
    React: { ...React, useState, useRef, useMemo, useLayoutEffect },
    useState, useRef, useEffect, useMemo, useLayoutEffect,
    useTerminal: () => ({ ...state, ...setters,
      getCurrentTime: () => clock,
      initialMsg: { role: 'system', content: 'Welcome.', time: clock },
    }),
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    document, window: {}, Blob,
    URL: { createObjectURL: blob => { downloads.push(blob); return 'blob:offline'; } },
    navigator: { clipboard: { writeText: text => { copied.push(text); } } },
    createPortal: children => ({ type: 'test-portal', props: { children } }),
    setTimeout: () => 1, clearTimeout() {},
    fetch: () => assert.fail('Network forbidden in terminal tests'),
  });
  return { state, storage, downloads, copied, setClock: value => { clock = value; }, render() {
    cursor = 0;
    commits = [];
    const tree = Terminal();
    commits.forEach(callback => callback());
    return tree;
  } };
}

function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) { const found = find(child, predicate); if (found) return found; }
    return null;
  }
  return predicate(node) ? node : find(node.props?.children, predicate);
}
const transcript = tree => find(tree, node => node.props?.className === 'flex-1 overflow-y-auto overscroll-contain no-scrollbar p-3 sm:p-4 space-y-3 scroll-smooth bg-transparent');
const rows = tree => transcript(tree).props.children[0];
const html = tree => renderToStaticMarkup(React.createElement(React.Fragment, null, rows(tree)));
const fixture = () => [
  { role: 'system', content: 'Welcome.', time: '12.00' },
  { role: 'user', content: 'Question', time: '12.01', attachments: [
    { name: 'image.png', type: 'image/png', data: 'data:image/png;base64,AA==', isImage: true },
    { name: 'note.txt', type: 'text/plain', data: 'Attachment text' },
  ] },
  { role: 'ai', content: 'Static result.', time: '12.02', isStatic: true },
  { id: 4, role: 'ai', content: '| Name | Value |\n| --- | --- |\n| one | two |', time: '12.03',
    isTyping: true, steps: [{ tool: 'web_search', label: 'Web', sources: ['local fixture'], sourcesCount: 1 }] },
];

test('input, loading and popup changes reuse existing transcript nodes', () => {
  const messages = fixture();
  let mapped = 0;
  Object.defineProperty(messages, 'map', { value(callback) { mapped++; return Array.prototype.map.call(this, callback); } });
  const app = harness(messages);
  const initial = rows(app.render());
  for (const update of [{ input: 'typing' }, { isLoading: true }, { isTerminalPopupOpen: true }, { isTerminalPopupOpen: false }]) {
    Object.assign(app.state, update);
    assert.strictEqual(rows(app.render()), initial);
  }
  assert.equal(mapped, 1, 'unchanged messages must not be mapped for unrelated renders');
});

test('transcript DOM matches baseline including attachments, GFM, source badges and typing caret', () => {
  const digest = createHash('sha256').update(html(harness(fixture()).render())).digest('hex');
  assert.equal(digest, 'af68c989cacdddf7c7670966d947d2e7d6fa0c86d8195b8ee9cdab52e8c80f92');
});

test('message content, effort fallback and typing completion remain live', () => {
  const app = harness(fixture());
  const before = rows(app.render());
  app.state.messages = app.state.messages.map(message => message.id === 4 ? { ...message, content: 'Finished answer.', isTyping: false } : message);
  app.state.effort = 'high';
  const tree = app.render();
  assert.notStrictEqual(rows(tree), before);
  assert.match(html(tree), /Finished answer\./);
  assert.match(html(tree), /\[Effort: high\]/);
  assert.doesNotMatch(html(tree), /inline-block w-2 h-4 bg-cyan-400 animate-pulse/);
});

test('missing message timestamp still updates when a later render crosses the minute', () => {
  const app = harness([{ role: 'ai', content: 'Legacy message' }]);
  assert.match(html(app.render()), /12\.00/);
  app.setClock('12.01');
  app.state.input = 'changed';
  assert.match(html(app.render()), /12\.01/);
});

test('previously rendered rollback action reads current messages and restores current attachments', () => {
  const app = harness(fixture());
  const initial = app.render();
  const rollback = find(rows(initial), node => node.props?.title === 'Rollback percakapan ke sebelum pesan ini').props.onClick;
  app.state.messages = [
    { role: 'system', content: 'New context', time: '13.00' },
    { role: 'user', content: 'Latest question', time: '13.00', attachments: [{ name: 'latest.txt', type: 'text/plain', data: 'Latest bytes' }] },
  ];
  app.setClock('13.00');
  app.render();
  rollback();
  assert.equal(app.state.input, 'Latest question');
  assert.deepEqual(Array.from(app.state.messages, message => message.content), ['New context']);
  assert.ok(find(app.render(), node => node.props?.['aria-label'] === 'Hapus lampiran latest.txt'));
});

test('cached rollback uses latest initial message after input-only context updates', () => {
  const app = harness([{ role: 'user', content: 'Question', time: '12.00' }]);
  const initial = app.render();
  const rollback = find(rows(initial), node => node.props?.title === 'Rollback percakapan ke sebelum pesan ini').props.onClick;
  app.setClock('13.00');
  app.state.input = 'draft';
  const current = app.render();
  assert.strictEqual(rows(current), rows(initial));
  rollback();
  assert.equal(app.state.messages[0].time, '13.00');
});

test('copy and download use latest message text after transcript updates', async () => {
  const app = harness([{ id: 1, role: 'ai', content: 'Old answer', time: '12.00' }]);
  app.render();
  app.state.messages = [{ id: 1, role: 'ai', content: 'Current answer', time: '12.00' }];
  const current = rows(app.render());
  const button = label => find(current, node => node.type === 'button' && find(node.props.children, child => child.type === 'span' && child.props.children === label));
  button('Salin').props.onClick();
  button('Unduh .md').props.onClick();
  assert.deepEqual(app.copied, ['Current answer']);
  assert.equal(await app.downloads[0].text(), 'Current answer');
});
