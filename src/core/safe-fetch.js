// SiteGrab — (c) 2026 Salih Avcioglu. MIT License.
// SSRF-hardened fetch: only public http(s) targets, every redirect hop re-checked,
// response size capped while streaming, per-request timeout, AbortSignal aware.
import net from 'node:net';
import { lookup } from 'node:dns/promises';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const DEFAULT_HEADERS = {
  'user-agent': USER_AGENT,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

const MAX_REDIRECTS = 5;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_TIMEOUT = 30_000;

const privateAllowed = () => process.env.ALLOW_PRIVATE_HOSTS === '1';

export class BlockedUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlockedUrlError';
    this.code = 'EBLOCKED';
  }
}

export class MaxBytesError extends Error {
  constructor(limit) {
    super(`Size limit exceeded (${limit} bytes)`);
    this.name = 'MaxBytesError';
    this.code = 'EMAXBYTES';
  }
}

// ---------- IP classification ----------

const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([ip, bits]) => [v4ToInt(ip), bits]);

function v4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) | Number(octet)) >>> 0, 0);
}

function isPrivateV4(ip) {
  const n = v4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

/** Expands an IPv6 string (may contain an embedded dotted IPv4 tail) to 8 numeric hextets. */
function expandV6(ip) {
  let addr = ip.split('%')[0].toLowerCase();
  const v4Tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4Tail) {
    const n = v4ToInt(v4Tail[1]);
    addr = addr.slice(0, -v4Tail[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = addr.includes('::') ? Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map((x) => parseInt(x, 16) || 0);
}

const embeddedV4 = (hx, i) =>
  `${hx[i] >> 8}.${hx[i] & 0xff}.${hx[i + 1] >> 8}.${hx[i + 1] & 0xff}`;

function isPrivateV6(ip) {
  const hx = expandV6(ip);
  const zeroPrefix = (n) => hx.slice(0, n).every((x) => x === 0);
  if (zeroPrefix(8)) return true; // ::
  if (zeroPrefix(7) && hx[7] === 1) return true; // ::1
  if (zeroPrefix(5) && hx[5] === 0xffff) return isPrivateV4(embeddedV4(hx, 6)); // ::ffff:a.b.c.d
  if (zeroPrefix(6)) return isPrivateV4(embeddedV4(hx, 6)); // ::a.b.c.d (deprecated)
  if (hx[0] === 0x64 && hx[1] === 0xff9b) return isPrivateV4(embeddedV4(hx, 6)); // NAT64
  if (hx[0] === 0x2002) return isPrivateV4(embeddedV4(hx, 1)); // 6to4
  if ((hx[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((hx[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((hx[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((hx[0] & 0xff00) === 0xff00) return true; // multicast
  if (hx[0] === 0x2001 && hx[1] === 0x0db8) return true; // documentation
  if (hx[0] === 0x2001 && hx[1] === 0) return true; // Teredo
  return false;
}

/** True for any loopback/private/link-local/CGNAT/multicast/reserved address. */
export function isPrivateIp(ip) {
  const kind = net.isIP(ip.split('%')[0]);
  if (kind === 4) return isPrivateV4(ip);
  if (kind === 6) return isPrivateV6(ip);
  return true; // not an IP at all: treat as unsafe
}

// ---------- URL validation ----------

/**
 * Validates that `input` is an http(s) URL pointing at a public host (DNS checked).
 * Returns the parsed URL. Throws BlockedUrlError otherwise.
 */
export async function assertPublicUrl(input) {
  let url;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(String(input));
  } catch {
    throw new BlockedUrlError('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError(`Protocol not allowed: ${url.protocol}`);
  }
  if (url.username || url.password) throw new BlockedUrlError('Credentials in URL are not allowed');
  if (privateAllowed()) return url;

  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) throw new BlockedUrlError('Missing host');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new BlockedUrlError(`Host not allowed: ${host}`);
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new BlockedUrlError(`Address not allowed: ${host}`);
    return url;
  }
  let addresses;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new BlockedUrlError(`Could not resolve host: ${host}`);
  }
  if (!addresses.length) throw new BlockedUrlError(`Could not resolve host: ${host}`);
  for (const { address } of addresses) {
    if (isPrivateIp(address)) throw new BlockedUrlError(`Host ${host} resolves to a private address`);
  }
  return url;
}

// ---------- fetch ----------

/** Combines the caller's signal with a timeout; returns the merged signal and a disposer. */
function withTimeout(signal, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`Request timed out after ${Math.round(ms / 1000)}s`)), ms);
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  err.cause = reason;
  return err;
}

async function readBody(res, maxBytes, onData) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new MaxBytesError(maxBytes);
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new MaxBytesError(maxBytes);
      onData?.(value.byteLength);
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
  return Buffer.concat(chunks, total);
}

/**
 * Fetches a public URL. Follows up to 5 redirects manually, validating every hop.
 * Resolves to { url, status, ok, headers, contentType, body: Buffer }.
 * Bodies of non-2xx responses are discarded (body is empty).
 *
 * Options: signal, maxBytes (default 100 MB), timeout ms (default 30s, covers headers + body),
 * headers (merged over browser-like defaults), onData(chunkBytes) — may throw to abort.
 */
export async function safeFetch(input, { signal, maxBytes = 100 * 1024 * 1024, timeout = DEFAULT_TIMEOUT, headers, onData } = {}) {
  if (signal?.aborted) throw abortError(signal);
  const timed = withTimeout(signal, timeout);
  const reqHeaders = { ...DEFAULT_HEADERS, ...lowerKeys(headers) };
  try {
    let url = await assertPublicUrl(input);
    for (let hop = 0; ; hop++) {
      const res = await fetch(url, { redirect: 'manual', signal: timed.signal, headers: reqHeaders });
      const location = res.headers.get('location');
      if (REDIRECT_CODES.has(res.status) && location) {
        await res.body?.cancel().catch(() => {});
        if (hop >= MAX_REDIRECTS) throw new Error('Too many redirects');
        url = await assertPublicUrl(new URL(location, url));
        continue;
      }
      const base = {
        url: url.href,
        status: res.status,
        ok: res.ok,
        headers: res.headers,
        contentType: res.headers.get('content-type') || '',
      };
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return { ...base, body: Buffer.alloc(0) };
      }
      return { ...base, body: await readBody(res, maxBytes, onData) };
    }
  } catch (err) {
    if (signal?.aborted) throw abortError(signal);
    if (timed.signal.aborted && timed.signal.reason instanceof Error) throw timed.signal.reason;
    throw err;
  } finally {
    timed.dispose();
  }
}

function lowerKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v != null) out[k.toLowerCase()] = String(v);
  return out;
}
