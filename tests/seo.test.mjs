import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const config = JSON.parse(read('vercel.json'));
const matches = (source, path) => new RegExp(`^${source}$`).test(path);
const appRewrite = path => config.rewrites.find(rule =>
  rule.destination === '/index.html' && matches(rule.source, path));
const robotsHeader = path => config.headers
  .filter(rule => matches(rule.source, path))
  .flatMap(rule => rule.headers)
  .find(header => header.key.toLowerCase() === 'x-robots-tag')?.value;

// Contract: only registered pages reach React; static files and missing URLs stay with Vercel.
test('known client routes still reach the app', () => {
  for (const path of ['/dashboard', '/archive-v1', '/archive-v1/dashboard', '/preview-stitch', '/preview-stitch/dashboard']) {
    assert.ok(appRewrite(path), path);
    assert.ok(appRewrite(`${path}/`), `${path}/`);
  }
});

test('unknown URLs and static resources never fall back to the homepage', () => {
  for (const path of ['/seo-check-not-a-real-page', '/dashboard-extra', '/archive-v1/missing', '/robots.txt', '/sitemap.xml', '/google462b52e1b6cba12b.html', '/og-cover.jpg', '/site.webmanifest', '/assets/missing.js', '/certificates/missing.pdf', '/api/chat']) {
    assert.equal(appRewrite(path), undefined, path);
  }
});

test('dashboard aliases are noindex without hiding the homepage', () => {
  for (const path of ['/dashboard', '/archive-v1/dashboard', '/preview-stitch/dashboard']) {
    assert.match(robotsHeader(path) || '', /\bnoindex\b/, path);
    assert.match(robotsHeader(`${path}/`) || '', /\bnoindex\b/, `${path}/`);
  }
  assert.equal(robotsHeader('/'), undefined);
});

test('robots allows Google to read noindex and points to the deployed sitemap', () => {
  const robots = read('public/robots.txt');
  assert.doesNotMatch(robots, /^Disallow:\s*\/dashboard\s*$/m);
  assert.match(robots, /^Sitemap: https:\/\/raflyf\.vercel\.app\/sitemap\.xml\s*$/m);
  assert.equal(robots, read('robots.txt'));
});

test('returning from dashboard restores the static homepage title', () => {
  const title = read('index.html').match(/<title>(.*?)<\/title>/)[1];
  const effect = read('src/stitch-ui/StitchPortfolio.jsx').match(/useEffect\(\(\) => \{([\s\S]*?)\}, \[\]\)/)[1];
  const document = { title: 'Dashboard Telemetri & Observatorium - Rafly Firmansyah' };
  runInNewContext(effect, { document, telemetry: { init() {}, logEvent() {} } });
  assert.equal(document.title, title);
});

test('legacy domain redirects preserve paths but keep the verification file', () => {
  const rule = config.redirects.find(rule => rule.has?.some(condition => condition.type === 'host' && condition.value === 'raflyfirmansyah-portofolio.vercel.app'));
  assert.ok(rule);
  assert.equal(rule.permanent, true);
  const pattern = new RegExp(`^${rule.source.replace(':path(', '(')}$`);
  for (const path of ['/', '/dashboard', '/contoh-portfolio-react-tailwind', '/certificates/test.pdf']) {
    const match = pattern.exec(path);
    assert.ok(match, path);
    assert.equal(rule.destination.replace(':path', match[1]), `https://raflyf.vercel.app${path}`);
  }
  assert.equal(pattern.test('/google462b52e1b6cba12b.html'), false);
});

test('sitemap lists public canonical pages and verification content stays intact', () => {
  const sitemap = read('public/sitemap.xml');
  assert.deepEqual([...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]), ['https://raflyf.vercel.app/', 'https://raflyf.vercel.app/contoh-portfolio-react-tailwind']);
  assert.equal(sitemap, read('sitemap.xml'));
  assert.equal(read('public/google462b52e1b6cba12b.html').trim(), 'google-site-verification: google462b52e1b6cba12b.html');
});
