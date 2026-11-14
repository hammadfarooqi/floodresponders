import { readFile } from "node:fs/promises";
import path from "node:path";
import { LAYERS_DIR } from "../../layersDir";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const text = await readFile(path.join(LAYERS_DIR, "manifest.json"), "utf8");
    return new Response(text, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return Response.json({ layers: [], panels: [], error: `no manifest in ${LAYERS_DIR}; run export_layers.py` });
  }
}
