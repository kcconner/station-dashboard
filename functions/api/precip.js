/* GET /api/precip?station=<id>
 *
 * Calendar-bucketed precipitation totals, station-local time:
 *   { station, units, asOf, today, yesterday, week, month, ytd,
 *     backfillRemaining }
 *
 * TWO MODES:
 *
 * KV mode (PRECIP_KV binding present) — for stations that only publish
 * fine-interval data. Daily totals are computed from the native-interval
 * records one local day at a time and stored permanently in KV (one JSON
 * object per station; closed days never change). Each request lazily
 * backfills up to BACKFILL_PER_REQUEST missing days, newest first, so
 * recent buckets become accurate immediately and YTD converges over a few
 * dozen requests. `backfillRemaining` reports progress.
 *
 * Fallback mode (no KV binding) — queries station.summaryInterval
 * (default 1440) from Jan 1, for stations that publish daily/hourly tables.
 *
 * Day attribution: a record timestamped T covers (T − interval, T], so a
 * record stamped at local midnight belongs to the PREVIOUS day. Attribution
 * uses each record's own embedded local timestamp, which also makes DST
 * transitions self-correcting.
 *
 * Applies the same unit conversion configured for the Precip field in
 * _config.js. Response edge-cached for SUMMARY_TTL_SEC (default 300);
 * while backfill is incomplete a short TTL (15 s) is used so progress
 * polling isn't served stale.
 */
import { getStation } from "./_config.js";
import { CONVERSIONS, upstream, jsonResponse, errorResponse } from "./_lib.js";

const HIST_MAX_RECORDS = 9000;     // fallback mode: hourly YTD with headroom
const BACKFILL_PER_REQUEST = 6;    // day-queries per invocation (subrequest budget)

