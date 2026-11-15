// Loads the two files that data/pipeline/interior_layouts.py writes to data/demo/ (gitignored, sponsor data).
// A machine that has not run that script has no files: the index is then empty and no building offers a layout.
import type { Layout } from "../../lib/interior/route";

export interface ScanSummary { id: string; name: string; floors: number; rooms: number; bedrooms: number; positions: number }
export interface PropertyInteriors { name: string | null; address: string | null; scans: ScanSummary[] }
/** Key: CoStar property id (DemoBuilding.costar.id). */
export type InteriorIndex = Record<string, PropertyInteriors>;

export async function loadInteriorIndex(): Promise<InteriorIndex> {
  const r = await fetch("/api/demo/interiors_index.json");
  if (r.status === 404) return {};
  if (!r.ok) throw new Error(`interiors_index.json: ${r.status}`);
  return (await r.json()).properties;
}

let layouts: Promise<Record<string, Layout>> | null = null;
/** All layouts, by scan id (about 2 MB). Fetched once, when the first layout is opened. */
export function loadLayouts(): Promise<Record<string, Layout>> {
  layouts ??= fetch("/api/demo/interiors.json").then(r => {
    if (!r.ok) throw new Error(`interiors.json: ${r.status}`);
    return r.json();
  }).then(j => j.scans as Record<string, Layout>);
  layouts.catch(() => { layouts = null; });   // a failed load can be tried again
  return layouts;
}
