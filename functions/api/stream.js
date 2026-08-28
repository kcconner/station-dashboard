/* GET /api/stream?station=<id>
 *
 * USGS stream-gauge data for the gauges configured on a station:
 *   { gauges: [ { id, label, asOf,
 *                 stage: {unit, t:[epochSec], v:[num]},
 *                 flow:  {unit, t:[epochSec], v:[num]} } ] }
 *
 * Source: the modernized USGS Water Data APIs (OGC API - Features),
 * collection "continuous" — the legacy waterservices.usgs.gov family is
 * being decommissioned (Q1 2027, degradation possible from Aug 2026), so
 * this deliberately targets the replacement:
 *   GET /ogcapi/v0/collections/continuous/items
 *       ?monitoring_location_id=USGS-01632082&parameter_code=00065
 *       &time=P7D&f=json&limit=1500
 * Values arrive as strings (precision preservation) with RFC3339 times.
 * Anonymous access is permitted; set USGS_API_KEY to send an X-Api-Key
 * for higher rate limits if ever needed.
 *
 * Edge-cached for STREAM_TTL_SEC (default 600) — gauges report every
 * 15 min, so public traffic costs USGS at most a few requests per cycle.
 * Config (per station in _config.js):
 *   streamGauges: [ { id: "USGS-01632082", label: "Linville Creek at Broadway" } ]
 */
import { getStation } from "./_config.js";
import { jsonResponse, errorResponse } from "./_lib.js";

const USGS_BASE = "https://api.waterdata.usgs.gov/ogcapi/v0";
const PARAMS = { stage: "00065", flow: "00060" };
const WINDOW = "P7D";
const LIMIT = 1500;              // 7 d of 15-min data = 672 points
const TIMEOUT_MS = 20000;

async function usgsSeries(env, gaugeId, parameterCode) {
  const u = USGS_BASE + "/collections/continuous/items" +
    "?monitoring_location_id=" + encodeURIComponent(gaugeId) +
    "&parameter_code=" + parameterCode +
    "&time=" + WINDOW + "&f=json&limit=" + LIMIT;
  const headers = { "Accept": "application/geo+json" };
  if (env.USGS_API_KEY) headers["X-Api-Key"] = env.USGS_API_KEY;
  const resp = await fetch(u, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`USGS ${gaugeId}/${parameterCode} -> HTTP ${resp.status}`);
  const gj = await resp.json();
  const feats = (gj && gj.features) || [];

  const pts = [];
  let unit = "";
  for (const f of feats) {
    const p = f.properties || {};
    const t = Date.parse(p.time);
    const v = parseFloat(p.value);
    if (Number.isNaN(t) || Number.isNaN(v)) continue;
    if (!unit && p.unit_of_measure) unit = p.unit_of_measure;
    pts.push([Math.floor(t / 1000), v]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  return { unit, t: pts.map((p) => p[0]), v: pts.map((p) => p[1]) };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const station = getStation(url.searchParams.get("station") || "");
  if (!station) return errorResponse("unknown station", 404);
  const gauges = station.streamGauges || [];
  if (!gauges.length) return jsonResponse({ gauges: [] }, 200, 3600);

  const ttl = parseInt(env.STREAM_TTL_SEC || "600", 10);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  try {
    const out = [];
    for (const g of gauges) {
      // stage + flow in parallel per gauge; a gauge missing one parameter
      // (some report stage only) degrades gracefully
      const [stage, flow] = await Promise.all([
        usgsSeries(env, g.id, PARAMS.stage).catch(() => ({ unit: "", t: [], v: [] })),
        usgsSeries(env, g.id, PARAMS.flow).catch(() => ({ unit: "", t: [], v: [] })),
      ]);
      if (!stage.t.length && !flow.t.length) continue;   // silent gauge
      const newest = Math.max(
        stage.t.length ? stage.t[stage.t.length - 1] : 0,
        flow.t.length ? flow.t[flow.t.length - 1] : 0,
      );
      out.push({ id: g.id, label: g.label || g.id, asOf: newest, stage, flow });
    }
    const resp = jsonResponse({ gauges: out }, 200, ttl);
    if (cache) context.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  } catch (e) {
    console.error(`stream gauges failed for station=${station.id}: ${e.message}`);
    return errorResponse("data source unavailable", 502);
  }
}
