import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { transformSync } from 'rolldown/utils';
import { PROJECTS_DATA, CERTIFICATES_DATA, DEVELOPER_PROFILE } from '../src/data.js';

const source = readFileSync(new URL('../src/components/terminal/TerminalAI.jsx', import.meta.url), 'utf8');
// Execute production declarations without app imports, effects, network, or a build.
const transformed = transformSync('TerminalAI.jsx', source
  .replace(/^import[^\n]*\r?\n/gm, '')
  .replace('export default function TerminalAI', 'function TerminalAI'), {
  jsx: { runtime: 'classic' },
});
assert.deepEqual(transformed.errors, []);
const load = (projects = PROJECTS_DATA) => runInNewContext(`${transformed.code}\n({
  commands: COMMAND_REGISTRY,
  Markdown: typeof MessageMarkdown === 'undefined' ? null : MessageMarkdown,
});`, { React, ReactMarkdown, remarkGfm, PROJECTS_DATA: projects, CERTIFICATES_DATA, DEVELOPER_PROFILE });

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
