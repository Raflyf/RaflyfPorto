import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(address, prefix, 'ipv4');
blocked.addAddress('168.63.129.16', 'ipv4'); // Azure platform virtual address, not public content.
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3ffe::', 16], ['3fff::', 20],
]) blocked.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

function publicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  // Only native global unicast: excludes mapped/compatible IPv4, NAT64, ULA and link-local.
  if (family !== 6 || !globalV6.check(address, 'ipv6') || blocked.check(address, 'ipv6')) return false;
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [left, right = ''] = canonical.split('::');
  const head = left ? left.split(':') : [], tail = right ? right.split(':') : [];
  const words = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail].map(word => parseInt(word, 16));
  return !((words[4] === 0 || words[4] === 0x200) && words[5] === 0x5efe); // ISATAP tunnel identifier.
}

function publicUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || !/^https?:\/\//i.test(value)
    || /[\u0000-\u0020\u007f\\]/.test(value) || /^https?:\/\/[^/?#]*@/i.test(value)) {
    throw new TypeError('Unsafe public URL');
  }
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (url.username || url.password || !host || url.port === '0') throw new TypeError('Unsafe public URL');
  if (isIP(host)) {
    if (!publicAddress(host)) throw new TypeError('Non-public address');
  } else {
    if (host.length > 253 || !host.includes('.')
      || host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
      || /(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|intranet|test|invalid|onion|arpa)$/.test(host)) {
      throw new TypeError('Non-public hostname');
    }
  }
  return url;
}

// A syntax gate only; fetchPublic validates DNS and every redirect before connecting.
export function isSafePublicUrl(url) {
  try { publicUrl(url); return true; } catch { return false; }
}

const allowedHeaders = new Set(['accept', 'accept-language', 'user-agent', 'cache-control', 'pragma',
  'range', 'if-none-match', 'if-modified-since', 'accept-encoding']);
function limit(value, fallback, maximum, minimum = 1) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new TypeError('Invalid public fetch limit');
  return result;
}

export async function fetchPublic(value, options = {}) {
  let url = publicUrl(value);
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || (options.method !== undefined && options.method !== 'GET') || options.body != null) {
    throw new TypeError('Public fetch supports GET only');
  }
  const maxBytes = limit(options.maxBytes, 2 * 1024 * 1024, 4 * 1024 * 1024);
  const timeoutMs = limit(options.timeoutMs, 10000, 30000);
  const maxRedirects = limit(options.maxRedirects, 3, 3, 0);
  const headers = new Headers(options.headers);
  let headerBytes = 0;
  for (const [name, content] of headers) {
    headerBytes += Buffer.byteLength(name) + Buffer.byteLength(content);
    if (!allowedHeaders.has(name) || headerBytes > 8192) throw new TypeError('Unsupported public fetch header');
  }
  headers.set('accept-encoding', 'identity');
  const external = options.signal;
  if (external != null && !(external instanceof AbortSignal)) throw new TypeError('Invalid abort signal');
  external?.throwIfAborted();
  const controller = new AbortController();
  const signal = controller.signal;
  const forwardAbort = () => controller.abort(external.reason);
  external?.addEventListener('abort', forwardAbort, { once: true });
  let request, response, rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    rejectAbort(signal.reason);
    response?.destroy();
    request?.destroy();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Public fetch deadline exceeded', 'TimeoutError')), timeoutMs);

  const read = async () => {
    for (let redirects = 0; ; redirects++) {
      signal.throwIfAborted();
      const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
      const family = isIP(host);
      const records = family ? [{ address: host, family }] : await lookup(host, { all: true, verbatim: true });
      // Native DNS lookup cannot be cancelled; never open a socket after its deadline.
      signal.throwIfAborted();
      if (!Array.isArray(records) || records.length === 0 || records.some(record =>
        !record || !publicAddress(record.address) || isIP(record.address) !== record.family)) {
        throw new Error('DNS returned a non-public address');
      }
      const selected = records[0];
      response = await new Promise((resolve, reject) => {
        request = (url.protocol === 'https:' ? https : http).request(url, {
          method: 'GET', headers: Object.fromEntries(headers), signal, agent: false,
          family: selected.family, autoSelectFamily: false,
          servername: family ? '' : host, rejectUnauthorized: true, maxHeaderSize: 16384,
          lookup: (_host, opts, callback) => {
            if (typeof opts === 'function') { callback = opts; opts = {}; }
            if (opts.all) callback(null, [{ address: selected.address, family: selected.family }]);
            else callback(null, selected.address, selected.family);
          },
        }, resolve);
        request.once('error', reject);
        request.once('upgrade', (_res, socket) => { socket.destroy(); reject(new Error('Protocol upgrade rejected')); });
        request.end();
      });
      signal.throwIfAborted();
      const status = response.statusCode;
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location !== undefined) {
        response.destroy();
        if (redirects >= maxRedirects) throw new Error('Too many public redirects');
        if (typeof location !== 'string' || location.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(location)
          || /^(?:https?:)?\/\/[^/?#]*@/i.test(location)) throw new Error('Unsafe redirect');
        url = publicUrl(new URL(location, url).href);
        continue;
      }
      const resultHeaders = new Headers();
      for (const [name, content] of Object.entries(response.headers)) {
        if (content !== undefined) for (const item of Array.isArray(content) ? content : [content]) resultHeaders.append(name, item);
      }
      const encoding = resultHeaders.get('content-encoding');
      if (encoding && encoding.trim().toLowerCase() !== 'identity') throw new Error('Compressed public response rejected');
      const length = resultHeaders.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new Error('Public response exceeds byte limit');
      const buffer = Buffer.allocUnsafe(maxBytes);
      let bytes = 0;
      for await (const chunk of response) {
        signal.throwIfAborted();
        if (bytes + chunk.length > maxBytes) throw new Error('Public response exceeds byte limit');
        chunk.copy(buffer, bytes);
        bytes += chunk.length;
      }
      signal.throwIfAborted();
      if (!response.complete) throw new Error('Truncated public response');
      const text = buffer.toString('utf8', 0, bytes);
      return { ok: status >= 200 && status < 300, status, headers: resultHeaders,
        text: async () => text, json: async () => JSON.parse(text) };
    }
  };
  try {
    return await Promise.race([read(), aborted]);
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', forwardAbort);
    signal.removeEventListener('abort', onAbort);
    response?.destroy();
    request?.destroy();
  }
}
