import { readFile } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";
const DEMO_DIR = process.env.DEMO_DIR ?? path.resolve(process.cwd(), "../data/demo");

// Small payload for the simulation: only buildings the fire reaches (2.6k of 42.6k), only the fields it needs,
// plus the LAFD stations. buildings.json is 40 MB, too big for the browser. Generated data, never committed.
let cache: { mtime: number; body: string } | null = null;

export async function GET(req: Request) {
  const file = path.join(DEMO_DIR, "buildings.json");
  const { stat } = await import("node:fs/promises");
  const mtime = (await stat(file)).mtimeMs;
  if (!cache || cache.mtime !== mtime) {
    const raw = JSON.parse(await readFile(file, "utf8"));
    const all = (Array.isArray(raw) ? raw : raw.buildings) as Record<string, any>[];
    const buildings = all.filter(b => b.fire_arrival_min !== null && b.people_est > 0).map(b => ({
      id: b.id, lat: b.lat, lng: b.lng, people_est: b.people_est, people_need_help_est: b.people_need_help_est,
      fire_arrival_min: b.fire_arrival_min, units: b.units, height_m: b.height_m,
      costar: b.costar ? { id: b.costar.id, name: b.costar.name, address: b.costar.address, stories: b.costar.stories,
                           manager: b.costar.manager } : null,
    }));
    const stations = JSON.parse(await readFile(path.join(DEMO_DIR, "stations.json"), "utf8")).stations;
    cache = { mtime, body: JSON.stringify({ buildings, stations }) };
  }
  const etag = `"sim-${Math.round(cache.mtime)}"`;
  const headers = { "content-type": "application/json", "cache-control": "no-cache", etag };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(cache.body, { headers });
}
