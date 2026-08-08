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
  | "engineer" | "janitor" | "face" | "monkey"
  // structures
  | "datacenter" | "house" | "drive" | "gallery" | "cloud" | "keyboard" | "feed" | "hospital"
  // neutral deposits
  | "bitnode" | "pixnode"
  // hazards
  | "dung";

export type Res = "bits" | "pixels" | "slop";

export interface Cost { bits: number; pixels: number; slop: number }
export const cost = (bits: number, pixels = 0, slop = 0): Cost => ({ bits, pixels, slop });
export const RES_EMOJI: Record<Res, string> = { bits: "💾", pixels: "🎨", slop: "🤖" };

// Everything that fights is levelled at the Social Feed, and the two lines want
// opposite things from it.
//
// A Smiley trades its body for its temper: it starts as a cheerful sack of
// hitpoints that can barely hurt anyone, and each step down the mood makes it
// frailer and nastier, until 😡 is trivially killed and lethal to stand near.
// From 🙁 it stops closing to melee and starts throwing, so a levelled army
// naturally sorts itself — happy faces soak at the front, sour ones shoot over
// their shoulders.
//
// A Monkey levels the ordinary way instead: tougher and faster each time, so it
// stays the harassment unit and simply gets better at not dying.
export const PROGRESSION: Partial<Record<Kind, string[]>> = {
  face: ["🙂", "😐", "🙁", "😠", "😡"],
  monkey: ["🙈", "🙉", "🙊", "🐵"],
};

const FACE_HP = [220, 165, 115, 78, 48];
const FACE_DAMAGE = [4, 10, 17, 25, 34];
const FACE_RANGE = [14, 14, 104, 118, 132]; // world px; melee until 🙁
const FACE_COOLDOWN = [16, 15, 20, 19, 18];
const MONKEY_HP = [65, 92, 120, 152];
const MONKEY_SPEED = [1.6, 1.8, 2.05, 2.3];

export const BLAST_RADIUS = 96; // world pixels
export const BLAST_DAMAGE = 135;

export function maxLevel(kind: Kind): number {
  const p = PROGRESSION[kind];
  return p ? p.length - 1 : 0;
}
export function canLevel(kind: Kind): boolean { return maxLevel(kind) > 0; }
export function levelEmoji(kind: Kind, level: number): string {
  const p = PROGRESSION[kind];
  return p ? p[Math.min(level, p.length - 1)]! : STATS[kind].emoji;
}
const at = (table: number[], level: number) => table[Math.min(level, table.length - 1)]!;

export function unitHp(kind: Kind, level: number): number {
  if (kind === "face") return at(FACE_HP, level);
  if (kind === "monkey") return at(MONKEY_HP, level);
  return STATS[kind].hp;
}
export function unitDamage(kind: Kind, level: number): number {
  return kind === "face" ? at(FACE_DAMAGE, level) : STATS[kind].damage;
}
export function unitRange(kind: Kind, level: number): number {
  return kind === "face" ? Math.round(at(FACE_RANGE, level) * FP) : STATS[kind].range;
}
export function unitCooldown(kind: Kind, level: number): number {
  return kind === "face" ? at(FACE_COOLDOWN, level) : STATS[kind].cooldown;
}
export function unitSpeed(kind: Kind, level: number): number {
  return kind === "monkey" ? Math.round(at(MONKEY_SPEED, level) * FP) : STATS[kind].speed;
}
/** Only a thrown attack draws a projectile; a Smiley punches until 🙁. */
export function unitProjectile(kind: Kind, level: number): string {
  if (kind === "monkey") return "💩";
  if (kind === "face" && level >= 2) return "💢";
  return "";
}

