import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const pin = '4826';
const legacyHash = value => crypto.createHash('sha256').update(value + 'rafly_telemetry_salt').digest('hex');
const token = `adm_${'a'.repeat(64)}`;
const tokenHash = value => crypto.createHash('sha256').update(value).digest('hex');
const response = () => ({
  headers: {}, statusCode: 0, body: null,
  setHeader(k, v) { this.headers[k] = v; },
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  end() { return this; },
});
const request = (body = {}, extra = {}) => ({
  method: 'POST', headers: { origin: 'https://raflyf.vercel.app', 'content-type': 'application/json', ...extra.headers },
  socket: { remoteAddress: '192.0.2.1' }, body, query: {}, ...extra,
});

// Relational fixture executes the real handlers/helpers; only network and local env reads are replaced.
function fixture(options = {}) {
  let now = Date.parse('2026-11-10T12:04:59.000Z');
  const initial = {
    id: 'master_auth', pin_hash: legacyHash(pin), lockout_attempts: 0, locked_until: null,
    session_token: null, session_expires_at: null, otp_code_hash: null, otp_expires_at: null,
    otp_attempts: 0, otp_blocked_until: null, updated_at: new Date(now - 86400000).toISOString(),
    ...options.row,
  };
  let row = options.missing ? null : structuredClone(initial);
  const counters = new Map();
  const stats = { authWrites: [], mail: [], calls: 0, envReads: 0, logs: 0, otp: '' };
  const current = () => structuredClone(row);
  const time = () => now;
  function match(record, params) {
    return [...params].every(([key, filter]) => {
      if (['select', 'limit', 'order'].includes(key)) return true;
      if (filter === 'is.null') return record?.[key] == null;
      if (filter.startsWith('eq.')) {
        const raw = filter.slice(3);
        const value = raw.startsWith('"') ? JSON.parse(raw) : raw;
        return String(record?.[key]) === String(value);
      }
      if (filter.startsWith('gt.')) return Date.parse(record?.[key]) > Date.parse(filter.slice(3));
      if (filter.startsWith('lt.')) return Number(record?.[key]) < Number(filter.slice(3));
      throw new Error('Unsupported local database filter');
    });
  }
  const result = (status, data) => ({
    ok: status >= 200 && status < 300, status,
    async json() { return structuredClone(data); }, async text() { return status === 200 ? 'OK' : ''; },
  });
  const fetch = async (url, init = {}) => {
    stats.calls++;
    const parsed = new URL(url);
    const method = init.method || 'GET';
    if (parsed.origin === 'https://api.resend.com' || parsed.origin === 'https://api.emailjs.com') {
      const mail = JSON.parse(init.body);
      stats.mail.push(mail);
      stats.otp = /KODE OTP: (\d{6})/.exec(mail.text || mail.template_params?.message || '')?.[1] || '';
      if (options.mailFailure) return result(503, {});
      return result(200, { id: 'offline-message' });
    }
    assert.equal(parsed.origin, 'https://database.invalid', 'No live endpoints may be reached');
    if (options.databaseFailure) throw new Error('Offline upstream failure');
    if (parsed.pathname.startsWith('/rest/v1/rpc/')) return result(500, {});
    const resource = parsed.pathname.slice('/rest/v1/'.length);
    if (resource === 'admin_auth_config') {
      if (method === 'GET') return result(200, row ? [current()] : []);
      if (options.writeFailure) return result(503, {});
      const body = JSON.parse(init.body);
      stats.authWrites.push({ method, query: parsed.searchParams, body });
      if (method === 'PATCH') {
        if (!row || !match(row, parsed.searchParams)) return result(200, []);
        if (options.conflict) return result(200, []);
        row = { ...row, ...body };
        return result(200, [current()]);
      }
      if (method === 'POST') { row = { ...row, ...body }; return result(201, [current()]); }
    }
    if (resource === 'rate_limits') {
      const params = parsed.searchParams;
      const id = `${params.get('client_ip')}|${params.get('window_start')}`;
      if (method === 'GET') return result(200, counters.has(id) ? [structuredClone(counters.get(id))] : []);
      const body = JSON.parse(init.body);
      if (method === 'POST') {
        const key = `eq.${body.client_ip}|eq.${body.window_start}`;
        if (counters.has(key)) return result(409, {});
        counters.set(key, body);
        return result(201, [structuredClone(body)]);
      }
      if (method === 'PATCH') {
        const previous = counters.get(id);
        if (!previous || !match(previous, params)) return result(200, []);
        const next = { ...previous, ...body };
        counters.set(id, next);
        return result(200, [structuredClone(next)]);
      }
    }
    throw new Error('Unexpected offline effect');
  };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = {
    crypto, isIP, promisify, Buffer, URL, Headers, AbortController, AbortSignal, path,
    Date: Clock, process: { env: { SUPABASE_URL: 'https://database.invalid', SUPABASE_SERVICE_ROLE_KEY: 'offline-test-key', RESEND_API_KEY: 'offline-mail-key', ...options.env }, cwd: () => 'offline-fixture' },
    fs: { existsSync: () => false, readFileSync() { stats.envReads++; throw new Error('Local env forbidden'); } },
    console: { log() { stats.logs++; }, warn() { stats.logs++; }, error() { stats.logs++; } },
    fetch, setTimeout, clearTimeout,
  };
  const load = (file, exports) => runInNewContext(`(() => {
    ${read(file).replace(/^import[\s\S]*?;\n/gm, '').replace(/^export (?:default )?/gm, '')}
    return { ${exports.join(', ')} };
  })()`, context, { filename: file });
  Object.assign(context, load('api/_security.js', ['databaseRequest', 'databaseConfig', 'httpError', 'applyCors', 'readJsonBody', 'getClientIp', 'enforceRateLimit', 'safeEqual', 'signValue']));
  let auth = {};
  if (existsSync(new URL('../api/_admin-auth.js', import.meta.url))) {
    auth = load('api/_admin-auth.js', ['readAdminRow', 'patchAdminRow', 'hashPin', 'hashLegacyPinHash', 'verifyPin', 'hashToken', 'activeSessions', 'requireAdmin']);
    Object.assign(context, auth);
  }
  const { handler } = load('api/admin-otp.js', ['handler']);
  return { handler, auth, stats, row: current, time, advance(ms) { now += ms; }, setRow(changes) { row = { ...row, ...changes }; } };
}

