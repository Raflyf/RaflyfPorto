import crypto from 'node:crypto';
import { isIP } from 'node:net';

const DEFAULT_DATABASE = 'https://rphyzcqwpkxtzllvymss.supabase.co';
const CANONICAL_ORIGIN = 'https://raflyf.vercel.app';

export function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

export function databaseConfig() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
  let url;
  try { url = new URL(process.env.SUPABASE_URL || DEFAULT_DATABASE); }
  catch { throw httpError(503, 'Layanan keamanan belum tersedia.'); }
  if (!key || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw httpError(503, 'Layanan keamanan belum tersedia.');
  }
  return { url: url.origin, key };
}

export async function databaseRequest(resource, options = {}) {
  const { url, key } = databaseConfig();
  if (!/^[a-z_][a-z0-9_]*(?:[/?]|$)/i.test(resource) || /[\r\n#]/.test(resource)) throw httpError(500, 'Permintaan database tidak valid.');
  try {
    const res = await fetch(`${url}/rest/v1/${resource}`, {
      ...options,
      redirect: 'error',
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
      headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', Prefer: 'return=representation',
        ...options.headers, apikey: key, Authorization: `Bearer ${key}`,
      },
    });
    if (!res.ok) throw Object.assign(httpError(502, 'Layanan database gagal merespons.'), { upstreamStatus: res.status });
    if (res.status === 204) return null;
    return await res.json();
  } catch (error) {
    if (error.statusCode) throw error;
    throw httpError(503, 'Layanan keamanan tidak dapat dihubungi.');
  }
}

export function applyCors(req, res) {
  const origin = req.headers?.origin;
  const allowed = [process.env.ALLOWED_ORIGIN, CANONICAL_ORIGIN, 'https://raflyfirmansyah-portofolio.vercel.app'];
  if (process.env.VERCEL !== '1') allowed.push('http://localhost:5173', 'http://127.0.0.1:5173');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'private, no-store');
  if (origin !== undefined && (typeof origin !== 'string' || !allowed.includes(origin))) {
    res.status(403).json({ success: false, message: 'Origin tidak diizinkan.' });
    return false;
  }
  res.setHeader('Access-Control-Allow-Origin', origin || process.env.ALLOWED_ORIGIN || CANONICAL_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token');
  return true;
}

export function readJsonBody(req, maxBytes = 16384) {
  const length = req.headers?.['content-length'];
  if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > maxBytes)) throw httpError(413, 'Payload terlalu besar.');
  if (typeof req.headers?.['content-type'] !== 'string' || req.headers['content-type'].split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw httpError(415, 'Gunakan Content-Type application/json.');
  }
  let body;
  try {
    const raw = req.body;
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (typeof text !== 'string') throw httpError(400, 'Payload JSON wajib diisi.');
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw httpError(413, 'Payload terlalu besar.');
    body = JSON.parse(text);
  } catch (error) {
    if (error.statusCode) throw error;
    throw httpError(400, 'Payload JSON tidak valid.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || ['__proto__', 'prototype', 'constructor'].some(k => Object.hasOwn(body, k))) {
    throw httpError(400, 'Payload harus berupa objek JSON.');
  }
  return body;
}