/** A fouled tile is this percentage of normal speed to cross. */
export const HEAL_RADIUS = 112; // world pixels
export const HEAL_AMOUNT = 14; // health restored per pulse, per unit in the ring
export const HEAL_EVERY = 25; // ticks between pulses
export const HEAL_SLOP = 1; // slop burned per pulse, however many it patches up
export const RECYCLE_PCT = 60; // fraction of cost handed back when recycling
export const MUCK_SLOW = 42;
export const MUCK_COST = 22; // extra Dijkstra cost, so routes prefer to go around
export const DUNG_COOLDOWN = 160; // ticks a Monkey needs between droppings
export const CLEAN_TICKS = 44; // how long a Janitor scrubs

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
  projectile: string; // emoji lobbed at the target; "" for melee
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
  label: "", hotkey: "", emoji: "", blurb: "", projectile: "", depot: null, solid: false, lifesteal: 0, supply: 0,
} satisfies Stats;

export const STATS: Record<Kind, Stats> = {
  engineer: {
    ...base, hp: 45, radius: px(9), speed: px(1.5), damage: 4, range: px(12), cooldown: 12,
    cost: cost(50), buildTime: sec(10), sight: px(170),
    label: "Engineer", hotkey: "E", emoji: "🧑‍🔧", blurb: "mines, builds, hauls",
  },
  janitor: {
    ...base, hp: 70, radius: px(9), speed: px(1.55), damage: 0, range: 0, cooldown: 0,
    cost: cost(60, 10), buildTime: sec(9), sight: px(200),
    label: "Janitor", hotkey: "J", emoji: "👨🏻‍🔧", blurb: "scrubs 💩 off the map",
  },
  face: {
    ...base, hp: 220, radius: px(9), speed: px(1.28), damage: 4, range: px(14), cooldown: 16,
    cost: cost(60), buildTime: sec(10),
    label: "Smiley", hotkey: "F", emoji: "🙂",
    blurb: "cheerful meat shield — sours into a glass cannon at the Feed",
  },
  monkey: {
    ...base, hp: 65, radius: px(9), speed: px(1.6), damage: 8, range: px(96), cooldown: 15,
    cost: cost(70, 25), buildTime: sec(11), sight: px(225), projectile: "💩",
    label: "Monkey", hotkey: "M", emoji: "🙈",
    blurb: "throws 💩, fouls ground — the Feed makes it faster and tougher",
  },

  datacenter: {
    ...base, solid: true, hp: 1300, radius: px(32), building: true, cost: cost(300, 80), buildTime: sec(32),
    sight: px(300), supply: 15, label: "Datacenter", hotkey: "B", emoji: "🏢",
    blurb: "makes Engineers · +15 supply",
  },
  house: {
    ...base, solid: true, hp: 380, radius: px(17), building: true, cost: cost(70),
    buildTime: sec(10), sight: px(190), supply: 10, label: "House", hotkey: "H", emoji: "🏠",
    blurb: "+10 supply, makes nothing — and blocks the way",
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

  dung: {
    ...base, hp: 60, radius: px(14), building: true, sight: 0,
    label: "Fouling", emoji: "💩", blurb: "slows anything crossing it — needs a 🧹 Janitor",
  },
  hospital: {
    ...base, solid: true, hp: 560, radius: px(24), building: true, cost: cost(160, 40),
    buildTime: sec(18), sight: px(230), label: "Hospital", hotkey: "L", emoji: "🏥",
    blurb: "heals everyone standing round it — burns 🤖 to do it",
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

export const UNITS: Kind[] = ["engineer", "janitor", "face", "monkey"];
export const BUILDABLE: Kind[] = ["house", "drive", "gallery", "keyboard", "cloud", "feed", "hospital", "datacenter"];

export type OrderKind =
  | "idle" | "move" | "attackMove" | "attack"
  | "harvest" | "returnCargo" | "build"
  | "haul" // shuttling bits and pixels from depots into a Cloud
  | "enroll" // walking into a Social Feed to be made angrier
  | "dung" // a Monkey walking somewhere to foul it
  | "clean"; // a Janitor walking to a fouling to scrub it away

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
  dungCd: number; // Monkey's own cooldown; must not share `progress`
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
  | { c: "dung"; ids: number[]; x: number; y: number }
  | { c: "recycle"; ids: number[] }
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
