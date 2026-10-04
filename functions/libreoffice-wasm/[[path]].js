import { version, assets } from '../../cloudflare/libreoffice-assets.generated.js';

export async function onRequest({ request, env }) {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  });
  if (!['GET', 'HEAD'].includes(request.method)) {
    headers.set('Allow', 'GET, HEAD');
    return new Response(null, { status: 405, headers });
  }
  const pathname = new URL(request.url).pathname;
  const name = pathname.startsWith('/libreoffice-wasm/') ? pathname.slice('/libreoffice-wasm/'.length) : '';
  if (!Object.hasOwn(assets, name)) return new Response(null, { status: 404, headers });
  try {
    const key = `libreoffice-wasm/${version}/${name}`;
    const object = await env.LIBREOFFICE_BUCKET[request.method === 'HEAD' ? 'head' : 'get'](key);
    if (!object) return new Response(null, { status: 404, headers });
    object.writeHttpMetadata(headers);
    headers.set('Content-Type', assets[name].contentType);
    if (assets[name].contentEncoding) headers.set('Content-Encoding', assets[name].contentEncoding);
    else headers.delete('Content-Encoding');
    // Stable public URLs are not immutable: never reuse bytes from a different deployment.
    headers.set('Cache-Control', 'no-store');
    headers.set('ETag', object.httpEtag);
    headers.set('Content-Length', String(object.size));
    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
  } catch {
    return new Response(null, { status: 503, headers });
  }
}
