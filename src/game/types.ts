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
export const TPS = 1000 / TICK_MS;

export type Kind =
  // units
  | "engineer" | "face" | "ninja" | "guard" | "wizard" | "vampire"
  // structures
  | "datacenter" | "drive" | "gallery" | "cloud" | "keyboard" | "feed"
  // neutral deposits
  | "bitnode" | "pixnode";

export type Res = "bits" | "pixels" | "slop";

export interface Cost { bits: number; pixels: number; slop: number }
export const cost = (bits: number, pixels = 0, slop = 0): Cost => ({ bits, pixels, slop });
export const RES_EMOJI: Record<Res, string> = { bits: "💾", pixels: "🎨", slop: "🤖" };

/** Faces sour as they level up at the Social Feed. The last one detonates. */
export const FACE_FACES = ["🙂", "😐", "🙁", "😠", "😡"];
export const MAX_LEVEL = 4;
export const BLAST_RADIUS = 78; // world pixels
export const BLAST_DAMAGE = 70;

export interface Stats {
  hp: number;
  radius: number; // fixed-point — this is both the drawn ring and the collision circle
  speed: number; // fixed-point per tick
  damage: number;
  range: number; // fixed-point
  cooldown: number; // ticks between attacks
  cost: Cost;
  buildTime: number; // ticks
  building: boolean;
  sight: number; // fixed-point
  label: string;
  hotkey: string;
  emoji: string;
  blurb: string;
  depot: Res | null; // harvesters may unload this resource here
  solid: boolean; // blocks movement and gets routed around
  lifesteal: number; // percent of damage dealt returned as health
  supply: number; // supply this structure adds
}

const px = (n: number) => Math.round(n * FP);
const sec = (n: number) => Math.round(n * TPS);

const base = {
  hp: 100, radius: px(9), speed: px(1.3), damage: 0, range: 0, cooldown: 0,
  cost: cost(0), buildTime: sec(10), building: false, sight: px(190),
  label: "", hotkey: "", emoji: "", blurb: "", depot: null, solid: false, lifesteal: 0, supply: 0,
} satisfies Stats;

export const STATS: Record<Kind, Stats> = {
  engineer: {
    ...base, hp: 45, radius: px(9), speed: px(1.5), damage: 4, range: px(12), cooldown: 12,
    cost: cost(50), buildTime: sec(10), sight: px(170),
    label: "Engineer", hotkey: "E", emoji: "🧑‍🔧", blurb: "mines, builds, hauls",
  },
  face: {
    ...base, hp: 100, radius: px(9), speed: px(1.3), damage: 8, range: px(14), cooldown: 14,
    cost: cost(60), buildTime: sec(10),
    label: "Smiley", hotkey: "F", emoji: "🙂", blurb: "melee · levels up at the Feed",
  },
  ninja: {
    ...base, hp: 70, radius: px(9), speed: px(2), damage: 11, range: px(14), cooldown: 8,
    cost: cost(70, 30), buildTime: sec(12), sight: px(215),
    label: "Ninja", hotkey: "N", emoji: "🥷", blurb: "fast, deadly, made of paper",
  },
  guard: {
    ...base, hp: 190, radius: px(10), speed: px(1), damage: 10, range: px(16), cooldown: 16,
    cost: cost(90, 20), buildTime: sec(14),
    label: "Guard", hotkey: "G", emoji: "💂", blurb: "slow wall of hitpoints",
  },
  wizard: {
    ...base, hp: 60, radius: px(9), speed: px(1.1), damage: 17, range: px(150), cooldown: 26,
    cost: cost(90, 60, 2), buildTime: sec(15), sight: px(260),
    label: "Wizard", hotkey: "W", emoji: "🧙", blurb: "outranges everything",
  },
  vampire: {
    ...base, hp: 115, radius: px(9), speed: px(1.45), damage: 12, range: px(15), cooldown: 13,
    cost: cost(80, 50, 3), buildTime: sec(15), lifesteal: 50,
    label: "Vampire", hotkey: "V", emoji: "🧛", blurb: "heals for half the damage it deals",
  },

  datacenter: {
    ...base, solid: true, hp: 1300, radius: px(32), building: true, cost: cost(300, 80), buildTime: sec(32),
    sight: px(300), supply: 15, label: "Datacenter", hotkey: "B", emoji: "🏢",
    blurb: "makes Engineers · +15 supply",
  },
  drive: {
    ...base, solid: true, hp: 520, radius: px(22), building: true, cost: cost(90), buildTime: sec(14),
    sight: px(220), depot: "bits", label: "Drive", hotkey: "D", emoji: "🗄️",
    blurb: "where 💾 bits are dropped off",
  },
  gallery: {
    ...base, solid: true, hp: 520, radius: px(22), building: true, cost: cost(110, 20), buildTime: sec(16),
    sight: px(220), depot: "pixels", label: "Gallery", hotkey: "Y", emoji: "🖼️",
    blurb: "where 🎨 pixels are dropped off",
  },
  cloud: {
    ...base, solid: true, hp: 760, radius: px(27), building: true, cost: cost(180, 70), buildTime: sec(24),
    sight: px(240), label: "Cloud", hotkey: "C", emoji: "☁️",
    blurb: "fuses 2 💾 + 1 🎨 into 🤖 slop — couriers carry it out",
  },
  keyboard: {
    ...base, solid: true, hp: 700, radius: px(25), building: true, cost: cost(140), buildTime: sec(20),
    sight: px(230), supply: 10, label: "Keyboard", hotkey: "K", emoji: "⌨️",
    blurb: "types fighters into existence · +10 supply",
  },
  feed: {
    ...base, solid: true, hp: 620, radius: px(23), building: true, cost: cost(150, 40), buildTime: sec(18),
    sight: px(230), label: "Social Feed", hotkey: "X", emoji: "📱",
    blurb: "sours 🙂 one step — costs one delivered 🤖 each",
  },

  bitnode: {
    ...base, hp: 1, radius: px(15), building: true, sight: 0,
    label: "Bit Cache", emoji: "💾", blurb: "plentiful, quick to mine",
  },
  pixnode: {
    ...base, hp: 1, radius: px(17), building: true, sight: 0,
    label: "Pixel Seam", emoji: "🎨", blurb: "scarce, slow to mine",
  },
};