async function run(f, body, extra) {
  const res = response();
  await f.handler(request(body, extra), res);
  assert.equal(f.stats.envReads, 0);
  return res;
}

for (const method of ['GET', 'PUT', 'DELETE', 'HEAD']) {
  test(`admin rejects ${method} before query action or I/O`, async () => {
    const f = fixture();
    const res = await run(f, {}, { method, query: { action: 'verify_pin', pin_hash: 'b'.repeat(64) } });
    assert.equal(res.statusCode, 405);
    assert.equal(f.stats.calls, 0);
  });
}

test('admin refuses query actions, non-JSON, malformed fields and hash-as-password', async () => {
  const cases = [
    [{}, { query: { action: 'send_otp' } }, 400],
    ['{broken', {}, 400],
    [[], {}, 400],
    [{ action: 'verify_pin', pin_hash: legacyHash(pin) }, {}, 400],
    [{ action: 'verify_pin', pin: 4826 }, {}, 400],
    [{ action: 'verify_pin', pin: '48x6' }, {}, 400],
    [{ action: 'verify_pin', pin: '482' }, {}, 400],
    [{ action: 'verify_pin', pin: '482600000' }, {}, 400],
    [{ action: 'verify_pin', pin, extra: 'ignored?' }, {}, 400],
    [{ action: 'verify_pin', pin }, { headers: { 'content-type': 'application/x-www-form-urlencoded' } }, 415],
    [{ action: 'verify_pin', pin }, { headers: { 'content-type': 'application/json', 'content-length': '16385' } }, 413],
    [{ action: 'verify_otp_and_reset_pin', otp_code: 'abcdef', new_pin: '9021' }, {}, 400],
    [{ action: 'verify_otp_and_reset_pin', otp_code: '123456', new_pin: 'abcd' }, {}, 400],
  ];
  for (const [body, extra, expected] of cases) {
    const f = fixture();
    const res = await run(f, body, extra);
    assert.equal(res.statusCode, expected);
    assert.equal(f.stats.calls, 0);
  }
});

