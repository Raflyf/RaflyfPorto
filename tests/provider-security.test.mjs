import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const security = read('api/_security.js');
const helper = security.slice(security.indexOf('export async function readResponseText('), security.indexOf('export function chatSession(')).replace(/^export /gm, '');
const source = read('api/_providers.js').replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '');

test('provider streams/errors are capped, redirects blocked, and lifetimes cleaned', async () => {
  for (const adapter of ['streamSse', 'opencodeChat']) {
    for (const mode of ['success', 'oversized', 'error']) {
      const timers = new Set();
      const listeners = new Set();
      const signal = { aborted: false, addEventListener(_type, fn) { listeners.add(fn); }, removeEventListener(_type, fn) { listeners.delete(fn); } };
      let requestSignal, redirect, cancelled = 0, released = 0;
      const small = Buffer.from('data: {"choices":[{"delta":{"content":"hello"}}]}\n');
      const chunks = [mode === 'success' ? small : Buffer.alloc(2 * 1024 * 1024 + 1, 65)];
      const reader = { async read() { return chunks.length ? { value: chunks.shift(), done: false } : { done: true }; }, async cancel() { cancelled++; }, releaseLock() { released++; } };
      const context = {
        crypto, Buffer, URL, Headers, TextDecoder, AbortController,
        process: { env: {} }, console: { log() {}, warn() {}, error() {} },
        setTimeout(fn) { const id = { fn }; timers.add(id); return id; }, clearTimeout(id) { timers.delete(id); },
        async fetch(_url, init) {
          requestSignal = init.signal; redirect = init.redirect;
          return { ok: mode !== 'error', status: mode === 'error' ? 429 : 200, headers: new Headers(), body: { getReader: () => reader, async cancel() {} } };
        },
      };
      const api = runInNewContext(`${helper}\n${source}\n({streamSse,opencodeChat,openAiDelta,openAiUsage});`, context);
      const call = adapter === 'streamSse'
        ? api.streamSse('https://provider.invalid', {}, {}, { firstTokenMs: 10, idleMs: 10, totalMs: 20 }, api.openAiDelta, api.openAiUsage, signal)
        : api.opencodeChat('offline', 'offline-model', [{ role: 'user', content: 'hello' }], 20, signal);
      if (mode === 'success') assert.equal((await call).text, 'hello');
      else await assert.rejects(call, /(?:TOO_LARGE|byte limit)/);
      assert.equal(redirect, 'error');
      assert.equal(requestSignal.aborted, true);
      assert.equal(timers.size, 0);
      assert.equal(listeners.size, 0);
      assert.equal(cancelled, 1);
      assert.equal(released, 1);
    }
  }
});
