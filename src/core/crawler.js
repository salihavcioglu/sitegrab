// SiteGrab — (c) 2026 Salih Avcioglu. MIT License.
// Website crawler: downloads pages + their requisites into outDir and rewrites links
// so the copy works offline. Two phases:
//   1. fetch everything (BFS, bounded concurrency), saving HTML/CSS as decoded UTF-8 text;
//   2. once the final URL -> file map is known, rewrite links in every saved HTML/CSS file.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { safeFetch } from './safe-fetch.js';

const MB = 1024 * 1024;
const MAX_SEGMENT = 100;
const MAX_DIR_DEPTH = 30;

// ---------- URL helpers ----------

/** Resolves `input` against `base`, keeps only http(s), strips hash/credentials. Returns href or null. */
export function normalizeUrl(input, base) {
  let u;
  try {
    u = new URL(String(input).trim(), base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.username = '';
  u.password = '';
  if (!u.search) u.search = ''; // drop a dangling "?"
  return u.href;
}

const SKIP_SCHEME = /^(?:data|javascript|mailto|tel|sms|blob|about|file|ftp):/i;

function resolveLink(raw, base) {
  const value = raw.trim();
  if (!value || value.startsWith('#') || SKIP_SCHEME.test(value)) return null;
  try {
    const u = new URL(value, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

const shortHash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 8);

// ---------- URL -> local path mapping ----------

const RESERVED_WIN = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const VALID_EXT = /^\.[a-z0-9]{1,8}$/i;

const MIME_EXT = {
  'text/html': '.html', 'application/xhtml+xml': '.html', 'text/css': '.css',
  'application/javascript': '.js', 'text/javascript': '.js', 'application/x-javascript': '.js',
  'application/json': '.json', 'application/manifest+json': '.webmanifest', 'application/xml': '.xml',
  'text/xml': '.xml', 'text/plain': '.txt', 'application/pdf': '.pdf',
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/avif': '.avif', 'image/svg+xml': '.svg', 'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico',
  'image/bmp': '.bmp', 'font/woff': '.woff', 'font/woff2': '.woff2', 'font/ttf': '.ttf', 'font/otf': '.otf',
  'application/font-woff': '.woff', 'application/font-woff2': '.woff2', 'application/x-font-ttf': '.ttf',
  'application/vnd.ms-fontobject': '.eot', 'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg', 'audio/wav': '.wav', 'text/vtt': '.vtt',
};

/** Makes one decoded path segment safe on every filesystem (no traversal, no reserved names). */
export function sanitizeSegment(segment) {
  let s;
  try {
    s = decodeURIComponent(segment);
  } catch {
    s = segment;
  }
  s = s.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').replace(/[\s.]+$/, '').replace(/^\s+/, '');
  if (!s || /^\.+$/.test(s)) s = '_';
  if (RESERVED_WIN.test(s)) s = `_${s}`;
  if (s.length > MAX_SEGMENT) {
    const ext = path.extname(s);
    const keepExt = VALID_EXT.test(ext) ? ext : '';
    s = `${s.slice(0, MAX_SEGMENT - keepExt.length - 9)}_${shortHash(s)}${keepExt}`;
  }
  return s;
}

function mimeOf(contentType) {
  return (contentType || '').split(';')[0].trim().toLowerCase();
}

/** Classifies a response as 'html', 'css' or 'other' using Content-Type, falling back to the extension. */
export function detectType(contentType, url) {
  const mime = mimeOf(contentType);
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  if (mime === 'text/css') return 'css';
  if (!mime || mime === 'application/octet-stream' || mime === 'text/plain') {
    const ext = path.posix.extname(new URL(url).pathname).toLowerCase();
    if (ext === '.css') return 'css';
    if (ext === '.html' || ext === '.htm') return 'html';
  }
  return 'other';
}

/**
 * Deterministically maps a URL to a relative POSIX path inside the output dir.
 * Same-site URLs map to their path; other hosts go under _ext/<host>/.
 * Directories become index.html, query strings are hashed into the filename,
 * and HTML/CSS always get a matching extension.
 */
export function urlToLocalPath(url, { rootHost, type = 'other', contentType = '' } = {}) {
  const u = new URL(url);
  const parts = u.pathname.split('/').slice(1);
  const last = parts.pop() ?? '';
  const dirs = parts.filter(Boolean).map(sanitizeSegment).slice(0, MAX_DIR_DEPTH);

  let name = last ? sanitizeSegment(last) : 'index';
  let ext = path.posix.extname(name);
  if (!VALID_EXT.test(ext) || ext === name) ext = '';
  let stem = ext ? name.slice(0, -ext.length) : name;
  if (u.search) stem += `_${shortHash(u.search)}`;

  const lowerExt = ext.toLowerCase();
  if (type === 'html' && lowerExt !== '.html' && lowerExt !== '.htm') {
    stem += ext;
    ext = '.html';
  } else if (type === 'css' && lowerExt !== '.css') {
    stem += ext;
    ext = '.css';
  } else if (!ext) {
    ext = MIME_EXT[mimeOf(contentType)] ?? '';
  }
  name = stem + ext;

  const prefix = rootHost && u.host !== rootHost ? ['_ext', sanitizeSegment(u.host)] : [];
  return [...prefix, ...dirs, name].join('/');
}

/** Resolves a relative POSIX path inside `root`, refusing anything that escapes it. */
export function safeJoin(root, rel) {
  const base = path.resolve(root);
  const abs = path.resolve(base, ...rel.split('/'));
  if (!abs.startsWith(base + path.sep)) throw new Error(`Refusing to write outside output dir: ${rel}`);
  return abs;
}

/** Relative, URL-encoded link from one local file to another. */
export function relativeLink(fromFile, toFile) {
  const rel = path.posix.relative(path.posix.dirname(fromFile), toFile) || path.posix.basename(toFile);
  return rel
    .split('/')
    .map((seg) => (seg === '..' ? seg : encodeURIComponent(seg)))
    .join('/');
}

// ---------- link extraction / rewriting ----------

/** Maps every URL in a srcset attribute through `fn` (which returns a replacement or null). */
export function mapSrcset(value, fn) {
  const out = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value[i])) i++;
    if (i >= value.length) break;
    const start = i;
    while (i < value.length && !/\s/.test(value[i])) i++;
    let url = value.slice(start, i);
    let desc = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      const d = i;
      let depth = 0;
      while (i < value.length && (value[i] !== ',' || depth > 0)) {
        if (value[i] === '(') depth++;
        else if (value[i] === ')') depth--;
        i++;
      }
      desc = value.slice(d, i).trim();
    }
    out.push((fn(url) ?? url) + (desc ? ` ${desc}` : ''));
  }
  return out.join(', ');
}

