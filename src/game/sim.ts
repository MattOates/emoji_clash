import {
  FP, TILE, MAP_TILES, MAP_SIZE, STATS, IDLE, MAX_LEVEL, BLAST_RADIUS, BLAST_DAMAGE,
  affordable, pay, faceHp, faceDamage,
  type Command, type Entity, type Kind, type Player, type Res,
} from "./types";
import { PathCache } from "./flow";
import { Trails, laneIndex, DECAY_EVERY, CONGEST_EVERY, TRAIL_STRONG, FRICTION_FLOOR } from "./trails";

// ---------------------------------------------------------------- integer math

/** Deterministic integer square root. The float seed is corrected by exact
 *  integer comparisons, so a platform disagreeing on the last bit of
 *  Math.sqrt still produces the same answer. */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let x = Math.floor(Math.sqrt(n));
  while (x > 0 && x * x > n) x--;
  while ((x + 1) * (x + 1) <= n) x++;
  return x;
}

function rng(state: number): number {
  // mulberry32, kept entirely in uint32 space
  let t = (state + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (t ^ (t >>> 14)) >>> 0;
}

// ---------------------------------------------------------------------- world

export const BIT_TICKS = 30; // bits come out quickly
export const PIX_TICKS = 55; // pixels are a slog — nearly twice a bit
export const CARGO_SIZE = 10;
export const BUILD_RANGE = 22 * FP;
export const ENROLL_TICKS = 70;
export const CONVERT_TICKS = 26;
export const SUPPLY_MAX = 120;
export const LANE_BIAS = 12; // percent of a step that may be spent moving sideways
export const ENROLL_COST = { bits: 30, pixels: 0, slop: 2 };

export interface World {
  tick: number;
  seed: number;
  nextId: number;
  entities: Entity[]; // always sorted by id
  byId: Map<number, Entity>;
  players: [Player, Player];
  events: { x: number; y: number; kind: string; text?: string }[]; // render-only
  winner: number; // -1 while undecided
  paths: PathCache; // derived from the entities; never part of the checksum
  trails: Trails; // pheromone laid by carriers; feeds movement, so it is sim state
  laneBias: number; // percent of a step spendable on lane separation; 0 disables
  spread: boolean; // crowding-aware deposit choice (off only for A/B measurement)
  avoidJams: boolean; // fold collision friction into routing cost (A/B)
}

function makeEntity(w: World, kind: Kind, owner: number, x: number, y: number, complete = true): Entity {
  const s = STATS[kind];
  const e: Entity = {
    id: w.nextId++, kind, owner, x, y,
    hp: complete ? s.hp : Math.max(1, (s.hp / 10) | 0),
    maxHp: s.hp,
    order: { ...IDLE }, cooldown: 0, cargo: 0, cargoRes: null, amount: 0, progress: 0,
    complete, queue: [], queueLeft: 0,
    rallyX: x, rallyY: y + 62 * FP,
    level: 0, stockBits: 0, stockPixels: 0,
    stuck: 0, lastD: 0,
    px: x, py: y, flash: 0,
  };
  w.entities.push(e);
  w.byId.set(e.id, e);
  if (s.building) w.paths.invalidate();
  return e;
}

export function createWorld(seed: number): World {
  const w: World = {
    tick: 0, seed: seed >>> 0, nextId: 1, entities: [], byId: new Map(),
    players: [
      { bits: 250, pixels: 60, slop: 0, supply: 0, supplyCap: 0, defeated: false },
      { bits: 250, pixels: 60, slop: 0, supply: 0, supplyCap: 0, defeated: false },
    ],
    events: [], winner: -1, paths: new PathCache(),
    trails: new Trails(), laneBias: LANE_BIAS, spread: true, avoidJams: true,
  };

  const t = (n: number) => Math.round(n * TILE * FP); // tiles -> fixed-point, integral
  const starts: [number, number][] = [[t(10), t(10)], [t(MAP_TILES - 10), t(MAP_TILES - 10)]];

  const node = (kind: Kind, x: number, y: number, amount: number) => {
    const n = makeEntity(w, kind, -1, clamp(x, t(1), t(MAP_TILES - 1)), clamp(y, t(1), t(MAP_TILES - 1)));
    n.amount = amount;
    return n;
  };

  for (let p = 0; p < 2; p++) {
    const [bx, by] = starts[p]!;
    const away = p === 0 ? 1 : -1;
    makeEntity(w, "datacenter", p, bx, by);
    // You open with somewhere to put each resource; losing one really hurts.
    makeEntity(w, "drive", p, bx + away * t(2.9), by - away * t(1.2));
    makeEntity(w, "gallery", p, bx - away * t(1.2), by + away * t(2.9));
    for (let i = 0; i < 4; i++) {
      makeEntity(w, "engineer", p, bx + away * t(1.7), by + away * t(1.7) + i * 24 * FP - 36 * FP);
    }
    // Bits are everywhere; pixels are not — five caches to every seam. Every
    // offset is mirrored through `away` so the two starts are identical under
    // a 180° rotation of the map.
    for (const [ox, oy] of [[-3.6, -0.4], [-0.4, -3.6], [-4.1, -3.4]] as [number, number][]) {
      for (let i = 0; i < 2; i++) {
        node("bitnode", bx + away * (t(ox) + i * 46 * FP), by + away * t(oy), 1400);
      }
    }
    for (const [ox, oy] of [[-4.9, -4.9], [1.9, -4.4]] as [number, number][]) {
      node("pixnode", bx + away * t(ox), by + away * t(oy), 1500);
    }
  }

  // Contested ground down the diagonal: mostly bits, one rich seam in the middle.
  for (let i = 0; i < 13; i++) {
    const r = rng(seed + i * 7919);
    const along = t(14 + i * 2.7);
    const off = t(11) - ((r % t(22)) | 0);
    node("bitnode", along + off, t(MAP_TILES) - along + off, 1600);
  }
  node("pixnode", t(32), t(32), 2600);

  recomputeSupply(w);
  return w;
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

function recomputeSupply(w: World) {
  const used = [0, 0], cap = [0, 0];
  for (const e of w.entities) {
    if (e.owner < 0) continue;
    if (STATS[e.kind].building) {
      if (e.complete) cap[e.owner]! += STATS[e.kind].supply;
    } else {
      used[e.owner]! += 1;
    }
  }
  for (let p = 0; p < 2; p++) {
    w.players[p]!.supply = used[p]!;
    w.players[p]!.supplyCap = Math.min(SUPPLY_MAX, cap[p]!);
  }
}

export function canTrain(building: Kind, unit: Kind): boolean {
  if (building === "datacenter") return unit === "engineer";
  if (building === "keyboard") return unit === "face" || unit === "ninja" || unit === "guard" || unit === "wizard" || unit === "vampire";
  return false;
}

export function trainableAt(building: Kind): Kind[] {
  if (building === "datacenter") return ["engineer"];
  if (building === "keyboard") return ["face", "ninja", "guard", "wizard", "vampire"];
  return [];
}

function nodeRes(kind: Kind): Res | null {
  return kind === "bitnode" ? "bits" : kind === "pixnode" ? "pixels" : null;
}

export function siteClear(w: World, x: number, y: number, radius: number): boolean {
  if (x < radius || y < radius || x > MAP_SIZE - radius || y > MAP_SIZE - radius) return false;
  for (const e of w.entities) {
    if (!STATS[e.kind].building) continue;
    const need = radius + STATS[e.kind].radius + 4 * FP;
    const dx = e.x - x, dy = e.y - y;
    if (dx * dx + dy * dy < need * need) return false;
  }
  return true;
}

// -------------------------------------------------------------------- commands

/** Commands arrive from the network, so every one is re-validated against
 *  ownership and cost before it touches the world. */
export function applyCommand(w: World, owner: number, cmd: Command) {
  const mine = (id: number) => {
    const e = w.byId.get(id);
    return e && e.owner === owner && e.hp > 0 ? e : undefined;
  };
  switch (cmd.c) {
    case "move":
    case "attackMove": {
      const kind = cmd.c === "move" ? "move" : "attackMove";
      const units = cmd.ids.map(mine).filter((e): e is Entity => !!e && !STATS[e.kind].building);
      formation(units, cmd.x, cmd.y, (e, x, y) => {
        e.order = { kind, x, y, target: 0, build: null };
      });
      break;
    }
    case "target": {
      const t = w.byId.get(cmd.id);
      if (!t) break;
      for (const id of cmd.ids) {
        const e = mine(id);
        if (!e || STATS[e.kind].building) continue;
        e.order = contextOrder(e, t, owner);
      }
      break;
    }
    case "build": {
      const s = STATS[cmd.kind];
      const pl = w.players[owner]!;
      const crew = cmd.ids.map(mine).filter((e): e is Entity => !!e && e.kind === "engineer");
      if (!crew.length || !s.building || !affordable(pl, s.cost)) break;
      const x = clamp(cmd.x, s.radius, MAP_SIZE - s.radius);
      const y = clamp(cmd.y, s.radius, MAP_SIZE - s.radius);
      if (!siteClear(w, x, y, s.radius)) break;
      pay(pl, s.cost);
      const b = makeEntity(w, cmd.kind, owner, x, y, false);
      for (const wk of crew) wk.order = { kind: "build", x, y, target: b.id, build: cmd.kind };
      recomputeSupply(w);
      break;
    }
    case "train": {
      const s = STATS[cmd.kind];
      const pl = w.players[owner]!;
      // Everything already queued anywhere counts against supply, otherwise
      // parallel production quietly overshoots the cap.
      let queued = 0;
      for (const e of w.entities) if (e.owner === owner && STATS[e.kind].building) queued += e.queue.length;
      for (const id of cmd.ids) {
        const b = mine(id);
        if (!b || !b.complete || !canTrain(b.kind, cmd.kind)) continue;
        if (!affordable(pl, s.cost) || b.queue.length >= 5) continue;
        if (pl.supply + queued + 1 > pl.supplyCap) continue;
        pay(pl, s.cost);
        b.queue.push(cmd.kind);
        if (b.queue.length === 1) b.queueLeft = s.buildTime;
        break; // train from a single building per command
      }
      break;
    }
    case "rally": {
      for (const id of cmd.ids) {
        const b = mine(id);
        if (!b || !STATS[b.kind].building) continue;
        b.rallyX = cmd.x; b.rallyY = cmd.y;
      }
      break;
    }
    case "cancel": {
      for (const id of cmd.ids) {
        const b = mine(id);
        if (!b || !b.queue.length) continue;
        pay(w.players[owner]!, STATS[b.queue.pop()!].cost, +1);
        if (!b.queue.length) b.queueLeft = 0;
      }
      break;
    }
    case "detonate": {
      for (const id of cmd.ids) {
        const e = mine(id);
        if (e && e.kind === "face" && e.level >= MAX_LEVEL) e.hp = 0;
      }
      break;
    }
    case "stop": {
      for (const id of cmd.ids) {
        const e = mine(id);
        if (e) e.order = { ...IDLE };
      }
      break;
    }
  }
}

/** What a right-click on `t` should mean for `e`. */
function contextOrder(e: Entity, t: Entity, owner: number) {
  const at = { x: t.x, y: t.y, target: t.id, build: null };
  const res = nodeRes(t.kind);
  if (res) {
    return e.kind === "engineer"
      ? { kind: "harvest" as const, ...at }
      : { kind: "move" as const, x: t.x, y: t.y, target: 0, build: null };
  }
  if (t.owner === owner) {
    if (e.kind === "engineer" && !t.complete) return { kind: "build" as const, ...at, build: t.kind };
    if (e.kind === "engineer" && t.kind === "cloud" && t.complete) return { kind: "haul" as const, ...at };
    if (e.kind === "engineer" && e.cargo > 0 && STATS[t.kind].depot === e.cargoRes) {
      return { kind: "returnCargo" as const, ...at };
    }
    if (e.kind === "face" && t.kind === "feed" && t.complete) return { kind: "enroll" as const, ...at };
    return { kind: "move" as const, x: t.x, y: t.y, target: 0, build: null };
  }
  if (t.owner >= 0) return { kind: "attack" as const, ...at };
  return { kind: "move" as const, x: t.x, y: t.y, target: 0, build: null };
}

/** Spread a group order into a grid so units do not all target one point. */
function formation(units: Entity[], x: number, y: number, set: (e: Entity, x: number, y: number) => void) {
  const n = units.length;
  if (n === 0) return;
  if (n === 1) { set(units[0]!, x, y); return; }
  const cols = isqrt(n - 1) + 1;
  const gap = 28 * FP;
  for (let i = 0; i < n; i++) {
    const cx = (i % cols) - (cols - 1) / 2;
    const cy = ((i / cols) | 0) - ((n - 1) / cols) / 2;
    set(units[i]!, clamp(x + Math.round(cx * gap), 0, MAP_SIZE), clamp(y + Math.round(cy * gap), 0, MAP_SIZE));
  }
}

// ------------------------------------------------------------------------ step

export function step(w: World, cmds: { owner: number; cmd: Command }[]) {
  w.events.length = 0;
  for (const { owner, cmd } of cmds) applyCommand(w, owner, cmd);
  w.paths.refresh(w.entities);
  if (w.tick % DECAY_EVERY === 0) w.trails.decay();
  if (w.avoidJams && w.tick % CONGEST_EVERY === 0 && w.trails.refreshCongestion()) {
    w.paths.setCongestion(w.trails.congestion);
  }

  for (const e of w.entities) {
    if (e.hp <= 0 || nodeRes(e.kind)) continue;
    if (e.cooldown > 0) e.cooldown--;
    if (STATS[e.kind].building) stepBuilding(w, e);
    else stepUnit(w, e);
  }

  separate(w);

  // Reap the dead in id order, so both peers remove the same things.
  let dirty = false;
  for (let i = w.entities.length - 1; i >= 0; i--) {
    const e = w.entities[i]!;
    if (e.hp > 0 && !(nodeRes(e.kind) && e.amount <= 0)) continue;
    if (e.kind === "face" && e.level >= MAX_LEVEL) detonate(w, e);
    w.events.push({ x: e.x, y: e.y, kind: nodeRes(e.kind) ? "depleted" : "death" });
    w.entities.splice(i, 1);
    w.byId.delete(e.id);
    if (STATS[e.kind].building) w.paths.invalidate();
    dirty = true;
  }
  if (dirty) recomputeSupply(w);

  if (w.winner < 0) {
    const alive = [false, false];
    for (const e of w.entities) if (e.owner >= 0) alive[e.owner] = true;
    if (!alive[0] && !alive[1]) w.winner = 2;
    else if (!alive[0]) w.winner = 1;
    else if (!alive[1]) w.winner = 0;
  }

  w.tick++;
}

/** 😡 goes off. Enemies only — friendly fire would make them unusable. */
function detonate(w: World, e: Entity) {
  const r = BLAST_RADIUS * FP;
  for (const o of w.entities) {
    if (o.owner < 0 || o.owner === e.owner || o.hp <= 0 || o.id === e.id) continue;
    const dx = o.x - e.x, dy = o.y - e.y;
    if (dx * dx + dy * dy > r * r) continue;
    o.hp -= BLAST_DAMAGE;
    o.flash = 8;
  }
  w.events.push({ x: e.x, y: e.y, kind: "blast", text: "🤯" });
}

function stepBuilding(w: World, b: Entity) {
  if (!b.complete) return;

  if (b.kind === "cloud" && b.stockBits >= 2 && b.stockPixels >= 1) {
    if (++b.progress >= CONVERT_TICKS) {
      b.progress = 0;
      b.stockBits -= 2;
      b.stockPixels -= 1;
      w.players[b.owner]!.slop += 1;
      w.events.push({ x: b.x, y: b.y - 30 * FP, kind: "float", text: "🤖" });
    }
  }

  if (!b.queue.length) return;
  b.queueLeft--;
  if (b.queueLeft > 0) return;
  const kind = b.queue.shift()!;
  const r = STATS[b.kind].radius + STATS[kind].radius + 8 * FP;
  const u = makeEntity(w, kind, b.owner, clamp(b.x + r, 0, MAP_SIZE), clamp(b.y + r, 0, MAP_SIZE));
  u.order = { kind: "move", x: b.rallyX, y: b.rallyY, target: 0, build: null };
  b.queueLeft = b.queue.length ? STATS[b.queue[0]!].buildTime : 0;
  w.events.push({ x: u.x, y: u.y, kind: "spawn", text: STATS[kind].emoji });
  recomputeSupply(w);
}

function stepUnit(w: World, e: Entity) {
  const s = STATS[e.kind];
  const o = e.order;

  switch (o.kind) {
    case "idle":
    case "attackMove": {
      const foe = acquire(w, e);
      if (foe) {
        if (o.kind === "idle" && inRange(e, foe, s.range)) { strike(w, e, foe); return; }
        e.order = { kind: "attack", x: foe.x, y: foe.y, target: foe.id, build: null };
        return;
      }
      if (o.kind === "attackMove") {
        if (moveToward(w, e, o.x, o.y, s.speed, 6 * FP) || giveUp(e, o.x, o.y)) e.order = { ...IDLE };
      }
      return;
    }
    case "move": {
      if (moveToward(w, e, o.x, o.y, s.speed, 5 * FP) || giveUp(e, o.x, o.y)) e.order = { ...IDLE };
      return;
    }
    case "attack": {
      const t = w.byId.get(o.target);
      if (!t || t.hp <= 0 || t.owner === e.owner || t.owner < 0) { e.order = { ...IDLE }; return; }
      if (inRange(e, t, s.range)) strike(w, e, t);
      else moveToward(w, e, t.x, t.y, s.speed, 0, t.id);
      return;
    }
    case "harvest": {
      const node = w.byId.get(o.target);
      const res = node && nodeRes(node.kind);
      if (e.cargo >= CARGO_SIZE) { e.order = { kind: "returnCargo", x: e.x, y: e.y, target: 0, build: null }; return; }
      if (!node || !res || node.amount <= 0) {
        const next = pickNode(w, e, node ? nodeRes(node.kind) : e.cargoRes);
        e.order = next
          ? { kind: "harvest", x: next.x, y: next.y, target: next.id, build: null }
          : { ...IDLE };
        e.progress = 0;
        return;
      }
      if (!inRange(e, node, 6 * FP)) {
        if (moveToward(w, e, node.x, node.y, s.speed, 0, node.id) || giveUp(e, node.x, node.y)) e.order = { ...IDLE };
        e.progress = 0;
        return;
      }
      e.progress++;
      if (e.progress >= (res === "bits" ? BIT_TICKS : PIX_TICKS)) {
        const take = Math.min(CARGO_SIZE, node.amount);
        node.amount -= take;
        e.cargo = take;
        e.cargoRes = res;
        e.progress = 0;
        e.order = { kind: "returnCargo", x: e.x, y: e.y, target: 0, build: null };
      }
      return;
    }
    case "returnCargo": {
      let depot = w.byId.get(o.target);
      if (!acceptsFrom(depot, e)) {
        depot = nearest(w, e, (b) => acceptsFrom(b, e));
        if (!depot) { e.order = { ...IDLE }; return; }
        o.target = depot.id;
      }
      if (!inRange(e, depot, 8 * FP)) {
        if (moveToward(w, e, depot.x, depot.y, s.speed, 0, depot.id) || giveUp(e, depot.x, depot.y)) e.order = { ...IDLE };
        return;
      }
      const pl = w.players[e.owner]!;
      if (e.cargoRes === "bits") pl.bits += e.cargo;
      else if (e.cargoRes === "pixels") pl.pixels += e.cargo;
      w.events.push({ x: depot.x, y: depot.y - 26 * FP, kind: "float", text: e.cargoRes === "bits" ? "💾" : "🎨" });
      const was = e.cargoRes;
      e.cargo = 0;
      e.cargoRes = null;
      const node = pickNode(w, e, was);
      e.order = node
        ? { kind: "harvest", x: node.x, y: node.y, target: node.id, build: null }
        : { ...IDLE };
      return;
    }
    case "build": {
      const b = w.byId.get(o.target);
      if (!b || b.complete || b.owner !== e.owner) { e.order = { ...IDLE }; return; }
      if (!inRange(e, b, BUILD_RANGE)) {
        if (moveToward(w, e, b.x, b.y, s.speed, 0, b.id) || giveUp(e, b.x, b.y)) e.order = { ...IDLE };
        return;
      }
      const total = STATS[b.kind].buildTime;
      b.progress++;
      b.hp = Math.min(b.maxHp, Math.max(1, Math.round((b.maxHp * (b.progress + total / 10)) / total)));
      if (b.progress >= total) {
        b.complete = true;
        b.hp = b.maxHp;
        b.progress = 0;
        w.events.push({ x: b.x, y: b.y, kind: "built", text: "✨" });
        recomputeSupply(w);
        const node = pickNode(w, e, null);
        e.order = node
          ? { kind: "harvest", x: node.x, y: node.y, target: node.id, build: null }
          : { ...IDLE };
      }
      return;
    }
    case "haul": {
      // Shuttle between the depots and a Cloud, keeping it fed 2 bits to 1 pixel.
      const cloud = w.byId.get(o.target);
      if (!cloud || cloud.kind !== "cloud" || cloud.owner !== e.owner || !cloud.complete) { e.order = { ...IDLE }; return; }
      if (e.cargo > 0) {
        if (!inRange(e, cloud, 8 * FP)) {
          if (moveToward(w, e, cloud.x, cloud.y, s.speed, 0, cloud.id) || giveUp(e, cloud.x, cloud.y)) e.order = { ...IDLE };
          return;
        }
        if (e.cargoRes === "bits") cloud.stockBits += e.cargo;
        else cloud.stockPixels += e.cargo;
        w.events.push({ x: cloud.x, y: cloud.y - 28 * FP, kind: "float", text: e.cargoRes === "bits" ? "💾" : "🎨" });
        e.cargo = 0;
        e.cargoRes = null;
        return;
      }
      const pl = w.players[e.owner]!;
      const wantPixels = cloud.stockPixels * 2 <= cloud.stockBits;
      const want: Res = wantPixels && pl.pixels > 0 ? "pixels" : "bits";
      const store = want === "bits" ? pl.bits : pl.pixels;
      if (store <= 0) { moveToward(w, e, cloud.x, cloud.y, s.speed, 60 * FP); return; } // idle near the Cloud
      const src = nearest(w, e, (b) => b.owner === e.owner && b.complete && STATS[b.kind].depot === want);
      if (!src) { e.order = { ...IDLE }; return; }
      if (!inRange(e, src, 8 * FP)) {
        if (moveToward(w, e, src.x, src.y, s.speed, 0, src.id) || giveUp(e, src.x, src.y)) e.order = { ...IDLE };
        return;
      }
      const take = Math.min(CARGO_SIZE, store);
      if (want === "bits") pl.bits -= take; else pl.pixels -= take;
      e.cargo = take;
      e.cargoRes = want;
      return;
    }
    case "enroll": {
      const feed = w.byId.get(o.target);
      if (!feed || feed.kind !== "feed" || feed.owner !== e.owner || !feed.complete || e.kind !== "face") {
        e.order = { ...IDLE }; return;
      }
      if (e.level >= MAX_LEVEL) { e.order = { ...IDLE }; return; }
      if (!inRange(e, feed, 10 * FP)) { moveToward(w, e, feed.x, feed.y, s.speed, 0, feed.id); e.progress = 0; return; }
      const pl = w.players[e.owner]!;
      if (e.progress === 0 && !affordable(pl, ENROLL_COST)) return; // wait for slop
      if (e.progress === 0) pay(pl, ENROLL_COST);
      if (++e.progress < ENROLL_TICKS) return;
      e.progress = 0;
      e.level++;
      e.maxHp = faceHp(e.level);
      e.hp = e.maxHp;
      w.events.push({ x: e.x, y: e.y - 24 * FP, kind: "levelup", text: "😤" });
      e.order = e.level >= MAX_LEVEL
        ? { ...IDLE }
        : { kind: "move", x: feed.rallyX, y: feed.rallyY, target: 0, build: null };
      return;
    }
  }
}

function acceptsFrom(depot: Entity | undefined, e: Entity): depot is Entity {
  return !!depot && depot.owner === e.owner && depot.complete && !!e.cargoRes
    && STATS[depot.kind].depot === e.cargoRes;
}

function inRange(a: Entity, b: Entity, range: number): boolean {
  const reach = range + STATS[a.kind].radius + STATS[b.kind].radius;
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy <= reach * reach;
}

function damageOf(e: Entity): number {
  return e.kind === "face" ? faceDamage(e.level) : STATS[e.kind].damage;
}

function strike(w: World, a: Entity, b: Entity) {
  if (a.cooldown > 0) return;
  const s = STATS[a.kind];
  a.cooldown = s.cooldown;
  const dmg = damageOf(a);
  b.hp -= dmg;
  b.flash = 6;
  if (s.lifesteal > 0) a.hp = Math.min(a.maxHp, a.hp + Math.trunc((dmg * s.lifesteal) / 100));
  w.events.push({ x: b.x, y: b.y, kind: s.range > 60 * FP ? "shot" : "hit" });
  // Being shot at pulls idle defenders into the fight.
  if (b.order.kind === "idle" && !STATS[b.kind].building && b.owner >= 0) {
    b.order = { kind: "attack", x: a.x, y: a.y, target: a.id, build: null };
  }
}

function stepBy(e: Entity, dx: number, dy: number, d: number, speed: number) {
  e.x = clamp(e.x + Math.trunc((dx * speed) / d), 0, MAP_SIZE);
  e.y = clamp(e.y + Math.trunc((dy * speed) / d), 0, MAP_SIZE);
}

const LANE_LOOK = 1; // tiles ahead to sniff
const LANE_ENDPOINT = 3; // tiles around a goal where lane logic is switched off

/** Steer away from the pheromone of every crew that is not this one.
 *
 *  Two carriers meeting head-on used to shove through each other via
 *  separation, and that is where harvesting throughput quietly bleeds away. A
 *  bit crew crossing a pixel crew is the same problem wearing a different hat.
 *  So each carrier reads how thick the *other* lanes are on either side of the
 *  path ahead and drifts toward the thinner side. Two flows push each other
 *  apart until they settle into separate lanes.
 *
 *  On an empty road there is nothing to avoid, and swerving anyway just costs
 *  distance — hence the floor. */
function laneShift(w: World, e: Entity, dx: number, dy: number, d: number, speed: number, goalD: number): [number, number] {
  const lane = laneOf(w, e);
  if (lane < 0 || w.laneBias <= 0 || d === 0) return [0, 0];
  const cell = TILE * FP;
  // Crowding at the deposit and at the depot is not a jam to be solved — it is
  // units correctly converging on the same point. Swerving there just pushes
  // them off the thing they are trying to reach, so leave the endpoints alone.
  if (goalD < LANE_ENDPOINT * cell) return [0, 0];
  const fx = Math.trunc((dx * FP) / d), fy = Math.trunc((dy * FP) / d);
  const ahead = LANE_LOOK * cell;
  const px = e.x + Math.trunc((fx * ahead) / FP);
  const py = e.y + Math.trunc((fy * ahead) / FP);
  const nx = -fy, ny = fx; // right-hand normal
  // Swerve only where units genuinely bump into each other. Volume alone is a
  // bad trigger — a busy lane that flows freely costs nothing, and steering on
  // the left/right trail difference never stops: once the lanes separate, each
  // carrier still senses the other off to one side and curves away forever.
  // Friction is self-limiting, because a separated lane stops colliding.
  const jam = w.trails.jam(px, py);
  if (jam < FRICTION_FLOOR) return [0, 0];
  const rt = w.trails.foreign(lane,
    Math.floor((px + Math.trunc((nx * cell) / FP)) / cell),
    Math.floor((py + Math.trunc((ny * cell) / FP)) / cell));
  const lf = w.trails.foreign(lane,
    Math.floor((px - Math.trunc((nx * cell) / FP)) / cell),
    Math.floor((py - Math.trunc((ny * cell) / FP)) / cell));
  const sign = rt > lf ? -1 : 1; // to the thinner side; ties keep right
  const mag = Math.trunc((speed * w.laneBias * Math.min(TRAIL_STRONG, jam)) / (100 * TRAIL_STRONG));
  return [Math.trunc((nx * sign * mag) / FP), Math.trunc((ny * sign * mag) / FP)];
}

/** Which lane this unit belongs to right now, or -1 for "not a carrier". */
function laneOf(w: World, e: Entity): number {
  if (e.kind !== "engineer") return -1;
  switch (e.order.kind) {
    case "harvest": {
      if (e.cargo > 0) return laneIndex(e.cargoRes, true);
      const node = w.byId.get(e.order.target);
      return laneIndex(node ? nodeRes(node.kind) : null, false);
    }
    case "returnCargo": return laneIndex(e.cargoRes, true);
    case "haul": return laneIndex(e.cargoRes, e.cargo > 0);
    default: return -1;
  }
}

/** Lay down what this unit is doing, for whoever comes next. */
function markTrail(w: World, e: Entity) {
  const lane = laneOf(w, e);
  if (lane >= 0) w.trails.drop(e.x, e.y, lane);
}

/** The first structure standing in the way of a straight run at (tx, ty).
 *  `ignore` is whatever the unit is deliberately walking up to. */
function blocker(w: World, e: Entity, tx: number, ty: number, ignore: number): Entity | undefined {
  const er = STATS[e.kind].radius;
  const dx = tx - e.x, dy = ty - e.y;
  const d = isqrt(dx * dx + dy * dy);
  if (d === 0) return undefined;
  const look = Math.min(d, 56 * FP);
  let best: Entity | undefined;
  let bestD = Infinity;
  for (const b of w.entities) {
    if (!STATS[b.kind].solid || b.id === ignore || b.hp <= 0) continue;
    const need = STATS[b.kind].radius + er + 2 * FP;
    const rx = b.x - e.x, ry = b.y - e.y;
    let t = Math.trunc((rx * dx + ry * dy) / d); // how far along the path it sits
    if (t < 0) t = 0; else if (t > look) t = look;
    const cx = b.x - (e.x + Math.trunc((dx * t) / d));
    const cy = b.y - (e.y + Math.trunc((dy * t) / d));
    if (cx * cx + cy * cy >= need * need) continue;
    const away = rx * rx + ry * ry;
    if (away < bestD) { bestD = away; best = b; }
  }
  return best;
}

/** One step toward a point.
 *
 *  Open ground is walked in a straight line — that is what looks right and it
 *  costs nothing. Only when a structure actually lies across the path does the
 *  unit consult the flow field, which routes it around the whole obstruction
 *  rather than letting it grind along one edge. If even the field cannot reach
 *  the goal (walled in, or the goal is inside the obstacle) it falls back to
 *  hugging the obstacle's tangent. */
function moveToward(w: World, e: Entity, tx: number, ty: number, speed: number, slack: number, ignore = 0): boolean {
  const dx = tx - e.x, dy = ty - e.y;
  const d = isqrt(dx * dx + dy * dy);
  if (d <= slack || d === 0) return true;

  const ob = blocker(w, e, tx, ty, ignore);
  if (!ob) {
    if (d <= speed) { e.x = tx; e.y = ty; return true; }
    stepBy(e, dx, dy, d, speed);
    const [sx, sy] = laneShift(w, e, dx, dy, d, speed, d);
    if (sx || sy) { e.x = clamp(e.x + sx, 0, MAP_SIZE); e.y = clamp(e.y + sy, 0, MAP_SIZE); }
    markTrail(w, e);
    return false;
  }

  const wp = w.paths.waypoint(tx, ty, e.x, e.y);
  if (wp) {
    const wx = wp.x - e.x, wy = wp.y - e.y;
    const wd = isqrt(wx * wx + wy * wy);
    if (wd > 0) {
      stepBy(e, wx, wy, wd, speed);
      const [sx, sy] = laneShift(w, e, wx, wy, wd, speed, d);
      if (sx || sy) { e.x = clamp(e.x + sx, 0, MAP_SIZE); e.y = clamp(e.y + sy, 0, MAP_SIZE); }
      markTrail(w, e);
      return false;
    }
  }

  const ox = e.x - ob.x, oy = e.y - ob.y;
  const od = isqrt(ox * ox + oy * oy) || 1;
  const dot = -oy * dx + ox * dy;
  const tanX = dot >= 0 ? -oy : oy;
  const tanY = dot >= 0 ? ox : -ox;
  e.x = clamp(e.x + Math.trunc(((tanX * 4 + ox) * speed) / (od * 4)), 0, MAP_SIZE);
  e.y = clamp(e.y + Math.trunc(((tanY * 4 + oy) * speed) / (od * 4)), 0, MAP_SIZE);
  return false;
}

/** Units that cannot make headway — boxed in, or shoving at a spot another
 *  unit already occupies — stop instead of grinding there forever. */
function giveUp(e: Entity, tx: number, ty: number): boolean {
  const dx = tx - e.x, dy = ty - e.y;
  const d = isqrt(dx * dx + dy * dy);
  // A jump in distance means a fresh order rather than a failure to advance.
  if (e.lastD === 0 || d < e.lastD - FP || d > e.lastD + 4 * FP) {
    e.lastD = d; e.stuck = 0; return false;
  }
  return ++e.stuck > 90; // ~4.5s of no progress
}

function acquire(w: World, e: Entity): Entity | undefined {
  const s = STATS[e.kind];
  if (s.damage <= 0 && e.kind !== "face") return undefined;
  // Stagger scans across ticks; cheap and identical on both peers.
  if (((w.tick + e.id) & 3) !== 0) return undefined;
  const leash = e.order.kind === "attackMove" ? s.sight : (e.kind === "engineer" ? s.range * 3 : s.sight);
  let best: Entity | undefined;
  let bestD = leash * leash + 1;
  for (const o of w.entities) {
    if (o.owner < 0 || o.owner === e.owner || o.hp <= 0) continue;
    const dx = o.x - e.x, dy = o.y - e.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD) { bestD = d2; best = o; }
  }
  return best;
}

const CROWD_PENALTY = 70 * FP; // how much further a busy deposit "feels"

/** Pick something to mine. Distance matters, but so does how many crew are
 *  already committed to that deposit — the count is the stigmergic signal, and
 *  it spreads the crew out instead of stacking them all on the nearest pile.
 *  Miners also stay on the resource they were already on, so a pixel crew does
 *  not quietly collapse into a bit crew after one delivery. */
function pickNode(w: World, e: Entity, prefer: Res | null): Entity | undefined {
  const load = new Map<number, number>();
  for (const o of w.entities) {
    if (o.owner !== e.owner || o.kind !== "engineer" || o.id === e.id) continue;
    if (o.order.kind !== "harvest") continue;
    load.set(o.order.target, (load.get(o.order.target) ?? 0) + 1);
  }
  let best: Entity | undefined;
  let bestScore = Infinity;
  for (const pass of prefer && w.spread ? [prefer, null] : [null]) {
    for (const c of w.entities) {
      const res = nodeRes(c.kind);
      if (!res || c.amount <= 0) continue;
      if (pass && res !== pass) continue;
      const dx = c.x - e.x, dy = c.y - e.y;
      const score = isqrt(dx * dx + dy * dy)
        + (w.spread ? (load.get(c.id) ?? 0) * CROWD_PENALTY : 0);
      if (score < bestScore) { bestScore = score; best = c; }
    }
    if (best) break; // preferred resource wins outright when any is left
  }
  return best;
}

function nearest(w: World, e: Entity, pred: (o: Entity) => boolean): Entity | undefined {
  let best: Entity | undefined;
  let bestD = Infinity;
  for (const o of w.entities) {
    if (!pred(o)) continue;
    const dx = o.x - e.x, dy = o.y - e.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD) { bestD = d2; best = o; }
  }
  return best;
}

