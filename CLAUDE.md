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
  canvas charts (class `MiniChart`, zoom/pan), current-conditions tiles that
  link through to per-parameter history tables, one merged precipitation tile,
  stream-gauge panels, CSV export. No build step, no external assets (logo is
  an inline data URI). There is no longer a full data table on the page — it
  was replaced by the per-parameter tables (Aug 2026).
- `functions/api/_config.js` — station allow-list. THE file to edit for
  stations, fields, conversions, stream gauges.
- `functions/api/_lib.js` — WWG API client + contract translation +
  CONVERSIONS table + jsonResponse/errorResponse helpers.
- `functions/api/data.js` — GET /api/data?station=&last=|hours=|since_rec=
- `functions/api/stations.js` — GET /api/stations
- `functions/api/precip.js` — GET /api/precip (calendar totals, KV-backed)
- `functions/api/stream.js` — GET /api/stream (USGS gauges)
- `tests/frontend.test.js` — front-end suite, `node tests/frontend.test.js`

Underscore-prefixed files in functions/ are shared modules, not routes.
Pages only publishes `public/`, so `tests/` is never served.

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
- The front end shows `today` from its own buffer (live, no KV round-trip) and
  takes yesterday/7-day/month/YTD from this endpoint, so `today` in the
  response is currently unused by the tile. Keep returning it.
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
  USGS-01632000 N F Shenandoah River at Cootes Store, USGS-01636500
  Shenandoah River at Millville WV, USGS-01636464 Bullskin Run below
  Kabletown WV. (Beware: 01632900 is Smith Creek near New Market, NOT
  Linville Creek; and 01636460 is Bullskin Run ABOVE Kabletown.)
- ONE GAUGE PER REQUEST. `?gauge=<id>` picks one, no param gives the first
  configured one, `?gauge=all` restores the old every-gauge response. Every
  response carries `catalog: [{id,label}]` for all configured gauges — that
  is what fills the picker, so the browser gets a 4-item menu without
  pulling 4 gauges' worth of series. Each variant caches under its own URL.
- Front end: a `<select>` in the section header (hidden when only one gauge
  is configured) chooses the gauge; a fixed 7-day dual-axis panel (stage L
  filled, flow R) is drawn for it. The selection is mirrored in the query
  string as `?gauge=`, survives the 15-min refresh, and falls back to the
  default once if a stale id 404s. Section hides only when the catalog is
  empty; a configured-but-silent gauge gets a "No recent data" note instead.
  Keep the "USGS provisional data" note — their terms ask for it.

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
- Chart zoom/pan lives on the chart instance as `view = [t0,t1]` (null = full
  extent), clamped inside the data every draw; zooming back out past the full
  span clears it. Wheel zooms at the cursor, drag/shift+wheel pans, pinch on
  touch, double-click or `resetZoom()` restores. The y-axis rescales to the
  visible window, and one point either side of it is drawn (then clipped) so
  lines entering the view stay connected. Zoom is PER CHART on purpose — the
  fixed 7-day stream panels must not be dragged around by the station charts.
  Changing the range buttons clears every chart's zoom.
- Tiles link to per-parameter history tables. `PARAM_VIEWS` maps a param id to
  a label + columns; `Drill` renders the overlay; the open view is mirrored in
  the URL as `#param=<id>` so it is shareable and Back closes it. Only params
  whose roles the station actually reports become clickable. Wind is one tile
  but a three-column table (speed/gust/direction).
- Tile day figures (`dayStats`) use the SAME day attribution as the precip
  backend: a record stamped T covers (T - interval, T], so a local-midnight
  record belongs to the previous day. Implemented by subtracting 1 ms before
  reading the local date — DST-safe because timestamps are already local.
  Keep this in step with `dayOf()` server-side or the tiles and the KV totals
  will disagree by one record.
- Air-temperature tile: the label is the full "Air Temperature", and the
  detail line under the reading is the apparent temperature —
  `feelsLikeF()` implements the NWS Rothfusz heat index (>= 80 °F, with the
  dry-air and muggy-air corrections) and the 2001 wind chill (<= 50 °F,
  wind > 3 mph). It works in °F internally and converts back through the
  field's own units, so a °C station still gets the right answer. The line
  is suppressed unless the result is at least a degree HOTTER (heat) or
  COLDER (chill) than the thermometer — near the 80/50 °F edges the
  formulas otherwise print a "feels like" that is not different, or points
  the wrong way. Nothing is stored: it is computed from the latest record.
