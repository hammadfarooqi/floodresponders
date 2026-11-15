import { readFileSync } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

// Server only: the Supabase secret key must never reach the browser. Reads the two names from the environment
// (explore/.env.local) or, when they are not set there, from the .env file at the repo root.
function env(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    const line = readFileSync(path.resolve(process.cwd(), "../.env"), "utf8").split("\n").find(l => l.startsWith(`${name}=`));
    return line?.slice(name.length + 1).trim() || undefined;
  } catch { return undefined; }
}

// GET /api/fire-risk?lat=34.11&lng=-118.35&wind_from_deg=315  -> the 1,000 highest fire_risk_score rows.
// GET /api/fire-risk                                          -> no fire: the 1,000 highest risk_score rows.
// The rule and its weights are in the database function buildings_fire_risk (repo: data/db/fire_risk.py).
export async function GET(req: Request) {
  const url = env("SUPABASE_URL"), key = env("SUPABASE_SECRET_KEY");
  if (!url || !key)
    return Response.json({ detail: "SUPABASE_URL and SUPABASE_SECRET_KEY are not set. Put them in the .env file at the repo root." }, { status: 500 });
  const q = new URL(req.url).searchParams;
  let body: Record<string, number>;
  if (q.has("lat") || q.has("lng")) {
    const lat = Number(q.get("lat")), lng = Number(q.get("lng"));
    if (!q.get("lat") || !q.get("lng") || !Number.isFinite(lat) || !Number.isFinite(lng))
      return Response.json({ detail: "lat and lng must be numbers." }, { status: 400 });
    body = { p_origin_lat: lat, p_origin_lng: lng };
    if (q.get("wind_from_deg")) {
      const wind = Number(q.get("wind_from_deg"));
      if (!Number.isFinite(wind)) return Response.json({ detail: "wind_from_deg must be a number." }, { status: 400 });
      body.p_wind_from_deg = wind;
    }
  } else {
    body = { p_origin_lat: 0, p_origin_lng: 0, p_boost: 0 };     // boost 0: every fire_factor is 1
  }
  const res = await fetch(`${url}/rest/v1/rpc/buildings_fire_risk`, {
    method: "POST", cache: "no-store",
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return Response.json({ detail: `Supabase returned ${res.status}.` }, { status: 502 });
  return Response.json({ buildings: await res.json() }, { headers: { "cache-control": "no-store" } });
}
