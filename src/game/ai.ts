import { FP, STATS, affordable, MAX_LEVEL, type Command, type Entity, type Kind } from "./types";
import { siteClear, type World } from "./sim";

// Eight unit directions at 1000x scale — integer table instead of trig, so the
// AI stays as deterministic as the simulation it drives.
const RING: [number, number][] = [
  [1000, 0], [707, 707], [0, 1000], [-707, 707],
  [-1000, 0], [-707, -707], [0, -1000], [707, -707],
];

/** Practice-mode opponent. Pure function of world state, so it stays
 *  deterministic — it is safe to run inside the lockstep simulation. */
export function aiCommands(w: World, me: number): Command[] {
  if (w.tick % 10 !== 0 || w.winner >= 0) return [];
  const out: Command[] = [];
  const mine: Entity[] = [];
  const foes: Entity[] = [];
  for (const e of w.entities) {
    if (e.owner === me) mine.push(e);
    else if (e.owner >= 0) foes.push(e);
  }
  const of = (k: Kind) => mine.filter((e) => e.kind === k);
  const centres = of("datacenter").filter((b) => b.complete);
  const keyboards = of("keyboard");
  const clouds = of("cloud").filter((b) => b.complete);
  const feeds = of("feed").filter((b) => b.complete);
  const crew = of("engineer");
  const army = mine.filter((e) => !STATS[e.kind].building && e.kind !== "engineer");
  const pl = w.players[me]!;
  const nodes = w.entities.filter((c) => (c.kind === "bitnode" || c.kind === "pixnode") && c.amount > 0);

  // Idle engineers go dig — every third on pixels, every fourth seconded to
  // a Cloud once one exists.
  // A Cloud is useless without couriers, and couriers never go idle, so they
  // are conscripted from the mining crew rather than waiting for spare hands.
  const haulers = crew.filter((e) => e.order.kind === "haul").length;
  if (clouds.length && haulers < 3) {
    const spare = crew.find((e) => e.order.kind === "harvest");
    if (spare) out.push({ c: "target", ids: [spare.id], id: clouds[0]!.id });
  }

  let idleSeen = 0;
  for (const wk of crew) {
    if (wk.order.kind !== "idle") continue;
    const n = idleSeen++;
    if (clouds.length && n % 4 === 3) { out.push({ c: "target", ids: [wk.id], id: clouds[0]!.id }); continue; }
    const wantPixels = n % 3 === 2;
    let best: Entity | undefined, bestD = Infinity;
    for (const c of nodes) {
      if (wantPixels !== (c.kind === "pixnode")) continue;
      const dx = c.x - wk.x, dy = c.y - wk.y, d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = c; }
    }
    if (!best) for (const c of nodes) {
      const dx = c.x - wk.x, dy = c.y - wk.y, d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best) out.push({ c: "target", ids: [wk.id], id: best.id });
  }

  // What to put up next, most important first.
  const want: Kind[] = [];
  if (!keyboards.length) want.push("keyboard");
  if (crew.length >= 7 && !of("cloud").length) want.push("cloud");
  if (crew.length >= 8 && !of("feed").length) want.push("feed");
  if (crew.length >= 6 && keyboards.length < 3) want.push("keyboard");
  // Dribbling every last bit into units means never affording the good
  // buildings, so stop making bodies while banking for the next one.
  const saving = want.length > 0 && !affordable(pl, STATS[want[0]!].cost);

  if (centres.length && crew.length < 13) {
    out.push({ c: "train", ids: centres.map((b) => b.id), kind: "engineer" });
  }
  if (!saving) for (const b of keyboards) {
    if (!b.complete) continue;
    const roll = ((w.tick / 10) | 0) % 5;
    const kind: Kind = roll === 0 ? "guard" : roll === 1 ? "ninja"
      : roll === 2 && affordable(pl, STATS.wizard.cost) ? "wizard"
      : roll === 3 && affordable(pl, STATS.vampire.cost) ? "vampire" : "face";
    out.push({ c: "train", ids: [b.id], kind });
  }

  // Radicalise a smiley whenever there is slop to spare.
  const enrolling = new Set<number>();
  if (feeds.length && pl.slop >= 4) {
    const calm = mine.filter((e) => e.kind === "face" && e.level < MAX_LEVEL && e.order.kind === "idle");
    if (calm.length) {
      out.push({ c: "target", ids: [calm[0]!.id], id: feeds[0]!.id });
      enrolling.add(calm[0]!.id); // or the hold order below would overwrite it
    }
  }

  // Build out whatever we can currently pay for.
  const target = want.find((k) => affordable(pl, STATS[k].cost));
  if (target && centres.length && crew.length >= 4) {
    const home = centres[0]!;
    const ring = 100 * FP * (10 + mine.filter((e) => STATS[e.kind].building).length * 3);
    for (let i = 0; i < RING.length; i++) {
      const [cx, cy] = RING[i]!;
      const x = home.x + Math.trunc((cx * ring) / 10000);
      const y = home.y + Math.trunc((cy * ring) / 10000);
      if (siteClear(w, x, y, STATS[target].radius)) {
        const builder = crew.find((k) => k.order.kind === "harvest") ?? crew[0];
        if (builder) out.push({ c: "build", ids: [builder.id], kind: target, x, y });
        break;
      }
    }
  }

  // Attack once there is a critical mass; otherwise hold near home.
  const idleArmy = army.filter((a) => a.order.kind === "idle" && !enrolling.has(a.id)
    && !(a.kind === "face" && a.level > 0 && a.level < MAX_LEVEL));
  if (army.length >= 7 && idleArmy.length) {
    const hit = foes.find((f) => f.kind === "datacenter") ?? foes.find((f) => STATS[f.kind].building) ?? foes[0];
    if (hit) out.push({ c: "attackMove", ids: idleArmy.map((a) => a.id), x: hit.x, y: hit.y });
  } else if (idleArmy.length && centres.length) {
    const h = centres[0]!;
    out.push({ c: "attackMove", ids: idleArmy.map((a) => a.id), x: h.x + 80 * FP, y: h.y + 80 * FP });
  }

  return out;
}
