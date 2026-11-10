import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const src = readFileSync(new URL('../api/_security.js', import.meta.url), 'utf8');
const response = () => ({
  headers: {}, statusCode: 0,
  setHeader(k, v) { this.headers[k] = v; },
  status(s) { this.statusCode = s; return this; },
  json(b) { this.body = b; return this; },
});
function fixture(fetch = () => { throw new Error('Network forbidden'); }, env = {}) {
  return runInNewContext(`${src.replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '')}\n({getClientIp,readJsonBody,databaseRequest,enforceRateLimit,chatSession,signValue,applyCors});`, {
    crypto, isIP, Buffer, URL, AbortSignal, fetch,
    process: { env: { SUPABASE_URL: 'https://database.invalid', SUPABASE_SERVICE_ROLE_KEY: 'offline-private-key', ...env } },
  });
}
function store() {
  const rows = new Map();
  return { rows, async fetch(raw, options) {
    const u = new URL(raw);
    assert.equal(u.origin, 'https://database.invalid');
    assert.equal(u.pathname, '/rest/v1/rate_limits');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    const method = options.method || 'GET';
    const value = options.body ? JSON.parse(options.body) : null;
    const id = method === 'POST' ? `${value.client_ip}/${value.window_start}` : `${u.searchParams.get('client_ip').slice(3)}/${u.searchParams.get('window_start').slice(3)}`;
    const snapshot = rows.get(id);
    if (method === 'GET') return { ok: true, status: 200, json: async () => snapshot ? [{ request_count: snapshot.request_count }] : [] };
    if (method === 'POST') {
      if (snapshot) return { ok: false, status: 409 };
      rows.set(id, value);
      return { ok: true, status: 201, json: async () => [value] };
    }
    assert.equal(method, 'PATCH');
    const wanted = Number(u.searchParams.get('request_count').slice(3));
    if (!snapshot || snapshot.request_count !== wanted) return { ok: true, status: 200, json: async () => [] };
    rows.set(id, { ...snapshot, ...value });
    return { ok: true, status: 200, json: async () => [rows.get(id)] };
  } };
}
const request = ip => ({ headers: { 'content-type': 'application/json' }, socket: { remoteAddress: ip } });

test('distributed admission never exceeds quota under a concurrent create/update race', async () => {
  const db = store();
  const instances = Array.from({ length: 20 }, () => fixture(db.fetch));
  const results = await Promise.all(instances.map(api => api.enforceRateLimit(request('198.51.100.1'), response(), { scope: 'test', limit: 3, windowMs: 86400000 })));
  assert.equal(results.filter(Boolean).length, 3);
  assert.equal([...db.rows.values()][0].request_count, 3);
  assert.ok(![...db.rows.keys()][0].includes('198.51.100.1'));
});

test('limits isolate callers and scopes and fail closed on datastore errors', async () => {
  const db = store(); const api = fixture(db.fetch);
  for (const [ip, scope, allowed] of [['198.51.100.1','login',true], ['198.51.100.1','login',false], ['198.51.100.2','login',true], ['198.51.100.1','chat',true]]) {
    const res = response();
    assert.equal(await api.enforceRateLimit(request(ip), res, { scope, limit: 1, windowMs: 60000 }), allowed);
    if (!allowed) { assert.equal(res.statusCode, 429); assert.ok(Number(res.headers['Retry-After']) >= 1); }
  }
  for (const fetch of [async () => { throw new Error('secret network error'); }, async () => ({ok:false,status:500}), async () => ({ok:true,status:200,json:async()=>({})})]) {
    const res = response();
    assert.equal(await fixture(fetch).enforceRateLimit(request('198.51.100.9'), res, {scope:'test',limit:1,windowMs:60000}), false);
    assert.equal(res.statusCode, 503);
    assert.ok(!JSON.stringify(res.body).includes('secret'));
  }
});

test('forwarded headers are ignored outside Vercel and malformed trusted IPs fail closed', () => {
  const req = {headers:{'x-vercel-forwarded-for':'198.51.100.1', 'x-forwarded-for':'198.51.100.2'},socket:{remoteAddress:'127.0.0.1'}};
  assert.equal(fixture().getClientIp(req), '127.0.0.1');
  assert.equal(fixture(undefined,{VERCEL:'1'}).getClientIp(req), '198.51.100.1');
  assert.equal(fixture(undefined,{VERCEL:'1'}).getClientIp({headers:{'x-vercel-forwarded-for':'not-an-ip'}}), '');
});

test('JSON trust boundary enforces type, UTF8 size, and content-type before work', () => {
  const api = fixture();
  for (const body of ['{', 'null', '[]', '{"__proto__":{}}', 1, undefined]) {
    assert.throws(() => api.readJsonBody({...request('127.0.0.1'),body}), {statusCode:400});
  }
  assert.throws(() => api.readJsonBody({headers:{'content-type':'text/plain'},body:'{}'}), {statusCode:415});
  assert.throws(() => api.readJsonBody({...request('127.0.0.1'),body:{value:'é'.repeat(40)}},50), {statusCode:413});
  assert.equal(api.readJsonBody({...request('127.0.0.1'),body:'{"ok":true}'}).ok, true);
});

test('chat identity requires server-signed HttpOnly cookie, not caller-chosen telemetry id', () => {
  const api = fixture(undefined,{VERCEL:'1'});
  const req = {headers:{}};
  const a = response(); const b = response();
  const id = api.chatSession(req,a,'same-public-id');
  const other = api.chatSession(req,b,'same-public-id');
  assert.notEqual(id, other);
  assert.match(a.headers['Set-Cookie'], /__Host-portfolio_chat=.*; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000; Secure/);
  const cookie = a.headers['Set-Cookie'].split(';')[0];
  assert.equal(api.chatSession({headers:{cookie}},response(),'same-public-id'), id);
  assert.notEqual(api.chatSession({headers:{cookie}},response(),'different-chat'), id);
  assert.notEqual(api.chatSession({headers:{cookie:cookie.slice(0,-1)+'x'}},response(),'same-public-id'), id);
  assert.notEqual(api.chatSession({headers:{cookie:`${cookie}; ${cookie}`}},response(),'same-public-id'), id);
});
