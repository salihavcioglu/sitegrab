# SiteGrab

Paste a URL, get the whole site back as a ZIP you can open offline.

![Node](https://img.shields.io/badge/node-%3E%3D18.17-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)
![Tests](https://img.shields.io/badge/tests-50%20passing-brightgreen)
![Docker](https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white)

SiteGrab crawls a public website, downloads its pages and every asset they
depend on (CSS, JavaScript, images, fonts, favicons), rewrites every link so
the copy works with no server behind it, and packs the result into a single
ZIP. It ships three ways to use it: a web UI with live progress over
WebSockets, a command-line tool, and a Docker image.

![SiteGrab landing page in light mode](docs/screenshots/hero-light.png)

## Table of contents

- [Why SiteGrab](#why-sitegrab)
- [Features](#features)
- [Screenshots](#screenshots)
- [Quick start](#quick-start)
- [Web UI usage](#web-ui-usage)
- [CLI reference](#cli-reference)
- [Options](#options)
- [Environment variables](#environment-variables)
- [How it works](#how-it-works)
- [Project structure](#project-structure)
- [Security model](#security-model)
- [Testing](#testing)
- [Deployment notes](#deployment-notes)
- [Known limitations](#known-limitations)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## Why SiteGrab

Most "save page" tools only grab a single HTML file, and most crawlers are
built for scraping data rather than producing a browsable offline copy.
SiteGrab sits in between: it walks the pages on one host up to a depth you
choose, follows every stylesheet, script, image, `srcset` source, font,
favicon and CSS `url()`/`@import`, and rewrites every reference it finds so
the download opens straight from disk — no build step, no server, no
internet connection required for the copy itself.

It is intentionally a static, server-rendered snapshot tool: it fetches HTML
exactly as the server sends it (no headless browser, no JavaScript
execution), which keeps it fast, dependency-light, and safe to expose on the
public internet behind the SSRF protections described below.

## Features

### Crawling & link rewriting

- Breadth-first crawl of one host, with a configurable max depth (0–5) and a
  hard cap on page count (1–1000)
- Bounded-concurrency fetch queue (default 6 workers) so a crawl doesn't hammer
  the target
- Every saved HTML and CSS file is rewritten in a second pass, once the full
  URL → local-file map is known, so links point at the right relative path
  even when pages are fetched out of order
- Handles `<a>`, `<area>`, `<iframe>`, `<frame>`, `<link>` (stylesheet, icon,
  manifest, preload…), `<script>`, `<img>` (`src`, `srcset`, lazy-load
  attributes), `<source>`, `<video>`/`<audio>`/`<track>`/`<embed>`, `<object>`,
  `<use>`/`<image>` (SVG), inline `style` attributes and `<style>` blocks,
  `<meta http-equiv="refresh">`, `<base href>`, and CSS `@import`/`url()`
  (including inside `@font-face`)
- A `<base>`-aware resolver, so pages that declare a custom base URL still
  resolve correctly
- Single-page mode to grab just one page and its requisites, skipping the
  crawl entirely
- Text is always decoded and re-saved as UTF-8 (charset sniffed from the
  `Content-Type` header, a `<meta charset>`, a CSS `@charset`, or a BOM), and
  charset declarations are rewritten to say so
- Deterministic, filesystem-safe path mapping: directory URLs become
  `index.html`, query strings are folded into the filename via a short hash,
  Windows-reserved names and unsafe characters are sanitized, and path
  collisions are resolved automatically

### Cross-host assets (`_ext/`)

Links that stay on the crawled host map to a matching local path (e.g.
`/blog/` → `blog/index.html`). Anything served from a different host — a
CDN, a fonts provider, an embedded widget's assets — is still downloaded (so
the page renders correctly offline) but is placed under `_ext/<host>/...`
instead of mixing into the site's own directory tree. The crawl itself never
*follows links* to other hosts as new pages; only their assets are pulled in.

### Options

Every job accepts:

| Option | Meaning |
| --- | --- |
| Crawl depth | How many link-hops from the start page to follow |
| Max pages | Hard cap on page count regardless of depth |
| Max total size | Stops the crawl once this many megabytes have been fetched |
| Single page only | Fetch just the pasted page and its assets, no crawling |

See [Options](#options) below for exact ranges and defaults.

### Security / SSRF protections

SiteGrab is designed to be safely exposed to the public internet as a
"fetch this URL for me" service, which means it has to defend against
being used to reach internal infrastructure:

- Only `http:`/`https:` URLs are accepted; credentials embedded in a URL
  (`http://user:pass@host`) are rejected outright
- The hostname is checked against `localhost`, `*.localhost`, `*.local` and
  `*.internal` before anything else
- If the host is a literal IP, it's checked directly; otherwise DNS is
  resolved (`dns.lookup` with `all: true`) and **every** resolved address is
  checked — a hostname that resolves to more than one address can't hide a
  private one among them
- Blocked ranges cover loopback, RFC 1918 private space, link-local,
  CGNAT (100.64.0.0/10), the IPv6 equivalents (`::1`, `fc00::/7`,
  `fe80::/10`, …), IPv4-mapped and NAT64/6to4 IPv6 addresses, multicast, and
  the documentation/test ranges — see `src/core/safe-fetch.js` for the exact
  tables
- The same check runs again on **every redirect hop** (up to 5), so a
  same-origin 200 that redirects to `http://169.254.169.254/` is still
  caught
- Response bodies are streamed with a byte counter that aborts the moment
  the configured size limit is exceeded, so a `Content-Length` lie or an
  endless response can't exhaust memory or disk
- Every request has a timeout (headers + body combined)
- All of this can be disabled with `ALLOW_PRIVATE_HOSTS=1` for local
  development against a private target — never set this in a
  publicly-reachable deployment
- The server sends a strict set of security headers on every response
  (see [Security model](#security-model)) including a `Content-Security-Policy`
  scoped to `'self'` plus Google Fonts
- Downloads are served only for job IDs matching a strict hex pattern, and
  the resolved file path is re-checked to stay inside the ZIP output
  directory before it's streamed

### Abuse limits

- Per-IP rate limiting on starting new jobs (`MAX_JOBS_PER_HOUR`, default 10
  per hour, tracked with a sliding window)
- A global concurrent-job cap (`MAX_CONCURRENT_JOBS`, default 3) so the
  server can't be told to run unlimited crawls at once
- One active job per socket connection; starting a second one on the same
  connection is rejected
- A per-job wall-clock timeout (`JOB_TIMEOUT_MINUTES`, default 15) that
  cancels a runaway crawl
- Disconnecting the browser tab cancels the in-flight job immediately

### Auto cleanup

- Finished ZIPs are deleted after `ZIP_TTL_MINUTES` (default 30) by a
  periodic sweep (every 5 minutes)
- The temporary crawl directory for a job is always removed when the job
  finishes, succeeds, fails, or is cancelled — there's no manual cleanup step
- Server-side job metadata for a completed download is dropped once its ZIP
  file no longer exists on disk

### CLI

A small, dependency-free CLI (`bin/sitegrab.js`) that reuses the same job
engine as the server: live single-line progress in a TTY, `Ctrl+C` to cancel
cleanly (removing the partial ZIP and temp files), and a plain exit code on
failure. See [CLI reference](#cli-reference).

### Docker

A slim `node:20-alpine`-based image that installs only production
dependencies, runs as a non-root `sitegrab` user, and ships a built-in
`HEALTHCHECK` that hits `/health`. See [Quick start](#quick-start).

## Screenshots

| Light | Dark |
| --- | --- |
| ![Landing page, light theme](docs/screenshots/hero-light.png) | ![Landing page, dark theme](docs/screenshots/hero-dark.png) |

| Crawl in progress | Finished job |
| --- | --- |
| ![A crawl running, with live stats and log](docs/screenshots/job-running.png) | ![Finished job with a Download ZIP button](docs/screenshots/job-done.png) |

| Mobile |
| --- |
| ![The landing page on a 390×844 mobile viewport](docs/screenshots/mobile.png) |

## Quick start

### npm

```bash
npm install
npm start
```

The server listens on `http://localhost:3000` by default (override with
`PORT`). Open it in a browser, paste a URL, and start a job. For local
development with auto-restart on file changes:

```bash
npm run dev
```

### Docker

```bash
docker build -t sitegrab .
docker run --rm -p 3000:3000 sitegrab
```

Persist ZIPs and temp files outside the container, and tune limits via
environment variables:

```bash
docker run --rm -p 3000:3000 \
  -v "$PWD/data:/app/data" \
  -e MAX_JOBS_PER_HOUR=20 \
  -e ZIP_TTL_MINUTES=60 \
  sitegrab
```

### CLI

Run it directly with Node, or install the `sitegrab` command globally:

```bash
# one-off, via node
node bin/sitegrab.js https://example.com -o example.zip

# or install the "sitegrab" command globally
npm install -g .
sitegrab https://example.com
sitegrab https://example.com --depth 1 --pages 50 --single -o site.zip
```

## Web UI usage

1. Paste a public `http(s)` URL into the field on the landing page.
2. Optionally open **Options** to adjust crawl depth, max pages, max total
   size, or switch to single-page mode.
3. Click **Download**. A live panel appears showing pages/files/size crawled,
   elapsed time, the URL currently being fetched, and an expandable log.
4. When the crawl finishes, the panel switches to a **Download ZIP** button
   along with a final summary (pages, files, total bytes crawled, and any
   errors encountered along the way).
5. The ZIP is deleted automatically after about 30 minutes — download it
   promptly.

The header's theme button toggles between light and dark (persisted in
`localStorage`); by default the page follows the browser's
`prefers-color-scheme`. Progress and results arrive over a Socket.IO
connection; if it drops mid-crawl, the job is cancelled server-side and the
UI reports the lost connection.

## CLI reference

```
sitegrab <url> [options]

  -d, --depth <n>     Max crawl depth (default: 2)
  -p, --pages <n>     Max pages to fetch (default: 200)
  -s, --size <mb>     Max total size in MB (default: 100)
      --single        Only fetch the single page (no crawling)
  -o, --out <path>    Output zip path (default: ./<host>.zip)
  -h, --help          Show this help message
```

| Flag | Argument | Description |
| --- | --- | --- |
| `-d`, `--depth` | integer | Crawl depth, clamped to 0–5 |
| `-p`, `--pages` | integer | Max pages, clamped to 1–1000 |
| `-s`, `--size` | integer (MB) | Max total download size, clamped to 1–500 |
| `--single` | — | Single-page mode; overrides depth |
| `-o`, `--out` | path | Where to write the ZIP (default `./<hostname>.zip`) |
| `-h`, `--help` | — | Print usage and exit |

Press `Ctrl+C` during a run to cancel; SiteGrab cleans up the partial ZIP and
exits with code `130`. On success it prints the page/file/size summary and
the output path; on failure it prints an error and exits with code `1`.

## Options

These are the same limits in both the web UI and the CLI (the server clamps
any out-of-range value it receives rather than rejecting the job):

| Option | Range | Default | Notes |
| --- | --- | --- | --- |
| `maxDepth` | 0–5 | 2 | 0 fetches only the start page's own requisites |
| `maxPages` | 1–1000 | 200 | Hard cap, independent of depth |
| `maxSizeMB` | 1–500 | 100 | Crawl stops once this many MB have been fetched |
| `singlePage` | boolean | `false` | Skips link discovery entirely (equivalent to depth 0 with no page-following) |

## Environment variables

All variables are read once at server startup (`src/server/index.js` and
`src/core/job.js`); none require a restart-free reload.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port the server listens on |
| `MAX_JOBS_PER_HOUR` | `10` | Per-IP limit on starting new jobs, sliding 1-hour window |
| `MAX_CONCURRENT_JOBS` | `3` | Maximum number of crawl jobs running at once, server-wide |
| `ZIP_TTL_MINUTES` | `30` | How long a finished ZIP is kept before the cleanup sweep deletes it |
| `JOB_TIMEOUT_MINUTES` | `15` | Wall-clock timeout that cancels a single job |
| `TRUST_PROXY` | unset | Passed to Express's `trust proxy` (accepts `true`, a hop count, or a specific value like `loopback`) so client IPs are read from `X-Forwarded-For` correctly behind a reverse proxy |
| `ALLOW_PRIVATE_HOSTS` | unset | Set to `1` to disable the SSRF/private-network guard — local development only, never in production |
| `DATA_DIR` | `<project root>/data` | Base directory for the `tmp/` (in-progress crawls) and `zips/` (finished downloads) subfolders |

## How it works

```mermaid
flowchart LR
    A[URL submitted<br/>web UI or CLI] --> B[SSRF check<br/>safe-fetch.js]
    B --> C[Crawl<br/>crawler.js]
    C --> D[Rewrite links<br/>HTML + CSS, phase 2]
    D --> E[Zip directory<br/>zip.js]
    E --> F[Serve /download/:id<br/>then auto-delete]
```

1. **Submit** — the web UI emits `job:start` over Socket.IO, or the CLI calls
   `startJob()` directly. Either way, `normalizeOptions()` validates the URL
   and clamps every option.
2. **SSRF check** — before any network request, `assertPublicUrl()` rejects
   disallowed schemes, credentials, and non-public hosts/IPs (re-checked on
   every redirect hop).
3. **Crawl** — a bounded-concurrency queue fetches the start page, then its
   requisites and linked pages breadth-first, up to the depth/page/size
   limits. HTML and CSS are decoded to UTF-8 and saved as text; everything
   else is saved as-is. New links discovered in HTML/CSS are enqueued as they
   are found.
4. **Rewrite** — once every URL that will be downloaded has a known local
   path, a second pass rewrites every reference in the saved HTML/CSS files
   to a relative, URL-encoded local path (or leaves it as an absolute URL if
   it wasn't downloaded, e.g. because it was off-host and depth 0 was used).
5. **Zip** — the output directory is streamed into a ZIP with `archiver`.
6. **Download** — the server emits `job:done` with a `downloadUrl`; the file
   is served from `/download/:id` (id validated against a strict hex
   pattern) and deleted automatically after `ZIP_TTL_MINUTES`.

### Socket.IO events

| Direction | Event | Payload |
| --- | --- | --- |
| Client → server | `job:start` | `{ url, options: { maxDepth, maxPages, maxSizeMB, singlePage } }` |
| Client → server | `job:cancel` | — |
| Server → client | `job:progress` | `{ pages, files, bytes, current }` |
| Server → client | `job:log` | `{ level, message }` |
| Server → client | `job:done` | `{ id, downloadUrl, pages, files, bytes, zipBytes, errors }` |
| Server → client | `job:error` | `{ message }` |

## Project structure

```
sitegrab/
├── bin/
│   └── sitegrab.js        # CLI entry point
├── src/
│   ├── core/
│   │   ├── crawler.js      # BFS crawl, URL → path mapping, HTML/CSS link rewriting
│   │   ├── safe-fetch.js   # SSRF-hardened fetch (IP/DNS checks, redirects, size cap, timeout)
│   │   ├── job.js          # Ties crawl + zip together; option validation; cleanup
│   │   └── zip.js          # Streams a directory into a ZIP with archiver
│   └── server/
│       └── index.js        # Express + Socket.IO server, rate limiting, downloads
├── public/                 # Static web UI (no build step)
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   ├── theme.js
│   └── favicon.svg
├── test/core/               # node:test suites for crawler, job, paths, safe-fetch
├── data/                    # tmp/ (in-flight crawls) and zips/ (finished downloads)
├── Dockerfile
└── package.json
```

## Security model

- **Network egress is the main attack surface.** Every outbound request goes
  through `safeFetch()` / `assertPublicUrl()` in `src/core/safe-fetch.js`,
  which is the single choke point for the SSRF protections described in
  [Features](#features).
- **Filesystem writes are sandboxed.** `safeJoin()` resolves every local path
  the crawler writes to and refuses anything that would escape the job's
  output directory; filenames are sanitized (`sanitizeSegment()`) to strip
  control characters, path separators, trailing dots/spaces, and
  Windows-reserved device names.
- **Downloads are strictly scoped.** `/download/:id` only accepts IDs
  matching `^[a-f0-9]{8,64}$`, and the resolved path is verified to stay
  inside the ZIP directory before the file is streamed.
- **Response headers** set on every request: `X-Content-Type-Options:
  nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy` / `Cross-Origin-Resource-Policy: same-origin`,
  a locked-down `Permissions-Policy`, and a `Content-Security-Policy`
  restricted to `'self'` (plus Google Fonts for the web UI's font).
- **Abuse controls** (rate limiting, concurrency cap, per-job timeout,
  one-job-per-connection) protect the server itself; see
  [Abuse limits](#abuse-limits).
- **`ALLOW_PRIVATE_HOSTS=1`** turns all of the SSRF protections off. It
  exists for testing against a local target and must never be set on a
  deployment reachable by untrusted users.

## Testing

```bash
npm test
```

Runs Node's built-in test runner (`node --test`) against `test/core/*.js`:
50 tests across the crawler, job orchestration, path/URL mapping, and the
SSRF-hardened fetch layer, including:

- Link/asset discovery and rewriting across every supported HTML attribute
  and CSS construct, srcset parsing, `<base>` handling, redirect
  deduplication, and same-page anchor handling
- Deterministic path mapping, filename collisions, directory-vs-file
  conflicts, and traversal attempts (`../../etc/passwd`-style inputs)
- Full job lifecycle: crawl → zip → cleanup, cancellation mid-crawl,
  charset decoding (including non-UTF-8 sources), and option
  validation/clamping
- The SSRF blocklist against a long list of loopback/private/link-local/
  CGNAT/multicast/documentation addresses in both IPv4 and IPv6 (including
  IPv4-mapped and encoded forms like decimal/hex IPs), redirect
  re-validation, byte-limit enforcement while streaming, timeouts, and
  `AbortSignal` handling

Tests spin up local HTTP servers on ephemeral ports and run with
`ALLOW_PRIVATE_HOSTS=1` so they can talk to `127.0.0.1`.

## Deployment notes

SiteGrab needs a long-running Node.js process (it holds WebSocket
connections and writes temporary files to disk), so it's not a fit for
static hosting — deploy it to a Node-friendly host such as Render, Railway,
Fly.io, or a plain VPS, or run the Docker image anywhere that can run a
container.

- Put a reverse proxy (nginx, Caddy, the platform's own edge) in front of
  it for TLS, and set `TRUST_PROXY` so `MAX_JOBS_PER_HOUR` rate limiting
  keys on the real client IP instead of the proxy's.
- Make sure WebSocket upgrades are passed through the proxy (Socket.IO
  falls back to long-polling if not, which still works but loses some
  responsiveness).
- Mount `DATA_DIR` on a writable volume if you want ZIPs to survive a
  container restart during their TTL window — not required for correctness,
  since finished jobs are meant to be short-lived.
- Set `MAX_CONCURRENT_JOBS`, `MAX_JOBS_PER_HOUR`, `ZIP_TTL_MINUTES`, and
  `JOB_TIMEOUT_MINUTES` based on the host's CPU/bandwidth/disk budget.
- Never set `ALLOW_PRIVATE_HOSTS=1` on a deployment reachable by anyone but
  you.

## Known limitations

- **No JavaScript rendering.** SiteGrab saves HTML exactly as the server
  sends it; sites that render their content client-side (SPA frameworks with
  no server-side rendering) will download looking mostly empty.
- **DNS rebinding is only partly mitigated.** Hostnames are re-resolved and
  checked at request time and on every redirect hop, which closes the most
  common SSRF paths, but there is no DNS pinning — a name that resolves to a
  public IP at check time and a private one a few milliseconds later at
  connect time is a theoretical (if narrow) gap. See
  [Roadmap](#roadmap).
- **`www.` vs. apex host.** Same-host detection strips a leading `www.`
  before comparing hosts, so `www.example.com` and `example.com` are treated
  as one site for crawl purposes, but the two are not merged for anything
  else (e.g. an asset served from one while the crawl started on the other
  still lands under `_ext/` if the raw hosts differ).
- **Bot-defensive sites won't come through fully.** Sites that require a
  login, block non-browser user agents, or otherwise gate content will
  produce a partial or empty download.
- **No resume.** A cancelled or failed job's partial output is discarded;
  there is no way to pick a crawl back up where it left off.

## Roadmap

- Optional headless-browser rendering for JavaScript-heavy sites
- DNS pinning (resolve once, connect to the pinned address) to close the
  remaining DNS-rebinding gap
- Resumable crawls for large sites
- Import a `sitemap.xml` as the initial page set instead of relying purely on
  link discovery

## Contributing

Issues and pull requests are welcome. Before opening a PR:

1. Run `npm test` and make sure all tests pass.
2. Keep new outbound requests routed through `safeFetch()` — don't add a
   fetch path that bypasses the SSRF checks.
3. Add tests alongside any change to `src/core/` (see `test/core/` for the
   existing patterns).
4. Keep the web UI dependency-free (no build step) unless there's a strong
   reason to introduce one.

## License

MIT © 2026 Salih Avcioglu — see [LICENSE](./LICENSE).
