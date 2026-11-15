// Search route inside one scanned apartment: from the entrance to each bedroom, nearest first.
// Pure functions over the layout that data/pipeline/interior_layouts.py writes (meters, x right, y up).
// "Positions" are the spots where the scan camera stood. Matterport links each one to the spots a person can walk
// to from it, so the links are a walkable graph.

export interface Room { labels: string[]; polygon: [number, number][]; center: [number, number] | null }
export interface Opening { type: "doorway" | "window"; label: string | null; a: [number, number]; b: [number, number]; exterior: boolean }
export interface Floor { label: string; rooms: Room[]; walls: [number, number, number, number][]; openings: Opening[] }
export interface Position { x: number; y: number; floor: number; room: number | null; next: number[] }
export interface Layout { id: string; name: string; url: string; floors: Floor[]; positions: Position[] }

/** Rooms where a person is most likely to be when a fire starts. The route visits these. */
export const TARGET_LABEL = "Bedroom";
const FLOOR_CHANGE_M = 4;            // walking cost of one flight of stairs (assumption)
const DOOR_REACH_M = 2.5;            // a position this near an outside door counts as "at the door"
const SHARED_ROOMS = new Set(["Hallway", "Living Room", "Kitchen", "Dining Room", "Entrance"]);

export interface Stop { floor: number; room: number; label: string; position: number; path: number[]; meters: number }
export interface SearchRoute { entry: number; stops: Stop[]; unreachable: { floor: number; room: number }[]; meters: number }
export interface Entry { position: number; why: "entrance room" | "outside door" | "first position" }

const step = (a: Position, b: Position) => Math.hypot(a.x - b.x, a.y - b.y) + Math.abs(a.floor - b.floor) * FLOOR_CHANGE_M;
const roomOf = (l: Layout, p: Position) => (p.room === null ? null : l.floors[p.floor].rooms[p.room]);

/** Walking distance in meters from one position to every other one (Infinity = no way), and the way back. */
function distances(l: Layout, from: number): { dist: number[]; prev: number[] } {
  const n = l.positions.length;
  const dist = new Array<number>(n).fill(Infinity), prev = new Array<number>(n).fill(-1), done = new Array<boolean>(n).fill(false);
  dist[from] = 0;
  for (;;) {   // a scan has about 20 positions, so a plain scan for the nearest open one is enough
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0) break;
    done[u] = true;
    for (const v of l.positions[u].next) {
      const d = dist[u] + step(l.positions[u], l.positions[v]);
      if (d < dist[v]) { dist[v] = d; prev[v] = u; }
    }
  }
  return { dist, prev };
}

function pathTo(prev: number[], to: number): number[] {
  const path = [to];
  while (prev[path[0]] >= 0) path.unshift(prev[path[0]]);
  return path;
}

const round = (m: number) => Math.round(m * 100) / 100;

export function shortestPath(l: Layout, from: number, to: number): { path: number[]; meters: number } | null {
  const { dist, prev } = distances(l, from);
  return dist[to] < Infinity ? { path: pathTo(prev, to), meters: round(dist[to]) } : null;
}

/**
 * Best guess of the position at the apartment's front door. Matterport does not mark the front door, so:
 * 1. a position in a room labelled "Entrance";
 * 2. else the position nearest to a door in an outside wall. With several such doors, prefer a shared room
 *    (hallway, living room, kitchen), a hinged door, and a normal door width (a balcony door is wide);
 * 3. else the first position of the scan.
 * The panel lets the user pick another start, so a wrong guess costs one click.
 */
export function pickEntry(l: Layout): Entry {
  const inEntrance = l.positions.findIndex(p => roomOf(l, p)?.labels.includes("Entrance"));
  if (inEntrance >= 0) return { position: inEntrance, why: "entrance room" };

  let best = -1, bestScore = -1;
  l.floors.forEach((f, fi) => {
    for (const o of f.openings) {
      if (o.type !== "doorway" || !o.exterior) continue;
      const mx = (o.a[0] + o.b[0]) / 2, my = (o.a[1] + o.b[1]) / 2;
      let near = -1, nearD = DOOR_REACH_M;
      l.positions.forEach((p, i) => {
        const d = Math.hypot(p.x - mx, p.y - my);
        if (p.floor === fi && d <= nearD) { near = i; nearD = d; }
      });
      if (near < 0) continue;
      const labels = roomOf(l, l.positions[near])?.labels ?? [];
      const width = Math.hypot(o.a[0] - o.b[0], o.a[1] - o.b[1]);
      const score = (labels.some(x => SHARED_ROOMS.has(x)) ? 4 : labels.length === 0 ? 2 : 0)
        + (o.label === "door-pivot" ? 1 : 0) + (width >= 0.7 && width <= 1.2 ? 1 : 0);
      if (score > bestScore) { best = near; bestScore = score; }
    }
  });
  if (best >= 0) return { position: best, why: "outside door" };
  return { position: 0, why: "first position" };
}

/** From the entry to each bedroom, always the nearest one that is left. Each leg starts where the last one ended. */
export function searchRoute(l: Layout, entry: number): SearchRoute {
  const left: { floor: number; room: number }[] = [];
  l.floors.forEach((f, floor) => f.rooms.forEach((r, room) => { if (r.labels.includes(TARGET_LABEL)) left.push({ floor, room }); }));
  const stops: Stop[] = [];
  let at = entry, total = 0;
  while (left.length) {
    const { dist, prev } = distances(l, at);
    let pick = -1, pos = -1;
    left.forEach((t, k) => l.positions.forEach((p, i) => {
      if (p.floor === t.floor && p.room === t.room && dist[i] < (pos < 0 ? Infinity : dist[pos])) { pick = k; pos = i; }
    }));
    if (pick < 0) break;   // no bedroom that is left can be reached
    const [t] = left.splice(pick, 1);
    stops.push({ ...t, label: TARGET_LABEL, position: pos, path: pathTo(prev, pos), meters: round(dist[pos]) });
    total += dist[pos];
    at = pos;
  }
  return { entry, stops, unreachable: left, meters: round(total) };
}