test('foreign Origin rejects before DB and even malicious body parsing', async () => {
  const f = fixture();
  const req = request({}, { headers: { origin: 'https://evil.vercel.app' } });
  Object.defineProperty(req, 'body', { get() { assert.fail('Foreign body parsed'); } });
  const res = response();
  await f.handler(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(f.stats.calls, 0);
});

test('admin CAS keeps integer and timestamp operands valid for PostgREST', async () => {
  const f = fixture();
  const row = f.row();
  row.session_token = JSON.stringify([{ hash: tokenHash(token), exp: f.time() + 86400000 }]);
  row.session_expires_at = '2026-11-11T12:04:59.000Z';
  row.otp_expires_at = '2026-11-10T12:10:00.000Z';
  row.otp_blocked_until = '2026-11-10T12:07:00.000Z';
  f.setRow(row);
  const updated = await f.auth.patchAdminRow(row, { session_token: row.session_token });
  assert.ok(updated);
  const params = f.stats.authWrites.at(-1).query;
  assert.equal(params.get('otp_attempts'), 'eq.0');
  for (const name of ['pin_hash', 'session_token', 'session_expires_at', 'otp_expires_at', 'otp_blocked_until', 'updated_at']) {
    assert.equal(params.get(name), `eq.${row[name]}`, name);
  }
});

test('login migrates legacy PIN and sessions together, storing hashes only', async () => {
  const f = fixture({ row: { session_token: JSON.stringify([{ token, exp: Date.parse('2026-11-11T11:00:00Z') }]), session_expires_at: '2026-11-11T11:00:00Z' } });
  const res = await run(f, { action: 'verify_pin', pin });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.verified, true);
  assert.match(f.row().pin_hash, /^scrypt\$/);
  assert.match(res.body.session_token, /^adm_[a-f0-9]{64}$/);
  assert.ok(!f.row().session_token.includes(res.body.session_token));
  assert.ok(!f.row().session_token.includes(token));
  assert.ok(JSON.parse(f.row().session_token).some(item => item.hash === tokenHash(token)));
  assert.ok(JSON.parse(f.row().session_token).some(item => item.hash === tokenHash(res.body.session_token)));
  const write = f.stats.authWrites.at(-1);
  for (const key of ['pin_hash', 'session_token', 'updated_at']) assert.ok(write.query.has(key));
  assert.equal(f.stats.logs, 0);
});

test('scrypt salts differ and raw PIN verification works after migration', async () => {
  const f = fixture();
  assert.equal(typeof f.auth.hashPin, 'function');
  const first = await f.auth.hashPin(pin);
  const second = await f.auth.hashPin(pin);
  assert.notEqual(first, second);
  assert.equal(await f.auth.verifyPin(pin, first), true);
  assert.equal(await f.auth.verifyPin('9021', first), false);
  assert.equal(await f.auth.verifyPin(pin, 'scrypt$999999999$8$3$x$x'), false);
  f.setRow({ pin_hash: first });
  assert.equal((await run(f, { action: 'verify_pin', pin })).statusCode, 200);
});

test('legacy hash can be wrapped without changing PIN, then upgraded on login', async () => {
  const f = fixture();
  const wrapped = await f.auth.hashLegacyPinHash(legacyHash(pin));
  assert.match(wrapped, /^scrypt-sha256\$/);
  assert.ok(!wrapped.includes(legacyHash(pin)));
  assert.equal(await f.auth.verifyPin(pin, wrapped), true);
  assert.equal(await f.auth.verifyPin('9021', wrapped), false);
  f.setRow({ pin_hash: wrapped });
  assert.equal((await run(f, { action: 'verify_pin', pin })).statusCode, 200);
  assert.match(f.row().pin_hash, /^scrypt\$/);
});

