import { FP, STATS, type Command, type Entity } from "./types";
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
  const of = (k: string) => mine.filter((e) => e.kind === k);
  const bases = of("base").filter((b) => b.complete);
  const barracks = of("barracks");
  const workers = of("worker");
  const army = mine.filter((e) => e.kind === "soldier" || e.kind === "archer");
  const pl = w.players[me]!;
  const crystals = w.entities.filter((c) => c.kind === "crystal" && c.amount > 0);

  // Idle workers go dig.
  for (const wk of workers) {
    if (wk.order.kind !== "idle") continue;
    let best: Entity | undefined, bestD = Infinity;
    for (const c of crystals) {
      const dx = c.x - wk.x, dy = c.y - wk.y, d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best) out.push({ c: "target", ids: [wk.id], id: best.id });
  }

  // Economy first, then army production.
  if (bases.length && workers.length < 11) {
    out.push({ c: "train", ids: bases.map((b) => b.id), kind: "worker" });
  }
  for (const b of barracks) {
    if (!b.complete) continue;
    const kind = ((w.tick / 10) | 0) % 3 === 0 ? "archer" : "soldier";
    out.push({ c: "train", ids: [b.id], kind });
  }

  // Expand production while there is spare income.
  if (barracks.length < 4 && pl.crystals >= STATS.barracks.cost + 60 && bases.length && workers.length >= 5) {
    const home = bases[0]!;
    const ring = 90 * FP * (10 + barracks.length * 4);
    for (let i = 0; i < RING.length; i++) {
      const [cx, cy] = RING[i]!;
      const x = home.x + Math.trunc((cx * ring) / 10000);
      const y = home.y + Math.trunc((cy * ring) / 10000);
      if (siteClear(w, x, y, STATS.barracks.radius)) {
        const builder = workers.find((k) => k.order.kind === "harvest") ?? workers[0];
        if (builder) out.push({ c: "build", ids: [builder.id], kind: "barracks", x, y });
        break;
      }
    }
  }

  // Attack once there is a critical mass; otherwise hold near home.
  const idleArmy = army.filter((a) => a.order.kind === "idle");
  if (army.length >= 7 && idleArmy.length) {
    let target: Entity | undefined = foes.find((f) => f.kind === "base") ?? foes[0];
    if (target) {
      out.push({ c: "attackMove", ids: idleArmy.map((a) => a.id), x: target.x, y: target.y });
    }
  } else if (idleArmy.length && bases.length) {
    const h = bases[0]!;
    out.push({ c: "attackMove", ids: idleArmy.map((a) => a.id), x: h.x + 70 * FP, y: h.y + 70 * FP });
  }

  return out;
}
