import crypto from 'node:crypto';
import { applyCors, readJsonBody, enforceRateLimit, httpError, safeEqual } from './_security.js';
import { readAdminRow, patchAdminRow, hashPin, verifyPin, hashToken, activeSessions, requireAdmin } from './_admin-auth.js';

const TARGET_EMAIL = 'raflyfirmansyah02@gmail.com';
const OTP_TTL = 10 * 60 * 1000;
const OTP_COOLDOWN = 5 * 60 * 1000;
const PIN_PATTERN = /^\d{4,8}$/;
const ACTION_FIELDS = {
  verify_pin: ['pin'], send_otp: [], verify_otp_and_reset_pin: ['otp_code', 'new_pin'],
  update_pin: ['current_pin', 'new_pin'], logout: [], get_auth_state: [],
};

function retryLater(res, milliseconds) {
  const retry = Math.max(1, Math.ceil(milliseconds / 1000));
  res.setHeader('Retry-After', String(retry));
  return res.status(429).json({ success: false, retry_after_seconds: retry, message: 'Terlalu banyak permintaan. Coba lagi nanti.' });
}

async function dispatchEmail(otpCode) {
  const subject = `[Admin Security] Kode OTP Reset Master PIN: ${otpCode}`;
  const text = `Halo Rafly Firmansyah,\n\nKODE OTP: ${otpCode}\n\nKode berlaku 10 menit. Jangan berikan kode ini kepada siapapun. Jika Anda tidak meminta pemulihan PIN, abaikan pesan ini.`;
  const resend = process.env.RESEND_API_KEY;
  const publicKey = process.env.EMAILJS_PUBLIC_KEY || process.env.EMAILJS_USER_ID;
  let url, payload, headers;
  if (resend) {
    url = 'https://api.resend.com/emails';
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${resend}` };
    payload = { from: `Portfolio Security <${process.env.RESEND_FROM || 'onboarding@resend.dev'}>`, to: [TARGET_EMAIL], subject, text };
  } else if (process.env.EMAILJS_SERVICE_ID && process.env.EMAILJS_TEMPLATE_ID && publicKey) {
    url = 'https://api.emailjs.com/api/v1.0/email/send';
    headers = { 'Content-Type': 'application/json' };
    payload = {
      service_id: process.env.EMAILJS_SERVICE_ID, template_id: process.env.EMAILJS_TEMPLATE_ID, user_id: publicKey,
      template_params: { to_email: TARGET_EMAIL, to_name: 'Rafly Firmansyah', otp_code: otpCode, message: text, subject },
      ...(process.env.EMAILJS_PRIVATE_KEY ? { accessToken: process.env.EMAILJS_PRIVATE_KEY } : {}),
    };
  } else {
    throw httpError(503, 'Layanan email pemulihan belum tersedia.');
  }
  try {
    const result = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!result.ok) throw httpError(502, 'Penyedia email menolak permintaan OTP.');
    if (resend) {
      let data;
      try { data = await result.json(); } catch { throw httpError(502, 'Penerimaan email tidak dapat diverifikasi.'); }
      if (typeof data?.id !== 'string' || !data.id) throw httpError(502, 'Penerimaan email tidak dapat diverifikasi.');
    }
    return { dispatched: true, provider: resend ? 'resend' : 'emailjs' };
  } catch (error) {
    if (error.statusCode) throw error;
    throw httpError(503, 'Penyedia email tidak dapat dihubungi.');
  }
}

export default async function handler(req, res) {
  if (!applyCors(req, res)) return;
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
  }
  try {
    const body = readJsonBody(req);
    const action = body.action;
    if (typeof action !== 'string' || !Object.hasOwn(ACTION_FIELDS, action)
        || Object.keys(req.query || {}).length
        || Object.keys(body).some(key => key !== 'action' && !ACTION_FIELDS[action].includes(key))) {
      throw httpError(400, 'Aksi atau parameter tidak valid.');
    }
    for (const name of ACTION_FIELDS[action]) {
      const pattern = name === 'otp_code' ? /^\d{6}$/ : PIN_PATTERN;
      if (typeof body[name] !== 'string' || !pattern.test(body[name])) throw httpError(400, name === 'otp_code' ? 'OTP harus 6 digit angka.' : 'PIN harus 4-8 digit angka.');
    }

    if (action === 'verify_pin') {
      if (!await enforceRateLimit(req, res, { scope: 'admin-pin', limit: 5, windowMs: 15 * 60 * 1000 })) return;
      const token = 'adm_' + crypto.randomBytes(32).toString('hex');
      const exp = Date.now() + 24 * 60 * 60 * 1000;
      let migrated;
      for (let attempt = 0; attempt < 3; attempt++) {
        const row = await readAdminRow();
        if (!await verifyPin(body.pin, row.pin_hash)) throw httpError(401, 'Master PIN tidak valid.');
        const sessions = [...activeSessions(row), { hash: hashToken(token), exp }].slice(-10);
        const changes = { session_token: JSON.stringify(sessions), session_expires_at: new Date(Math.max(...sessions.map(s => s.exp))).toISOString() };
        if (!row.pin_hash.startsWith('scrypt$')) changes.pin_hash = migrated ||= await hashPin(body.pin);
        if (await patchAdminRow(row, changes)) {
          return res.status(200).json({ success: true, verified: true, session_token: token, expires_at: exp, message: 'Autentikasi Master PIN berhasil.' });
        }
      }
    } else if (action === 'logout' || action === 'get_auth_state' || action === 'update_pin') {
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      if (!await enforceRateLimit(req, res, { scope: action === 'update_pin' ? 'admin-pin' : 'admin-session', limit: action === 'update_pin' ? 5 : 60, windowMs: action === 'update_pin' ? 15 * 60 * 1000 : 60000 })) return;
      if (action === 'get_auth_state') return res.status(200).json({ success: true, authenticated: true, expires_at: auth.expiresAt });
      let replacement;
      for (let attempt = 0; attempt < 3; attempt++) {
        const row = attempt === 0 ? auth.row : await readAdminRow();
        const sessions = activeSessions(row);
        if (!sessions.some(session => safeEqual(session.hash, auth.sessionHash))) throw httpError(401, 'Sesi admin telah kedaluwarsa.');
        let changes;
        if (action === 'logout') {
          const remaining = sessions.filter(session => !safeEqual(session.hash, auth.sessionHash));
          changes = { session_token: remaining.length ? JSON.stringify(remaining) : null, session_expires_at: remaining.length ? new Date(Math.max(...remaining.map(s => s.exp))).toISOString() : null };
        } else {
          if (!await verifyPin(body.current_pin, row.pin_hash)) throw httpError(403, 'Master PIN aktif tidak valid.');
          replacement ||= await hashPin(body.new_pin);
          changes = { pin_hash: replacement, session_token: null, session_expires_at: null, otp_code_hash: null, otp_expires_at: null, otp_attempts: 0 };
        }
        if (await patchAdminRow(row, changes)) return res.status(200).json({ success: true, message: action === 'logout' ? 'Sesi admin telah diakhiri.' : 'Master PIN diperbarui. Silakan login ulang.' });
      }
    } else if (action === 'verify_otp_and_reset_pin') {
      if (!await enforceRateLimit(req, res, { scope: 'admin-otp-verify', limit: 5, windowMs: OTP_TTL })) return;
      let replacement;
      for (let attempt = 0; attempt < 3; attempt++) {
        const row = await readAdminRow();
        const expiry = Date.parse(row.otp_expires_at);
        if (!row.otp_code_hash || !Number.isFinite(expiry) || expiry <= Date.now()) throw httpError(400, 'OTP tidak aktif atau telah kedaluwarsa.');
        if (!Number.isSafeInteger(row.otp_attempts) || row.otp_attempts < 0) throw httpError(503, 'Status OTP tidak dapat diverifikasi.');
        if (row.otp_attempts >= 5) return retryLater(res, expiry - Date.now());
        const valid = await verifyPin(body.otp_code, row.otp_code_hash);
        let changes = { otp_attempts: row.otp_attempts + 1 };
        if (valid) {
          replacement ||= await hashPin(body.new_pin);
          changes = { pin_hash: replacement, session_token: null, session_expires_at: null, otp_code_hash: null, otp_expires_at: null, otp_attempts: 0 };
        }
        if (await patchAdminRow(row, changes, { activeOtp: true })) {
          if (!valid) throw httpError(400, 'Kode OTP tidak valid.');
          return res.status(200).json({ success: true, message: 'Master PIN direset dan semua sesi diakhiri.' });
        }
      }
    } else if (action === 'send_otp') {
      if (!await enforceRateLimit(req, res, { scope: 'admin-otp-send-ip', limit: 3, windowMs: OTP_TTL })) return;
      let row = await readAdminRow();
      const pending = value => value.otp_code_hash && Date.parse(value.otp_expires_at) > Date.now();
      if (pending(row)) return res.status(200).json({ success: true, pending: true, dispatched: false, expires_at: row.otp_expires_at, message: 'OTP masih aktif. Gunakan kode sebelumnya.' });
      // otp_blocked_until is delivery cooldown, never a PIN/OTP verification lock.
      const cooldown = value => Math.max(Date.parse(value.otp_blocked_until) || 0, (Date.parse(value.otp_expires_at) || 0) - OTP_TTL + OTP_COOLDOWN);
      if (cooldown(row) > Date.now()) return retryLater(res, cooldown(row) - Date.now());
      const publicKey = process.env.EMAILJS_PUBLIC_KEY || process.env.EMAILJS_USER_ID;
      if (!process.env.RESEND_API_KEY && !(process.env.EMAILJS_SERVICE_ID && process.env.EMAILJS_TEMPLATE_ID && publicKey)) throw httpError(503, 'Layanan email pemulihan belum tersedia.');
      if (!await enforceRateLimit(req, res, { scope: 'admin-otp-send-min', subject: 'admin-email', limit: 1, windowMs: OTP_COOLDOWN })) return;
      if (!await enforceRateLimit(req, res, { scope: 'admin-otp-send-day', subject: 'admin-email', limit: 6, windowMs: 86400000 })) return;
      const otpCode = crypto.randomInt(100000, 1000000).toString();
      const otpHash = await hashPin(otpCode);
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) row = await readAdminRow();
        if (pending(row)) return res.status(200).json({ success: true, pending: true, dispatched: false, expires_at: row.otp_expires_at, message: 'OTP masih aktif. Gunakan kode sebelumnya.' });
        if (cooldown(row) > Date.now()) return retryLater(res, cooldown(row) - Date.now());
        const saved = await patchAdminRow(row, { otp_code_hash: otpHash, otp_expires_at: new Date(Date.now() + OTP_TTL).toISOString(), otp_attempts: 0, otp_blocked_until: new Date(Date.now() + OTP_COOLDOWN).toISOString() });
        if (!saved) continue;
        try {
          const result = await dispatchEmail(otpCode);
          return res.status(200).json({ success: true, ...result, expires_at: saved.otp_expires_at, message: 'Permintaan OTP diterima penyedia email. Berlaku 10 menit.' });
        } catch (error) {
          // Keep cooldown after failed delivery; never clear a newer challenge.
          for (let cleanup = 0; cleanup < 3; cleanup++) {
            const current = await readAdminRow();
            if (current.otp_code_hash !== otpHash) break;
            if (await patchAdminRow(current, { otp_code_hash: null, otp_expires_at: null, otp_attempts: 0 })) break;
          }
          throw error;
        }
      }
    }
    throw httpError(409, 'Status autentikasi berubah. Coba lagi.');
  } catch (error) {
    const status = [400, 401, 403, 409, 413, 415, 502, 503].includes(error.statusCode) ? error.statusCode : 503;
    return res.status(status).json({ success: false, verified: false, message: error.statusCode ? error.message : 'Layanan autentikasi tidak tersedia.' });
  }
}
