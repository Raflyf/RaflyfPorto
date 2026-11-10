import { databaseRequest, safeEqual, signValue } from './_security.js';

const SESSION_ID = /^web_v2_[A-Za-z0-9_-]{43}$/;
const chatId = value => {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new Error('Identitas sesi tidak valid.');
  return encodeURIComponent(value);
};

export async function saveMessage({ sessionId, role, content, via = null, tokens = null, latencyMs = null }) {
  chatId(sessionId);
  if (!['user', 'assistant'].includes(role) || typeof content !== 'string' || !content) return false;
  const body = { platform: 'web', chat_id: sessionId, role, content: content.slice(0, 20000), via };
  if (tokens) {
    for (const [key, column] of [['prompt', 'prompt_tokens'], ['completion', 'completion_tokens'], ['total', 'total_tokens']]) {
      if (Number.isSafeInteger(tokens[key]) && tokens[key] >= 0) body[column] = tokens[key];
    }
  }
  if (Number.isFinite(latencyMs)) body.latency_ms = Math.max(0, Math.round(latencyMs));
  await databaseRequest('messages', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(body) });
  return true;
}

export async function getContext(sessionId, limit = 24) {
  const id = chatId(sessionId);
  const [messages, summaries, corrections] = await Promise.all([
    databaseRequest(`messages?chat_id=eq.${id}&platform=eq.web&select=role,content,via,created_at&order=created_at.desc&limit=${Math.max(1, Math.min(24, limit))}`),
    databaseRequest(`summaries?chat_id=eq.${id}&select=summary&limit=1`),
    databaseRequest(`corrections?chat_id=eq.${id}&select=correction&order=created_at.desc&limit=5`),
  ]);
  if (![messages, summaries, corrections].every(Array.isArray)) throw new Error('Konteks database tidak valid.');
  return {
    messages: messages.reverse().filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string').map(m => ({role:m.role, content:m.content})),
    summary: typeof summaries[0]?.summary === 'string' ? summaries[0].summary : '',
    corrections: corrections.map(c => c.correction).filter(c => typeof c === 'string'),
  };
}

export async function saveSummary(sessionId, summary) {
  chatId(sessionId);
  if (typeof summary !== 'string' || !summary) return false;
  await databaseRequest('summaries', { method:'POST', headers:{Prefer:'resolution=merge-duplicates,return=minimal'}, body:JSON.stringify({chat_id:sessionId,summary:summary.slice(0,4000),updated_at:new Date().toISOString()}) });
  return true;
}

export async function countMessages(sessionId) {
  const rows = await databaseRequest(`messages?chat_id=eq.${chatId(sessionId)}&platform=eq.web&select=id&order=created_at.desc&limit=24`);
  if (!Array.isArray(rows)) throw new Error('Riwayat database tidak valid.');
  return rows.length;
}

export async function fetchMemories(limit = 25) {
  const rows = await databaseRequest(`ai_memories?session_id=like.trusted_v1%3A*&select=fact_text,session_id&order=created_at.desc&limit=${Math.max(1,Math.min(50,limit))}`);
  if (!Array.isArray(rows)) throw new Error('Memori database tidak valid.');
  return rows.filter(row => typeof row.fact_text === 'string' && row.fact_text.length >= 5 && row.fact_text.length <= 1000
    && safeEqual(row.session_id, `trusted_v1:${signValue('shared-memory:v1',row.fact_text)}`)).map(row => row.fact_text);
}

export function isResetCommand(text) {
  return ['/reset', '/clear', '/new', 'reset percakapan', 'mulai baru'].includes(String(text || '').trim().toLowerCase());
}
