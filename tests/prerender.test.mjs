import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');

test('built homepage exposes its real heading, projects and links without JavaScript', () => {
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /Rafly<br\s*\/?>(?:\s|<[^>]*>)*Firmansyah/);
  assert.match(html, /OpenPlagiarismChecker/);
  assert.match(html, /href="https:\/\/github.com\/Raflyf\/OpenPlagiarismChecker"/);
  assert.match(html, /href="\/contoh-portfolio-react-tailwind"/);
  assert.match(html, /rel="canonical" href="https:\/\/raflyf\.vercel\.app\/"/);
  assert.doesNotMatch(html, /<div id="root"><\/div>/);
  for (const control of html.matchAll(/<(?:input|textarea|select|button)\b[^>]*>/g)) {
    assert.match(control[0], /\sdisabled(?:\s|=|>)/);
  }
});

test('built case study stays readable as static HTML', () => {
  const article = readFileSync(new URL('../dist/contoh-portfolio-react-tailwind.html', import.meta.url), 'utf8');
  assert.equal((article.match(/<h1\b/g) || []).length, 1);
  assert.match(article, /Contoh Portfolio React/);
  assert.match(article, /href="https:\/\/github\.com\/Raflyf\/RaflyfPorto"/);
  assert.match(article, /rel="canonical" href="https:\/\/raflyf\.vercel\.app\/contoh-portfolio-react-tailwind"/);
  assert.doesNotMatch(article, /<script(?![^>]*application\/ld\+json)/);
  for (const name of ['desktop', 'mobile']) {
    const image = readFileSync(new URL(`../dist/assets/portfolio-${name}.webp`, import.meta.url));
    assert.equal(image.toString('ascii', 0, 4), 'RIFF');
    assert.equal(image.toString('ascii', 8, 12), 'WEBP');
  }
});
