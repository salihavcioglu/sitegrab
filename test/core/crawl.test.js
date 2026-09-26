// SiteGrab — (c) 2026 Salih Avcioglu. MIT License.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm, access } from 'node:fs/promises';
import { crawl } from '../../src/core/crawler.js';

process.env.ALLOW_PRIVATE_HOSTS = '1';

const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
let site;
let cdn;
let SITE;
let CDN;
const tmpDirs = [];

const tmp = async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'sitegrab-test-'));
  tmpDirs.push(d);
  return d;
};
const exists = (p) => access(p).then(() => true, () => false);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function routes() {
  const html = (body) => [
    'text/html; charset=utf-8',
    `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`,
  ];
  return {
    '/': html(`
      <link rel="stylesheet" href="/css/style.css?v=1" integrity="sha384-abc" crossorigin="anonymous">
      <script src="${CDN}/lib.js" integrity="sha384-def" crossorigin></script>
      <img src="/img/logo.png" srcset="/img/logo.png 1x, /img/logo@2x.png 2x" alt="">
      <div style="background:url('/img/bg.png')"></div>
      <a href="/about">About</a> <a href="/about#team">Team</a> <a href="#top">Top</a>
      <a href="/deep/one">Deep</a> <a href="/redirect">Redirect</a> <a href="/missing">Missing</a>
      <a href="https://unreachable.invalid/page">External</a> <a href="mailto:x@y.z">Mail</a>
      <a href="/base-page">Base</a> <a href="${CDN}/other-page">Other host page</a>`),
    '/about': html(`<a href="/">Home</a><a href="deep/one">Deep</a><style>.a{background:url(/img/bg.png)}</style>`),
    '/deep/one': html(`<a href="/deep/two">Two</a>`),
    '/deep/two': html(`<a href="/deep/three">Three</a><img src="../img/logo.png">`),
    '/deep/three': html(`deepest`),
    '/base-page': html(`<base href="/sub/"><img src="pic.png"><a href="../about">About</a>`),
    '/sub/pic.png': ['image/png', binary],
    '/css/style.css': ['text/css', `@import "print.css";\nbody{background:url(../img/bg.png)}\n@font-face{src:url("/fonts/f.woff2")}`],
    '/css/print.css': ['text/css', `p{color:red}`],
    '/img/logo.png': ['image/png', binary],
    '/img/logo@2x.png': ['image/png', binary],
    '/img/bg.png': ['image/png', binary],
    '/fonts/f.woff2': ['font/woff2', binary],
  };
}

before(async () => {
  cdn = http.createServer((req, res) => {
    if (req.url === '/lib.js') return res.writeHead(200, { 'content-type': 'application/javascript' }).end('console.log(1)');
    if (req.url === '/other-page') return res.writeHead(200, { 'content-type': 'text/html' }).end('<p>other</p>');
    res.writeHead(404).end();
  });
  site = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/redirect') return res.writeHead(302, { location: '/about' }).end();
    if (pathname === '/slow') return setTimeout(() => res.end('x'), 5000);
    const r = routes()[pathname];
    if (!r) return res.writeHead(404, { 'content-type': 'text/html' }).end('nope');
    res.writeHead(200, { 'content-type': r[0] }).end(r[1]);
  });
  await new Promise((r) => cdn.listen(0, '127.0.0.1', r));
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  SITE = `http://127.0.0.1:${site.address().port}`;
  CDN = `http://127.0.0.1:${cdn.address().port}`;
});

