import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, createHmac } from 'node:crypto';
import { gzipSync } from 'node:zlib';

// Validate the signature independently at the local S3 HTTP boundary.
function validSignature(req, body) {
  const auth = req.headers.authorization;
  const [, credential, signedHeaders, signature] = auth.match(/Credential=([^,]+), SignedHeaders=([^,]+), Signature=(.+)$/);
  const [id, date, region, service] = credential.split('/');
  assert.equal(id, 'local-test-key');
  assert.equal(region, 'auto');
  assert.equal(service, 's3');
  const sha = value => createHash('sha256').update(value).digest('hex');
  assert.equal(req.headers['x-amz-content-sha256'], sha(body));
  assert.equal(req.headers['content-md5'], createHash('md5').update(body).digest('base64'));
  const canonicalHeaders = signedHeaders.split(';').map(name => `${name}:${req.headers[name].trim()}\n`).join('');
  const canonical = ['PUT', req.url, '', canonicalHeaders, signedHeaders, sha(body)].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', req.headers['x-amz-date'], scope, sha(canonical)].join('\n');
  const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
  let key = hmac('AWS4local-test-secret', date);
  for (const value of [region, service, 'aws4_request']) key = hmac(key, value);
  assert.equal(createHmac('sha256', key).update(toSign).digest('hex'), signature);
}

const script = fileURLToPath(new URL('./prepare-cloudflare-r2.mjs', import.meta.url));
async function run(root, endpoint) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd: root, env: {
      ...process.env, R2_ENDPOINT: endpoint, R2_ACCESS_KEY_ID: 'local-test-key', R2_SECRET_ACCESS_KEY: 'local-test-secret',
    }});
    let output = '';
    child.stdout.on('data', (data) => output += data);
    child.stderr.on('data', (data) => output += data);
    child.on('close', (code) => resolve({ code, output }));
  });
}

test('successful signed upload publishes version mapping and scoped routes before stripping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bentopdf-r2-'));
  const uploads = new Map();
  const errors = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    try { validSignature(req, body); uploads.set(req.url, { body, headers: req.headers }); res.writeHead(200); }
    catch (error) { errors.push(error); res.writeHead(400); }
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await mkdir(join(root, 'dist/libreoffice-wasm'), { recursive: true });
    await writeFile(join(root, 'dist/sw.js'), "self.addEventListener('fetch', (event) => {\n  const url = new URL(event.request.url);\n  event.respondWith(caches.match(event.request));\n});");
    await writeFile(join(root, 'dist/sw.js.gz'), 'stale compressed worker');
    await writeFile(join(root, 'dist/_redirects'), '/* /index.html 200\n');
    await writeFile(join(root, 'dist/libreoffice-wasm/soffice.js'), 'script');
    await writeFile(join(root, 'dist/libreoffice-wasm/soffice.wasm.gz'), gzipSync('wasm'));
    const result = await run(root, `http://127.0.0.1:${server.address().port}`);
    assert.deepEqual(errors, []);
    assert.equal(result.code, 0, result.output);
    assert.equal(uploads.size, 2);
    assert.match(await readFile(join(root, 'dist/sw.js'), 'utf8'), /if \(url.pathname.startsWith\('\/libreoffice-wasm\/'\)\) return;/);
    await assert.rejects(access(join(root, 'dist/sw.js.gz')));
    assert.doesNotMatch(await readFile(join(root, 'dist/_redirects'), 'utf8'), /index.html/);
    const { version, assets } = await import(pathToFileURL(join(root, 'cloudflare/libreoffice-assets.generated.js')));
    assert.match(version, /^[a-f0-9]{64}$/);
    assert.equal(assets['soffice.wasm.gz'].contentEncoding, 'gzip');
    assert.equal(assets['soffice.wasm.gz'].contentType, 'application/wasm');
    assert.deepEqual(await readFile(join(root, 'dist/_routes.json'), 'utf8').then(JSON.parse), { version: 1, include: ['/libreoffice-wasm/*'], exclude: [] });
    for (const name of Object.keys(assets)) assert.ok(uploads.has(`/bentopdf-libreoffice/libreoffice-wasm/${version}/${name}`));
    await assert.rejects(access(join(root, 'dist/libreoffice-wasm')));
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});

