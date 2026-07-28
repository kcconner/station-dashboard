/*
 * Station allow-list — the only stations/fields the public site can reach.
 *
 *   id           public URL identifier used by the dashboard (?station=)
 *   code         the WWG API station code (server-side only; never sent
 *                to browsers)
 *   public_name  display name. PUBLIC SITE: per WWG policy, do not
 *                disclose customer names without marketing approval.
 *   interval     data interval in MINUTES (10 = Min10-equivalent)
 *   fields       WWG API field keys, in display order. Units/long names
 *                are pulled automatically from /v2/metadata/fields.
 *                Pin this list so only intended fields are exposed.
 *
 * Files beginning with "_" are not routed by Pages Functions — this is a
 * shared module, not an endpoint. Editing this file + committing deploys
 * the change.
 */
export const STATIONS = [
  {
    id: "Broadway Weather",
    code: "WWG-1006",
    public_name: "Broadway Weather",
    interval: 10,
    fields: ["Temp", "RH", "WindSpeed", "WindSpeedMax", "WindDir",
             "Solar", "Precip", "Battery"],
  },
  {
    id: "demo2",
    code: "DEF",
    public_name: "High Desert Plateau",
    interval: 10,
    fields: ["Temp", "RH", "WindSpeed", "WindDir", "Battery"],
  },
];

export function getStation(id) {
  return STATIONS.find((s) => s.id === id) || null;
}
