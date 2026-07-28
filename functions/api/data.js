/* GET /api/data?station=<id>&last=N | &hours=H | &since_rec=R
 * Response mirrors the CR1000X dataquery JSON contract (see _lib.js).
 * Edge-cached via caches.default keyed on the full request URL. */
import { getStation } from "./_config.js";
import { queryData, jsonResponse, errorResponse } from "./_lib.js";

function intParam(url, name) {
  if (!url.searchParams.has(name)) return null;
  const v = parseInt(url.searchParams.get(name), 10);
  return Number.isNaN(v) ? NaN : v;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const ttl = parseInt(env.CACHE_TTL_SEC || "30", 10);

  const station = getStation(url.searchParams.get("station") || "");
  if (!station) return errorResponse("unknown station", 404);

  let last = intParam(url, "last");
  let sinceRec = intParam(url, "since_rec");
  let hours = url.searchParams.has("hours")
    ? parseFloat(url.searchParams.get("hours"))
    : null;
  if ([last, sinceRec, hours].some((v) => typeof v === "number" && Number.isNaN(v)))
    return errorResponse("bad parameter", 400);
  if (last === null && sinceRec === null && hours === null) last = 1;

  // clamps — public endpoint, keep queries bounded
  if (last !== null) last = Math.max(1, Math.min(last, 100));
  if (hours !== null) hours = Math.max(0.1, Math.min(hours, 24 * 14));
  if (sinceRec !== null && sinceRec < 0) return errorResponse("bad parameter", 400);

  // edge cache (per-colo); normalized key = the request URL
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  let resp;
  try {
    const payload = await queryData(station, { last, hours, sinceRec }, env);
    resp = jsonResponse(payload, 200, ttl);
  } catch (e) {
    console.error(`WWG API query failed for station=${station.id}: ${e.message}`);
    return errorResponse("data source unavailable: " + e.message, 502);
  }

  if (cache) context.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}

