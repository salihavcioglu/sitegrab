// SiteGrab — (c) 2026 Salih Avcioglu. MIT License.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {
  normalizeUrl, urlToLocalPath, sanitizeSegment, safeJoin, relativeLink, mapSrcset, rewriteCss,
} from '../../src/core/crawler.js';

const root = 'example.com';
const map = (url, type) => urlToLocalPath(url, { rootHost: root, type });

test('normalizeUrl strips hash, credentials and dangling ?, dedupes default ports', () => {
  assert.equal(normalizeUrl('HTTP://Example.COM:80/a/../b?#x'), 'http://example.com/b');
  assert.equal(normalizeUrl('https://u:p@example.com/x#frag'), 'https://example.com/x');
  assert.equal(normalizeUrl('/c?d=1#e', 'https://example.com/a/b'), 'https://example.com/c?d=1');
  assert.equal(normalizeUrl('mailto:a@b.c'), null);
  assert.equal(normalizeUrl('javascript:void 0'), null);
  assert.equal(normalizeUrl('http://['), null);
});

test('maps URLs to deterministic local paths', () => {
  assert.equal(map('https://example.com/', 'html'), 'index.html');
  assert.equal(map('https://example.com/blog/', 'html'), 'blog/index.html');
  assert.equal(map('https://example.com/about', 'html'), 'about.html');
  assert.equal(map('https://example.com/page.php', 'html'), 'page.php.html');
  assert.equal(map('https://example.com/a/b.htm', 'html'), 'a/b.htm');
  assert.equal(map('https://example.com/img/logo.png'), 'img/logo.png');
  assert.equal(map('https://cdn.other.net:8443/lib.js'), '_ext/cdn.other.net_8443/lib.js');
  const q1 = map('https://example.com/s.css?v=1', 'css');
  const q2 = map('https://example.com/s.css?v=2', 'css');
  assert.match(q1, /^s_[0-9a-f]{8}\.css$/);
  assert.notEqual(q1, q2);
  assert.equal(q1, map('https://example.com/s.css?v=1', 'css'));
  assert.match(map('https://fonts.example.com/css2?family=Inter', 'css'), /^_ext\/fonts\.example\.com\/css2_[0-9a-f]{8}\.css$/);
  assert.equal(urlToLocalPath('https://example.com/pic', { rootHost: root, contentType: 'image/png' }), 'pic.png');
});

test('path mapping never escapes the output dir', () => {
  const nasty = [
    'https://example.com/%2e%2e/%2e%2e/etc/passwd',
    'https://example.com/..%2f..%2fwin.ini',
    'https://example.com/a/%2E%2E%5C%2E%2E%5Cboot.ini',
    'https://example.com/%00evil',
    'https://example.com/C:%5CWindows%5Cx.dll',
    'https://example.com/con',
    'https://example.com/' + 'x'.repeat(500) + '.png',
  ];
  const out = path.join(os.tmpdir(), 'sitegrab-out');
  for (const url of nasty) {
    const rel = map(url);
    for (const seg of rel.split('/')) {
      assert.ok(seg && seg !== '..' && seg !== '.', `${url} -> ${rel}`);
      assert.ok(!/[<>:"\|?*\x00-\x1f]/.test(seg), `${url} -> ${rel}`);
      assert.ok(seg.length <= 100);
    }
    assert.ok(safeJoin(out, rel).startsWith(out + path.sep));
  }
  assert.equal(sanitizeSegment('con'), '_con');
  assert.equal(sanitizeSegment('..'), '_');
  assert.throws(() => safeJoin(out, '../escape.txt'));
  assert.throws(() => safeJoin(out, 'a/../../escape.txt'));
});

test('relativeLink builds encoded relative paths', () => {
  assert.equal(relativeLink('index.html', 'css/a.css'), 'css/a.css');
  assert.equal(relativeLink('blog/post.html', 'index.html'), '../index.html');
  assert.equal(relativeLink('blog/post.html', 'blog/post.html'), 'post.html');
  assert.equal(relativeLink('a.html', 'img/my pic#1.png'), 'img/my%20pic%231.png');
});

test('mapSrcset handles descriptors and commas in URLs', () => {
  const up = (u) => u.toUpperCase();
  assert.equal(mapSrcset('a.png 1x, b.png 2x', up), 'A.PNG 1x, B.PNG 2x');
  assert.equal(mapSrcset('a.png 1x,b.png 2x', up), 'A.PNG 1x, B.PNG 2x');
  assert.equal(mapSrcset('a.png, b.png 2x', up), 'A.PNG, B.PNG 2x');
  assert.equal(mapSrcset('https://x/c_1,w_2/a.png 480w,  b.png 800w', up), 'HTTPS://X/C_1,W_2/A.PNG 480w, B.PNG 800w');
});

test('rewriteCss rewrites url() and @import', () => {
  const css = `@import "a.css"; @import url('b.css'); .x{background:url( img/x.png )} .y{src:url(data:font/woff2;base64,AA)}`;
  const seen = [];
  const out = rewriteCss(css, (raw, kind) => {
    seen.push([raw, kind]);
    return raw.startsWith('data:') ? null : { value: `L/${raw}` };
  });
  assert.deepEqual(seen.map((s) => s[1]), ['css', 'asset', 'asset', 'asset']);
  assert.equal(out, `@import "L/a.css"; @import url("L/b.css"); .x{background:url("L/img/x.png")} .y{src:url(data:font/woff2;base64,AA)}`);
});
