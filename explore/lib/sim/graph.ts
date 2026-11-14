// Road graph for truck routing (data/demo/roads.json, OSM, undirected: trucks ignore one-way rules).
// Compressed adjacency in typed arrays + Dijkstra with a binary heap. Fire closes an edge at its fire_min.

export interface RoadsJson {
  nodes: [number, number][];
  edges: [number, number, number, number | null][];
  building_node: Record<string, number>;
}

export class RoadGraph {
  readonly n: number;
  readonly lng: Float64Array;
  readonly lat: Float64Array;
  private start: Int32Array;   // CSR row offsets
  private to: Int32Array;
  private len: Float32Array;   // meters
  private fire: Float32Array;  // minute the fire closes the edge (Infinity = never)
  readonly buildingNode: Record<string, number>;

  constructor(r: RoadsJson) {
    this.n = r.nodes.length;
    this.lng = new Float64Array(this.n);
    this.lat = new Float64Array(this.n);
    r.nodes.forEach(([x, y], i) => { this.lng[i] = x; this.lat[i] = y; });
    const deg = new Int32Array(this.n + 1);
    for (const [a, b] of r.edges) { deg[a + 1]++; deg[b + 1]++; }
    for (let i = 0; i < this.n; i++) deg[i + 1] += deg[i];
    this.start = deg;
    const m = deg[this.n];
    this.to = new Int32Array(m); this.len = new Float32Array(m); this.fire = new Float32Array(m);
    const fill = deg.slice(0, this.n);
    for (const [a, b, meters, fm] of r.edges) {
      const f = fm === null ? Infinity : fm;
      let k = fill[a]++; this.to[k] = b; this.len[k] = meters; this.fire[k] = f;
      k = fill[b]++; this.to[k] = a; this.len[k] = meters; this.fire[k] = f;
    }
    this.buildingNode = r.building_node;
  }

  /** Shortest road distance (m) from `src` to every node, avoiding edges the fire has closed by `nowMin`.
   *  Writes into `dist` / `prev` (reused buffers). Stops past `maxM` meters. */
  dijkstra(src: number | number[], nowMin: number, dist: Float64Array, prev: Int32Array, maxM = Infinity) {
    dist.fill(Infinity); prev.fill(-1);
    const heapN: number[] = [], heapD: number[] = [];
    const push = (node: number, d: number) => {
      let i = heapN.length; heapN.push(node); heapD.push(d);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heapD[p] <= d) break;
        heapN[i] = heapN[p]; heapD[i] = heapD[p]; i = p;
      }
      heapN[i] = node; heapD[i] = d;
    };
    const pop = (): [number, number] => {
      const topN = heapN[0], topD = heapD[0];
      const lastN = heapN.pop()!, lastD = heapD.pop()!;
      const size = heapN.length;
      if (size > 0) {
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= size) break;
          if (c + 1 < size && heapD[c + 1] < heapD[c]) c++;
          if (heapD[c] >= lastD) break;
          heapN[i] = heapN[c]; heapD[i] = heapD[c]; i = c;
        }
        heapN[i] = lastN; heapD[i] = lastD;
      }
      return [topN, topD];
    };
    for (const s0 of typeof src === "number" ? [src] : src) { dist[s0] = 0; push(s0, 0); }
    while (heapN.length) {
      const [u, d] = pop();
      if (d > dist[u]) continue;
      if (d > maxM) break;
      for (let k = this.start[u], e = this.start[u + 1]; k < e; k++) {
        if (this.fire[k] <= nowMin) continue;
        const v = this.to[k], nd = d + this.len[k];
        if (nd < dist[v]) { dist[v] = nd; prev[v] = u; push(v, nd); }
      }
    }
  }

  /** Nodes touched by any street the fire closes (in the 3-hour scenario). */
  fireNodes(): number[] {
    const out: number[] = [];
    for (let u = 0; u < this.n; u++)
      for (let k = this.start[u], e = this.start[u + 1]; k < e; k++) if (Number.isFinite(this.fire[k])) { out.push(u); break; }
    return out;
  }

  /** Node list from the Dijkstra source to `target` (inclusive), or null if unreachable. */
  path(prev: Int32Array, dist: Float64Array, target: number): number[] | null {
    if (!Number.isFinite(dist[target])) return null;
    const out: number[] = [];
    for (let v = target; v !== -1; v = prev[v]) out.push(v);
    return out.reverse();
  }
}

export function meters(aLng: number, aLat: number, bLng: number, bLat: number): number {
  const kx = 111320 * Math.cos((aLat * Math.PI) / 180), ky = 110540;
  return Math.hypot((bLng - aLng) * kx, (bLat - aLat) * ky);
}
