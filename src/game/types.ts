// Shared vocabulary for the deterministic simulation.
//
// Hard rule for everything under src/game: integers only. No Math.random,
// no Date.now, no floating point. Both peers run this code over the same
// command stream and must land on bit-identical state.

export const FP = 256; // fixed-point scale: 1 world pixel = 256 units
export const TILE = 32; // world pixels per map tile
export const MAP_TILES = 64;
export const MAP_SIZE = MAP_TILES * TILE * FP; // world extent, fixed-point

export const TICK_MS = 50; // simulation step
export const TICKS_PER_SEC = 1000 / TICK_MS;

export type Kind =
  | "worker"
  | "soldier"
  | "archer"
  | "base"
  | "barracks"
  | "crystal";

export interface Stats {
  hp: number;
  radius: number; // fixed-point
  speed: number; // fixed-point per tick
  damage: number;
  range: number; // fixed-point
  cooldown: number; // ticks between attacks
  cost: number;
  buildTime: number; // ticks
  building: boolean;
  sight: number; // fixed-point
  label: string;
  hotkey: string;
}

const px = (n: number) => Math.round(n * FP);

export const STATS: Record<Kind, Stats> = {
  worker: {
    hp: 40, radius: px(7), speed: px(1.5), damage: 4, range: px(12),
    cooldown: 12, cost: 50, buildTime: 10 * 20, building: false,
    sight: px(160), label: "Worker", hotkey: "W",
  },
  soldier: {
    hp: 100, radius: px(9), speed: px(1.35), damage: 9, range: px(16),
    cooldown: 14, cost: 75, buildTime: 12 * 20, building: false,
    sight: px(180), label: "Soldier", hotkey: "S",
  },
  archer: {
    hp: 60, radius: px(8), speed: px(1.2), damage: 7, range: px(120),
    cooldown: 22, cost: 90, buildTime: 14 * 20, building: false,
    sight: px(240), label: "Archer", hotkey: "A",
  },
  base: {
    hp: 1200, radius: px(34), speed: 0, damage: 0, range: 0,
    cooldown: 0, cost: 400, buildTime: 35 * 20, building: true,
    sight: px(300), label: "Command Base", hotkey: "B",
  },
  barracks: {
    hp: 700, radius: px(26), speed: 0, damage: 0, range: 0,
    cooldown: 0, cost: 200, buildTime: 22 * 20, building: true,
    sight: px(240), label: "Barracks", hotkey: "R",
  },
  crystal: {
    hp: 1, radius: px(18), speed: 0, damage: 0, range: 0,
    cooldown: 0, cost: 0, buildTime: 0, building: true,
    sight: 0, label: "Crystal", hotkey: "",
  },
};

export type OrderKind =
  | "idle"
  | "move"
  | "attackMove"
  | "attack"
  | "harvest"
  | "returnCargo"
  | "build";

export interface Order {
  kind: OrderKind;
  x: number;
  y: number;
  target: number; // entity id, or 0
  build: Kind | null;
}

export const IDLE: Order = { kind: "idle", x: 0, y: 0, target: 0, build: null };

export interface Entity {
  id: number;
  kind: Kind;
  owner: number; // 0 or 1, or -1 for neutral
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  order: Order;
  cooldown: number;
  cargo: number; // worker crystal carried
  amount: number; // crystal remaining, for patches
  progress: number; // construction progress in ticks
  complete: boolean;
  queue: Kind[]; // production queue (buildings)
  queueLeft: number; // ticks left on head of queue
  rallyX: number;
  rallyY: number;
  // Render-only interpolation, never read by the simulation.
  px: number;
  py: number;
  flash: number;
}

export type Command =
  | { c: "move"; ids: number[]; x: number; y: number; queue?: boolean }
  | { c: "attackMove"; ids: number[]; x: number; y: number }
  | { c: "target"; ids: number[]; id: number }
  | { c: "build"; ids: number[]; kind: Kind; x: number; y: number }
  | { c: "train"; ids: number[]; kind: Kind }
  | { c: "rally"; ids: number[]; x: number; y: number }
  | { c: "cancel"; ids: number[] }
  | { c: "stop"; ids: number[] };

export interface Player {
  crystals: number;
  supply: number;
  supplyCap: number;
  defeated: boolean;
}
