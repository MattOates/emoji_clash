import { describe, expect, it } from "vitest";
import { applyCommand, step } from "../src/game/sim";
import { BLAST_DAMAGE, BLAST_RADIUS, maxLevel, unitHp, unitRange } from "../src/game/types";
import { all, dist, erect, find, run, soloWorld, spawn, tiles, FP } from "./helpers";

describe("combat", () => {
  it("a unit damages an enemy in range and not one out of it", () => {
    const w = soloWorld();
    const home = find(w, "datacenter");
    const attacker = spawn(w, "face", home.x + tiles(6), home.y);
    const near = spawn(w, "face", attacker.x + tiles(0.4), attacker.y, 1);
    const far = spawn(w, "face", attacker.x + tiles(9), attacker.y, 1);
    const farHp = far.hp;
    applyCommand(w, 0, { c: "target", ids: [attacker.id], id: near.id });
    run(w, 60);
    expect(near.hp).toBeLessThan(unitHp("face", 0));
    expect(far.hp).toBe(farHp);
  });

  it("a 🙁 outranges a 🙂 by enough to stand behind one", () => {
    expect(unitRange("face", 0)).toBeLessThan(30 * FP);       // melee
    expect(unitRange("face", 2)).toBeGreaterThan(90 * FP);    // thrown
    expect(unitRange("face", maxLevel("face"))).toBeGreaterThan(unitRange("face", 2));
  });

  it("a maxed Smiley detonates on death, hurting enemies only", () => {
    const w = soloWorld();
    const home = find(w, "datacenter");
    const bomb = spawn(w, "face", home.x + tiles(8), home.y, 0, maxLevel("face"));
    const foe = spawn(w, "face", bomb.x + tiles(1), bomb.y, 1);
    const friend = spawn(w, "face", bomb.x - tiles(1), bomb.y, 0);
    const outside = spawn(w, "face", bomb.x + tiles(6), bomb.y, 1);
    const foeHp = foe.hp, friendHp = friend.hp, outsideHp = outside.hp;

    applyCommand(w, 0, { c: "detonate", ids: [bomb.id] });
    step(w, []);

    expect(w.byId.has(bomb.id), "the bomb dies").toBe(false);
    expect(foeHp - foe.hp).toBeGreaterThanOrEqual(BLAST_DAMAGE);
    expect(friend.hp, "no friendly fire").toBe(friendHp);
    expect(outside.hp, `outside ${BLAST_RADIUS}px`).toBe(outsideHp);
  });

  it("only a maxed Smiley can be detonated", () => {
    const w = soloWorld();
    const home = find(w, "datacenter");
    const calm = spawn(w, "face", home.x + tiles(8), home.y, 0, 0);
    applyCommand(w, 0, { c: "detonate", ids: [calm.id] });
    step(w, []);
    expect(w.byId.has(calm.id)).toBe(true);
  });

  it("foulings slow whoever crosses them, and a Janitor clears them", () => {
    const w = soloWorld();
    const home = find(w, "datacenter");
    const monkey = spawn(w, "monkey", home.x + tiles(6), home.y);
    const spot = { x: home.x + tiles(7), y: home.y };
    applyCommand(w, 0, { c: "dung", ids: [monkey.id], x: spot.x, y: spot.y });
    run(w, 300);
    const muck = w.entities.find((e) => e.kind === "dung");
    expect(muck, "a fouling was left").toBeTruthy();

    // Same unit, same distance: one crossing the mess, one on clean ground.
    const slowed = spawn(w, "face", muck!.x - tiles(0.4), muck!.y);
    const clear = spawn(w, "face", muck!.x - tiles(0.4), muck!.y + tiles(8));
    applyCommand(w, 0, { c: "move", ids: [slowed.id], x: muck!.x + tiles(2), y: muck!.y });
    applyCommand(w, 0, { c: "move", ids: [clear.id], x: muck!.x + tiles(2), y: muck!.y + tiles(8) });
    const from = [slowed.x, clear.x];
    run(w, 30);
    expect(slowed.x - from[0]!).toBeLessThan(clear.x - from[1]!);

    const janitor = spawn(w, "janitor", muck!.x - tiles(2), muck!.y);
    run(w, 400);
    expect(w.byId.has(muck!.id), "the Janitor scrubbed it").toBe(false);
    expect(janitor.hp).toBeGreaterThan(0);
  });
});

describe("pathing", () => {
  it("walks around a wall instead of grinding against it", () => {
    const w = soloWorld();
    const home = find(w, "datacenter");
    // A wall of Houses with one end open.
    for (let i = 0; i < 6; i++) {
      erect(w, "house", home.x + tiles(2 + i * 1.5), home.y + tiles(6));
    }
    const walker = spawn(w, "face", home.x + tiles(5), home.y + tiles(3));
    const goal = { x: home.x + tiles(5), y: home.y + tiles(9) };
    applyCommand(w, 0, { c: "move", ids: [walker.id], x: goal.x, y: goal.y });
    run(w, 1500);
    expect(dist(walker, goal), "arrived on the far side").toBeLessThan(40);
  });

  it("gives up rather than shoving forever at something unreachable", () => {
    const w = soloWorld();
    const home = find(w, "datacenter");
    const walker = spawn(w, "face", home.x + tiles(5), home.y + tiles(5));
    // Off the map corner: the flow field can never reach it.
    applyCommand(w, 0, { c: "move", ids: [walker.id], x: 0, y: 0 });
    run(w, 4000);
    expect(walker.order.kind).toBe("idle");
  });

  it("miners spread across deposits rather than stacking on the nearest", () => {
    const w = soloWorld();
    const crew = all(w, "engineer");
    const node = w.entities.find((e) => e.kind === "bitnode")!;
    for (const e of crew) applyCommand(w, 0, { c: "target", ids: [e.id], id: node.id });
    run(w, 2000);
    const targets = new Set(
      w.entities.filter((e) => e.kind === "engineer" && e.order.kind === "harvest")
        .map((e) => e.order.target));
    expect(targets.size, "not all on one pile").toBeGreaterThan(1);
  });
});
