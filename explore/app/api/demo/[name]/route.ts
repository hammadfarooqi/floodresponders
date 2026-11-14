import { readFile } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";
// Generated demo files (data/demo/, gitignored: sponsor data). Only plain file names are allowed.
const DEMO_DIR = process.env.DEMO_DIR ?? path.resolve(process.cwd(), "../data/demo");
const BOUNDS_DIR = path.resolve(process.cwd(), "../data/boundaries");

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  if (!/^[a-z0-9_]+\.(json|geojson)$/.test(name)) return new Response("bad name", { status: 400 });
  for (const dir of [DEMO_DIR, BOUNDS_DIR]) {
    try {
      const text = await readFile(path.join(dir, name), "utf8");
      return new Response(text, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch {}
  }
  return new Response("not found", { status: 404 });
}