test('Pages function serves only deployment assets with isolation headers and no stale cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bentopdf-function-'));
  try {
    await mkdir(join(root, 'functions/libreoffice-wasm'), { recursive: true });
    await mkdir(join(root, 'cloudflare'));
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    const source = await readFile(new URL('../functions/libreoffice-wasm/[[path]].js', import.meta.url));
    await writeFile(join(root, 'functions/libreoffice-wasm/handler.js'), source);
    await writeFile(join(root, 'cloudflare/libreoffice-assets.generated.js'), 'export const version = "old-version"; export const assets = {"soffice.wasm.gz": {contentType:"application/wasm",contentEncoding:"gzip"}};');
    const { onRequest } = await import(pathToFileURL(join(root, 'functions/libreoffice-wasm/handler.js')));
    const calls = [];
    const object = { body: gzipSync('wasm'), size: 24, httpEtag: '"etag"', writeHttpMetadata(headers) { headers.set('Content-Type', 'application/wasm'); headers.set('Content-Encoding', 'gzip'); headers.set('Cache-Control', 'public, max-age=31536000'); } };
    const bucket = { async get(key) { calls.push(['get', key]); return object; }, async head(key) { calls.push(['head', key]); return object; } };
    const request = (path, method = 'GET', env = { LIBREOFFICE_BUCKET: bucket }) => onRequest({ request: new Request(`https://example.com${path}`, { method }), env });
    for (const method of ['GET', 'HEAD']) {
      const response = await request('/libreoffice-wasm/soffice.wasm.gz', method);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Content-Type'), 'application/wasm');
      assert.equal(response.headers.get('Content-Encoding'), 'gzip');
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal(response.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
      assert.equal(response.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
      assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
      if (method === 'HEAD') assert.equal(await response.text(), '');
    }
    assert.deepEqual(calls, [['get', 'libreoffice-wasm/old-version/soffice.wasm.gz'], ['head', 'libreoffice-wasm/old-version/soffice.wasm.gz']]);
    for (const path of ['/libreoffice-wasm/private.txt', '/libreoffice-wasm/nested/soffice.wasm.gz', '/libreoffice-wasm/%2fsoffice.wasm.gz', '/libreoffice-wasm/%ZZ', '/other/soffice.wasm.gz']) {
      const response = await request(path);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    assert.equal(calls.length, 2);
    const denied = await request('/libreoffice-wasm/soffice.wasm.gz', 'POST');
    assert.equal(denied.status, 405);
    assert.equal(denied.headers.get('Allow'), 'GET, HEAD');
    bucket.get = async () => null;
    assert.equal((await request('/libreoffice-wasm/soffice.wasm.gz')).status, 404);
    bucket.get = async () => { throw new Error('R2 unavailable'); };
    assert.equal((await request('/libreoffice-wasm/soffice.wasm.gz')).status, 503);
    assert.equal((await request('/libreoffice-wasm/soffice.wasm.gz', 'GET', {})).status, 503);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('oversized remaining Pages file blocks upload and preserves LibreOffice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bentopdf-limit-'));
  try {
    await mkdir(join(root, 'dist/libreoffice-wasm'), { recursive: true });
    await writeFile(join(root, 'dist/libreoffice-wasm/soffice.js'), 'script');
    await writeFile(join(root, 'dist/too-large.bin'), Buffer.alloc(25 * 1024 * 1024 + 1));
    const result = await run(root, 'http://127.0.0.1:1');
    assert.notEqual(result.code, 0);
    assert.match(result.output, /Pages file exceeds 25 MiB: too-large.bin/);
    await access(join(root, 'dist/libreoffice-wasm/soffice.js'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('upload failure preserves all LibreOffice assets and deployment mapping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bentopdf-r2-'));
  const server = createServer((req, res) => { req.resume(); res.writeHead(403); res.end('denied'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await mkdir(join(root, 'dist/libreoffice-wasm'), { recursive: true });
    await mkdir(join(root, 'cloudflare'));
    await writeFile(join(root, 'dist/libreoffice-wasm/soffice.js'), 'test script');
    await writeFile(join(root, 'cloudflare/libreoffice-assets.generated.js'), 'old mapping');
    const result = await run(root, `http://127.0.0.1:${server.address().port}`);
    assert.match(result.output, /R2 upload failed.*403/);
    assert.notEqual(result.code, 0);
    assert.equal(await readFile(join(root, 'dist/libreoffice-wasm/soffice.js'), 'utf8'), 'test script');
    assert.equal(await readFile(join(root, 'cloudflare/libreoffice-assets.generated.js'), 'utf8'), 'old mapping');
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});