after(async () => {
  site.closeAllConnections?.();
  site.close();
  cdn.close();
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

test('end-to-end crawl downloads pages + requisites and rewrites links', async () => {
  const outDir = await tmp();
  const events = [];
  const result = await crawl({ url: `${SITE}/`, outDir, maxDepth: 2, onProgress: (e) => events.push(e) });
  const read = (p) => readFile(path.join(outDir, p), 'utf8');

  const cdnDir = `_ext/127.0.0.1_${cdn.address().port}`;
  const files = (await readdir(outDir, { recursive: true })).map((f) => f.replaceAll('\\', '/'));
  const cssFile = files.find((f) => /^css\/style_[0-9a-f]{8}\.css$/.test(f));
  assert.ok(cssFile, `hashed css file missing: ${files}`);

  for (const f of ['index.html', 'about.html', 'deep/one.html', 'deep/two.html', 'base-page.html', 'sub/pic.png',
    'css/print.css', 'img/logo.png', 'img/logo@2x.png', 'img/bg.png', 'fonts/f.woff2', `${cdnDir}/lib.js`]) {
    assert.ok(await exists(path.join(outDir, f)), `missing ${f}`);
  }
  assert.equal(await exists(path.join(outDir, 'deep/three.html')), false, 'depth limit exceeded');
  assert.equal(await exists(path.join(outDir, `${cdnDir}/other-page.html`)), false, 'cross-host page followed');

  assert.deepEqual(await readFile(path.join(outDir, 'img/logo.png')), binary, 'binary corrupted');

  const index = await read('index.html');
  assert.match(index, new RegExp(`href="${esc(cssFile)}"`));
  assert.doesNotMatch(index, /integrity|crossorigin/);
  assert.match(index, new RegExp(`src="${esc(cdnDir)}/lib.js"`));
  assert.match(index, /srcset="img\/logo.png 1x, img\/logo%402x.png 2x"/);
  assert.match(index, /url\((&quot;|")img\/bg.png(&quot;|")\)/);
  assert.match(index, /href="about.html">About/);
  assert.match(index, /href="about.html#team"/);
  assert.match(index, /href="#top"/);
  assert.match(index, /href="about.html">Redirect/, 'redirected link maps to saved page');
  assert.match(index, new RegExp(`href="${esc(SITE)}/missing"`), '404 link stays absolute');
  assert.match(index, /href="https:\/\/unreachable.invalid\/page"/);
  assert.match(index, new RegExp(`href="${esc(CDN)}/other-page"`));
  assert.match(index, /href="mailto:x@y.z"/);

  const about = await read('about.html');
  assert.match(about, /href="index.html"/);
  assert.match(about, /href="deep\/one.html"/);
  assert.match(about, /<style>.a\{background:url\("img\/bg.png"\)\}<\/style>/);

  const two = await read('deep/two.html');
  assert.match(two, new RegExp(`href="${esc(SITE)}/deep/three"`), 'undownloaded link absolutized');
  assert.match(two, /src="..\/img\/logo.png"/);

  const basePage = await read('base-page.html');
  assert.doesNotMatch(basePage, /<base/);
  assert.match(basePage, /src="sub\/pic.png"/);
  assert.match(basePage, /href="about.html"/);

  const css = await read(cssFile);
  assert.match(css, /@import "print.css"/);
  assert.match(css, /url\("..\/img\/bg.png"\)/);
  assert.match(css, /url\("..\/fonts\/f.woff2"\)/);

  assert.equal(result.pages, 5);
  assert.ok(result.errors.some((e) => e.url.endsWith('/missing')));
  const last = events.filter((e) => e.type === 'file').at(-1);
  assert.equal(last.files, result.files);
  assert.equal(last.totalBytes, result.bytes);
});

test('singlePage only fetches the start page and its requisites', async () => {
  const outDir = await tmp();
  const result = await crawl({ url: `${SITE}/about`, outDir, singlePage: true });
  assert.equal(result.pages, 1);
  assert.ok(await exists(path.join(outDir, 'img/bg.png')));
  assert.equal(await exists(path.join(outDir, 'deep/one.html')), false);
  assert.match(await readFile(path.join(outDir, 'index.html'), 'utf8'), /url=about.html/);
});

test('maxBytes budget is never exceeded', async () => {
  const outDir = await tmp();
  const result = await crawl({ url: `${SITE}/`, outDir, maxBytes: 2500 });
  assert.ok(result.bytes <= 2500, `bytes=${result.bytes}`);
  assert.ok(result.files >= 1);
});

test('maxPages limits pages', async () => {
  const outDir = await tmp();
  const result = await crawl({ url: `${SITE}/`, outDir, maxPages: 2 });
  assert.ok(result.pages <= 2);
});

test('abort signal rejects the crawl', async () => {
  const outDir = await tmp();
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 150);
  const started = Date.now();
  await assert.rejects(crawl({ url: `${SITE}/slow`, outDir, signal: ctrl.signal }), { name: 'AbortError' });
  assert.ok(Date.now() - started < 3000);
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(crawl({ url: `${SITE}/`, outDir, signal: pre.signal }), { name: 'AbortError' });
});
