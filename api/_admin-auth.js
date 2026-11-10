import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { databaseRequest, httpError, safeEqual } from './_security.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const TOKEN_PATTERN = /^adm_[a-f0-9]{64}$/;
const PIN_PATTERN = /^\d{4,8}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export function hashToken(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function legacyPinHash(pin) {
  return hashToken(pin + 'rafly_telemetry_salt');
}

async function derivePin(value, algorithm) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(value, Buffer.from(salt, 'hex'), 64, SCRYPT_OPTIONS);
  return `${algorithm}$32768$8$3$${salt}$${key.toString('hex')}`;
}

export async function hashPin(pin) {
  if (typeof pin !== 'string' || !PIN_PATTERN.test(pin)) throw httpError(400, 'PIN harus 4-8 digit angka.');
  return derivePin(pin, 'scrypt');
}

// Wrap legacy hashes without recovering/changing the PIN; a later login upgrades to raw-PIN scrypt.
export async function hashLegacyPinHash(hash) {
  if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) throw httpError(400, 'Format hash lama tidak valid.');
  return derivePin(hash, 'scrypt-sha256');
}

export async function verifyPin(pin, stored) {
  if (typeof pin !== 'string' || !PIN_PATTERN.test(pin) || typeof stored !== 'string') return false;
  if (HASH_PATTERN.test(stored)) return safeEqual(legacyPinHash(pin), stored);
  const parts = /^(scrypt|scrypt-sha256)\$32768\$8\$3\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(stored);
  if (!parts) return false;
  const value = parts[1] === 'scrypt-sha256' ? legacyPinHash(pin) : pin;
  const key = await scrypt(value, Buffer.from(parts[2], 'hex'), 64, SCRYPT_OPTIONS);
  return safeEqual(key.toString('hex'), parts[3]);
}

export async function readAdminRow() {
  const rows = await databaseRequest('admin_auth_config?id=eq.master_auth&select=id,pin_hash,session_token,session_expires_at,otp_code_hash,otp_expires_at,otp_attempts,otp_blocked_until,updated_at');
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.id !== 'master_auth'
      || typeof rows[0].pin_hash !== 'string' || !rows[0].pin_hash || !Number.isFinite(Date.parse(rows[0].updated_at))) {
    throw httpError(503, 'Konfigurasi autentikasi belum tersedia.');
  }
  return rows[0];
}

export async function patchAdminRow(row, changes, { activeOtp = false } = {}) {
  const filters = ['id=eq.master_auth'];
  for (const name of ['pin_hash', 'session_token', 'session_expires_at', 'otp_code_hash', 'otp_expires_at', 'otp_attempts', 'otp_blocked_until', 'updated_at']) {
    const value = row[name];
    filters.push(`${name}=${value == null ? 'is.null' : `eq.${encodeURIComponent(String(value))}`}`);
  }
  if (activeOtp) filters.push(`otp_expires_at=gt.${encodeURIComponent(new Date().toISOString())}`, 'otp_attempts=lt.5');
  const updated = await databaseRequest(`admin_auth_config?${filters.join('&')}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ ...changes, updated_at: new Date().toISOString() }),
  });
  if (!Array.isArray(updated) || updated.length > 1) throw httpError(502, 'Perubahan autentikasi tidak dapat diverifikasi.');
  if (!updated.length) return null;
  if (updated[0]?.id !== 'master_auth') throw httpError(502, 'Perubahan autentikasi tidak dapat diverifikasi.');
  return updated[0];
}

export function activeSessions(row) {
  const raw = row.session_token;
  if (raw == null || raw === '') return [];
  if (typeof raw !== 'string') throw httpError(503, 'Format sesi admin tidak valid.');
  let sessions;
  if (TOKEN_PATTERN.test(raw)) {
    sessions = [{ token: raw, exp: Date.parse(row.session_expires_at) }];
  } else {
    try { sessions = JSON.parse(raw); } catch { throw httpError(503, 'Format sesi admin tidak valid.'); }
    if (!Array.isArray(sessions) || sessions.length > 10) throw httpError(503, 'Format sesi admin tidak valid.');
  }
  const now = Date.now();
  return sessions.filter(session => session && Number.isSafeInteger(session.exp) && session.exp > now
      && ((typeof session.hash === 'string' && HASH_PATTERN.test(session.hash))
          || (typeof session.token === 'string' && TOKEN_PATTERN.test(session.token))))
    .map(session => ({ hash: session.hash || hashToken(session.token), exp: session.exp }));
}

export async function requireAdmin(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  const headerToken = req.headers?.['x-admin-token'];
  const authorization = req.headers?.authorization;
  const bearer = typeof authorization === 'string' ? /^Bearer (adm_[a-f0-9]{64})$/i.exec(authorization)?.[1] : undefined;
  const token = headerToken ?? bearer;
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)
      || (headerToken !== undefined && authorization !== undefined && token !== bearer)) {
    res.status(401).json({ success: false, message: 'Sesi admin tidak ditemukan. Silakan login ulang.' });
    return null;
  }
  try {
    const row = await readAdminRow();
    const sessionHash = hashToken(token);
    const session = activeSessions(row).find(item => safeEqual(item.hash, sessionHash));
    if (!session) {
      res.status(401).json({ success: false, message: 'Sesi admin tidak valid atau telah kedaluwarsa.' });
      return null;
    }
    return { row, sessionHash, expiresAt: session.exp };
  } catch (error) {
    const status = error.statusCode === 502 ? 502 : 503;
    res.status(status).json({ success: false, message: 'Sesi admin tidak dapat diverifikasi. Coba lagi nanti.' });
    return null;
  }
}
