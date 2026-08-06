import {
  FP, TILE, MAP_TILES, MAP_SIZE, STATS, IDLE,
  type Command, type Entity, type Kind, type Player,
} from "./types";
import { PathCache } from "./flow";

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

export function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx, dy = ay - by;
  return isqrt(dx * dx + dy * dy);
}

function rng(state: number): number {
  // mulberry32, kept entirely in uint32 space
  let t = (state + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (t ^ (t >>> 14)) >>> 0;
}

// ---------------------------------------------------------------------- world

export const GATHER_TICKS = 40;
export const CARGO_SIZE = 10;
export const BUILD_RANGE = 22 * FP;
export const SUPPLY_MAX = 120;

export interface World {
  tick: number;
  seed: number;
  nextId: number;
  entities: Entity[]; // always sorted by id
  byId: Map<number, Entity>;
  players: [Player, Player];
  events: { x: number; y: number; kind: string }[]; // render-only, cleared each step
  winner: number; // -1 while undecided
  paths: PathCache; // derived from the entities; never part of the checksum
}

function makeEntity(w: World, kind: Kind, owner: number, x: number, y: number, complete = true): Entity {
  const s = STATS[kind];
  const e: Entity = {
    id: w.nextId++, kind, owner, x, y,
    hp: complete ? s.hp : Math.max(1, (s.hp / 10) | 0),
    maxHp: s.hp,
    order: { ...IDLE }, cooldown: 0, cargo: 0, amount: 0, progress: 0,
    complete, queue: [], queueLeft: 0,
    rallyX: x, rallyY: y + 60 * FP,
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
      { crystals: 300, supply: 0, supplyCap: 0, defeated: false },
      { crystals: 300, supply: 0, supplyCap: 0, defeated: false },
    ],
    events: [], winner: -1, paths: new PathCache(),
  };

  const t = (n: number) => Math.round(n * TILE * FP); // tiles -> fixed-point, integral
  const starts: [number, number][] = [[t(9), t(9)], [t(MAP_TILES - 9), t(MAP_TILES - 9)]];

  for (let p = 0; p < 2; p++) {
    const [bx, by] = starts[p]!;
    makeEntity(w, "base", p, bx, by);
    for (let i = 0; i < 4; i++) {
      const a = p === 0 ? 1 : -1;
      makeEntity(w, "worker", p, bx + a * t(1.6), by + a * t(0.4) + i * 22 * FP - 33 * FP);
    }
    // Two crystal fields per start location.
    for (const [ox, oy] of [[-3.2, 0.4], [0.4, -3.2]] as [number, number][]) {
      for (let i = 0; i < 4; i++) {
        const cx = bx + t(ox) + (i % 2) * 44 * FP;
        const cy = by + t(oy) + ((i / 2) | 0) * 44 * FP;
        const c = makeEntity(w, "crystal", -1, cx, cy);
        c.amount = 1500;
      }
    }
  }

  // Contested crystals along the centre diagonal.
  for (let i = 0; i < 6; i++) {
    const r = rng(seed + i * 7919);
    const along = t(18 + i * 5.5);
    const off = t(14) - ((r % t(28)) | 0);
    const c = makeEntity(w, "crystal", -1,
      clamp(along + off, t(2), t(MAP_TILES - 2)),
      clamp(t(MAP_TILES) - along + off, t(2), t(MAP_TILES - 2)));
    c.amount = 2000;
  }

  recomputeSupply(w);
  return w;
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function entityAt(w: World, id: number): Entity | undefined {
  return id ? w.byId.get(id) : undefined;
}

function recomputeSupply(w: World) {
  const used = [0, 0], cap = [0, 0];
  for (const e of w.entities) {
    if (e.owner < 0) continue;
    if (STATS[e.kind].building) {
      if (!e.complete) continue;
      cap[e.owner]! += e.kind === "base" ? 15 : 10;
    } else {
      used[e.owner]! += 1;
    }
  }
  for (let p = 0; p < 2; p++) {
    w.players[p]!.supply = used[p]!;
    w.players[p]!.supplyCap = Math.min(SUPPLY_MAX, cap[p]!);
  }
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
        if (e.cargo > 0 && kind === "move") e.cargo = e.cargo; // keep cargo on the move
      });
      break;
    }
    case "target": {
      const t = w.byId.get(cmd.id);
      if (!t) break;
      for (const id of cmd.ids) {
        const e = mine(id);
        if (!e || STATS[e.kind].building) continue;
        if (t.kind === "crystal") {
          if (e.kind !== "worker") { e.order = { kind: "move", x: t.x, y: t.y, target: 0, build: null }; continue; }
          e.order = { kind: "harvest", x: t.x, y: t.y, target: t.id, build: null };
          e.progress = 0;
        } else if (t.owner === owner) {
          if (e.kind === "worker" && !t.complete) {
            e.order = { kind: "build", x: t.x, y: t.y, target: t.id, build: t.kind };
          } else if (e.kind === "worker" && e.cargo > 0 && t.kind === "base") {
            e.order = { kind: "returnCargo", x: t.x, y: t.y, target: t.id, build: null };
          } else {
            e.order = { kind: "move", x: t.x, y: t.y, target: 0, build: null };
          }
        } else if (t.owner >= 0) {
          e.order = { kind: "attack", x: t.x, y: t.y, target: t.id, build: null };
        }
      }
      break;
    }
    case "build": {
      const s = STATS[cmd.kind];
      const pl = w.players[owner]!;
      const workers = cmd.ids.map(mine).filter((e): e is Entity => !!e && e.kind === "worker");
      if (!workers.length || !s.building || pl.crystals < s.cost) break;
      const x = clamp(cmd.x, s.radius, MAP_SIZE - s.radius);
      const y = clamp(cmd.y, s.radius, MAP_SIZE - s.radius);
      if (!siteClear(w, x, y, s.radius)) break;
      pl.crystals -= s.cost;
      const b = makeEntity(w, cmd.kind, owner, x, y, false);
      for (const wk of workers) {
        wk.order = { kind: "build", x, y, target: b.id, build: cmd.kind };
      }
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
        if (pl.crystals < s.cost || b.queue.length >= 5) continue;
        if (pl.supply + queued + 1 > pl.supplyCap) continue;
        pl.crystals -= s.cost;
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
        const k = b.queue.pop()!;
        w.players[owner]!.crystals += STATS[k].cost;
        if (!b.queue.length) b.queueLeft = 0;
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

export function canTrain(building: Kind, unit: Kind): boolean {
  if (building === "base") return unit === "worker";
  if (building === "barracks") return unit === "soldier" || unit === "archer";
  return false;
}

export function trainableAt(building: Kind): Kind[] {
  if (building === "base") return ["worker"];
  if (building === "barracks") return ["soldier", "archer"];
  return [];
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

/** Spread a group order into a grid so units do not all target one point. */
function formation(units: Entity[], x: number, y: number, set: (e: Entity, x: number, y: number) => void) {
  const n = units.length;
  if (n === 0) return;
  if (n === 1) { set(units[0]!, x, y); return; }
  const cols = isqrt(n - 1) + 1;
  const gap = 26 * FP;
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

  for (const e of w.entities) {
    if (e.hp <= 0 || e.kind === "crystal") continue;
    if (e.cooldown > 0) e.cooldown--;
    if (STATS[e.kind].building) stepBuilding(w, e);
    else stepUnit(w, e);
  }

  separate(w);

  // Reap the dead in id order, so both peers remove the same things.
  let dirty = false;
  for (let i = w.entities.length - 1; i >= 0; i--) {
    const e = w.entities[i]!;
    if (e.hp > 0 && !(e.kind === "crystal" && e.amount <= 0)) continue;
    w.events.push({ x: e.x, y: e.y, kind: e.kind === "crystal" ? "depleted" : "death" });
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

function stepBuilding(w: World, b: Entity) {
  if (!b.complete) return;
  if (!b.queue.length) return;
  b.queueLeft--;
  if (b.queueLeft > 0) return;
  const kind = b.queue.shift()!;
  const r = STATS[b.kind].radius + STATS[kind].radius + 6 * FP;
  const u = makeEntity(w, kind, b.owner, clamp(b.x + r, 0, MAP_SIZE), clamp(b.y + r, 0, MAP_SIZE));
  u.order = { kind: "move", x: b.rallyX, y: b.rallyY, target: 0, build: null };
  b.queueLeft = b.queue.length ? STATS[b.queue[0]!].buildTime : 0;
  w.events.push({ x: u.x, y: u.y, kind: "spawn" });
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
        if (o.kind === "attackMove") { e.order = { kind: "attack", x: foe.x, y: foe.y, target: foe.id, build: null }; }
        else if (inRange(e, foe, s.range)) { strike(w, e, foe); return; }
        else { e.order = { kind: "attack", x: foe.x, y: foe.y, target: foe.id, build: null }; }
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
      if (e.cargo >= CARGO_SIZE) { e.order = { kind: "returnCargo", x: e.x, y: e.y, target: 0, build: null }; return; }
      if (!node || node.amount <= 0) {
        const next = nearest(w, e, (c) => c.kind === "crystal" && c.amount > 0);
        e.order = next
          ? { kind: "harvest", x: next.x, y: next.y, target: next.id, build: null }
          : { ...IDLE };
        e.progress = 0;
        return;
      }
      if (!inRange(e, node, 6 * FP)) { moveToward(w, e, node.x, node.y, s.speed, 0, node.id); e.progress = 0; return; }
      e.progress++;
      if (e.progress >= GATHER_TICKS) {
        const take = Math.min(CARGO_SIZE, node.amount);
        node.amount -= take;
        e.cargo = take;
        e.progress = 0;
        e.order = { kind: "returnCargo", x: e.x, y: e.y, target: 0, build: null };
      }
      return;
    }
    case "returnCargo": {
      let depot = w.byId.get(o.target);
      if (!depot || depot.owner !== e.owner || !depot.complete || depot.kind !== "base") {
        depot = nearest(w, e, (b) => b.owner === e.owner && b.kind === "base" && b.complete);
        if (!depot) { e.order = { ...IDLE }; return; }
        o.target = depot.id;
      }
      if (!inRange(e, depot, 8 * FP)) { moveToward(w, e, depot.x, depot.y, s.speed, 0, depot.id); return; }
      w.players[e.owner]!.crystals += e.cargo;
      e.cargo = 0;
      w.events.push({ x: depot.x, y: depot.y, kind: "deposit" });
      const node = nearest(w, e, (c) => c.kind === "crystal" && c.amount > 0);
      e.order = node
        ? { kind: "harvest", x: node.x, y: node.y, target: node.id, build: null }
        : { ...IDLE };
      return;
    }
    case "build": {
      const b = w.byId.get(o.target);
      if (!b || b.complete || b.owner !== e.owner) {
        e.order = b && b.complete ? { ...IDLE } : { ...IDLE };
        return;
      }
      if (!inRange(e, b, BUILD_RANGE)) { moveToward(w, e, b.x, b.y, s.speed, 0, b.id); return; }
      const total = STATS[b.kind].buildTime;
      b.progress++;
      b.hp = Math.min(b.maxHp, Math.max(1, Math.round((b.maxHp * (b.progress + total / 10)) / total)));
      if (b.progress >= total) {
        b.complete = true;
        b.hp = b.maxHp;
        b.progress = 0;
        w.events.push({ x: b.x, y: b.y, kind: "built" });
        recomputeSupply(w);
        const node = nearest(w, e, (c) => c.kind === "crystal" && c.amount > 0);
        e.order = node && e.kind === "worker"
          ? { kind: "harvest", x: node.x, y: node.y, target: node.id, build: null }
          : { ...IDLE };
      }
      return;
    }
  }
}

function inRange(a: Entity, b: Entity, range: number): boolean {
  const reach = range + STATS[a.kind].radius + STATS[b.kind].radius;
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy <= reach * reach;
}

function strike(w: World, a: Entity, b: Entity) {
  if (a.cooldown > 0) return;
  const s = STATS[a.kind];
  a.cooldown = s.cooldown;
  b.hp -= s.damage;
  b.flash = 6;
  w.events.push({ x: b.x, y: b.y, kind: s.range > 60 * FP ? "shot" : "hit" });
  // Being shot at pulls idle defenders into the fight.
  if (b.order.kind === "idle" && !STATS[b.kind].building && b.owner >= 0) {
    b.order = { kind: "attack", x: a.x, y: a.y, target: a.id, build: null };
  }
}

/** The first building standing in the way of a straight run at (tx, ty).
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
    if (!STATS[b.kind].building || b.id === ignore || b.hp <= 0) continue;
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

function stepBy(e: Entity, dx: number, dy: number, d: number, speed: number) {
  e.x = clamp(e.x + Math.trunc((dx * speed) / d), 0, MAP_SIZE);
  e.y = clamp(e.y + Math.trunc((dy * speed) / d), 0, MAP_SIZE);
}

/** One step toward a point.
 *
 *  Open ground is walked in a straight line — that is what looks right and it
 *  costs nothing. Only when a building actually lies across the path does the
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
    return false;
  }

  const wp = w.paths.waypoint(tx, ty, e.x, e.y);
  if (wp) {
    const wx = wp.x - e.x, wy = wp.y - e.y;
    const wd = isqrt(wx * wx + wy * wy);
    if (wd > 0) { stepBy(e, wx, wy, wd, speed); return false; }
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
  if (s.damage <= 0) return undefined;
  // Stagger scans across ticks; cheap and identical on both peers.
  if (((w.tick + e.id) & 3) !== 0) return undefined;
  const leash = e.order.kind === "attackMove" ? s.sight : (e.kind === "worker" ? s.range * 3 : s.sight);
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

/** Push overlapping units apart. Buckets by tile so it stays linear-ish, and
 *  pairs are visited in id order to keep the result deterministic. */
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
          a.x = clamp(a.x - nx, 0, MAP_SIZE); a.y = clamp(a.y - ny, 0, MAP_SIZE);
          o.x = clamp(o.x + nx, 0, MAP_SIZE); o.y = clamp(o.y + ny, 0, MAP_SIZE);
        }
      }
    }
  }
  // Keep units out of the footprint of buildings.
  for (const b of w.entities) {
    if (!STATS[b.kind].building || b.hp <= 0) continue;
    const br = STATS[b.kind].radius;
    for (const a of mobile) {
      const need = br + STATS[a.kind].radius;
      const dx = a.x - b.x, dy = a.y - b.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= need * need) continue;
      const d = isqrt(d2);
      if (d === 0) { a.x += need; continue; }
      a.x = clamp(b.x + Math.trunc((dx * need) / d), 0, MAP_SIZE);
      a.y = clamp(b.y + Math.trunc((dy * need) / d), 0, MAP_SIZE);
    }
  }
}

/** Cheap desync detector — folded over the whole world state. */
export function checksum(w: World): number {
  let h = 0x811c9dc5 ^ w.tick;
  const mix = (v: number) => { h = Math.imul(h ^ (v | 0), 0x01000193) >>> 0; };
  for (const e of w.entities) {
    mix(e.id); mix(e.x); mix(e.y); mix(e.hp); mix(e.cargo);
    mix(e.order.kind.length * 31 + e.order.target); mix(e.queue.length);
  }
  for (const p of w.players) { mix(p.crystals); mix(p.supply); }
  return h >>> 0;
}