const CSS_REF_RE = /(@import\s+)(?:"([^"]*)"|'([^']*)')|url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi;

/** Calls visit(raw, kind) for each @import / url() in CSS; replaces it when visit returns {value}. */
export function rewriteCss(css, visit) {
  return css.replace(CSS_REF_RE, (match, imp, i1, i2, u1, u2, u3) => {
    if (imp !== undefined) {
      const r = visit(i1 ?? i2, 'css');
      return r ? `${imp}"${r.value}"` : match;
    }
    const r = visit(u1 ?? u2 ?? u3 ?? '', 'asset');
    return r ? `url("${r.value}")` : match;
  });
}

const ASSET_REL = /(?:^|\s)(?:icon|shortcut|apple-touch-icon|apple-touch-icon-precomposed|apple-touch-startup-image|mask-icon|manifest|preload|modulepreload|image_src)(?:\s|$)/i;
const NON_RESOURCE_REL = /(?:^|\s)(?:dns-prefetch|preconnect)(?:\s|$)/i;
const LAZY_ATTRS = ['data-src', 'data-lazy-src', 'data-original'];

/**
 * Walks every link-bearing attribute of a parsed document.
 * visit(raw, kind) → { value, local } | null, kinds: 'page' | 'asset' | 'css' | 'ref'.
 * When a value is replaced with a local path, integrity/crossorigin are removed.
 */