/** Push overlapping units apart. The circle used here is exactly the ring the
 *  renderer draws, so what you see is what collides. Bucketed by tile to stay
 *  linear-ish, and pairs are visited in id order to stay deterministic. */
function separate(w: World) {
  const cell = TILE * FP;
  const buckets = new Map<number, Entity[]>();
  const mobile: Entity[] = [];
  for (const e of w.entities) {
    if (STATS[e.kind].building || e.hp <= 0) continue;
    mobile.push(e);
    const k = ((e.y / cell) | 0) * MAP_TILES + ((e.x / cell) | 0);
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(e);
  }
  for (const a of mobile) {
    const cx = (a.x / cell) | 0, cy = (a.y / cell) | 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const b = buckets.get((cy + oy) * MAP_TILES + (cx + ox));
        if (!b) continue;
        for (const o of b) {
          if (o.id <= a.id) continue;
          const need = STATS[a.kind].radius + STATS[o.kind].radius;
          let dx = o.x - a.x, dy = o.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 >= need * need) continue;
          if (d2 === 0) { dx = ((a.id % 7) - 3) * FP; dy = ((o.id % 5) - 2) * FP; d2 = dx * dx + dy * dy; if (d2 === 0) continue; }
          const d = isqrt(d2) || 1;
          const push = Math.trunc((need - d) / 2) + 1;
          const nx = Math.trunc((dx * push) / d), ny = Math.trunc((dy * push) / d);
          // Mark where it happened; this is the jam signal everything else reads.
          w.trails.bump((a.x + o.x) >> 1, (a.y + o.y) >> 1);
          a.x = clamp(a.x - nx, 0, MAP_SIZE); a.y = clamp(a.y - ny, 0, MAP_SIZE);
          o.x = clamp(o.x + nx, 0, MAP_SIZE); o.y = clamp(o.y + ny, 0, MAP_SIZE);
        }
      }
    }
  }
  // Keep units out of the footprint of structures. Pushes are accumulated and
  // applied once: snapping to each structure in turn let a unit caught between
  // two of them ping-pong in place forever instead of squeezing out.
  const solids = w.entities.filter((b) => STATS[b.kind].solid && b.hp > 0);
  for (const a of mobile) {
    let sx = 0, sy = 0;
    for (const b of solids) {
      const need = STATS[b.kind].radius + STATS[a.kind].radius;
      let dx = a.x - b.x, dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 >= need * need) continue;
      if (d2 === 0) { dx = (a.id % 5) + 1; dy = (a.id % 3) + 1; d2 = dx * dx + dy * dy; }
      const d = isqrt(d2) || 1;
      const push = need - d;
      sx += Math.trunc((dx * push) / d);
      sy += Math.trunc((dy * push) / d);
    }
    if (sx || sy) {
      a.x = clamp(a.x + sx, 0, MAP_SIZE);
      a.y = clamp(a.y + sy, 0, MAP_SIZE);
    }
  }
}

/** Cheap desync detector — folded over the whole world state. */
export function checksum(w: World): number {
  let h = 0x811c9dc5 ^ w.tick;
  const mix = (v: number) => { h = Math.imul(h ^ (v | 0), 0x01000193) >>> 0; };
  for (const e of w.entities) {
    mix(e.id); mix(e.x); mix(e.y); mix(e.hp); mix(e.cargo); mix(e.level);
    mix(e.order.kind.length * 31 + e.order.target); mix(e.queue.length);
    mix(e.stockBits * 7 + e.stockPixels);
  }
  for (const p of w.players) { mix(p.bits); mix(p.pixels); mix(p.slop); mix(p.supply); }
  return h >>> 0;
}