export const UNITS: Kind[] = ["engineer", "face", "ninja", "guard", "wizard", "vampire"];
export const BUILDABLE: Kind[] = ["drive", "gallery", "keyboard", "cloud", "feed", "datacenter"];

export type OrderKind =
  | "idle" | "move" | "attackMove" | "attack"
  | "harvest" | "returnCargo" | "build"
  | "haul" // shuttling bits and pixels from depots into a Cloud
  | "enroll"; // walking into a Social Feed to be made angrier

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
  cargo: number; // amount being carried
  cargoRes: Res | null; // what is being carried
  amount: number; // remaining deposit, for nodes
  progress: number; // construction / gathering / enrolment ticks
  complete: boolean;
  queue: Kind[]; // production queue (structures)
  queueLeft: number; // ticks left on head of queue
  rallyX: number;
  rallyY: number;
  level: number; // how sour a face has become
  stockBits: number; // Cloud intake
  stockPixels: number;
  stockSlop: number; // slop sitting in a Cloud's output, or held at a Feed
  stuck: number; // ticks spent making no headway toward the current goal
  lastD: number; // best distance to that goal so far
  // Render-only interpolation, never read by the simulation.
  px: number;
  py: number;
  flash: number;
}

export type Command =
  | { c: "move"; ids: number[]; x: number; y: number }
  | { c: "attackMove"; ids: number[]; x: number; y: number }
  | { c: "target"; ids: number[]; id: number }
  | { c: "build"; ids: number[]; kind: Kind; x: number; y: number }
  | { c: "train"; ids: number[]; kind: Kind }
  | { c: "rally"; ids: number[]; x: number; y: number }
  | { c: "cancel"; ids: number[] }
  | { c: "detonate"; ids: number[] }
  | { c: "stop"; ids: number[] };

export interface Player {
  bits: number;
  pixels: number;
  slop: number;
  supply: number;
  supplyCap: number;
  defeated: boolean;
}

export function affordable(p: Player, c: Cost): boolean {
  return p.bits >= c.bits && p.pixels >= c.pixels && p.slop >= c.slop;
}
export function pay(p: Player, c: Cost, sign = -1) {
  p.bits += sign * c.bits;
  p.pixels += sign * c.pixels;
  p.slop += sign * c.slop;
}
export function costText(c: Cost): string {
  const bits = [];
  if (c.bits) bits.push(`${c.bits}💾`);
  if (c.pixels) bits.push(`${c.pixels}🎨`);
  if (c.slop) bits.push(`${c.slop}🤖`);
  return bits.join(" ") || "free";
}

/** A face's stats climb with its anger. */
export function faceHp(level: number): number {
  return STATS.face.hp + Math.trunc((STATS.face.hp * 40 * level) / 100);
}
export function faceDamage(level: number): number {
  return STATS.face.damage + Math.trunc((STATS.face.damage * 45 * level) / 100);
}
