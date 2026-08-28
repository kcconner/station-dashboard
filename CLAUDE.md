# station-dashboard — broadwaywx.com

Public weather-station dashboard for station WWG-1006 ("Broadway Weather"),
hosted on Cloudflare Pages at https://www.broadwaywx.com (and
https://station-dashboard.pages.dev). Data comes from the Western Weather
Group API (api.westernwx.com) via a key-holding proxy in Pages Functions,
plus USGS stream gauges. Built and tested conversationally with Claude
(claude.ai) in Aug 2026; this file transfers that context.

## Architecture

```
WWG station -> LoggerNet -> WWG DB -> WWG API v2 (X-Api-Key required)
                                          |
                          Pages Functions proxy (functions/api/*)
                          /api/stations /api/data /api/precip /api/stream
                                          |            \
                          Cloudflare edge cache      USGS Water Data API
                                          |          (api.waterdata.usgs.gov)
                          public/index.html (single-file dashboard)
```

The API key NEVER reaches the browser. Browsers only see public ids and
public_name values — the WWG station `code` stays server-side by design.

## File map

- `public/index.html` — the whole front end: WWG-branded CSS, dependency-free
  canvas charts (class `MiniChart`), current-conditions cards, precip totals
  tile, stream-gauge panels, data table, CSV export. No build step, no
  external assets (logo is an inline data URI).
- `functions/api/_config.js` — station allow-list. THE file to edit for
  stations, fields, conversions, stream gauges.
- `functions/api/_lib.js` — WWG API client + contract translation +
  CONVERSIONS table + jsonResponse/errorResponse helpers.
- `functions/api/data.js` — GET /api/data?station=&last=|hours=|since_rec=
- `functions/api/stations.js` — GET /api/stations
- `functions/api/precip.js` — GET /api/precip (calendar totals, KV-backed)
- `functions/api/stream.js` — GET /api/stream (USGS gauges)

Underscore-prefixed files in functions/ are shared modules, not routes.

## Core contract (do not break)

`/api/data` mirrors the CR1000X dataquery JSON shape:
`{head:{environment:{stationName,scan_sec},fields:[{name,units}]},
  data:[{time,no,vals:[...]}]}`.