test('failed PIN guesses throttle one IP without changing global auth state', async () => {
  const f = fixture();
  const before = f.row();
  for (let i = 0; i < 5; i++) assert.equal((await run(f, { action: 'verify_pin', pin: '0000' })).statusCode, 401);
  assert.equal((await run(f, { action: 'verify_pin', pin: '0000' })).statusCode, 429);
  assert.deepEqual(f.row(), before);
  assert.equal(f.stats.authWrites.length, 0);
  const other = await run(f, { action: 'verify_pin', pin }, { socket: { remoteAddress: '192.0.2.2' } });
  assert.equal(other.statusCode, 200);
});

for (const options of [{ databaseFailure: true }, { writeFailure: true }, { missing: true }, { conflict: true }, { env: { SUPABASE_SERVICE_ROLE_KEY: '' } }]) {
  test(`no admin success when ${Object.keys(options)[0]} prevents persistence`, async () => {
    const f = fixture(options);
    const res = await run(f, { action: 'verify_pin', pin });
    assert.ok([409, 502, 503].includes(res.statusCode));
    assert.ok(!res.body?.session_token && res.body?.success !== true);
    assert.equal(f.stats.mail.length, 0);
  });
}

test('concurrent logins preserve both persisted sessions', async () => {
  const f = fixture();
  const results = await Promise.all([run(f, { action: 'verify_pin', pin }), run(f, { action: 'verify_pin', pin })]);
  assert.ok(results.every(res => res.statusCode === 200));
  const hashes = JSON.parse(f.row().session_token).map(item => item.hash);
  assert.ok(results.every(res => hashes.includes(tokenHash(res.body.session_token))));
});

test('requireAdmin accepts unexpired hashed/legacy tokens, denies hash reuse and DB errors', async () => {
  const f = fixture({ row: { session_token: JSON.stringify([{ hash: tokenHash(token), exp: Date.parse('2026-11-11T11:00:00Z') }]) } });
  assert.equal(typeof f.auth.requireAdmin, 'function');
  let res = response();
  const valid = await f.auth.requireAdmin(request({}, { headers: { 'x-admin-token': token } }), res);
  assert.ok(valid?.row && valid.sessionHash === tokenHash(token));
  res = response();
  assert.equal(await f.auth.requireAdmin(request({}, { headers: { 'x-admin-token': tokenHash(token) } }), res), null);
  assert.equal(res.statusCode, 401);
  f.setRow({ session_token: token, session_expires_at: '2026-11-11T11:00:00Z' });
  assert.ok(await f.auth.requireAdmin(request({}, { headers: { authorization: `Bearer ${token}` } }), response()));
  f.setRow({ session_expires_at: new Date(f.time()).toISOString() });
  res = response();
  assert.equal(await f.auth.requireAdmin(request({}, { headers: { 'x-admin-token': token } }), res), null);
  assert.equal(res.statusCode, 401);
  const down = fixture({ databaseFailure: true });
  res = response();
  assert.equal(await down.auth.requireAdmin(request({}, { headers: { 'x-admin-token': token } }), res), null);
  assert.equal(res.statusCode, 503);
});

test('logout invalidates only current token and cannot fake success on failed PATCH', async () => {
  const f = fixture();
  const first = await run(f, { action: 'verify_pin', pin });
  const second = await run(f, { action: 'verify_pin', pin });
  const res = await run(f, { action: 'logout' }, { headers: { 'content-type': 'application/json', 'x-admin-token': first.body.session_token } });
  assert.equal(res.statusCode, 200);
  const hashes = JSON.parse(f.row().session_token).map(item => item.hash);
  assert.ok(!hashes.includes(tokenHash(first.body.session_token)));
  assert.ok(hashes.includes(tokenHash(second.body.session_token)));
  const down = fixture({ writeFailure: true, row: { session_token: token, session_expires_at: '2026-11-11T11:00:00Z' } });
  const failure = await run(down, { action: 'logout' }, { headers: { 'content-type': 'application/json', 'x-admin-token': token } });
  assert.equal(failure.statusCode, 502);
  assert.notEqual(failure.body.success, true);
});

