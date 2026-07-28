/* GET /api/precip?station=<id>
 *
 * Calendar-bucketed precipitation totals, station-local time:
 *   { station, units, asOf, today, yesterday, week, month, ytd }
 *
 * Strategy: two upstream queries.
 *   1. History at a coarse interval (station.summaryInterval, default 1440 =
 *      daily; set 60 if the station has no daily table) from Jan 1 — cheap
 *      (~210 daily or ~5100 hourly records YTD).
 *   2. The station's native interval for the last ~26 h to compute "today",
 *      which the coarse table won't contain until the day closes.
 *
 * Day attribution: a record timestamped T covers (T − interval, T], so a
 * record stamped at local midnight belongs to the PREVIOUS day. We attribute
 * each record to the local date of (T − interval).
 *
 * Applies the same unit conversion configured for the Precip field in
 * _config.js. Edge-cached for SUMMARY_TTL_SEC (default 300).
 */
import { getStation } from "./_config.js";
import { CONVERSIONS, upstream, jsonResponse, errorResponse } from "./_lib.js";

const HIST_MAX_RECORDS = 9000;   // covers hourly YTD with headroom

function wallMs(dateStr) {
  // treat the local wall time as UTC for pure date arithmetic
  return Date.parse(dateStr.slice(0, 19) + "Z");
}

function dayOf(dateStr, intervalMin) {
  // local calendar date the record's interval belongs to
  return new Date(wallMs(dateStr) - intervalMin * 60000)
    .toISOString().slice(0, 10);
}

function shiftDay(day, deltaDays) {
  return new Date(Date.parse(day + "T00:00:00Z") + deltaDays * 86400e3)
    .toISOString().slice(0, 10);
}

function isoUtcNowMinusHours(h) {
  return new Date(Date.now() - h * 3600e3).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function sumPrecip(records, intervalMin, includeDay) {
  let total = 0;
  for (const rec of records) {
    const v = rec.values && rec.values.Precip;
    if (typeof v !== "number" || Number.isNaN(v)) continue;
    if (includeDay(dayOf(rec.date, intervalMin))) total += v;
  }
  return total;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const station = getStation(url.searchParams.get("station") || "");
  if (!station) return errorResponse("unknown station", 404);

  const ttl = parseInt(env.SUMMARY_TTL_SEC || "300", 10);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  try {
    // Precip display conversion, same rules as the data endpoint
    const defs = (station.fields || [])
      .map((f) => (typeof f === "string" ? { key: f } : f));
    const pdef = defs.find((d) => d.key === "Precip") || { key: "Precip" };
    const conv = pdef.convert && CONVERSIONS[pdef.convert];
    const units = pdef.units !== undefined ? pdef.units : (conv ? conv.units : "");
    const out = (v) => Math.round((conv ? conv.fn(v) : v) * 100) / 100;

    // ---- query 1: native interval, last ~26 h, for "today" ----------------
    const nativeMin = station.interval;
    const minute = await upstream(env, "POST", "/v2/stationdata/query", {
      interval: nativeMin,
      stations: [station.code],
      utc: false,
      fields: ["Precip"],
      recordsPerStation: Math.min(Math.ceil((26 * 60) / nativeMin) + 5, 2500),
      earliestDate: isoUtcNowMinusHours(26),
    });
    const minuteRecs = Array.isArray(minute) ? minute : [];
    if (!minuteRecs.length) {
      // station silent — report unknowns rather than fake zeros
      return jsonResponse({ station: station.public_name, units, asOf: null,
        today: null, yesterday: null, week: null, month: null, ytd: null },
        200, ttl);
    }
    const newest = minuteRecs[0];                       // API sorts newest first
    const today = dayOf(newest.date, nativeMin);
    const year = today.slice(0, 4);
    const todayRaw = sumPrecip(minuteRecs, nativeMin, (d) => d === today);

    // ---- query 2: coarse interval since Jan 1, for the history buckets ----
    const histMin = station.summaryInterval || 1440;
    const hist = await upstream(env, "POST", "/v2/stationdata/query", {
      interval: histMin,
      stations: [station.code],
      utc: false,
      fields: ["Precip"],
      recordsPerStation: HIST_MAX_RECORDS,
      // overfetch two days into last year; local-date filtering trims it
      earliestDate: `${+year - 1}-12-30T00:00:00Z`,
    });
    const histRecs = Array.isArray(hist) ? hist : [];

    const jan1 = `${year}-01-01`;
    const monthStart = today.slice(0, 8) + "01";
    const yesterday = shiftDay(today, -1);
    const weekStart = shiftDay(today, -6);
    // history buckets always exclude today (today comes from query 1)
    const before = (d) => d < today;

    const yRaw = sumPrecip(histRecs, histMin, (d) => d === yesterday);
    const wRaw = sumPrecip(histRecs, histMin, (d) => before(d) && d >= weekStart) + todayRaw;
    const mRaw = sumPrecip(histRecs, histMin, (d) => before(d) && d >= monthStart) + todayRaw;
    const ytdRaw = sumPrecip(histRecs, histMin, (d) => before(d) && d >= jan1) + todayRaw;

    const resp = jsonResponse({
      station: station.public_name,
      units,
      asOf: newest.date.slice(0, 19),
      today: out(todayRaw),
      yesterday: out(yRaw),
      week: out(wRaw),
      month: out(mRaw),
      ytd: out(ytdRaw),
    }, 200, ttl);
    if (cache) context.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  } catch (e) {
    console.error(`precip summary failed for station=${station.id}: ${e.message}`);
    return errorResponse("data source unavailable", 502);
  }
}
