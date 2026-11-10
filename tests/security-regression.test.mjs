import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import crypto from 'node:crypto';
import path from 'node:path';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const source = read('api/save-memory.js');
const origin = 'https://raflyf.vercel.app';
const response = () => ({
  headers: {}, statusCode: 0, body: null,
  setHeader(k, v) { this.headers[k] = v; },
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  end() { return this; },
});

// The old Origin-only gate must not accept this caller even when the DB would.
test('forged allowed Origin cannot write shared memory without admin authentication', async () => {
  let writes = 0;
  const context = {
    Buffer, crypto, path, URL, Headers, AbortController, AbortSignal,
    process: { env: { SUPABASE_SERVICE_ROLE_KEY: 'test-only-key' }, cwd: () => 'isolated-fixture' },
    fs: { existsSync: () => false },
    console: { warn() {}, error() {} },
    setTimeout, clearTimeout,
    fetch: async () => { writes++; return { ok: true }; },
    applyCors: () => true,
    readJsonBody: req => req.body,
    requireAdmin: async (req, res) => { res.status(401).json({ success: false }); return null; },
    enforceRateLimit: async () => true,
    databaseRequest: async () => { writes++; return []; },
  };
  const handler = runInNewContext(`${source.replace(/^import[\s\S]*?;\r?\n/gm, '').replace('export default ', '')}\nhandler;`, context);
  const res = response();
  await handler({ method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: { fact_text: 'Untrusted cross-visitor knowledge', session_id: 'public-caller' } }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(writes, 0);
});

test('public chat never publishes key inventories', () => {
  const chat = read('api/chat.js');
  const health = chat.slice(chat.indexOf("if (req.method === 'GET')"), chat.indexOf("if (req.method !== 'POST')"));
  assert.doesNotMatch(health, /providerPool:|keys:\s*\{|tables:\s*\[/);
});

test('chat cannot promote visitor or model output into shared knowledge', () => {
  const chat = read('api/chat.js');
  assert.doesNotMatch(chat, /async function saveServerMemory\(/);
  assert.doesNotMatch(chat, /saveServerMemory\(/);
  assert.doesNotMatch(read('src/components/terminal/TerminalAI.jsx'), /fetch\('\/api\/save-memory'/);
});

test('script CSP denies inline scripts and Supabase wildcard connections', () => {
  const config = JSON.parse(read('vercel.json'));
  const policy = config.headers.flatMap(item => item.headers).find(h => h.key === 'Content-Security-Policy').value;
  const script = policy.split(';').find(d => d.trim().startsWith('script-src '));
  assert.ok(script);
  assert.ok(!script.includes("'unsafe-inline'"));
  assert.ok(!policy.includes('https://*.supabase.co'));
  assert.match(policy, /frame-ancestors 'self'/);
});
