/*
 * Upstream client for the WWG API (api.westernwx.com) — JS port of the
 * translation layer. Maps the dashboard's three access patterns onto
 * POST /v2/stationdata/query (or the QC variant) and reshapes WeatherData
 * records into the CR1000X dataquery-style contract the front end speaks.
 *
 * Key translations (identical semantics to the Python version):
 *  - Record numbers: the WWG API is time-keyed; we synthesize
 *      no = floor(epochSeconds / intervalSeconds)
 *    which is deterministic and monotonic, giving the front end stable
 *    dedup/incremental semantics.
 *  - Timestamps: the API returns ISO-8601 with a UTC offset. The full
 *    instant feeds the record-number math; the offset is then stripped so
 *    the page shows station-local wall time.
 *  - Field metadata (units/names) comes from /v2/metadata/fields, cached
 *    per-isolate for METADATA_TTL_SEC (default 3600).
 *
 * Environment (Pages project settings):
 *   WWG_API_KEY       required — sent as X-Api-Key. Use a key scoped to
 *                     only the stations this site exposes.
 *   WWG_API_BASE      optional — default https://api.westernwx.com
 *   QC_REDACT         optional — "unreliable" | "questionable" switches to
 *                     the QC endpoint with that redaction level.
 *   CACHE_TTL_SEC     optional — edge/browser cache TTL, default 30.
 *   METADATA_TTL_SEC  optional — default 3600.
 */

const MAX_RECORDS_PER_QUERY = 2500; // safety cap (14 d of 10-min = 2016)
const UPSTREAM_TIMEOUT_MS = 25000;

// per-isolate metadata cache (isolates recycle; that's fine, it refetches)
let fieldMeta = { expires: 0, data: {} };

function base(env) {
  return (env.WWG_API_BASE || "https://api.westernwx.com").replace(/\/+$/, "");
}

const CONVERSIONS = {
  c2f:    { fn: (v) => v * 9 / 5 + 32, units: "\u00B0F" },
  ms2mph: { fn: (v) => v * 2.236936,   units: "mph" },
  mm2in:  { fn: (v) => v / 25.4,       units: "in" },
};

async function upstream(env, method, path, body) {
  const resp = await fetch(base(env) + path, {
    method,
    headers: {
      "X-Api-Key": env.WWG_API_KEY,
      "Accept": "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`upstream ${path} -> HTTP ${resp.status}`);
  }
  return resp.json();
}

async function fieldMetadata(env) {
  const ttl = parseInt(env.METADATA_TTL_SEC || "3600", 10) * 1000;
  const now = Date.now();
  if (fieldMeta.expires < now) {
    try {
      fieldMeta = { data: (await upstream(env, "GET", "/v2/metadata/fields")) || {}, expires: now + ttl };
    } catch {
      // metadata is cosmetic — don't fail data requests, retry soon
      fieldMeta.expires = now + 60000;
    }
  }
  return fieldMeta.data;
}

function isoUtc(epochMs) {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function qcRedact(env) {
  const v = (env.QC_REDACT || "").trim().toLowerCase();
  return ["unreliable", "questionable", "u", "q"].includes(v) ? v : null;
}

export function buildQuery(station, { last, hours, sinceRec }) {
  const intervalSec = station.interval * 60;
  const body = {
    interval: station.interval,
    stations: [station.code],
    utc: false,
    recordsPerStation: MAX_RECORDS_PER_QUERY,
  };
  if (station.fields && station.fields.length)
    body.fields = station.fields.map((f) => (typeof f === "string" ? f : f.key));

  if (last != null) {
    body.recordsPerStation = Math.min(last, MAX_RECORDS_PER_QUERY);
  } else if (sinceRec != null) {
    // first instant strictly after the given synthetic record number
    body.earliestDate = isoUtc((sinceRec + 1) * intervalSec * 1000);
  } else if (hours != null) {
    body.earliestDate = isoUtc(Date.now() - hours * 3600e3);
  }
  return body;
}

export async function queryData(station, selectors, env) {
  const body = buildQuery(station, selectors);
  const redact = qcRedact(env);
  let records;
  if (redact) {
    const qcBody = { ...body, interval: String(body.interval), redact, qcResults: "none" };
    delete qcBody.utc;      // not part of the QC query schema
    delete qcBody.fields;   // QC query has no fields param; we filter below
    records = await upstream(env, "POST", "/v2/qc/stationdata/query", qcBody);
  } else {
    records = await upstream(env, "POST", "/v2/stationdata/query", body);
  }
  if (!Array.isArray(records)) records = [];

  const intervalSec = station.interval * 60;
const fieldDefs = (station.fields && station.fields.length
    ? station.fields : discoverFields(records))
    .map((f) => (typeof f === "string" ? { key: f } : f));
  const fields = fieldDefs.map((d) => d.key);
  const meta = await fieldMetadata(env);

  // API returns newest -> oldest; the front end wants ascending
  const data = [];
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    const epochMs = Date.parse(rec.date);
    if (!rec.date || Number.isNaN(epochMs)) continue;
    const rvals = rec.values || {};
    const vals = fieldDefs.map((d) => {
      const v = rvals[d.key];
      if (v === null || v === undefined) return "NAN";
      if (typeof v === "number") {
        if (Number.isNaN(v)) return "NAN";
        const c = d.convert && CONVERSIONS[d.convert];
        return c ? Math.round(c.fn(v) * 100) / 100 : v;
      }
      return String(v);
    });
    data.push({
      time: rec.date.slice(0, 19),                        // station-local wall time
      no: Math.floor(epochMs / 1000 / intervalSec),       // synthetic record number
      vals,
    });
  }

  return {
    head: {
      environment: {
        stationName: station.public_name,
        scan_sec: intervalSec,
      },
      fields: fieldDefs.map((d) => ({
        name: d.key,
        units: d.units !== undefined ? d.units
             : (d.convert && CONVERSIONS[d.convert]) ? CONVERSIONS[d.convert].units
             : (meta[d.key] && meta[d.key].units) || "",
      })),
    },
    data,
  };
}

function discoverFields(records) {
  const seen = [];
  for (const rec of records) {
    for (const k of Object.keys(rec.values || {})) {
      if (!seen.includes(k)) seen.push(k);
    }
  }
  return seen;
}

/* ---------------------------------------------------------- HTTP helpers -- */
export function jsonResponse(payload, status = 200, ttlSec = 30) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${ttlSec}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function errorResponse(message, status, ttlSec = 5) {
  // short TTL on errors so a transient upstream blip isn't cached for long
  return jsonResponse({ error: message }, status, ttlSec);
}

