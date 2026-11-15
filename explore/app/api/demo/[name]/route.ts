import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";
// Generated demo files (data/demo/, gitignored: sponsor data). Only plain file names are allowed.
const DEMO_DIR = process.env.DEMO_DIR ?? path.resolve(process.cwd(), "../data/demo");
const BOUNDS_DIR = path.resolve(process.cwd(), "../data/boundaries");

// The files are big (buildings_map 23 MB) and change only when the pipeline runs: send an ETag from the file's
// size and time, so a reload gets "304 Not Modified" and the browser reuses its copy.
export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  if (!/^[a-z0-9_]+\.(json|geojson)$/.test(name)) return new Response("bad name", { status: 400 });
  for (const dir of [DEMO_DIR, BOUNDS_DIR]) {
    try {
      const file = path.join(dir, name);
      const st = await stat(file);
      const etag = `"${st.size}-${Math.round(st.mtimeMs)}"`;
      const headers = { "content-type": "application/json", "cache-control": "no-cache", etag };
      if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
      return new Response(await readFile(file, "utf8"), { headers });
    } catch {}
  }
  return new Response("not found", { status: 404 });
}