test('PIN rotation consumes old sessions and OTP in one conditional PATCH', async () => {
  const f = fixture({ row: { otp_code_hash: legacyHash('123456'), otp_expires_at: '2026-11-10T12:10:00Z', otp_blocked_until: '2026-11-10T12:07:00Z' } });
  const login = await run(f, { action: 'verify_pin', pin });
  const res = await run(f, { action: 'update_pin', current_pin: pin, new_pin: '9021' }, { headers: { 'content-type': 'application/json', 'x-admin-token': login.body.session_token } });
  assert.equal(res.statusCode, 200);
  assert.equal(f.row().session_token, null);
  assert.equal(f.row().otp_code_hash, null);
  assert.equal(f.row().otp_blocked_until, '2026-11-10T12:07:00Z');
  assert.equal(await f.auth.verifyPin('9021', f.row().pin_hash), true);
  const patch = f.stats.authWrites.at(-1);
  assert.ok(patch.body.pin_hash && patch.body.session_token === null && patch.body.otp_code_hash === null);
  assert.ok(patch.query.has('updated_at') && patch.query.has('pin_hash'));
});

test('global per-challenge OTP attempts stop at five and never alter PIN/session', async () => {
  const f = fixture({ row: { otp_code_hash: legacyHash('123456'), otp_expires_at: '2026-11-10T12:10:00Z' } });
  for (let i = 0; i < 6; i++) {
    const res = await run(f, { action: 'verify_otp_and_reset_pin', otp_code: '000000', new_pin: '9021' }, { socket: { remoteAddress: `192.0.2.${i + 1}` } });
    assert.equal(res.statusCode, i < 5 ? 400 : 429);
  }
  assert.equal(f.row().otp_attempts, 5);
  assert.equal(f.row().pin_hash, legacyHash(pin));
  assert.equal(f.row().session_token, null);
  assert.ok(f.stats.authWrites.every(write => write.query.has('otp_attempts') && write.query.has('updated_at')));
});

test('concurrent OTP consume has one winner and invalidates sessions atomically', async () => {
  const f = fixture({ row: { session_token: token, session_expires_at: '2026-11-11T11:00:00Z', otp_code_hash: legacyHash('123456'), otp_expires_at: '2026-11-10T12:10:00Z', otp_blocked_until: '2026-11-10T12:07:00Z' } });
  const results = await Promise.all([
    run(f, { action: 'verify_otp_and_reset_pin', otp_code: '123456', new_pin: '9021' }),
    run(f, { action: 'verify_otp_and_reset_pin', otp_code: '123456', new_pin: '7753' }, { socket: { remoteAddress: '192.0.2.2' } }),
  ]);
  assert.equal(results.filter(res => res.statusCode === 200).length, 1);
  assert.equal(f.row().otp_code_hash, null);
  assert.equal(f.row().session_token, null);
  assert.equal(f.row().otp_blocked_until, '2026-11-10T12:07:00Z');
  assert.ok(f.stats.authWrites.filter(write => write.body.pin_hash).every(write => write.query.has('otp_code_hash') && write.query.has('otp_expires_at') && write.query.has('updated_at')));
});

test('OTP send is idempotent while active and cannot reset attempts or replace code', async () => {
  const f = fixture();
  const first = await run(f, { action: 'send_otp' });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.dispatched, true);
  const oldHash = f.row().otp_code_hash;
  f.setRow({ otp_attempts: 4 });
  f.advance(300001);
  const second = await run(f, { action: 'send_otp' }, { socket: { remoteAddress: '192.0.2.2' } });
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.pending, true);
  assert.equal(f.row().otp_code_hash, oldHash);
  assert.equal(f.row().otp_attempts, 4);
  assert.equal(f.stats.mail.length, 1);
});