- Missing values are the STRING "NAN" (front end's `num()` parses it).
- `time` is station-local wall time, offset stripped ("2026-07-28T10:39:00").
- `no` is SYNTHETIC: floor(epochSeconds / intervalSeconds). The WWG API is
  time-keyed with no record numbers; this synthesis gives the front end
  dedup + incremental-poll (`since_rec`) semantics. Monotonic, +1 per
  interval slot. The front end treats `no` going backwards as a table
  reset and clears its buffer.
- Unit conversions happen SERVER-SIDE in _lib.js via per-field
  `convert:` entries (c2f, ms2mph, mm2in in CONVERSIONS). Station reports
  metric; site displays imperial. `units:` on a field overrides the
  label; otherwise conversion units, otherwise /v2/metadata/fields.

## WWG API notes

- Auth: `X-Api-Key` header. The key is the SECRET, not the key ID (the
  ID/secret pair is for HTTP Basic). Getting this wrong yields HTTP 401.
- Workhorse: `POST /v2/stationdata/query` {interval, stations:[code],
  recordsPerStation | earliestDate | latestDate, utc:false, fields:[...]}.
  Returns newest-first; proxy reverses to ascending.
- Station WWG-1006 publishes ONLY 1-minute data (interval: 1). A stale
  10-minute table exists (dead since Jan 2026) — never query interval 10.
- Field keys: Temp, RH, DewPoint, WindSpeed, WindMax, WindDir, SolarRad,
  Precip (mm), BatVoltMin, PanelTemp, TempMax, TempMin, WindMaxDir.
  Values are metric despite the field dictionary claiming °F — trust the
  config conversions, not /v2/metadata/fields units, for this station.
- QC endpoint `POST /v2/qc/stationdata/query` used when env QC_REDACT set:
  interval is a STRING there, no `fields`/`utc` params.
- OpenAPI spec: https://api.westernwx.com/docs/public-v2.json

## Precip totals (/api/precip)

Station has no daily/hourly tables, so daily totals are computed from
1-minute data and stored permanently in Cloudflare KV (binding name
`PRECIP_KV`, one JSON object per station: {"YYYY-MM-DD": mm}).
- Lazy backfill: up to 6 missing days per request, newest first;
  `backfillRemaining` in the response; front end re-polls every 20 s while
  nonzero. Backfill since Jan 1 completed Aug 2026.
- Day attribution: a record stamped T covers (T − interval, T], so a
  local-midnight record belongs to the PREVIOUS day. Implemented via
  `dayOf()` using each record's own embedded local timestamp (DST-safe).
- Buckets: today (live 1-min), yesterday, 7 days (calendar, incl today),
  month-to-date, YTD. All station-local calendar days.
- Fallback mode (no KV binding): queries station.summaryInterval table.

## Stream gauges (/api/stream)

Uses the NEW USGS Water Data APIs (OGC API - Features), collection
`continuous`: items?monitoring_location_id=USGS-XXXX&parameter_code=00065
(stage) / 00060 (flow) &time=P7D&f=json&limit=1500. Anonymous access OK;
optional env USGS_API_KEY -> X-Api-Key.
- Do NOT use legacy waterservices.usgs.gov — decommission Q1 2027,
  degradation possible from Aug 2026.
- USGS values arrive as strings; times RFC3339; responses unsorted — proxy
  sorts ascending and drops unparseable points.
- Configured gauges: USGS-01632082 Linville Creek at Broadway,
  USGS-01632000 N F Shenandoah River at Cootes Store. (Beware: 01632900 is
  Smith Creek near New Market, NOT Linville Creek.)
- Front end: fixed 7-day dual-axis panels (stage L filled, flow R), section
  hidden if no gauges report. Keep the "USGS provisional data" note —
  their terms ask for it.

## Front end conventions

- `MiniChart` series entries: {role|get, color, kind:"line"|"bar",
  axis:"L"|"R", fill}. `role` reads via Store.roleVal; `get` is a direct
  accessor (used by stream panels). NaN values create line gaps.
- Axis rule: if a series' data minimum is >= 0, the axis never dips below
  zero (rain/wind/solar); genuinely negative data (winter temps) keeps full
  range. Bar axes always baseline at 0.
- Role auto-detection (ROLE_PATTERNS) maps field names to cards/charts;
  pinned names in CONFIG.fieldMap win. Cards/panels render only for roles
  present.
- WWG brand palette: Deep Blue #00669A, Horizon Blue #127EB7, Bright Blue
  #2495D3, Sky Blue #8CCEF0, teal #238F95 (ok/status), amber #C8993F
  (stale), rust #B5492A (error/NAN). Fonts DM Sans/Roboto with Arial
  fallback, no webfont imports (fully offline-capable file).

## Deployment & environment

Cloudflare Pages project `station-dashboard`, production branch `main`,
build output dir `public`, no build command. Every commit to main
auto-deploys (~1-2 min). GOTCHAS learned the hard way:
- Env vars and KV bindings attach at DEPLOY TIME — after changing them,
  a new deployment (commit or Retry on the LATEST deployment) is required.
  Retrying an OLD deployment resurrects old code.
- API responses carry Cache-Control (30 s data, 300 s precip, 600 s stream;
  15 s while precip backfilling) and cache at the edge AND in browsers.
  When testing changes, add a junk query param (&x=1) or hard-refresh;
  "deploy didn't work" is usually cache.
- Env vars (Pages > Settings > Variables and secrets, Production):
  WWG_API_KEY (secret, REQUIRED), QC_REDACT=unreliable (recommended),
  CACHE_TTL_SEC, SUMMARY_TTL_SEC, STREAM_TTL_SEC, USGS_API_KEY (optional).
- KV binding: variable name exactly `PRECIP_KV` -> namespace precip-dailies.

Local dev (optional): `npx wrangler pages dev public` auto-detects
functions/. Supply secrets via a `.dev.vars` file (WWG_API_KEY=...) and
`--kv PRECIP_KV`. If you create .dev.vars, ADD IT TO .gitignore — the repo
is PUBLIC.

## Policies & posture (important)

- The repo and site are PUBLIC. Never commit the WWG API key or any
  credential. Never put WWG customer names (SCE, etc.) in public-facing
  names, configs, or docs without marketing approval — neutral names only.
- Never leak upstream error details in public API responses — errors are
  the opaque {"error":"data source unavailable"}; details go to
  console.error (Functions logs). This was temporarily violated for
  debugging once; keep it reverted.
- Be polite to upstreams: keep edge caching on every endpoint; USGS gets
  at most a few requests per 10-min cycle.

## Testing conventions

Endpoints are tested in plain Node (v22+, no deps): import the module,
stub `globalThis.fetch` with canned upstream payloads, stub KV with a Map,
call `onRequestGet({request, env, waitUntil})`, assert on the parsed JSON.
Front-end logic is tested by extracting the <script> block and eval-ing
with minimal DOM stubs. Always `node --check` every touched file before
committing. Prior suites covered: dataquery contract shape, NAN/INF
parsing, synthetic recno monotonicity, table-reset recovery, KV backfill
order/resume/completion, midnight day-attribution, year-boundary
exclusion, mm->in conversion, USGS sorting/bad-value filtering.

## Known state / open items (Aug 28, 2026)

- Everything above is committed EXCEPT possibly the latest batch (stream
  gauges + data.js error revert) — verify functions/api/stream.js exists
  and data.js:~49 does not concatenate e.message before assuming deployed.
- broadwaywx.com blocked on WWG's corporate network as a "newly registered
  domain" — ages out ~30 days; pages.dev works there meanwhile.
- Bare domain broadwaywx.com not yet added as a custom domain (www only).
- Precip mm->in conversion confirmed by owner; verify plausibility after
  first big storm. WindDir unit label comes from WWG metadata ("°").
- Ideas parked: dew point card, multi-station map, wind rose, cumulative
  rain chart, 60-min WWG interval if ever added to the logger program.
