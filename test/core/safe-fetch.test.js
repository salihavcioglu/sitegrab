// SiteGrab — (c) 2026 Salih Avcioglu. MIT License.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { assertPublicUrl, safeFetch, isPrivateIp } from '../../src/core/safe-fetch.js';

const withEnv = async (value, fn) => {
  const prev = process.env.ALLOW_PRIVATE_HOSTS;
  if (value === undefined) delete process.env.ALLOW_PRIVATE_HOSTS;
  else process.env.ALLOW_PRIVATE_HOSTS = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.ALLOW_PRIVATE_HOSTS;
    else process.env.ALLOW_PRIVATE_HOSTS = prev;
  }
};

describe('SSRF protection', () => {
  const blocked = [
    'http://127.0.0.1/',
    'http://127.1.2.3:8080/x',
    'http://10.0.0.5/',
    'http://172.16.3.4/',
    'http://192.168.1.1/',
    'http://100.64.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[::]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[fe80::1]/',
    'http://[fd12:3456::1]/',
    'http://localhost/',
    'http://LOCALHOST.:3000/',
    'http://foo.localhost/',
    'http://2130706433/',
    'http://0x7f000001/',
    'file:///etc/passwd',
    'ftp://example.com/',
    'gopher://example.com/',
    'javascript:alert(1)',
    'http://user:pass@example.com/',
    'not a url',
  ];
  for (const url of blocked) {
    test(`blocks ${url}`, () => withEnv(undefined, () => assert.rejects(assertPublicUrl(url), { code: 'EBLOCKED' })));
  }

  test('safeFetch refuses private targets before connecting', () =>
    withEnv(undefined, () => assert.rejects(safeFetch('http://127.0.0.1:9/'), { code: 'EBLOCKED' })));

  test('allows public IP literals', () =>
    withEnv(undefined, async () => {
      assert.equal((await assertPublicUrl('http://93.184.215.14/')).hostname, '93.184.215.14');
      assert.equal((await assertPublicUrl('http://[2606:4700::1111]/')).hostname, '[2606:4700::1111]');
    }));

  test('isPrivateIp classification', () => {
    for (const ip of ['127.0.0.1', '10.1.1.1', '169.254.1.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', 'ff02::1'])
      assert.equal(isPrivateIp(ip), true, ip);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPrivateIp(ip), false, ip);
  });

  test('ALLOW_PRIVATE_HOSTS=1 permits private hosts but never file://', () =>
    withEnv('1', async () => {
      await assertPublicUrl('http://127.0.0.1/');
      await assert.rejects(assertPublicUrl('file:///etc/passwd'), { code: 'EBLOCKED' });
    }));
});

describe('safeFetch against a local server', () => {
  let server;
  let base;
  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url.startsWith('/loop')) {
        const n = Number(req.url.split('/')[2] || 0);
        res.writeHead(302, { location: `/loop/${n + 1}` }).end();
      } else if (req.url === '/to-file') {
        res.writeHead(302, { location: 'file:///etc/passwd' }).end();
      } else if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        const chunk = Buffer.alloc(64 * 1024);
        let sent = 0;
        const pump = () => {
          while (sent < 20) {
            sent++;
            if (!res.write(chunk)) return res.once('drain', pump);
          }
          res.end();
        };
        pump();
      } else if (req.url === '/slow') {
        setTimeout(() => res.end('late'), 2000);
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' }).end(req.headers['user-agent']);
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  test('sends a browser-like User-Agent', () =>
    withEnv('1', async () => {
      const res = await safeFetch(`${base}/ua`);
      assert.match(res.body.toString(), /Mozilla\/5\.0/);
    }));

  test('stops after 5 redirects', () =>
    withEnv('1', () => assert.rejects(safeFetch(`${base}/loop/0`), /Too many redirects/)));

  test('re-validates every redirect hop', () =>
    withEnv('1', () => assert.rejects(safeFetch(`${base}/to-file`), { code: 'EBLOCKED' })));

  test('enforces maxBytes while streaming', () =>
    withEnv('1', () => assert.rejects(safeFetch(`${base}/big`, { maxBytes: 100_000 }), { code: 'EMAXBYTES' })));

  test('times out', () => withEnv('1', () => assert.rejects(safeFetch(`${base}/slow`, { timeout: 200 }), /timed out/)));

  test('honours AbortSignal', () =>
    withEnv('1', () => {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 100);
      return assert.rejects(safeFetch(`${base}/slow`, { signal: ctrl.signal }), { name: 'AbortError' });
    }));
});