test('OTP delivery cooldown survives consume and fixed-window boundary', async () => {
  const f = fixture();
  assert.equal((await run(f, { action: 'send_otp' })).statusCode, 200);
  const consumed = await run(f, { action: 'verify_otp_and_reset_pin', otp_code: f.stats.otp, new_pin: '9021' });
  assert.equal(consumed.statusCode, 200);
  f.advance(2000);
  const second = await run(f, { action: 'send_otp' }, { socket: { remoteAddress: '192.0.2.2' } });
  assert.equal(second.statusCode, 429);
  assert.ok(Number(second.headers['Retry-After']) >= 298);
  assert.equal(f.stats.mail.length, 1);
});

test('OTP global daily cap applies across different IPs', async () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) {
    assert.equal((await run(f, { action: 'send_otp' }, { socket: { remoteAddress: `192.0.2.${i + 1}` } })).statusCode, 200);
    f.advance(600001);
  }
  const limited = await run(f, { action: 'send_otp' }, { socket: { remoteAddress: '192.0.2.7' } });
  assert.equal(limited.statusCode, 429);
  assert.equal(f.stats.mail.length, 6);
});

test('email failure or missing credentials never reports delivery success', async () => {
  for (const options of [{ mailFailure: true }, { env: { RESEND_API_KEY: '' } }]) {
    const f = fixture(options);
    const res = await run(f, { action: 'send_otp' });
    assert.ok([502, 503].includes(res.statusCode));
    assert.notEqual(res.body.success, true);
    assert.equal(f.row().otp_code_hash, null);
    assert.equal(f.stats.logs, 0);
  }
});

function dashboardFunction(name, endMarker, context) {
  const source = read('src/pages/Dashboard.jsx');
  const start = source.indexOf(`  const ${name} = `);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start);
  return runInNewContext(`${source.slice(start, end)}\n${name};`, context);
}

function dashboardContext() {
  const local = new Map([
    ['portfolio_dashboard_cached_events', '[{"id":"private"}]'],
    ['portfolio_dashboard_cached_memories', '[{"id":"private"}]'],
    ['portfolio_telemetry_events', 'visitor-local'],
  ]);
  const session = new Map([['dash_admin_auth_session', JSON.stringify({ auth: true, session_token: token, expires_at: Date.parse('2026-11-11T11:00:00Z') })]]);
  const states = {};
  const context = {
    localStorage: { getItem: key => local.get(key) ?? null, removeItem: key => local.delete(key), setItem: (key, value) => local.set(key, value) },
    sessionStorage: { getItem: key => session.get(key) ?? null, removeItem: key => session.delete(key), setItem: (key, value) => session.set(key, value) },
    SESSION_AUTH_KEY: 'dash_admin_auth_session', CACHE_EVENTS_KEY: 'portfolio_dashboard_cached_events', CACHE_MEMORIES_KEY: 'portfolio_dashboard_cached_memories',
    watermarkRef: { current: 'private-watermark' }, eventsRef: { current: [{ id: 'private' }] }, memoriesRef: { current: [{ id: 'private' }] },
    timeoutsRef: { current: [] }, abortControllerRef: { current: { abort() { states.aborted = true; } } },
    isFetchingRef: { current: true }, failedAttemptsRef: { current: 0 }, authGenerationRef: { current: 0 }, mountedRef: { current: true },
    language: 'id', clearTimeout, Date, AbortController,
  };
  for (const name of ['setIsAuthenticated', 'setEvents', 'setMemories', 'setPinInput', 'setIsLiveConnected', 'setIsLoading', 'setCurrentPinChange', 'setNewPinChange', 'setConfirmPinChange', 'setNewPinInput', 'setOtpInput', 'setAuthError', 'setIsChangePinOpen', 'setIsForgotPinOpen', 'setOtpStep', 'setChangePinMessage', 'setOtpMessage', 'setOtpLoading', 'setLockoutSeconds']) {
    context[name] = value => { states[name] = value; };
  }
  const source = read('src/pages/Dashboard.jsx');
  const start = source.indexOf('function storedAdminSession()');
  const end = source.indexOf('// 16 Individual', start);
  assert.ok(start >= 0 && end > start);
  context.storedAdminSession = runInNewContext(`${source.slice(start, end)}\nstoredAdminSession;`, context);
  context.clearAdminSession = dashboardFunction('clearAdminSession', '  const handleLogout = ', context);
  return { context, local, session, states };
}