function walkHtml($, visit) {
  const handle = (el, attr, kind, isSrcset = false) => {
    const raw = el.attribs[attr];
    if (raw == null) return;
    let local = false;
    let changed = false;
    const apply = (v) => {
      const r = visit(v, kind);
      if (!r) return null;
      if (r.local) local = true;
      if (r.value !== v) changed = true;
      return r.value;
    };
    const next = isSrcset ? mapSrcset(raw, apply) : apply(raw) ?? raw;
    if (changed) el.attribs[attr] = next;
    if (local) {
      delete el.attribs.integrity;
      delete el.attribs.crossorigin;
    }
  };
  const cssVisit = (raw, kind) => visit(raw, kind);

  $('*').each((_, el) => {
    const a = el.attribs || {};
    switch (el.name) {
      case 'a':
      case 'area':
        handle(el, 'href', 'page');
        break;
      case 'iframe':
      case 'frame':
        handle(el, 'src', 'page');
        break;
      case 'link': {
        const rel = a.rel || '';
        if (/(?:^|\s)stylesheet(?:\s|$)/i.test(rel)) handle(el, 'href', 'css');
        else if (ASSET_REL.test(rel)) handle(el, 'href', 'asset');
        else if (!NON_RESOURCE_REL.test(rel)) handle(el, 'href', 'ref');
        if (a.imagesrcset) handle(el, 'imagesrcset', 'asset', true);
        break;
      }
      case 'script':
      case 'embed':
      case 'track':
      case 'audio':
        handle(el, 'src', 'asset');
        break;
      case 'img':
      case 'source':
        handle(el, 'src', 'asset');
        handle(el, 'srcset', 'asset', true);
        handle(el, 'data-srcset', 'asset', true);
        for (const attr of LAZY_ATTRS) handle(el, attr, 'asset');
        break;
      case 'video':
        handle(el, 'src', 'asset');
        handle(el, 'poster', 'asset');
        break;
      case 'input':
        if ((a.type || '').toLowerCase() === 'image') handle(el, 'src', 'asset');
        break;
      case 'object':
        handle(el, 'data', 'asset');
        break;
      case 'image':
      case 'use':
        handle(el, 'href', 'asset');
        handle(el, 'xlink:href', 'asset');
        break;
      case 'form':
        handle(el, 'action', 'ref');
        break;
      case 'body':
      case 'table':
      case 'td':
      case 'th':
        handle(el, 'background', 'asset');
        break;
      case 'meta':
        if ((a['http-equiv'] || '').toLowerCase() === 'refresh' && a.content) {
          const m = /^(\s*[\d.]+\s*[;,]\s*url\s*=\s*)(['"]?)(.*?)\2\s*$/i.exec(a.content);
          if (m) {
            const r = visit(m[3], 'page');
            if (r) el.attribs.content = `${m[1]}${r.value}`;
          }
        }
        break;
      case 'style': {
        const css = $(el).text();
        const out = rewriteCss(css, cssVisit);
        if (out !== css) $(el).text(out);
        break;
      }
    }
    if (a.style) {
      const out = rewriteCss(a.style, cssVisit);
      if (out !== a.style) el.attribs.style = out;
    }
  });
}

function loadHtml(html) {
  // scriptingEnabled:false parses <noscript> content as markup so its images are found.
  return cheerio.load(html, { scriptingEnabled: false });
}

function documentBase($, pageUrl) {
  const href = $('base[href]').first().attr('href');
  return (href && resolveLink(href, pageUrl)?.href) || pageUrl;
}

// ---------- charset ----------

function decodeText(buf, contentType, type) {
  let charset = /charset=["']?([\w.:-]+)/i.exec(contentType || '')?.[1];
  if (!charset) {
    const head = buf.subarray(0, 2048).toString('latin1');
    charset =
      type === 'html'
        ? /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1]
        : /^@charset\s+["']([\w.:-]+)["']/i.exec(head)?.[1];
  }
  if (buf[0] === 0xff && buf[1] === 0xfe) charset = 'utf-16le';
  else if (buf[0] === 0xfe && buf[1] === 0xff) charset = 'utf-16be';
  try {
    return new TextDecoder(charset || 'utf-8').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

/** Saved text is always UTF-8, so declarations in the document must say so. */
function forceUtf8Meta($) {
  let found = false;
  $('meta[charset]').each((_, el) => {
    el.attribs.charset = 'utf-8';
    found = true;
  });
  $('meta[http-equiv]').each((_, el) => {
    if ((el.attribs['http-equiv'] || '').toLowerCase() === 'content-type') {
      el.attribs.content = 'text/html; charset=utf-8';
      found = true;
    }
  });
  if (!found) $('head').prepend('<meta charset="utf-8">');
}

// ---------- crawler ----------

function makeAbortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

const stripWww = (host) => host.replace(/^www\./i, '');

/**
 * Crawls `url` into `outDir`.
 * Resolves to { pages, files, bytes, errors: [{ url, message }] }.
 * Rejects with an AbortError if `signal` aborts (in-flight work is drained first).
 */
export async function crawl({
  url,
  outDir,
  maxDepth = 2,
  maxPages = 200,
  maxBytes = 100 * MB,
  maxFiles = 10_000,
  singlePage = false,
  sameHostOnly = true,
  concurrency = 6,
  timeout = 30_000,
  signal,
  onProgress,
} = {}) {
  const startUrl = normalizeUrl(url);
  if (!startUrl) throw new Error('Invalid start URL');
  if (!outDir) throw new Error('outDir is required');
  if (signal?.aborted) throw makeAbortError(signal);
  await mkdir(outDir, { recursive: true });

  const emit = (event) => {
    try {
      onProgress?.(event);
    } catch {
      /* listener errors must not break the crawl */
    }
  };
  const log = (level, message) => emit({ type: 'log', level, message });

  const stats = { pages: 0, files: 0, bytes: 0 };
  const errors = [];
  const urlToFile = new Map(); // normalized URL -> relative local path
  const textFiles = []; // { rel, baseUrl, type } to rewrite in phase 2
  const queued = new Set();
  const usedFiles = new Set();
  const usedDirs = new Set();
  const pageQueue = [];
  const assetQueue = [];
  const siteHosts = new Set([stripWww(new URL(startUrl).host)]);
  let rootHost = new URL(startUrl).host;
  let pagesQueued = 0;
  let inflightBytes = 0;
  let stopped = false;
  let budgetLogged = false;

  const isSiteHost = (host) => siteHosts.has(stripWww(host));

  function enqueue(rawUrl, kind, depth, referrer) {
    if (stopped || kind === 'ref') return;
    const key = normalizeUrl(rawUrl);
    if (!key || queued.has(key)) return;
    if (kind === 'page') {
      if (singlePage || depth > maxDepth || pagesQueued >= maxPages) return;
      if (sameHostOnly && !isSiteHost(new URL(key).host)) return;
      pagesQueued++;
      queued.add(key);
      pageQueue.push({ url: key, kind, depth, referrer });
    } else {
      if (queued.size >= maxFiles * 2) return;
      queued.add(key);
      assetQueue.push({ url: key, kind, depth, referrer });
    }
  }

  function allocatePath(candidate, url) {
    let cand = candidate;
    for (let n = 2; ; n++) {
      const lower = cand.toLowerCase();
      const segs = lower.split('/');
      const ancestors = segs.slice(0, -1).map((_, i) => segs.slice(0, i + 1).join('/'));
      if (ancestors.some((d) => usedFiles.has(d))) {
        // A file already occupies one of our parent directories; move aside.
        cand = `_x/${shortHash(url)}_${path.posix.basename(cand)}`;
        continue;
      }
      if (!usedFiles.has(lower) && !usedDirs.has(lower)) {
        usedFiles.add(lower);
        ancestors.forEach((d) => usedDirs.add(d));
        return cand;
      }
      const ext = path.posix.extname(candidate);
      cand = `${candidate.slice(0, candidate.length - ext.length)}-${n}${ext}`;
    }
  }

  async function saveFile(rel, data) {
    const abs = safeJoin(outDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, data);
  }

  function discoverHtml(text, pageUrl, depth) {
    const $ = loadHtml(text);
    const base = documentBase($, pageUrl);
    walkHtml($, (raw, kind) => {
      const abs = resolveLink(raw, base);
      if (abs) enqueue(abs.href, kind, kind === 'page' ? depth + 1 : depth, pageUrl);
      return null;
    });
  }

  function discoverCss(text, cssUrl, depth) {
    rewriteCss(text, (raw, kind) => {
      const abs = resolveLink(raw, cssUrl);
      if (abs) enqueue(abs.href, kind, depth, cssUrl);
      return null;
    });
  }

  async function processItem(item) {
    let myBytes = 0;
    let res;
    try {
      res = await safeFetch(item.url, {
        signal,
        timeout,
        maxBytes: Math.max(0, maxBytes - stats.bytes),
        headers: {
          accept: item.kind === 'page' ? undefined : '*/*',
          referer: item.referrer,
        },
        onData(n) {
          myBytes += n;
          inflightBytes += n;
          if (stats.bytes + inflightBytes > maxBytes) {
            const err = new Error('Size limit reached');
            err.code = 'EMAXBYTES';
            throw err;
          }
        },
      });
    } catch (err) {
      if (signal?.aborted) throw makeAbortError(signal);
      if (err.code === 'EMAXBYTES') {
        stopped = true;
        if (!budgetLogged) {
          budgetLogged = true;
          log('warn', `Size limit of ${Math.round(maxBytes / MB)} MB reached; stopping.`);
        }
        return;
      }
      errors.push({ url: item.url, message: err.message });
      log('warn', `Failed ${item.url}: ${err.message}`);
      return;
    } finally {
      inflightBytes -= myBytes;
    }

    if (!res.ok) {
      errors.push({ url: item.url, message: `HTTP ${res.status}` });
      log('warn', `HTTP ${res.status} for ${item.url}`);
      return;
    }

    const finalKey = normalizeUrl(res.url);
    if (item.url === startUrl) {
      rootHost = new URL(finalKey).host;
      siteHosts.add(stripWww(rootHost));
    }
    const existing = urlToFile.get(finalKey);
    if (existing) {
      urlToFile.set(item.url, existing); // redirected onto something already saved
      return;
    }
    if (stats.files >= maxFiles) {
      stopped = true;
      return;
    }

    const type = detectType(res.contentType, finalKey);
    const rel = allocatePath(urlToLocalPath(finalKey, { rootHost, type, contentType: res.contentType }), finalKey);
    urlToFile.set(item.url, rel);
    urlToFile.set(finalKey, rel);
    queued.add(finalKey);

    const isPage = type === 'html' && item.kind === 'page';
    if (isPage || type === 'css') {
      const text = decodeText(res.body, res.contentType, type);
      await saveFile(rel, text);
      textFiles.push({ rel, baseUrl: finalKey, type });
      if (isPage) {
        stats.pages++;
        discoverHtml(text, finalKey, item.depth);
      } else {
        discoverCss(text, finalKey, item.depth);
      }
    } else {
      await saveFile(rel, res.body);
    }
    stats.files++;
    stats.bytes += res.body.length;
    emit({
      type: 'file',
      url: finalKey,
      path: rel,
      bytes: res.body.length,
      pages: stats.pages,
      files: stats.files,
      totalBytes: stats.bytes,
    });
  }

  // Phase 1: bounded-concurrency queue; requisites before further pages.
  enqueue(startUrl, 'page', 0);
  if (!queued.has(startUrl)) {
    // singlePage/maxDepth rules never block the start page itself.
    queued.add(startUrl);
    pageQueue.push({ url: startUrl, kind: 'page', depth: 0 });
  }
  const workers = Math.max(1, Math.min(16, concurrency));
  await new Promise((resolve, reject) => {
    let active = 0;
    let failure = null;
    const settle = () => {
      if (active > 0) return;
      if (failure) reject(failure);
      else if (stopped || (!assetQueue.length && !pageQueue.length)) resolve();
    };
    const pump = () => {
      if (!failure && signal?.aborted) failure = makeAbortError(signal);
      // Only the start page runs until it finishes, so rootHost is known before mapping other URLs.
      const limit = stats.files === 0 && urlToFile.size === 0 ? 1 : workers;
      while (!failure && !stopped && active < limit) {
        const item = assetQueue.shift() ?? pageQueue.shift();
        if (!item) break;
        active++;
        processItem(item).then(
          () => {
            active--;
            pump();
          },
          (err) => {
            active--;
            failure ??= err;
            pump();
          },
        );
      }
      settle();
    };
    pump();
  });

  // Phase 2: rewrite links now that every downloaded URL has a local path.
  const resolverFor = (fromRel, base) => (raw, kind) => {
    const abs = resolveLink(raw, base);
    if (!abs) return null;
    const target = urlToFile.get(normalizeUrl(abs.href));
    if (target) return { value: relativeLink(fromRel, target) + abs.hash, local: true };
    return { value: abs.href, local: false };
  };

  for (const { rel, baseUrl, type } of textFiles) {
    if (signal?.aborted) throw makeAbortError(signal);
    const abs = safeJoin(outDir, rel);
    const text = await readFile(abs, 'utf8');
    let out;
    if (type === 'html') {
      const $ = loadHtml(text);
      const base = documentBase($, baseUrl);
      walkHtml($, resolverFor(rel, base));
      $('base').each((_, el) => {
        delete el.attribs.href;
        if (!Object.keys(el.attribs).length) $(el).remove();
      });
      forceUtf8Meta($);
      out = $.html();
    } else {
      out = rewriteCss(text, resolverFor(rel, baseUrl)).replace(/^﻿?@charset\s+["'][^"']*["']\s*;/i, '@charset "UTF-8";');
    }
    await writeFile(abs, out, 'utf8');
  }

  // Convenience entry point when the start page isn't at the root.
  const startFile = urlToFile.get(startUrl);
  if (startFile && !usedFiles.has('index.html') && !usedDirs.has('index.html')) {
    const href = relativeLink('index.html', startFile);
    await saveFile(
      'index.html',
      `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${href}"><a href="${href}">Open site</a>\n`,
    );
  }

  return { ...stats, errors };
}