export function getClientIp(req) {
  // Only Vercel may vouch for forwarding headers; local callers use the socket.
  const forwarded = process.env.VERCEL === '1' ? req.headers?.['x-vercel-forwarded-for'] : null;
  const raw = process.env.VERCEL === '1' ? (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') : req.socket?.remoteAddress;
  if (typeof raw !== 'string' || !isIP(raw)) return '';
  return isIP(raw) === 6 ? new URL(`http://[${raw}]/`).hostname.slice(1, -1) : raw;
}

export function signValue(purpose, value) {
  return crypto.createHmac('sha256', databaseConfig().key).update(`${purpose}\0${value}`).digest('base64url');
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export async function enforceRateLimit(req, res, { scope, limit, windowMs, subject }) {
  const now = Date.now();
  const identity = subject ?? getClientIp(req);
  const deny = () => {
    const retry = Math.max(1, Math.ceil((Math.floor(now / windowMs) * windowMs + windowMs - now) / 1000));
    res.setHeader('Retry-After', String(retry));
    res.status(429).json({ success: false, rateLimited: true, retry_after_seconds: retry, message: 'Terlalu banyak permintaan. Coba lagi nanti.' });
    return false;
  };
  try {
    if (!identity || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1000) throw httpError(503, 'Pembatasan permintaan tidak tersedia.');
    const id = `${scope}:${signValue('rate-limit:v1', identity)}`;
    const start = new Date(Math.floor(now / windowMs) * windowMs).toISOString();
    const filter = `client_ip=eq.${encodeURIComponent(id)}&window_start=eq.${encodeURIComponent(start)}`;
    // Unique INSERT and compare-and-swap PATCH serialize admission across instances.
    for (let attempt = 0; attempt < 5; attempt++) {
      const rows = await databaseRequest(`rate_limits?${filter}&select=request_count`);
      if (!Array.isArray(rows) || rows.length > 1) throw httpError(503, 'Pembatasan permintaan tidak tersedia.');
      if (!rows.length) {
        try {
          const created = await databaseRequest('rate_limits', { method: 'POST', body: JSON.stringify({ client_ip: id, window_start: start, request_count: 1, updated_at: new Date(now).toISOString() }) });
          if (!Array.isArray(created) || created.length !== 1) throw httpError(503, 'Pembatasan permintaan tidak tersedia.');
          return true;
        } catch (error) {
          if (error.upstreamStatus === 409) continue;
          throw error;
        }
      }
      const count = rows[0].request_count;
      if (!Number.isSafeInteger(count) || count < 1) throw httpError(503, 'Pembatasan permintaan tidak tersedia.');
      if (count >= limit) return deny();
      const updated = await databaseRequest(`rate_limits?${filter}&request_count=eq.${count}`, { method: 'PATCH', body: JSON.stringify({ request_count: count + 1, updated_at: new Date(now).toISOString() }) });
      if (!Array.isArray(updated) || updated.length > 1) throw httpError(503, 'Pembatasan permintaan tidak tersedia.');
      if (updated.length === 1) return true;
    }
    return deny();
  } catch {
    res.status(503).json({ success: false, message: 'Pembatasan permintaan tidak tersedia. Coba lagi nanti.' });
    return false;
  }
}

export async function readResponseText(response, maxBytes = 2 * 1024 * 1024) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new Error('Upstream response exceeds byte limit');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('Upstream response exceeds byte limit');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function chatSession(req, res, clientId = 'default', reset = false) {
  const cookieName = process.env.VERCEL === '1' ? '__Host-portfolio_chat' : 'portfolio_chat';
  const cookieHeader = typeof req.headers?.cookie === 'string' ? req.headers.cookie : '';
  const values = cookieHeader.split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`));
  let token = values.length === 1 ? values[0].slice(cookieName.length + 1) : '';
  const parts = token.split('.');
  const now = Math.floor(Date.now() / 1000);
  const valid = parts.length === 3 && /^[A-Za-z0-9_-]{43}$/.test(parts[0]) && /^\d{10}$/.test(parts[1])
    && Number(parts[1]) <= now && now - Number(parts[1]) < 2592000 && safeEqual(parts[2], signValue('chat-cookie:v1', `${parts[0]}.${parts[1]}`));
  if (reset || !valid) {
    const payload = `${crypto.randomBytes(32).toString('base64url')}.${now}`;
    token = `${payload}.${signValue('chat-cookie:v1', payload)}`;
    res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${process.env.VERCEL === '1' ? '; Secure' : ''}`);
  }
  return `web_v2_${signValue('chat-session:v1', `${token.split('.')[0]}:${clientId}`)}`;
}
