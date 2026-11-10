import { applyCors, databaseRequest, enforceRateLimit, httpError } from './_security.js';
import { requireAdmin } from './_admin-auth.js';

export default async function handler(req, res) {
  if (!applyCors(req, res)) return;
  if (req.method === 'OPTIONS') return res.status(200).end();
  res.setHeader('Allow', 'GET, OPTIONS');
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    if (!(await enforceRateLimit(req, res, { scope: 'dashboard', subject: admin.sessionHash, limit: 60, windowMs: 60000 }))) return;
    const since = req.query?.since;
    if (since !== undefined && (typeof since !== 'string' || since.length > 40 || !Number.isFinite(Date.parse(since)))) throw httpError(400, 'Waktu awal tidak valid.');
    const incremental = Boolean(since);
    const snapshot = new Date(Date.now() - 1000).toISOString();
    const cutoff = incremental ? new Date(since).toISOString() : new Date(Date.now() - 90 * 86400000).toISOString();
    const filter = `created_at=gte.${encodeURIComponent(cutoff)}&created_at=lte.${encodeURIComponent(snapshot)}`;
    const order = incremental ? 'asc' : 'desc';
    async function rows(table, columns, maximum) {
      const all = [];
      while (all.length < maximum) {
        const size = Math.min(1000, maximum - all.length);
        const batch = await databaseRequest(`${table}?select=${columns}&${filter}&order=created_at.${order},id.${order}&offset=${all.length}&limit=${size}`);
        if (!Array.isArray(batch) || batch.length > size) throw httpError(502, 'Respons data tidak valid.');
        all.push(...batch);
        if (batch.length < size) break;
      }
      return all;
    }
    const [events, memories] = await Promise.all([
      rows('portfolio_telemetry', 'id,event_type,event_target,event_label,device_type,screen_resolution,referrer,session_id,created_at', incremental ? 2000 : 10000),
      rows('ai_memories', 'id,fact_text,session_id,created_at', incremental ? 1000 : 3000),
    ]);
    const boundaries = [snapshot];
    if (incremental && events.length === 2000) boundaries.push(events.at(-1).created_at);
    if (incremental && memories.length === 1000) boundaries.push(memories.at(-1).created_at);
    const serverMax = boundaries.sort()[0];
    // gte replays the boundary timestamp; client merges by id so ties are not lost.
    return res.status(200).json({ success: true, incremental, events, memories, server_max: serverMax });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, message: 'Gagal mengambil data dashboard.' });
  }
}
