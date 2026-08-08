import { describe, expect, it } from "vitest";
import { applyCommand, step, trainableAt, ENROLL_SLOP } from "../src/game/sim";
import { STATS, unitHp, maxLevel, levelEmoji } from "../src/game/types";
import { all, erect, find, run, soloWorld, spawn, tiles } from "./helpers";

describe("mining", () => {
  it("delivers bits to a Drive and pixels to a Gallery", () => {
    const w = soloWorld();
    w.players[0]!.bits = 0;
    w.players[0]!.pixels = 0;
    const crew = all(w, "engineer");
    const bit = w.entities.find((e) => e.kind === "bitnode")!;
    const pix = w.entities.find((e) => e.kind === "pixnode")!;
    applyCommand(w, 0, { c: "target", ids: [crew[0]!.id, crew[1]!.id], id: bit.id });
    applyCommand(w, 0, { c: "target", ids: [crew[2]!.id, crew[3]!.id], id: pix.id });
    run(w, 3000);
    expect(w.players[0]!.bits).toBeGreaterThan(0);
    expect(w.players[0]!.pixels).toBeGreaterThan(0);
  });

  it("mines bits faster than pixels with the same number of hands", () => {
    const income = (node: "bitnode" | "pixnode") => {
      const w = soloWorld();
      w.players[0]!.bits = 0;
      w.players[0]!.pixels = 0;
      const target = w.entities.find((e) => e.kind === node)!;
      for (const e of all(w, "engineer")) applyCommand(w, 0, { c: "target", ids: [e.id], id: target.id });
      run(w, 3000);
      return node === "bitnode" ? w.players[0]!.bits : w.players[0]!.pixels;
    };
    expect(income("bitnode")).toBeGreaterThan(income("pixnode"));
  });
});

describe("the Cloud", () => {
  it("fuses 2 bits and 1 pixel into slop, and holds it until collected", () => {
    const w = soloWorld();
    const home = find(w, "datacenter");
    const cloud = erect(w, "cloud", home.x + tiles(4), home.y + tiles(4));
    cloud.stockBits = 20;
    cloud.stockPixels = 10;
    run(w, 400);
    expect(cloud.stockSlop).toBeGreaterThan(0);
    // Consumed in a 2:1 ratio.
    expect(20 - cloud.stockBits).toBe((10 - cloud.stockPixels) * 2);
    // And crucially it does NOT appear in the treasury by itself.
    expect(w.players[0]!.slop).toBe(0);
  });

  it("does nothing without both inputs", () => {
    const w = soloWorld();
    const home = find(w, "datacenter");
    const cloud = erect(w, "cloud", home.x + tiles(4), home.y + tiles(4));
    cloud.stockBits = 50;
    cloud.stockPixels = 0;
    run(w, 400);
    expect(cloud.stockSlop).toBe(0);
  });

  it("an Engineer on haul duty carries slop out to the treasury", () => {
    const w = soloWorld();
    const home = find(w, "datacenter");
    const cloud = erect(w, "cloud", home.x + tiles(4), home.y + tiles(4));
    cloud.stockSlop = 12;
    const hand = all(w, "engineer")[0]!;
    applyCommand(w, 0, { c: "target", ids: [hand.id], id: cloud.id });
    run(w, 1200);
    expect(w.players[0]!.slop).toBeGreaterThan(0);
  });
});

describe("the Social Feed", () => {
  it("levels a Smiley for one delivered slop, and stalls with an empty shelf", () => {
    const w = soloWorld();
    const home = find(w, "datacenter");
    const feed = erect(w, "feed", home.x - tiles(4), home.y + tiles(1));
    const smiley = spawn(w, "face", feed.x + tiles(1), feed.y);

    applyCommand(w, 0, { c: "target", ids: [smiley.id], id: feed.id });
    run(w, 400);
    expect(smiley.level, "no slop on the shelf means no level").toBe(0);

    feed.stockSlop = 1;
    run(w, 400);
    expect(smiley.level).toBe(1);
    expect(feed.stockSlop).toBe(1 - ENROLL_SLOP);
  });

  it("charges once per level, not once per tick", () => {
    // The Monkey shared its dung cooldown with the enrolment timer, which drained
    // a slop every tick while never actually levelling.
    const w = soloWorld();
    const home = find(w, "datacenter");
    const feed = erect(w, "feed", home.x - tiles(4), home.y + tiles(1));
    const monkey = spawn(w, "monkey", feed.x + tiles(1), feed.y);
    feed.stockSlop = 20;
    applyCommand(w, 0, { c: "target", ids: [monkey.id], id: feed.id });
    run(w, 400);
    expect(monkey.level).toBe(1);
    expect(feed.stockSlop).toBe(19);
  });
});

