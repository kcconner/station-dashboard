# WWG Station Dashboard — Cloudflare Pages Edition

Public weather station dashboard fed by the WWG API, hosted on Cloudflare
Pages (free tier) with Pages Functions as the key-holding proxy.

```
Stations ──▶ LoggerNet / collection ──▶ WWG database ──▶ WWG API (v2)
                                                            │ X-Api-Key
                                          Pages Functions proxy
                                          /api/stations  /api/data
                                          (allow-listed, edge-cached,
                                           key held server-side only)
                                                            │
                                          Cloudflare Pages (this repo)
                                                            │
                                                   public browsers
```

Every WWG API endpoint requires an API key, so the proxy is what makes a
public site possible: the key lives in the Pages project's environment
variables and never reaches a browser. Responses are cached at the
Cloudflare edge (`caches.default`, per-colo) plus browser-cached via
`Cache-Control`, so public traffic bursts are absorbed by the CDN and cost
roughly one upstream call per station per interval.

## Repo layout

```
public/index.html            the dashboard (single file, no dependencies)
functions/api/stations.js    GET /api/stations
functions/api/data.js        GET /api/data (edge-cached)
functions/api/_lib.js        WWG API client + contract translation
functions/api/_config.js     station allow-list — EDIT THIS
```

Pages Functions use file-based routing: `functions/api/data.js` serves
`/api/data` automatically. Files starting with `_` are shared modules, not
routes.

## ⚠ Public-content policy

`public_name` in `_config.js` is what visitors see. Per WWG policy, do not
disclose customer names in public-facing content without marketing
approval — use neutral geographic names. The WWG station `code` never
leaves the server. The same applies to any custom domain you choose.

## Deploy (once, all browser-based)

1. **API key** — at app.westernwx.com/apikeys create a **new, dedicated
   key** for this site; scope it to only the stations the site will show
   if key scoping is available.
2. **GitHub repo** — Cloudflare Pages' git integration supports
   GitHub/GitLab (not Azure DevOps). Create a repo (private is fine) and
   upload this project's contents via the GitHub web UI, preserving the
   folder structure. Edit `functions/api/_config.js` with your real
   station entries before (or after) the first deploy.
3. **Create the Pages project** — dash.cloudflare.com → Workers & Pages →
   Create → Pages → Connect to Git → pick the repo. Build settings:
   *Framework preset:* None, *Build command:* (leave empty),
   *Build output directory:* `public`. Functions in `functions/` are
   detected automatically. Save and Deploy.
4. **Environment variables** — Pages project → Settings → Environment
   variables → Production:

   | Variable | Value |
   |---|---|
   | `WWG_API_KEY` | required — mark as **Secret** |
   | `QC_REDACT` | optional — `unreliable` recommended for public sites |
   | `WWG_API_BASE` | optional, default `https://api.westernwx.com` |
   | `CACHE_TTL_SEC` | optional, default `30` |

   Redeploy (Deployments → Retry) so the functions pick up the settings.
5. **Verify, in this order** (isolates failures cleanly):
   * `https://<project>.pages.dev/api/stations` → your station list JSON.
     Errors here = config problem (check the Functions real-time logs
     under the deployment).
   * `https://<project>.pages.dev/api/data?station=<id>&last=1` → one
     dataquery-shaped record. A 502 = upstream call failed (bad key, bad
     station code, or the `earliestDate` format question — test
     `&hours=1` too, which exercises the date path).
   * The site root → cards paint, charts fill after backfill.
6. **Custom domain** (optional) — Pages project → Custom domains. If the
   domain's DNS is on Cloudflare it's one click; TLS is automatic either
   way.

Updates from then on: edit → commit → automatic redeploy. Adding a station
is a `_config.js` edit.

## Contract translation notes

The WWG API is time-keyed and has no record numbers, so the proxy
synthesizes them: `no = floor(epochSeconds / intervalSeconds)` — a
deterministic, monotonic value that gives the front end stable dedup and
incremental-poll semantics. Timestamps arrive as ISO-8601 with UTC
offsets; the full instant feeds the record-number math, then the offset is
stripped so the page shows station-local wall time. The three dashboard
access patterns all map onto `POST /v2/stationdata/query`:
`?last=N` → `recordsPerStation`, `?hours=H` → `earliestDate = now − H`,
`?since_rec=R` → `earliestDate` just past that interval slot. Upstream
`recordsPerStation` is always capped. With `QC_REDACT` set, the proxy uses
`POST /v2/qc/stationdata/query` instead, so unreliable (or questionable)
values are withheld from the public site.

## API quick reference

```
GET /api/stations
GET /api/data?station=demo1&last=1        latest record
GET /api/data?station=demo1&hours=168     7-day window
GET /api/data?station=demo1&since_rec=N   records after synthetic record N
```
