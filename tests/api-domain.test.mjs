import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const canonical = 'https://raflyf.vercel.app';
const legacy = 'https://raflyfirmansyah-portofolio.vercel.app';
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const files = ['chat', 'save-memory', 'dashboard-data', 'admin-otp'];
const chatSource = read('api/chat.js');

function loadHandler(file, env = {}) {
  let effects = 0;
  const forbidden = () => {
    effects += 1;
    throw new Error('External effect forbidden in offline origin tests');
  };
  const context = {
    crypto, path, Buffer, URL, AbortController,
    process: { env: { ...env }, cwd: () => 'offline-fixture' },
    fs: { existsSync: () => false, readFileSync: forbidden },
    fetch: forbidden, setTimeout: forbidden, clearTimeout() {},
    console: { log() {}, warn() {}, error() {} },
  };
  // Execute production bodies and dependencies unchanged; only module syntax and I/O are isolated.
  const load = (file, exports) => runInNewContext(`(() => {
    ${read(file).replace(/^import[\s\S]*?;\n/gm, '').replace(/^export (?:default )?/gm, '')}
    return { ${exports.join(', ')} };
  })()`, context, { filename: file });
  if (file === 'chat') {
    Object.assign(context, load('api/_providers.js', ['aiChat', 'providerStatus', 'AI_CONFIG', 'AI_MODELS']));
    Object.assign(context, load('src/data.js', ['PROJECTS_DATA_I18N']));
    const memory = load('api/_memory.js', ['saveMessage', 'getContext', 'saveSummary', 'saveCorrection', 'countMessages', 'isResetCommand']);
    Object.assign(context, {
      memSaveMessage: memory.saveMessage, memGetContext: memory.getContext,
      memSaveSummary: memory.saveSummary, memSaveCorrection: memory.saveCorrection,
      memCountMessages: memory.countMessages, isResetCommand: memory.isResetCommand,
    });
  }
  return {
    ...load(`api/${file}.js`, file === 'chat' ? ['handler', 'getSurgicalPortfolioContext'] : ['handler']),
    effects: () => effects,
  };
}

