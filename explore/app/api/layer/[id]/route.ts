import { readFile } from "node:fs/promises";
import path from "node:path";
import { LAYERS_DIR } from "../../../layersDir";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[a-z0-9_]+$/.test(id)) return new Response("bad id", { status: 400 });
  try {
    const text = await readFile(path.join(LAYERS_DIR, `${id}.geojson`), "utf8");
    return new Response(text, { headers: { "content-type": "application/geo+json", "cache-control": "no-store" } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
