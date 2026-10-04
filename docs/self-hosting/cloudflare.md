# Deploy to Cloudflare Pages

[Cloudflare Pages](https://pages.cloudflare.com) offers fast, global static site hosting with unlimited bandwidth.

## Quick Deploy

1. Go to [Cloudflare Pages](https://dash.cloudflare.com/?to=/:account/pages)
2. Click "Create a project"
3. Connect your GitHub repository

## Build Configuration

| Setting                | Value                      |
| ---------------------- | -------------------------- |
| Framework preset       | None                       |
| Build command          | `npm run build:cloudflare` |
| Build output directory | `dist`                     |
| Root directory         | `/`                        |

## Environment Variables

Add these in Settings → Environment variables:

| Variable                | Value                                      |
| ----------------------- | ------------------------------------------ |
| `NODE_VERSION`          | `22`                                       |
| `SIMPLE_MODE`           | `true` (optional)                          |
| `VITE_BRAND_NAME`       | Custom brand name (optional)               |
| `VITE_BRAND_LOGO`       | Logo path relative to `public/` (optional) |
| `VITE_FOOTER_TEXT`      | Custom footer/copyright text (optional)    |
| `VITE_DEFAULT_LANGUAGE` | Default UI language, e.g. `fr` (optional)  |

## Private R2 storage for LibreOffice

1. Keep bucket `bentopdf-libreoffice` private (no public domain or r2.dev access).
2. In Pages Settings, add the R2 runtime binding `LIBREOFFICE_BUCKET` →
   `bentopdf-libreoffice` for production and any preview environment you deploy.
3. Add build secrets `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, scoped to
   Object Read & Write for this bucket. Add build variable `R2_ENDPOINT` =
   `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (use the bucket's S3 endpoint
   shown in the dashboard). Do not use `VITE_` prefixes or commit credentials.
4. Build with `npm run build:cloudflare`, output `dist`. The original
   `npm run build` and Node configuration files are unchanged. Root `BASE_URL=/`
   is required for this Pages route. Install dev dependencies for the build
   (`npm ci --include=dev`); uploads use the official `@aws-sdk/client-s3`
   Node SDK, not the build image's curl.

The post-build script hashes the complete `dist/libreoffice-wasm` file set and
uploads each file via signed S3 PUT to `libreoffice-wasm/<sha256-version>/<file>`.
It streams hashes/uploads rather than loading the WASM into memory, sends
Content-MD5 and the precomputed SHA256 payload hash for integrity, and preserves
MIME and gzip/Brotli metadata. The SDK uses region `auto`, path-style bucket
addressing, and `requestChecksumCalculation: 'WHEN_REQUIRED'` to avoid automatic
CRC/chunked trailers while retaining these explicit checksums.
Only after **every upload succeeds** does it generate
`cloudflare/libreoffice-assets.generated.js`, write `dist/_routes.json`, and
remove `dist/libreoffice-wasm`. Any failed upload exits nonzero and leaves local
LibreOffice files and the previous mapping intact. Remaining Pages files are
checked against the 25 MiB limit before upload. The generated mapping is ignored
by Git and bundled into each deployment's Function, not read from a mutable
runtime variable. Keep all referenced R2 versions for previews and rollback;
this build deliberately does not delete old versions.

`functions/libreoffice-wasm/[[path]].js` serves only mapped filenames on the
same origin, GET/HEAD only, through `LIBREOFFICE_BUCKET`. It streams R2 bodies,
sets COOP/COEP/CORP on successes **and errors**, and returns 404/405/503 rather
than HTML. `_routes.json` invokes Functions only on `/libreoffice-wasm/*`.
Stable asset URLs use `Cache-Control: no-store` to avoid deployment cache mixes;
do not add a Cache Everything rule for this path. An old immutable browser cache
from a prior static deployment may need clearing once when migrating.

The post-build step also bypasses LibreOffice in the generated service worker's
cache-first handler and removes its stale `.gz`/`.br` copies. LibreOffice offline
caching is intentionally disabled for this deployment; other offline tools are
unchanged. It removes only the wildcard `/index.html` rewrite from generated
`dist/_redirects`: BentoPDF is multi-page, and rewriting assets to HTML breaks
tools. Source `public/_headers`, `public/_redirects`, and the upstream loader stay
unchanged. Cloudflare documents that `_redirects` does not apply to Function
responses, so the R2 route handles its own missing-file errors.

Verification: `npm run test:cloudflare` uses a local HTTP S3 server to verify
SigV4, MD5, success/failure stripping behavior, routing metadata, path/method
restrictions, and the size guard. It does **not** prove dashboard credentials or
remote R2 access; confirm those in the first Pages build, then GET/HEAD all five
loader assets and perform a document conversion on its deployment URL.

Official references:

- [Pages R2 storage and dashboard binding](https://developers.cloudflare.com/pages/tutorials/use-r2-as-static-asset-storage-for-pages/)
- [Pages Function routes and `_routes.json`](https://developers.cloudflare.com/pages/functions/routing/)
- [Pages headers: static responses only](https://developers.cloudflare.com/pages/configuration/headers/)
- [Pages redirects: not applied to Functions](https://developers.cloudflare.com/pages/configuration/redirects/)
- [R2 official AWS SDK v3 example](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/)
- [AWS SDK checksum configuration](https://docs.aws.amazon.com/sdkref/latest/guide/feature-dataintegrity.html)
- [R2 S3 PUT metadata and region `auto`](https://developers.cloudflare.com/r2/api/s3/api/)
- [R2 get/head and HTTP metadata](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)

## Configuration File

Create `_headers` in your `public` folder:

```
# Required security headers for SharedArrayBuffer (used by LibreOffice WASM)
/*
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: cross-origin

# Pre-compressed LibreOffice WASM binary
/libreoffice-wasm/soffice.wasm.gz
  Content-Type: application/wasm
  Content-Encoding: gzip
  Cache-Control: public, max-age=31536000, immutable

# Pre-compressed LibreOffice WASM data
/libreoffice-wasm/soffice.data.gz
  Content-Type: application/octet-stream
  Content-Encoding: gzip
  Cache-Control: public, max-age=31536000, immutable

# Cache WASM files aggressively
/*.wasm
  Cache-Control: public, max-age=31536000, immutable
  Content-Type: application/wasm

# Service worker
/sw.js
  Cache-Control: no-cache
```

::: warning Important
The `Cross-Origin-Embedder-Policy` and `Cross-Origin-Opener-Policy` headers are required for Word/ODT/Excel/PowerPoint to PDF conversions. Without them, `SharedArrayBuffer` is unavailable and the LibreOffice WASM engine will fail to initialize.
:::

Do not add a wildcard SPA rewrite: BentoPDF builds separate HTML pages.
The R2 post-build step strips the existing wildcard only in `dist/_redirects`.

## Custom Domain

1. Go to your Pages project
2. Click "Custom domains"
3. Add your domain
4. Cloudflare will auto-configure DNS if the domain is on Cloudflare

## Advantages

- **Free unlimited bandwidth**
- **Global CDN** with 300+ edge locations
- **Automatic HTTPS**
- **Preview deployments** for pull requests
- **Fast builds**

## Troubleshooting

### Large File Uploads

Cloudflare Pages supports individual assets up to 25 MiB. LibreOffice exceeds
this limit and is uploaded to private R2 by `npm run build:cloudflare`. The build
fails if any other output file is oversized; it never silently drops those files.

### Worker Size Limits

If using Cloudflare Workers for advanced routing, note the 1 MB limit for free plans.

## CORS Proxy Worker (For Digital Signatures)

The Digital Signature tool requires a CORS proxy to fetch certificate chains. Deploy the included worker:

```bash
cd cloudflare
npx wrangler login
npx wrangler deploy
```

### Security Features

| Feature                 | Description                    |
| ----------------------- | ------------------------------ |
| **URL Restrictions**    | Only certificate URLs allowed  |
| **File Size Limit**     | Max 10MB per request           |
| **Rate Limiting**       | 60 req/IP/min (requires KV)    |
| **Private IP Blocking** | Blocks localhost, internal IPs |

### Enable Rate Limiting

```bash
# Create KV namespace
npx wrangler kv namespace create "RATE_LIMIT_KV"

# Add to wrangler.toml with returned ID:
# [[kv_namespaces]]
# binding = "RATE_LIMIT_KV"
# id = "YOUR_ID"

npx wrangler deploy
```

### Build with Proxy URL

```bash
VITE_CORS_PROXY_URL=https://your-worker.workers.dev npm run build
```

Or with Docker:

```bash
export VITE_CORS_PROXY_URL="https://your-worker.workers.dev"
DOCKER_BUILDKIT=1 docker build \
  --secret id=VITE_CORS_PROXY_URL,env=VITE_CORS_PROXY_URL \
  -t your-bentopdf .
```

> **Note:** See [README](https://github.com/alam00000/bentopdf#digital-signature-cors-proxy-required) for HMAC signature setup.
