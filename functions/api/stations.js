/* GET /api/stations — public station directory (ids + display names only) */
import { STATIONS } from "./_config.js";
import { jsonResponse } from "./_lib.js";

export async function onRequestGet(context) {
  const ttl = parseInt(context.env.CACHE_TTL_SEC || "30", 10);
  return jsonResponse(
    STATIONS.map((s) => ({ id: s.id, name: s.public_name })),
    200,
    ttl
  );
}

