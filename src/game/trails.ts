import { MAP_TILES, TILE, FP, MUCK_COST, type Res } from "./types";

// Stigmergy: carriers leave pheromone on the ground and read what others left.
//
// This does *not* replace the flow field. Dijkstra already returns the shortest
// route, so pheromone trail-laying could only make routing worse at that job.
// What it buys is the thing exact shortest-path cannot express:
//
//   · directionality — each crew lays a trail specific to what it is carrying
//     and which way it is going, and steers away from every *other* crew's
//     trail. A shared corridor resolves into parallel lanes: bits out, bits
//     home, pixels out, pixels home. Nobody decided that; it falls out of the
//     deposits and the evaporation.
//   · friction — when two carriers actually bump, that spot is marked. Volume of
//     traffic is not the problem; a busy lane flowing freely costs nothing. The
//     places where units genuinely collide are the jams, and those marks are
//     folded into the flow field's edge costs so later routes bend around them,
//     and they are what licenses a carrier to swerve at all.
//   · memory — trails strengthen with use and evaporate without it, so the map
//     reflects where traffic has actually been over the last few seconds.
//
// Integers only, fixed iteration order: this feeds movement, so it is part of
// the simulation and both peers must agree on it exactly.

const G = MAP_TILES;
const CELL = TILE * FP;

export const DEPOSIT = 40;
export const TRAIL_MAX = 6000;
export const TRAIL_STRONG = 900; // level at which the lane bias saturates
export const TRAIL_FLOOR = 120; // below this, the road is empty — do not swerve
export const DECAY_EVERY = 10; // ticks between evaporation passes
export const DECAY_SHIFT = 4; // v -= v>>4, a ~5.5s half-life
export const CONGEST_EVERY = 60; // how often friction is folded into routing
export const CONGEST_SHIFT = 7; // friction -> extra Dijkstra cost per tile
export const CONGEST_MAX = 24;
export const FRICTION_DROP = 55; // laid per colliding pair per tick
export const FRICTION_FLOOR = 90; // below this a tile is not actually jammed

// Four lanes: what you carry, and which way you are pointed.
export const LANE_COUNT = 4;
export const BITS_OUT = 0, BITS_HOME = 1, PIX_OUT = 2, PIX_HOME = 3;

export function laneIndex(res: Res | null, laden: boolean): number {
  return (res === "pixels" ? PIX_OUT : BITS_OUT) + (laden ? 1 : 0);
}

export class Trails {
  /** One pheromone grid per lane. */
  readonly lanes: Int32Array[] = Array.from({ length: LANE_COUNT }, () => new Int32Array(G * G));
  /** Laid where units actually collide. This — not raw traffic — is what
   *  marks a jam, and it drives both routing cost and the decision to swerve. */
  readonly friction = new Int32Array(G * G);
  /** Quantised congestion actually baked into the current flow fields. */
  readonly congestion = new Uint8Array(G * G);
  /** Tiles fouled by a Monkey. Unlike friction this does not evaporate — it
   *  sits there ruining the route until somebody scrubs it off. */
  readonly muck = new Uint8Array(G * G);

  static tileOf(x: number, y: number): number {
    const tx = Math.floor(x / CELL), ty = Math.floor(y / CELL);
    if (tx < 0 || ty < 0 || tx >= G || ty >= G) return -1;
    return ty * G + tx;
  }

  drop(x: number, y: number, lane: number) {
    const i = Trails.tileOf(x, y);
    if (i < 0) return;
    const g = this.lanes[lane]!;
    g[i] = Math.min(TRAIL_MAX, g[i]! + DEPOSIT);
  }

  /** Two units just shoved through each other here. */
  bump(x: number, y: number) {
    const i = Trails.tileOf(x, y);
    if (i >= 0) this.friction[i] = Math.min(TRAIL_MAX, this.friction[i]! + FRICTION_DROP);
  }

  jam(x: number, y: number): number {
    const i = Trails.tileOf(x, y);
    return i < 0 ? 0 : this.friction[i]!;
  }

  /** How thick every lane *other than mine* is on a tile. That is the thing
   *  worth avoiding: oncoming traffic and the other resource's crew alike. */
  foreign(mine: number, tx: number, ty: number): number {
    if (tx < 0 || ty < 0 || tx >= G || ty >= G) return 0;
    const i = ty * G + tx;
    let sum = 0;
    for (let l = 0; l < LANE_COUNT; l++) if (l !== mine) sum += this.lanes[l]![i]!;
    return sum;
  }

  read(lane: number, tx: number, ty: number): number {
    if (tx < 0 || ty < 0 || tx >= G || ty >= G) return 0;
    return this.lanes[lane]![ty * G + tx]!;
  }

  decay() {
    for (const g of this.lanes) {
      for (let i = 0; i < g.length; i++) {
        const v = g[i]!;
        if (v > 0) g[i] = v - (v >> DECAY_SHIFT) - 1;
      }
    }
    for (let i = 0; i < this.friction.length; i++) {
      const v = this.friction[i]!;
      if (v > 0) this.friction[i] = v - (v >> DECAY_SHIFT) - 1;
    }
  }

  /** Re-quantise friction into routing cost. Returns true when the picture
   *  changed enough to be worth rebuilding the cached flow fields. */
  refreshCongestion(): boolean {
    let changed = false;
    for (let i = 0; i < this.friction.length; i++) {
      const v = Math.min(255, (this.friction[i]! >> CONGEST_SHIFT > CONGEST_MAX
        ? CONGEST_MAX : this.friction[i]! >> CONGEST_SHIFT) + (this.muck[i] ? MUCK_COST : 0));
      if (v !== this.congestion[i]) { this.congestion[i] = v; changed = true; }
    }
    return changed;
  }
}
