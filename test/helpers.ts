import { STATS, unitHp, type Entity, type Kind } from "../src/game/types";
import { applyCommand, createWorld, recomputeSupply, step, type World } from "../src/game/sim";
import { aiCommands } from "../src/game/ai";

export const FP = 256;
export const TILE_FP = 32 * FP;
export const tiles = (n: number) => Math.round(n * TILE_FP);

/** A world with one player, rich, and nothing of the opponent's in the way. */
export function soloWorld(seed = 1): World {
  const w = createWorld(seed);
  for (let i = w.entities.length - 1; i >= 0; i--) {
    const e = w.entities[i]!;
    if (e.owner === 1) { w.entities.splice(i, 1); w.byId.delete(e.id); }
  }
  w.paths.invalidate();
  Object.assign(w.players[0]!, { bits: 10_000, pixels: 10_000, slop: 0 });
  return w;
}

export const find = (w: World, kind: Kind, owner = 0) =>
  w.entities.find((e) => e.kind === kind && e.owner === owner)!;
export const all = (w: World, kind: Kind, owner = 0) =>
  w.entities.filter((e) => e.kind === kind && e.owner === owner);

/** Drop an entity straight onto the map, bypassing production. */
export function spawn(w: World, kind: Kind, x: number, y: number, owner = 0, level = 0): Entity {
  const e: Entity = {
    id: w.nextId++, kind, owner, x, y,
    hp: unitHp(kind, level), maxHp: unitHp(kind, level),
    order: { kind: "idle", x: 0, y: 0, target: 0, build: null },
    cooldown: 0, cargo: 0, cargoRes: null, amount: 0, progress: 0, dungCd: 0,
    complete: true, queue: [], queueLeft: 0, rallyX: x, rallyY: y,
    level, stockBits: 0, stockPixels: 0, stockSlop: 0, stuck: 0, lastD: 0,
    px: x, py: y, flash: 0,
  };
  w.entities.push(e);
  w.byId.set(e.id, e);
  if (STATS[kind].building) w.paths.invalidate();
  return e;
}

/** Build something and have it finish immediately. */
export function erect(w: World, kind: Kind, x: number, y: number, owner = 0): Entity {
  const builder = all(w, "engineer", owner)[0]!;
  const before = w.nextId;
  applyCommand(w, owner, { c: "build", ids: [builder.id], kind, x, y });
  const b = w.entities.filter((e) => e.kind === kind && e.owner === owner).pop();
  // Must be a *new* building. Returning whatever was already there let a test
  // assert twice about one object and pass while proving nothing.
  if (!b || b.id < before) {
    throw new Error(`could not place a ${kind} at ${x},${y} — the site is not clear`);
  }
  b.complete = true;
  b.hp = b.maxHp;
  recomputeSupply(w); // the real build path does this on completion
  builder.order = { kind: "idle", x: 0, y: 0, target: 0, build: null };
  w.paths.invalidate();
  step(w, []);
  return b;
}

export const run = (w: World, ticks: number) => { for (let i = 0; i < ticks; i++) step(w, []); };

/** Drive both sides with the practice AI — the closest thing to a real match. */
export function runAI(w: World, ticks: number) {
  for (let i = 0; i < ticks && w.winner < 0; i++) {
    const batch = [];
    for (const p of [0, 1]) for (const cmd of aiCommands(w, p)) batch.push({ owner: p, cmd });
    step(w, batch);
  }
}

export const dist = (a: Entity, b: { x: number; y: number }) =>
  Math.round(Math.hypot(a.x - b.x, a.y - b.y) / FP);
