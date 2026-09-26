// SiteGrab — (c) 2026 Salih Avcioglu. MIT License.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readdir, rm, stat, writeFile, mkdir, utimes } from 'node:fs/promises';

process.env.ALLOW_PRIVATE_HOSTS = '1';
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sitegrab-job-'));
process.env.DATA_DIR = dataDir;
const { startJob, ZIP_DIR, TMP_DIR, cleanupOldZips, normalizeOptions } = await import('../../src/core/job.js');

let server;
let SITE;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/slow') return setTimeout(() => res.end('x'), 5000);
    if (req.url === '/latin1') {
      // "café" encoded as windows-1252
      res.writeHead(200, { 'content-type': 'text/html; charset=windows-1252' });
      return res.end(Buffer.concat([Buffer.from('<html><head></head><body>caf'), Buffer.from([0xe9]), Buffer.from('</body></html>')]));
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body><img src="/a.png"></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  SITE = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  server.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('normalizeOptions clamps values and validates URLs', () => {
  const o = normalizeOptions({ url: 'example.com', maxDepth: 99, maxPages: -5, maxSizeMB: 'abc', singlePage: 'true' });
  assert.deepEqual(o, { url: 'https://example.com/', maxDepth: 5, maxPages: 1, maxSizeMB: 100, singlePage: true });
  assert.throws(() => normalizeOptions({ url: 'file:///etc/passwd' }));
  assert.throws(() => normalizeOptions({ url: 'http://' }));
});

test('job crawls, zips, emits events and cleans tmp', async () => {
  const events = [];
  const job = startJob({ url: `${SITE}/latin1`, maxDepth: 1 }, (name, data) => events.push([name, data]));
  assert.match(job.id, /^[0-9a-f]+$/);
  const result = await job.done;
  assert.equal(result.id, job.id);
  assert.equal(result.file, path.join(ZIP_DIR, `${job.id}.zip`));
  assert.ok(result.zipBytes > 0 && (await stat(result.file)).size === result.zipBytes);
  assert.ok(events.some(([n]) => n === 'progress'));
  assert.deepEqual(events.at(-1), ['done', result]);
  assert.deepEqual(await readdir(TMP_DIR), []);
});

test('cancel rejects done, emits error, removes tmp and zip', async () => {
  const events = [];
  const job = startJob({ url: `${SITE}/slow` }, (name, data) => events.push([name, data]));
  setTimeout(() => job.cancel(), 100);
  await assert.rejects(job.done);
  assert.deepEqual(events.at(-1), ['error', { message: 'Job cancelled.' }]);
  assert.deepEqual(await readdir(TMP_DIR), []);
  await assert.rejects(stat(path.join(ZIP_DIR, `${job.id}.zip`)));
});

test('cleanupOldZips removes only old zips', async () => {
  await mkdir(ZIP_DIR, { recursive: true });
  const oldZip = path.join(ZIP_DIR, 'old.zip');
  const newZip = path.join(ZIP_DIR, 'new.zip');
  await writeFile(oldZip, 'x');
  await writeFile(newZip, 'x');
  const past = new Date(Date.now() - 2 * 3600_000);
  await utimes(oldZip, past, past);
  assert.equal(await cleanupOldZips(3600_000), 1);
  const left = await readdir(ZIP_DIR);
  assert.ok(left.includes('new.zip') && !left.includes('old.zip'));
});