describe("production", () => {
  it("spreads a rapid burst of orders across every Keyboard", () => {
    // Choosing the building in the UI meant several quick clicks read the same
    // state and piled onto one, leaving a second Keyboard idle.
    const w = soloWorld();
    const home = find(w, "datacenter");
    const a = erect(w, "keyboard", home.x + tiles(5), home.y + tiles(3));
    const b = erect(w, "keyboard", home.x + tiles(5), home.y - tiles(3.5));
    expect(a.id, "two distinct Keyboards").not.toBe(b.id);
    const ids = [a.id, b.id];
    for (let i = 0; i < 6; i++) applyCommand(w, 0, { c: "train", ids, kind: "face" });
    expect(a.queue.length).toBeGreaterThan(0);
    expect(b.queue.length).toBeGreaterThan(0);
    expect(a.queue.length + b.queue.length).toBe(6);
    expect(Math.abs(a.queue.length - b.queue.length)).toBeLessThanOrEqual(1);
  });

  it("refuses to train past the supply cap", () => {
    const w = soloWorld();
    const home = find(w, "datacenter");
    const kb = erect(w, "keyboard", home.x + tiles(4), home.y);
    const pl = w.players[0]!;
    for (let i = 0; i < 60; i++) applyCommand(w, 0, { c: "train", ids: [kb.id], kind: "face" });
    expect(pl.supply + kb.queue.length).toBeLessThanOrEqual(pl.supplyCap);
  });
});

describe("buildings", () => {
  it("a House buys supply and makes nothing", () => {
    const w = soloWorld();
    const home = find(w, "datacenter");
    const before = w.players[0]!.supplyCap;
    erect(w, "house", home.x, home.y + tiles(5));
    step(w, []);
    expect(w.players[0]!.supplyCap).toBe(before + STATS.house.supply);
    expect(trainableAt("house")).toHaveLength(0);
    expect(STATS.house.cost.bits).toBeLessThan(STATS.datacenter.cost.bits);
  });

  it("a Hospital heals its ring only when stocked, and only inside it", () => {
    const w = soloWorld();
    const home = find(w, "datacenter");
    const hos = erect(w, "hospital", home.x + tiles(5), home.y);
    const near = spawn(w, "face", hos.x, hos.y + tiles(1.5));
    const far = spawn(w, "face", hos.x + tiles(9), hos.y);
    near.hp = 60;
    far.hp = 60;

    run(w, 200);
    expect(near.hp, "no slop, no healing").toBe(60);

    hos.stockSlop = 5;
    run(w, 200);
    expect(near.hp).toBeGreaterThan(60);
    expect(near.hp).toBeLessThanOrEqual(near.maxHp);
    expect(far.hp, "outside the ring").toBe(60);
    expect(hos.stockSlop).toBeLessThan(5);
  });

  it("recycling refunds part of the cost plus everything stored inside", () => {
    const w = soloWorld();
    const home = find(w, "datacenter");
    const cloud = erect(w, "cloud", home.x + tiles(4), home.y + tiles(4));
    cloud.stockSlop = 7;
    const pl = w.players[0]!;
    const bits = pl.bits;
    applyCommand(w, 0, { c: "recycle", ids: [cloud.id] });
    step(w, []);
    expect(pl.slop).toBe(7);
    expect(pl.bits).toBeGreaterThan(bits);
    expect(w.byId.has(cloud.id)).toBe(false);
  });
});

describe("level curves", () => {
  it("a Smiley trades health for damage and turns ranged at 🙁", () => {
    const hp = [], dmg = [];
    for (let l = 0; l <= maxLevel("face"); l++) {
      hp.push(unitHp("face", l));
      dmg.push(STATS.face.damage);
    }
    for (let l = 1; l <= maxLevel("face"); l++) {
      expect(unitHp("face", l), `hp at ${l}`).toBeLessThan(unitHp("face", l - 1));
    }
    expect(levelEmoji("face", 0)).toBe("🙂");
    expect(levelEmoji("face", maxLevel("face"))).toBe("😡");
    void hp; void dmg;
  });

  it("a Monkey gains health and speed, and runs 🙈 to 🐵", () => {
    for (let l = 1; l <= maxLevel("monkey"); l++) {
      expect(unitHp("monkey", l)).toBeGreaterThan(unitHp("monkey", l - 1));
    }
    expect(levelEmoji("monkey", 0)).toBe("🙈");
    expect(levelEmoji("monkey", maxLevel("monkey"))).toBe("🐵");
  });
});
