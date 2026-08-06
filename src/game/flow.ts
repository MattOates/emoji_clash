import { FP, MAP_TILES, STATS, TILE, type Entity } from "./types";

// Flow-field navigation.
//
// Steering straight at a goal is fine in the open and useless anywhere else, so
// obstacles are rasterised onto a tile grid and a Dijkstra field is flooded out
// from each goal. A unit reads the field to find the next tile to head for.
// Fields are keyed by goal tile, which is what makes this cheap for an RTS:
// twelve units sent to the same place share one field.
//
// Everything here is integer and iterated in a fixed order — a flow field that
// differed between peers by one tile would desync the match.

export const G = MAP_TILES;
export const CELL = TILE * FP;
const HALF = CELL / 2;
const INF = 0x7fffffff;
const CLEARANCE = 10 * FP; // widest unit radius, so paths leave room to pass
const MAX_FIELDS = 64;

// Orthogonals first: ties resolve toward straight movement rather than diagonal.
const NEIGH: [number, number, number][] = [
  [1, 0, 10], [-1, 0, 10], [0, 1, 10], [0, -1, 10],
  [1, 1, 14], [1, -1, 14], [-1, 1, 14], [-1, -1, 14],
];

export class PathCache {
  readonly grid = new Uint8Array(G * G);
  private fields = new Map<number, Int32Array>();
  private dirty = true;

  /** Buildings appeared or died; the grid and every field are stale. */
  invalidate() { this.dirty = true; }

  refresh(entities: Entity[]) {
    if (!this.dirty) return;
    this.dirty = false;
    this.grid.fill(0);
    for (const e of entities) {
      if (!STATS[e.kind].solid || e.hp <= 0) continue;
      const r = STATS[e.kind].radius + CLEARANCE;
      const lo = (v: number) => Math.max(0, Math.floor((v - r) / CELL));
      const hi = (v: number) => Math.min(G - 1, Math.floor((v + r) / CELL));
      for (let ty = lo(e.y); ty <= hi(e.y); ty++) {
        for (let tx = lo(e.x); tx <= hi(e.x); tx++) {
          const dx = tx * CELL + HALF - e.x, dy = ty * CELL + HALF - e.y;
          if (dx * dx + dy * dy < r * r) this.grid[ty * G + tx] = 1;
        }
      }
    }
    this.fields.clear();
  }

  private field(goalIdx: number): Int32Array {
    const hit = this.fields.get(goalIdx);
    if (hit) return hit;
    const f = flood(this.grid, goalIdx);
    if (this.fields.size >= MAX_FIELDS) {
      // Insertion-ordered eviction. Fields are a pure function of grid + goal,
      // so what gets evicted can never change the outcome of the game.
      const oldest = this.fields.keys().next();
      if (!oldest.done) this.fields.delete(oldest.value);
    }
    this.fields.set(goalIdx, f);
    return f;
  }

  /** Centre of the next tile to walk to, or null when the field cannot help
   *  (already in the goal tile, or walled off from it). */
  waypoint(goalX: number, goalY: number, x: number, y: number): { x: number; y: number } | null {
    const gx = clampTile(goalX), gy = clampTile(goalY);
    const goalIdx = gy * G + gx;
    const f = this.field(goalIdx);
    const tx = clampTile(x), ty = clampTile(y);
    const here = f[ty * G + tx]!;
    let best = -1, bestCost = INF;
    for (const [dx, dy, cost] of NEIGH) {
      const nx = tx + dx, ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= G || ny >= G) continue;
      const ni = ny * G + nx;
      // The goal tile is walkable-into even when blocked: depots, resource
      // nodes and structures under attack all sit on obstructed tiles, and
      // refusing that last step left units orbiting their own drop-off.
      if (ni !== goalIdx) {
        if (this.grid[ni]) continue;
        if (dx && dy && (this.grid[ty * G + nx] || this.grid[ny * G + tx])) continue; // no corner cutting
      }
      const d = f[ni]!;
      if (d === INF) continue;
      if (d + cost < bestCost) { bestCost = d + cost; best = ni; }
    }
    // For a reachable tile `here` already equals the best neighbour's d + cost;
    // anything worse means we are in the goal tile and should steer directly.
    if (best < 0 || bestCost > here) return null;
    return { x: (best % G) * CELL + HALF, y: ((best / G) | 0) * CELL + HALF };
  }
}

function clampTile(v: number): number {
  const t = Math.floor(v / CELL);
  return t < 0 ? 0 : t > G - 1 ? G - 1 : t;
}

/** Dijkstra out from the goal over passable tiles. The goal tile itself is
 *  always expanded even when blocked — you must be able to path to a crystal
 *  patch or to the building you are about to attack. */
function flood(grid: Uint8Array, goal: number): Int32Array {
  const dist = new Int32Array(G * G).fill(INF);
  dist[goal] = 0;
  const heapIdx: number[] = [goal];
  const heapKey: number[] = [0];

  const swap = (a: number, b: number) => {
    const i = heapIdx[a]!, k = heapKey[a]!;
    heapIdx[a] = heapIdx[b]!; heapKey[a] = heapKey[b]!;
    heapIdx[b] = i; heapKey[b] = k;
  };
  // Ties break on tile index so the traversal order is fully determined.
  const less = (a: number, b: number) =>
    heapKey[a]! < heapKey[b]! || (heapKey[a] === heapKey[b] && heapIdx[a]! < heapIdx[b]!);

  const push = (idx: number, key: number) => {
    heapIdx.push(idx); heapKey.push(key);
    let i = heapIdx.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(i, p)) break;
      swap(i, p); i = p;
    }
  };
  const pop = (): number => {
    const top = heapIdx[0]!;
    const lastI = heapIdx.pop()!, lastK = heapKey.pop()!;
    if (heapIdx.length) {
      heapIdx[0] = lastI; heapKey[0] = lastK;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heapIdx.length && less(l, m)) m = l;
        if (r < heapIdx.length && less(r, m)) m = r;
        if (m === i) break;
        swap(i, m); i = m;
      }
    }
    return top;
  };

  while (heapIdx.length) {
    const cur = pop();
    const cd = dist[cur]!;
    const cx = cur % G, cy = (cur / G) | 0;
    for (const [dx, dy, cost] of NEIGH) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= G || ny >= G) continue;
      const ni = ny * G + nx;
      if (grid[ni]) continue;
      if (dx && dy && (grid[cy * G + nx] || grid[ny * G + cx])) continue;
      const nd = cd + cost;
      if (nd >= dist[ni]!) continue;
      dist[ni] = nd;
      push(ni, nd);
    }
  }
  return dist;
}