function response() {
  return {
    headers: {}, statusCode: null, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

for (const file of files) {
  test(`${file}: trusted preflights reflect exact origin despite stale environment`, async () => {
    const api = loadHandler(file, { ALLOWED_ORIGIN: legacy });
    for (const origin of [canonical, legacy, 'http://localhost:5173', 'http://127.0.0.1:5173']) {
      const res = response();
      await api.handler({ method: 'OPTIONS', headers: { origin } }, res);
      assert.equal(res.statusCode, 200, origin);
      assert.equal(res.headers['Access-Control-Allow-Origin'], origin);
      assert.equal(res.headers.Vary, 'Origin');
    }
    assert.equal(api.effects(), 0);
  });

  test(`${file}: explicit foreign origins are rejected before payload or external effects`, async () => {
    const api = loadHandler(file, {
      SUPABASE_URL: 'https://database.invalid', SUPABASE_SERVICE_ROLE_KEY: 'offline-test-key',
    });
    for (const origin of ['https://untrusted.vercel.app', `${canonical}.evil.invalid`, 'http://raflyf.vercel.app', `${canonical}:8443`, `${canonical}/`, 'null']) {
      for (const method of ['OPTIONS', 'POST', 'GET']) {
        const req = { method, headers: { origin, 'x-admin-token': 'offline-invalid-token' } };
        Object.defineProperty(req, 'body', { get() { assert.fail('Origin rejection must precede body access'); } });
        const res = response();
        await api.handler(req, res);
        assert.equal(res.statusCode, 403, `${method} ${origin}`);
        assert.notEqual(res.headers['Access-Control-Allow-Origin'], origin);
        assert.equal(api.effects(), 0);
      }
    }
  });

  test(`${file}: canonical POST still reaches existing validation without network`, async () => {
    const api = loadHandler(file, { SUPABASE_SERVICE_ROLE_KEY: 'offline-test-key' });
    const res = response();
    await api.handler({
      method: 'POST', headers: { origin: canonical, 'content-length': '51201' }, body: {},
    }, res);
    assert.equal(res.statusCode, { chat: 400, 'save-memory': 413, 'dashboard-data': 401, 'admin-otp': 400 }[file]);
    assert.equal(res.headers['Access-Control-Allow-Origin'], canonical);
    assert.equal(api.effects(), 0);
  });

  test(`${file}: default CORS origin migrates; explicit environment override remains supported`, async () => {
    for (const env of [{}, { ALLOWED_ORIGIN: 'https://configured.example' }]) {
      const api = loadHandler(file, env);
      const res = response();
      const origin = env.ALLOWED_ORIGIN;
      await api.handler({ method: 'OPTIONS', headers: origin ? { origin } : {} }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['Access-Control-Allow-Origin'], origin || canonical);
      assert.equal(api.effects(), 0);
    }
  });
}

test('chat health and dashboard authentication still work without Origin', async () => {
  for (const [file, statusCode] of [['chat', 200], ['dashboard-data', 401]]) {
    const api = loadHandler(file, { SUPABASE_SERVICE_ROLE_KEY: 'offline-test-key' });
    const res = response();
    await api.handler({ method: 'GET', headers: {} }, res);
    assert.equal(res.statusCode, statusCode);
    assert.equal(api.effects(), 0);
  }
});

test('missing Origin preserves existing POST gates without external effects', async () => {
  for (const [file, statusCode] of [['chat', 400], ['save-memory', 403], ['dashboard-data', 401], ['admin-otp', 400]]) {
    const api = loadHandler(file, { SUPABASE_SERVICE_ROLE_KEY: 'offline-test-key' });
    const res = response();
    await api.handler({ method: 'POST', headers: {}, body: {} }, res);
    assert.equal(res.statusCode, statusCode);
    assert.equal(api.effects(), 0);
  }
});

test('portfolio identity and real URL filter accept new site, not arbitrary Vercel hosts', () => {
  const api = loadHandler('chat');
  assert.ok(api.getSurgicalPortfolioContext('kontak').includes(`${canonical}/`));
  const start = chatSource.indexOf('      const officialDomains = [');
  const end = chatSource.indexOf('      // 6.5.', start);
  assert.ok(start >= 0 && end > start);
  const filter = text => runInNewContext(`let cleaned = input;\n${chatSource.slice(start, end)}\ncleaned;`, { input: text, URL });
  const link = `[Portfolio](${canonical}/)`;
  assert.equal(filter(link), link);
  assert.equal(filter('[Untrusted](https://untrusted.vercel.app/)'), 'Untrusted');
  assert.equal(filter(`[Spoof](${canonical}.evil.invalid/)`), 'Spoof');
  assert.equal(api.effects(), 0);
});

test('OpenRouter wrapper constructs canonical HTTP-Referer without sending a request', async () => {
  const start = chatSource.indexOf('    async function callOpenRouter(');
  const end = chatSource.indexOf('    async function callOpenCode(', start);
  assert.ok(start >= 0 && end > start);
  let captured;
  const call = runInNewContext(`${chatSource.slice(start, end)}\ncallOpenRouter;`, {
    OPENROUTER_KEYS: ['offline-test-key'], rateLimitedKeyCache: new Map(),
    isSpecificManual: false, openRouterMessages: [], maxTokensConfig: 64,
    tempConfig: 0.25, effectiveEffort: 'low', providerErrors: [],
    async fetchJsonWithTimeout(url, options) {
      captured = { url, options };
      return { ok: false, status: 503, text: '' };
    },
  });
  await call('offline-fixture');
  assert.equal(captured.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(captured.options.headers['HTTP-Referer'], `${canonical}/`);
});
