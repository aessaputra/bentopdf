import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const assetsDir = join(root, 'dist/libreoffice-wasm');
const { R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;

try {
  if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error('Required build variables: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
  }
  const endpoint = new URL(R2_ENDPOINT);
  const local = endpoint.hostname === '127.0.0.1' || endpoint.hostname === 'localhost';
  if ((!local && (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.r2.cloudflarestorage.com'))) ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw new Error('R2_ENDPOINT must be the HTTPS R2 S3 origin (or localhost for tests)');
  }
  const swPath = join(root, 'dist/sw.js');
  let worker;
  try { worker = await readFile(swPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const fetchUrl = 'const url = new URL(event.request.url);';
  if (worker && !worker.includes(fetchUrl)) throw new Error('Service worker fetch handler changed; review LibreOffice cache bypass');
  let remainingFiles = 0;
  async function validatePages(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (name === 'libreoffice-wasm') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await validatePages(path, `${name}/`);
      else if (!entry.isFile()) throw new Error(`Unexpected Pages asset: ${name}`);
      else {
        if ((await stat(path)).size > 25 * 1024 * 1024) throw new Error(`Pages file exceeds 25 MiB: ${name}`);
        remainingFiles++;
      }
    }
  }
  await validatePages(join(root, 'dist'));
  console.log(`Validated ${remainingFiles} remaining Pages files: all <=25 MiB`);
  const files = (await readdir(assetsDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  if (!files.length) throw new Error('No LibreOffice assets found');
  const manifest = {};
  const versionHash = createHash('sha256');
  for (const file of files) {
    if (!file.isFile() || !/^[\w.-]+\.(?:js|wasm|data)(?:\.(?:gz|br))?$/.test(file.name)) {
      throw new Error(`Unexpected LibreOffice asset: ${file.name}`);
    }
    const hash = createHash('sha256');
    const md5 = createHash('md5');
    for await (const chunk of createReadStream(join(assetsDir, file.name))) { hash.update(chunk); md5.update(chunk); }
    const sha256 = hash.digest('hex');
    versionHash.update(`${file.name}\0${sha256}\n`);
    const base = file.name.replace(/\.(gz|br)$/, '');
    manifest[file.name] = {
      contentType: base.endsWith('.js') ? 'text/javascript' : base.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream',
      ...(file.name.endsWith('.gz') ? { contentEncoding: 'gzip' } : file.name.endsWith('.br') ? { contentEncoding: 'br' } : {}),
      sha256, md5: md5.digest('base64'),
    };
  }
  const version = versionHash.digest('hex');
  for (const file of files) {
    const metadata = manifest[file.name];
    const url = `${endpoint.origin}/bentopdf-libreoffice/libreoffice-wasm/${version}/${file.name}`;
    const headers = { 'Content-Type': metadata.contentType, 'Content-MD5': metadata.md5,
      'x-amz-content-sha256': metadata.sha256, 'Cache-Control': 'no-store',
      ...(metadata.contentEncoding ? { 'Content-Encoding': metadata.contentEncoding } : {}),
    };
    // curl signs S3 requests natively; credentials travel via stdin, never command arguments.
    const quote = value => JSON.stringify(value);
    const config = `user = ${quote(`${R2_ACCESS_KEY_ID}:${R2_SECRET_ACCESS_KEY}`)}\n` +
      Object.entries(headers).map(([name, value]) => `header = ${quote(`${name}: ${value}`)}\n`).join('');
    await new Promise((resolve, reject) => {
      const child = spawn('curl', ['--config', '-', '--aws-sigv4', 'aws:amz:auto:s3', '--silent', '--show-error',
        '--connect-timeout', '30', '--max-time', '900', '--upload-file', join(assetsDir, file.name),
        '--output', '/dev/null', '--write-out', '%{http_code}', url], { stdio: ['pipe', 'pipe', 'pipe'] });
      let status = '';
      child.stdout.on('data', data => status += data);
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', code => code === 0 && /^2\d\d$/.test(status) ? resolve() : reject(new Error(`R2 upload failed for ${file.name}: HTTP ${status || 'network error'}`)));
      child.stdin.on('error', () => {});
      child.stdin.end(config);
    });
    console.log(`Uploaded libreoffice-wasm/${version}/${file.name}`);
  }
  await mkdir(join(root, 'cloudflare'), { recursive: true });
  await writeFile(join(root, 'cloudflare/libreoffice-assets.generated.js'), `// Generated by prepare-cloudflare-r2.mjs; bundled per deployment.\nexport const version = ${JSON.stringify(version)};\nexport const assets = ${JSON.stringify(manifest, null, 2)};\n`);
  await writeFile(join(root, 'dist/_routes.json'), JSON.stringify({ version: 1, include: ['/libreoffice-wasm/*'], exclude: [] }));
  if (worker) {
    await writeFile(swPath, worker.replace(fetchUrl, `${fetchUrl}\n  // R2 uses deployment-specific bytes behind stable URLs; bypass offline cache.\n  if (url.pathname.startsWith('/libreoffice-wasm/')) return;`));
    for (const suffix of ['.gz', '.br']) await rm(swPath + suffix, { force: true });
  }
  // BentoPDF is multi-page, not an SPA: a catch-all rewrite would serve HTML for assets.
  const redirectsPath = join(root, 'dist/_redirects');
  try {
    const redirects = await readFile(redirectsPath, 'utf8');
    await writeFile(redirectsPath, redirects.replace(/^\/\*\s+\/index\.html\s+200\s*$/gm, ''));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rm(assetsDir, { recursive: true });
  console.log(`R2 version ${version}: uploaded ${files.length} assets; removed dist/libreoffice-wasm`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
