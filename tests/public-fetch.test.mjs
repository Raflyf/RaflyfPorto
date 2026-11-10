import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { BlockList, isIP } from 'node:net';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const file = new URL('../api/_public-fetch.js', import.meta.url);
const PUBLIC = { address: '8.8.8.8', family: 4 };

function fixture({ records = [PUBLIC], resolve, steps = [] } = {}) {
  assert.ok(existsSync(file), 'bounded public-fetch helper missing');
  const calls = [], dnsCalls = [], responses = [], timers = new Map();
  let nextTimer = 0;
  const request = (url, options, receive) => {
    const step = steps[calls.length] || {};
    const req = new EventEmitter();
    req.destroyed = false;
    const call = { url, options, req, pinned: null };
    calls.push(call);
    req.destroy = error => {
      if (req.destroyed) return;
      req.destroyed = true;
      call.response?.destroy();
      if (error) queueMicrotask(() => req.emit('error', error));
    };
    const abort = () => req.destroy(options.signal.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    req.end = () => {
      if (options.lookup) {
        options.lookup(url.hostname.replace(/^\[|\]$/g, ''), {}, (error, address, family) => {
          assert.ifError(error);
          call.pinned = { address, family };
        });
      }
      if (step.hang) return;
      queueMicrotask(() => {
        if (req.destroyed) return;
        if (step.error) { req.emit('error', step.error); return; }
        const response = new PassThrough();
        call.response = response;
        responses.push(response);
        response.statusCode = step.status || 200;
        response.headers = step.headers || { 'content-type': 'application/json' };
        response.complete = !step.incomplete;
        response.on('close', () => options.signal?.removeEventListener('abort', abort));
        receive(response);
        if (response.destroyed || step.stallBody) return;
        for (const chunk of step.chunks || ['{"answer":42}']) {
          if (!response.destroyed) response.write(chunk);
        }
        if (!response.destroyed) response.end();
      });
    };
    return req;
  };
  const context = {
    http: { request }, https: { request }, BlockList, isIP, URL, Headers, Buffer,
    AbortController, AbortSignal, DOMException,
    lookup: async (host, options) => { dnsCalls.push({ host, options }); return resolve ? resolve(host) : records; },
    setTimeout(callback, ms) { timers.set(++nextTimer, { callback, ms }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  };
  const api = runInNewContext(readFileSync(file, 'utf8')
    .replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '')
    + '\n({ isSafePublicUrl, fetchPublic });', context, { filename: 'api/_public-fetch.js' });
  return { ...api, calls, dnsCalls, responses, timers,
    expire() { [...timers.values()][0].callback(); },
  };
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('URL gate rejects private, special, disguised, and encapsulated addresses but accepts public IPv6', () => {
  const api = fixture();
  const blocked = [
    '', 'file:///etc/passwd', 'gopher://8.8.8.8/', '//example.com/', 'https:example.com',
    'https://user:password@example.com/', 'https://@example.com/', 'http://localhost.', 'http://a.local/',
    'http://metadata.google.internal/', 'http://instance-data/', 'http://a.home.arpa/',
    'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/',
    'http://%31%32%37.0.0.1/', 'http://127.0.0.1.nip.io\n/', 'http://example.com\\@127.0.0.1/',
    ...['0.1.2.3', '10.2.3.4', '100.64.0.1', '100.127.255.254', '127.2.3.4',
      '169.254.169.254', '168.63.129.16', '172.16.0.1', '172.31.255.254', '192.0.0.8', '192.0.2.1',
      '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.19.255.254', '198.51.100.1',
      '203.0.113.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255'].map(ip => `http://${ip}/`),
    ...['::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:8.8.8.8', '::8.8.8.8',
      '64:ff9b::a9fe:a9fe', '64:ff9b:1::a00:1', '2002:7f00:1::', '2001::1',
      '2001:db8::1', '2001:2::1', '2001:20::1', '3fff::1', 'fc01::1', 'fdff::1',
      'fe80::1', 'febf::1', 'fec0::1', 'ff02::1', 'fe80::1%25eth0',
      '2606:4700::5efe:7f00:1', '2606:4700::200:5efe:a00:1'].map(ip => `http://[${ip}]/`),
  ];
  for (const url of blocked) assert.equal(api.isSafePublicUrl(url), false, url);
  for (const url of ['https://example.com/a?q=1', 'http://8.8.8.8/', 'https://example.com./',
    'https://[2606:4700:4700::1111]/', 'https://[2001:4860:4860::8888]/']) {
    assert.equal(api.isSafePublicUrl(url), true, url);
  }
  assert.equal(api.dnsCalls.length, 0, 'syntax checks must not resolve DNS');
});

test('DNS validation rejects any unsafe record and does not open a socket', async () => {
  for (const records of [[], [PUBLIC, { address: '10.0.0.1', family: 4 }],
    [PUBLIC, { address: '::ffff:127.0.0.1', family: 6 }], [{ address: 'not-an-ip', family: 4 }],
    [{ address: '8.8.8.8', family: 6 }]]) {
    const api = fixture({ records });
    await assert.rejects(api.fetchPublic('https://example.com/'));
    assert.equal(api.calls.length, 0);
    assert.equal(api.timers.size, 0);
  }
});

test('request pins DNS once without replacing TLS hostname, SNI, or certificate validation', async () => {
  const api = fixture({ resolve: () => api.dnsCalls.length === 1 ? [PUBLIC] : [{ address: '127.0.0.1', family: 4 }] });
  const res = await api.fetchPublic('https://example.com/path', { headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip' } });
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.ok(res.headers instanceof Headers);
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.equal(JSON.stringify(await res.json()), '{"answer":42}');
  assert.equal(await res.text(), '{"answer":42}');
  assert.equal(api.dnsCalls.length, 1);
  assert.equal(api.dnsCalls[0].options.all, true);
  assert.deepEqual(api.calls[0].pinned, PUBLIC);
  const { url, options } = api.calls[0];
  assert.equal(url.hostname, 'example.com');
  assert.equal(options.servername, 'example.com');
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.checkServerIdentity, undefined);
  assert.equal(options.agent, false);
  assert.equal(options.method, 'GET');
  assert.equal(new Headers(options.headers).get('accept-encoding'), 'identity');
  let answers;
  options.lookup('example.com', { all: true }, (error, result) => { assert.ifError(error); answers = result; });
  assert.equal(answers.length, 1);
  assert.equal(answers[0].address, PUBLIC.address);
  assert.equal(api.dnsCalls.length, 1, 'connection lookup must never resolve again');
  assert.equal(api.timers.size, 0);
});

test('public literal IPv4 and IPv6 remain supported without DNS lookup', async () => {
  for (const url of ['http://8.8.8.8/', 'https://[2606:4700:4700::1111]/']) {
    const api = fixture();
    assert.equal((await api.fetchPublic(url)).status, 200);
    assert.equal(api.dnsCalls.length, 0);
  }
});

test('redirects revalidate syntax and DNS, close bodies, and preserve public relative redirects', async () => {
  for (const location of ['http://127.1/', 'file:///etc/passwd', 'https://u:p@example.com/', 'http://[64:ff9b::a9fe:a9fe]/']) {
    const api = fixture({ steps: [{ status: 302, headers: { location } }] });
    await assert.rejects(api.fetchPublic('https://example.com/'));
    assert.equal(api.calls.length, 1);
    assert.equal(api.responses[0].destroyed, true);
  }
  const rebinding = fixture({ steps: [{ status: 302, headers: { location: '/next' } }],
    resolve: () => rebinding.dnsCalls.length === 1 ? [PUBLIC] : [{ address: '169.254.169.254', family: 4 }] });
  await assert.rejects(rebinding.fetchPublic('https://example.com/'));
  assert.equal(rebinding.calls.length, 1);
  const good = fixture({ steps: [{ status: 307, headers: { location: '../final?q=1' } }, { status: 404, chunks: ['missing'] }] });
  const res = await good.fetchPublic('https://example.com/path/start');
  assert.equal(good.calls[1].url.href, 'https://example.com/final?q=1');
  assert.equal(good.dnsCalls.length, 2);
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'missing');
});

test('redirect count cannot exceed configured or hard limits', async () => {
  const loop = fixture({ steps: Array.from({ length: 5 }, () => ({ status: 301, headers: { location: '/' } })) });
  await assert.rejects(loop.fetchPublic('https://example.com/'));
  assert.equal(loop.calls.length, 4);
  const none = fixture({ steps: [{ status: 302, headers: { location: '/next' } }] });
  await assert.rejects(none.fetchPublic('https://example.com/', { maxRedirects: 0 }));
  assert.equal(none.calls.length, 1);
});

test('bounded body rejects oversized headers, chunked overflow, compression, and truncation', async () => {
  for (const step of [
    { headers: { 'content-length': '100' }, chunks: [] },
    { headers: {}, chunks: [Buffer.from('1234'), Buffer.from('56789')] },
    { headers: { 'content-encoding': 'gzip' }, chunks: [Buffer.alloc(1)] },
    { headers: {}, incomplete: true, chunks: ['abc'] },
  ]) {
    const api = fixture({ steps: [step] });
    await assert.rejects(api.fetchPublic('https://example.com/', { maxBytes: 8 }));
    assert.equal(api.responses[0].destroyed, true);
    assert.equal(api.timers.size, 0);
  }
  const exact = fixture({ steps: [{ chunks: ['1234', '5678'] }] });
  assert.equal(await (await exact.fetchPublic('https://example.com/', { maxBytes: 8 })).text(), '12345678');
});

test('total deadline covers pending DNS and never opens a late socket', async () => {
  let finishDNS;
  const api = fixture({ resolve: () => new Promise(resolve => { finishDNS = resolve; }) });
  const result = api.fetchPublic('https://example.com/', { timeoutMs: 15 });
  const rejected = assert.rejects(result, error => error.name === 'TimeoutError');
  await settle();
  api.expire();
  await rejected;
  finishDNS([PUBLIC]);
  await settle();
  assert.equal(api.calls.length, 0);
  assert.equal(api.timers.size, 0);
});

test('deadline or cancellation destroys a stalled body and clears its timer', async () => {
  for (const cancel of [false, true]) {
    const ctrl = new AbortController();
    const api = fixture({ steps: [{ stallBody: true }] });
    const result = api.fetchPublic('https://example.com/', { signal: ctrl.signal, timeoutMs: 15 });
    const rejected = assert.rejects(result, error => error.name === (cancel ? 'AbortError' : 'TimeoutError'));
    await settle();
    if (cancel) ctrl.abort(); else api.expire();
    await rejected;
    assert.equal(api.calls[0].req.destroyed, true);
    assert.equal(api.responses[0].destroyed, true);
    assert.equal(api.timers.size, 0);
  }
});

test('DNS failures and connection errors reject, and cancellation also stops pending DNS', async () => {
  const dnsError = fixture({ resolve: () => { throw new Error('ENOTFOUND'); } });
  await assert.rejects(dnsError.fetchPublic('https://example.com/'), /ENOTFOUND/);
  assert.equal(dnsError.calls.length, 0);
  assert.equal(dnsError.timers.size, 0);
  const connection = fixture({ steps: [{ error: new Error('certificate rejected') }] });
  await assert.rejects(connection.fetchPublic('https://example.com/'), /certificate rejected/);
  assert.equal(connection.calls[0].req.destroyed, true);
  assert.equal(connection.timers.size, 0);
  const pending = fixture({ steps: [{ hang: true }] });
  const deadline = pending.fetchPublic('https://example.com/');
  const timedOut = assert.rejects(deadline, error => error.name === 'TimeoutError');
  await settle(); pending.expire(); await timedOut;
  assert.equal(pending.calls[0].req.destroyed, true);
  let finishDNS;
  const ctrl = new AbortController();
  const dns = fixture({ resolve: () => new Promise(resolve => { finishDNS = resolve; }) });
  const result = dns.fetchPublic('https://example.com/', { signal: ctrl.signal });
  const rejected = assert.rejects(result, error => error.name === 'AbortError');
  await settle(); ctrl.abort(); await rejected;
  finishDNS([PUBLIC]); await settle();
  assert.equal(dns.calls.length, 0);
  assert.equal(dns.timers.size, 0);
});

test('invalid request options fail before DNS; pre-aborted request opens no connection', async () => {
  for (const options of [
    { method: 'POST' }, { body: 'payload' }, { maxBytes: 0 }, { maxBytes: 4194305 },
    { maxBytes: NaN }, { timeoutMs: -1 }, { timeoutMs: 30001 }, { maxRedirects: 4 },
    { headers: { Host: '127.0.0.1' } }, { headers: { Authorization: 'test-only' } },
    { headers: { Cookie: 'test-only' } }, { headers: { 'Proxy-Authorization': 'test-only' } },
    { headers: { 'User-Agent': 'a'.repeat(9000) } },
  ]) {
    const api = fixture();
    await assert.rejects(api.fetchPublic('https://example.com/', options));
    assert.equal(api.dnsCalls.length, 0);
    assert.equal(api.calls.length, 0);
  }
  const api = fixture();
  const ctrl = new AbortController(); ctrl.abort();
  await assert.rejects(api.fetchPublic('https://example.com/', { signal: ctrl.signal }), error => error.name === 'AbortError');
  assert.equal(api.dnsCalls.length, 0);
  assert.equal(api.calls.length, 0);
});