/* ------------------------------------------------------------ date utils -- */
function wallMs(dateStr) {
  return Date.parse(dateStr.slice(0, 19) + "Z"); // wall time as UTC, for arithmetic
}
function dayOf(dateStr, intervalMin) {
  return new Date(wallMs(dateStr) - intervalMin * 60000)
    .toISOString().slice(0, 10);
}
function shiftDay(day, deltaDays) {
  return new Date(Date.parse(day + "T00:00:00Z") + deltaDays * 86400e3)
    .toISOString().slice(0, 10);
}
function isoUtc(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
function offsetMinOf(dateStr) {
  const m = dateStr.slice(19).match(/([+-])(\d{2}):(\d{2})/);
  if (!m) return 0; // "Z" or missing
  return (m[1] === "-" ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
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

/* ------------------------------------------------- KV mode: day backfill -- */
async function fetchDayTotal(env, station, day, approxOffsetMin) {
  // UTC window generously covering local day `day` (±2 h beyond the 24 h,
  // absorbing DST drift in the offset approximation); records are then
  // filtered by their own embedded local date, so attribution stays exact.
  const localMidnightUtc = Date.parse(day + "T00:00:00Z") - approxOffsetMin * 60000;
  const records = await upstream(env, "POST", "/v2/stationdata/query", {
    interval: station.interval,
    stations: [station.code],
    utc: false,
    fields: ["Precip"],
    recordsPerStation: Math.min(Math.ceil((28 * 60) / station.interval) + 5, 2500),
    earliestDate: isoUtc(localMidnightUtc - 2 * 3600e3),
    latestDate: isoUtc(localMidnightUtc + 26 * 3600e3),
  });
  const recs = Array.isArray(records) ? records : [];
  return sumPrecip(recs, station.interval, (d) => d === day);
}

function kvKey(station) {
  return "precip-dailies:" + station.id;
}

async function kvLoad(env, station) {
  try {
    const raw = await env.PRECIP_KV.get(kvKey(station));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

async function kvSave(env, station, dailies) {
  try { await env.PRECIP_KV.put(kvKey(station), JSON.stringify(dailies)); }
  catch (e) { console.error("KV save failed: " + e.message); }
}

/* ------------------------------------------------------------- endpoint -- */
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
    const defs = (station.fields || [])
      .map((f) => (typeof f === "string" ? { key: f } : f));
    const pdef = defs.find((d) => d.key === "Precip") || { key: "Precip" };
    const conv = pdef.convert && CONVERSIONS[pdef.convert];
    const units = pdef.units !== undefined ? pdef.units : (conv ? conv.units : "");
    const out = (v) => Math.round((conv ? conv.fn(v) : v) * 100) / 100;

    // ---- native interval, last ~26 h: today's running total + "now" ------
    const nativeMin = station.interval;
    const minute = await upstream(env, "POST", "/v2/stationdata/query", {
      interval: nativeMin,
      stations: [station.code],
      utc: false,
      fields: ["Precip"],
      recordsPerStation: Math.min(Math.ceil((26 * 60) / nativeMin) + 5, 2500),
      earliestDate: isoUtc(Date.now() - 26 * 3600e3),
    });
    const minuteRecs = Array.isArray(minute) ? minute : [];
    if (!minuteRecs.length) {
      return jsonResponse({ station: station.public_name, units, asOf: null,
        today: null, yesterday: null, week: null, month: null, ytd: null,
        backfillRemaining: null }, 200, ttl);
    }
    const newest = minuteRecs[0];
    const today = dayOf(newest.date, nativeMin);
    const year = today.slice(0, 4);
    const jan1 = `${year}-01-01`;
    const monthStart = today.slice(0, 8) + "01";
    const yesterday = shiftDay(today, -1);
    const weekStart = shiftDay(today, -6);
    const todayRaw = sumPrecip(minuteRecs, nativeMin, (d) => d === today);

    let dayTotal;              // (day) => raw total or undefined
    let backfillRemaining = 0;

    if (env.PRECIP_KV) {
      // ---------------- KV mode: stored dailies + lazy backfill -----------
      const dailies = await kvLoad(env, station);
      const missing = [];
      for (let d = yesterday; d >= jan1; d = shiftDay(d, -1)) {
        if (dailies[d] === undefined) missing.push(d);   // newest first
      }
      if (missing.length) {
        const approxOffsetMin = offsetMinOf(newest.date);
        const batch = missing.slice(0, BACKFILL_PER_REQUEST);
        for (const d of batch) {
          dailies[d] = await fetchDayTotal(env, station, d, approxOffsetMin);
        }
        await kvSave(env, station, dailies);
        backfillRemaining = missing.length - batch.length;
      }
      dayTotal = (d) => dailies[d];
    } else {
      // ---------------- fallback mode: coarse-interval table --------------
      const histMin = station.summaryInterval || 1440;
      const hist = await upstream(env, "POST", "/v2/stationdata/query", {
        interval: histMin,
        stations: [station.code],
        utc: false,
        fields: ["Precip"],
        recordsPerStation: HIST_MAX_RECORDS,
        earliestDate: `${+year - 1}-12-30T00:00:00Z`,
      });
      const histRecs = Array.isArray(hist) ? hist : [];
      const sums = {};
      for (const rec of histRecs) {
        const v = rec.values && rec.values.Precip;
        if (typeof v !== "number" || Number.isNaN(v)) continue;
        const d = dayOf(rec.date, histMin);
        sums[d] = (sums[d] || 0) + v;
      }
      dayTotal = (d) => sums[d];
    }

    const sumRange = (from, to) => {   // inclusive local-date range, closed days
      let t = 0;
      for (let d = from; d <= to; d = shiftDay(d, 1)) {
        const v = dayTotal(d);
        if (typeof v === "number") t += v;
      }
      return t;
    };

    const yRaw = dayTotal(yesterday);
    const resp = jsonResponse({
      station: station.public_name,
      units,
      asOf: newest.date.slice(0, 19),
      today: out(todayRaw),
      yesterday: typeof yRaw === "number" ? out(yRaw) : null,
      week: out(sumRange(weekStart, yesterday) + todayRaw),
      month: out(sumRange(monthStart, yesterday) + todayRaw),
      ytd: out(sumRange(jan1, yesterday) + todayRaw),
      backfillRemaining,
    }, 200, backfillRemaining > 0 ? 15 : ttl);
    if (cache) context.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  } catch (e) {
    console.error(`precip summary failed for station=${station.id}: ${e.message}`);
    return errorResponse("data source unavailable", 502);
  }
}
