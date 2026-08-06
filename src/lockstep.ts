import { TICK_MS, type Command } from "./game/types";
import { aiCommands } from "./game/ai";
import { checksum, createWorld, step, type World } from "./game/sim";
import type { Net } from "./net";

/** Ticks of input latency. Commands issued now execute this many ticks later,
 *  which gives the packet time to cross the wire before either side needs it. */
const DELAY = 6;
const SUM_EVERY = 40;

export type Mode = "practice" | "peer";

export interface Runner {
  world: World;
  me: number;
  mode: Mode;
  issue(cmd: Command): void;
  /** Advance the simulation to match wall-clock time. Returns 0..1 fraction
   *  into the next tick, for render interpolation. */
  update(dtMs: number): number;
  stalledMs: number;
  desync: boolean;
  rtt: number;
  ticksBehind: number;
}

export function createRunner(opts: { mode: Mode; me: number; seed: number; net?: Net }): Runner {
  const world = createWorld(opts.seed);
  const buffers: [Map<number, Command[]>, Map<number, Command[]>] = [new Map(), new Map()];
  const pending: Command[] = [];
  const sums = new Map<number, number>();
  const peer = 1 - opts.me;
  const delay = opts.mode === "peer" ? DELAY : 0;

  for (let t = 0; t < delay; t++) { buffers[0].set(t, []); buffers[1].set(t, []); }

  const r: Runner = {
    world, me: opts.me, mode: opts.mode,
    stalledMs: 0, desync: false, rtt: 0, ticksBehind: 0,
    issue(cmd) { pending.push(cmd); },
    update,
  };

  if (opts.net) {
    const net = opts.net;
    net.onMessage = (msg) => {
      if (msg.t === "cmds") buffers[peer].set(msg.tick, msg.cmds as Command[]);
      else if (msg.t === "sum") {
        const mineSum = sums.get(msg.tick);
        if (mineSum !== undefined && mineSum !== msg.sum) r.desync = true;
        else sums.set(msg.tick, msg.sum);
      }
    };
  }

  let acc = 0;
  function update(dtMs: number): number {
    // A backgrounded tab gets its timers clamped to ~1s, so allow a full
    // second of catch-up: the peer must not be left waiting on us.
    acc += Math.min(dtMs, 1000);
    let ran = 0;
    while (acc >= TICK_MS) {
      if (!tickOnce()) break;
      acc -= TICK_MS;
      if (++ran > 40) { acc = 0; break; }
    }
    if (opts.net) r.rtt = opts.net.stats().rtt;
    return Math.min(1, acc / TICK_MS);
  }

  function tickOnce(): boolean {
    const t = world.tick;
    if (world.winner >= 0) return false;

    // Publish our own input for a tick far enough ahead that the peer has it in time.
    if (!buffers[opts.me].has(t + delay)) {
      const mine = pending.splice(0, pending.length);
      buffers[opts.me].set(t + delay, mine);
      if (opts.net && delay > 0) opts.net.send({ t: "cmds", tick: t + delay, cmds: mine });
    }
    // In practice mode the opponent is local: its orders come from the AI below.
    if (opts.mode === "practice") buffers[1 - opts.me].set(t, []);

    const a = buffers[0].get(t);
    const b = buffers[1].get(t);
    if (!a || !b) {
      r.stalledMs += TICK_MS;
      r.ticksBehind++;
      return false;
    }
    r.stalledMs = 0;
    r.ticksBehind = 0;

    const batch: { owner: number; cmd: Command }[] = [];
    for (const cmd of a) batch.push({ owner: 0, cmd });
    for (const cmd of b) batch.push({ owner: 1, cmd });
    if (opts.mode === "practice") {
      for (const cmd of aiCommands(world, 1 - opts.me)) batch.push({ owner: 1 - opts.me, cmd });
    }

    for (const e of world.entities) { e.px = e.x; e.py = e.y; if (e.flash > 0) e.flash--; }
    step(world, batch);
    buffers[0].delete(t);
    buffers[1].delete(t);

    if (opts.net && world.tick % SUM_EVERY === 0) {
      const s = checksum(world);
      const theirs = sums.get(world.tick);
      if (theirs !== undefined && theirs !== s) r.desync = true;
      else sums.set(world.tick, s);
      opts.net.send({ t: "sum", tick: world.tick, sum: s });
      for (const k of sums.keys()) if (k < world.tick - SUM_EVERY * 4) sums.delete(k);
    }
    return true;
  }

  return r;
}
