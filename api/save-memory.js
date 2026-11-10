import { applyCors, databaseRequest, enforceRateLimit, httpError, readJsonBody, signValue } from './_security.js';
import { requireAdmin } from './_admin-auth.js';

export default async function handler(req, res) {
  if (!applyCors(req, res)) return;
  if (req.method === 'OPTIONS') return res.status(200).end();
  res.setHeader('Allow', 'POST, OPTIONS');
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
  try {
    const body = readJsonBody(req, 50 * 1024);
    if (!(await requireAdmin(req, res))) return;
    if (Object.keys(body).some(k => !['fact_text', 'session_id'].includes(k))) throw httpError(400, 'Parameter tidak dikenal.');
    if (typeof body.fact_text !== 'string') throw httpError(400, 'Fakta memori harus berupa teks.');
    const fact = body.fact_text.trim();
    if (fact.length < 5 || fact.length > 1000) throw httpError(400, 'Fakta memori harus 5-1000 karakter.');
    if (body.session_id !== undefined && (typeof body.session_id !== 'string' || body.session_id.length > 64)) throw httpError(400, 'session_id tidak valid.');
    if (!(await enforceRateLimit(req, res, { scope: 'admin-memory', limit: 5, windowMs: 60000 }))) return;
    // Sign admin-approved facts; existing visitor-authored rows never become trusted by migration.
    const rows = await databaseRequest('ai_memories', {
      method: 'POST',
      body: JSON.stringify({ fact_text: fact, session_id: `trusted_v1:${signValue('shared-memory:v1', fact)}`, created_at: new Date().toISOString() }),
    });
    if (!Array.isArray(rows) || rows.length !== 1) throw httpError(502, 'Gagal menyimpan memori.');
    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, message: error.statusCode ? error.message : 'Gagal menyimpan memori.' });
  }
}
