import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => readFileSync(path.join(root, file), 'utf8');
const ownedDirectories = new Set(['api', 'database', 'public', 'scripts', 'src', 'tests', '.vscode']);
const textFile = /\.(?:[cm]?js|jsx|tsx?|css|html|json|md|txt|xml|svg|sql|py|bat|toml|ya?ml|webmanifest)$/i;

function scan(directory = root) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && (directory !== root || ownedDirectories.has(entry.name))) files.push(...scan(file));
    if (entry.isFile() && (textFile.test(entry.name) || ['.gitignore', '.vercelignore', '.env.example'].includes(entry.name)) && entry.name !== 'ngrok_auth.md') files.push(file);
  }
  return files;
}

test('project-owned text contains no literal em dash', () => {
  const offenders = scan().filter(file => readFileSync(file, 'utf8').includes('\u2014')).map(file => path.relative(root, file));
  assert.deepEqual(offenders, []);
});

const terminal = read('src/components/terminal/TerminalAI.jsx');
const { formatMessageContent: format, MARKDOWN_PLUGINS } = runInNewContext(terminal.slice(terminal.indexOf('function formatMessageContent('), terminal.indexOf('const MessageMarkdown')) + '\n({ formatMessageContent, MARKDOWN_PLUGINS });', { remarkGfm });
const render = content => renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: MARKDOWN_PLUGINS }, format(content)));

test('terminal normalizes em dashes in new and restored text without changing line boundaries', () => {
  for (const text of ['Alpha \u2014 Beta', 'Alpha\u2014Beta', 'Alpha &mdash; Beta', 'Alpha &#8212; Beta', 'Alpha &#x2014; Beta']) {
    assert.equal(render(text), '<p>Alpha - Beta</p>');
  }
  assert.equal(render('Alpha\n\u2014 Beta'), '<p>Alpha\n- Beta</p>');
  assert.equal(render('value--flag, v1.2, 2020\u20132025'), '<p>value--flag, v1.2, 2020\u20132025</p>');
  const list = render('Intro: \u2014 1. Alpha: first \u2014 2. Beta: second');
  assert.match(list, /<strong>Alpha<\/strong>/);
  assert.match(list, /<strong>Beta<\/strong>/);
  assert.doesNotMatch(list, /\u2014/);
});

test('punctuation cleanup leaves link destinations and code samples intact', () => {
  assert.match(render('[Link](https://example.test/a\u2014b)'), /href="https:\/\/example\.test\/a(?:%E2%80%94|\u2014)b"/);
  assert.equal(render('`const name = "a\u2014b"`'), '<p><code>const name = &quot;a\u2014b&quot;</code></p>');
  assert.equal(render('```js\nconst name = "a\u2014b"\n```'), '<pre><code class="language-js">const name = &quot;a\u2014b&quot;\n</code></pre>');
  assert.match(render('https://example.test/a\u2014b'), /href="https:\/\/example\.test\/a(?:%E2%80%94|\u2014)b"/);
});

const chat = read('api/chat.js');
const extract = runInNewContext(chat.slice(chat.indexOf('function extractFitMarkdownContent('), chat.indexOf('async function scrapeDirectWebpageContent(')) + '\nextractFitMarkdownContent;');

test('HTML extraction converts em-dash entities instead of emitting mojibake', () => {
  for (const entity of ['&mdash;', '&#8212;', '&#x2014;']) {
    const result = extract(`<p>Alpha ${entity} Beta</p>`);
    assert.match(result, /Alpha - Beta/);
    assert.doesNotMatch(result, /\u2014|\u0393\u00c7\u00f6/);
  }
});