test('dashboard logout revokes server token and clears only private cache/state', async () => {
  const ui = dashboardContext();
  const calls = [];
  ui.context.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, async json() { return { success: true }; } }; };
  const logout = dashboardFunction('handleLogout', '  const fetchTelemetryData = ', ui.context);
  await logout();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/admin-otp');
  assert.equal(JSON.parse(calls[0].init.body).action, 'logout');
  assert.equal(calls[0].init.headers['X-Admin-Token'], token);
  assert.equal(ui.local.has('portfolio_dashboard_cached_events'), false);
  assert.equal(ui.local.has('portfolio_dashboard_cached_memories'), false);
  assert.equal(ui.local.get('portfolio_telemetry_events'), 'visitor-local');
  assert.deepEqual(Array.from(ui.states.setEvents), []);
  assert.deepEqual(Array.from(ui.states.setMemories), []);
  assert.equal(ui.states.aborted, true);
});

for (const status of [401, 403]) {
  test(`dashboard ${status} clears private state and does not reuse visitor-local fallback`, async () => {
    const ui = dashboardContext();
    ui.context.isFetchingRef.current = false;
    ui.context.useMemo = fn => fn();
    ui.context.fetch = async () => ({ ok: false, status });
    const fetchData = dashboardFunction('fetchTelemetryData', '  useEffect(() => {', ui.context);
    await fetchData();
    assert.equal(ui.session.size, 0);
    assert.deepEqual(Array.from(ui.states.setEvents), []);
    assert.deepEqual(Array.from(ui.states.setMemories), []);
    assert.equal(ui.local.has('portfolio_dashboard_cached_events'), false);
    assert.equal(ui.local.get('portfolio_telemetry_events'), 'visitor-local');
  });
}

test('late dashboard payload cannot repopulate private data after logout', async () => {
  const ui = dashboardContext();
  ui.context.isFetchingRef.current = false;
  ui.context.useMemo = fn => fn();
  let resolve;
  ui.context.fetch = () => new Promise(done => { resolve = done; });
  const fetchData = dashboardFunction('fetchTelemetryData', '  useEffect(() => {', ui.context);
  const pending = fetchData();
  ui.context.clearAdminSession();
  resolve({ ok: true, status: 200, async json() { return { success: true, events: [{ id: 'late-private' }], memories: [], server_max: 'late' }; } });
  await pending;
  assert.deepEqual(Array.from(ui.states.setEvents), []);
  assert.deepEqual(Array.from(ui.context.eventsRef.current), []);
  assert.equal(ui.local.has('portfolio_dashboard_cached_events'), false);
});

test('dashboard login sends raw PIN over same-origin POST and stores validated expiry only', async () => {
  const ui = dashboardContext();
  ui.context.pinInput = pin;
  ui.context.lockoutSeconds = 0;
  let posted;
  ui.context.fetch = async (url, init) => {
    posted = JSON.parse(init.body);
    return { ok: true, status: 200, async json() { return { verified: true, session_token: token, expires_at: Date.parse('2026-11-11T11:00:00Z') }; } };
  };
  const login = dashboardFunction('handleLogin', '  // 4. Change PIN Handler', ui.context);
  await login({ preventDefault() {} });
  assert.equal(posted.pin, pin);
  assert.equal(Object.hasOwn(posted, 'pin_hash'), false);
  assert.equal(ui.states.setIsAuthenticated, true);
  assert.equal(ui.states.setPinInput, '');
});