- Battery tile: `BATT_LOW_V` (11.5) flags the current reading, `BATT_DIP_V`
  (12) is the level whose 24 h excursions are counted. The count is
  EXCURSIONS, not readings — a continuous run below the line counts once, and
  a NAN mid-run does not split it. Border colour is reassigned every refresh
  (rust / amber / none) so the tile recovers; do not go back to setting it
  only on the low branch.
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
is PUBLIC, and there is no .gitignore in the repo yet, so you have to
create one.

For front-end-only work (layout, tiles, charts) you don't need the API key:
serve `public/` from any static server and stub `/api/*` with synthetic data
on the same origin. Note the API sets no CORS headers, so a local page cannot
be pointed at production via `?api=` — the browser will block it.

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
exclusion, mm->in conversion, USGS sorting/bad-value filtering; and on the
front end, role auto-detection, tile linking, #param deep links and Back,
history-table row capping, chart zoom/pan clamping at both limits,
wheel/drag/pinch/double-click gestures, tile day-boundary attribution, and
battery excursion counting.

The front-end suite IS in the repo and takes no arguments:

    node tests/frontend.test.js

102 assertions, exits non-zero on failure. It covers role auto-detection,
tile linking, #param deep links and Back, history-table row capping, chart
zoom/pan clamping, wheel/drag/pinch/double-click gestures, day-boundary
attribution, the battery excursion count, the heat-index/wind-chill maths
against the NWS tables, and the stream-gauge picker (catalog -> options,
selection reaching the endpoint and the URL, surviving a refresh, silent
gauge, no gauges). Run it after touching
public/index.html — it is the only thing standing between a typo and a
broken dashboard, since there is no build step to catch anything.

Backend/endpoint suites are still ad hoc and not committed. There is no
package.json and no test runner; tests are plain Node scripts, run directly.

Two DOM-stub requirements that are easy to get wrong (both documented in the
test header): `document.createTextNode` is needed as well as `createElement`,
and `getElementById` must resolve cards created at runtime — otherwise every
tile assertion reads through a null card and silently PASSES. The gauge
picker added three more: FakeEl needs `value`/`hidden`/`dataset`, `location`
needs an `href` and `history.replaceState`, and `global.URL` must extend
Node's real URL (setGaugeParam parses `location.href`) rather than replace it
with the object-URL stub.

## Known state / open items (Aug 28, 2026)

- Stream gauges and the data.js error revert ARE committed (8f39787 and
  earlier) — the previous note asking you to verify them is resolved.
  functions/api/stream.js exists and no endpoint leaks e.message.
- The dashboard UI overhaul is committed as e4dfdf7: per-parameter history
  tables, chart zoom/pan, today/yesterday tile figures, merged precip tile,
  battery excursion count, page data table removed. Pushed and verified live
  on both www.broadwaywx.com and station-dashboard.pages.dev.
- broadwaywx.com blocked on WWG's corporate network as a "newly registered
  domain" — ages out ~30 days; pages.dev works there meanwhile.
- Bare domain broadwaywx.com not yet added as a custom domain (www only).
- Precip mm->in conversion confirmed by owner; verify plausibility after
  first big storm. WindDir unit label comes from WWG metadata ("°").
- The history overlay does not trap focus — Tab can walk into the page
  behind it. Escape and the close button work, so it is usable, but it is
  not a fully compliant modal.
- Sep 3, 2026: air-temperature tile renamed and given a feels-like line; the
  two WV gauges (Millville, Bullskin Run) added behind a gauge picker.
  Bullskin Run is a small stream — confirm it actually returns 00060 flow as
  well as 00065 stage once it is live; the panel degrades to stage only if
  not.
- Ideas parked: feels-like as a column in the air-temperature history table
  (PARAM_VIEWS columns are role-based, so this needs a computed-column hook
  in Drill), dew point card (DewPoint is already queried and lands in the
  full CSV export, but has no ROLE_PATTERNS entry, so it gets no tile, no
  chart and no history table), multi-station map, wind rose, cumulative rain
  chart, synchronised zoom across charts, 60-min WWG interval if ever added
  to the logger program.
