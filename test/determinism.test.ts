import { describe, expect, it } from "vitest";
import { checksum, createWorld } from "../src/game/sim";
import { runAI } from "./helpers";

// The one invariant the whole peer-to-peer design rests on. If two identical
// worlds ever diverge, a live match silently becomes two different games.
describe("determinism", () => {
  for (const seed of [1, 12345, 4242, 31337]) {
    it(`two worlds on seed ${seed} stay bit-identical for 8000 ticks`, () => {
      const a = createWorld(seed);
      const b = createWorld(seed);
      runAI(a, 8000);
      runAI(b, 8000);
      expect(checksum(a)).toBe(checksum(b));
      expect(a.tick).toBe(b.tick);
    });
  }

  it("diverging seeds produce diverging worlds", () => {
    // Guards against a checksum so weak it would call anything equal.
    const a = createWorld(1);
    const b = createWorld(2);
    runAI(a, 2000);
    runAI(b, 2000);
    expect(checksum(a)).not.toBe(checksum(b));
  });

  it("uses no floating point in entity positions", () => {
    // Fractional coordinates are how non-determinism creeps in.
    const w = createWorld(99);
    runAI(w, 3000);
    for (const e of w.entities) {
      expect(Number.isInteger(e.x), `${e.kind} x=${e.x}`).toBe(true);
      expect(Number.isInteger(e.y), `${e.kind} y=${e.y}`).toBe(true);
      expect(Number.isInteger(e.hp), `${e.kind} hp=${e.hp}`).toBe(true);
    }
  });
});
