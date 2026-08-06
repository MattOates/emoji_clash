import { FP, MAP_TILES, STATS, TILE, type Command, type Entity, type Kind } from "./game/types";
import { canTrain, siteClear, trainableAt, type World } from "./game/sim";
import { createRunner, type Mode, type Runner } from "./lockstep";
import { createGuest, createHost, type Net } from "./net";
import { COLORS, Renderer, type Camera } from "./render";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const MAP_PX = MAP_TILES * TILE;

// ------------------------------------------------------------------- main menu

const status = $<HTMLDivElement>("status");
function setStatus(text: string, cls: "" | "err" | "ok" = "") {
  status.textContent = text;
  status.className = "status " + cls;
}
const stun = () => $<HTMLInputElement>("useStun").checked;

function showPane(which: "menu" | "host" | "join") {
  $("modeButtons").classList.toggle("hidden", which !== "menu");
  $("hostPane").classList.toggle("hidden", which !== "host");
  $("joinPane").classList.toggle("hidden", which !== "join");
  setStatus("");
}

$("btnPractice").onclick = () => start("practice", 0, (Math.random() * 2 ** 31) | 0);

$("btnHost").onclick = async () => {
  showPane("host");
  setStatus("Gathering connection candidates…");
  try {
    const session = await createHost(stun());
    $<HTMLTextAreaElement>("hostCode").value = session.code;
    setStatus("Send that code to your opponent, then paste their reply below.");
    $("hostStart").onclick = async () => {
      const answer = $<HTMLTextAreaElement>("hostAnswer").value.trim();
      if (!answer) return setStatus("Paste the join code first.", "err");
      try {
        setStatus("Connecting…");
        await session.accept(answer);
        const net = await session.ready;
        const seed = (Math.random() * 2 ** 31) | 0;
        net.send({ t: "start", seed });
        start("peer", 0, seed, net);
      } catch (err) {
        setStatus("Could not connect: " + (err as Error).message, "err");
      }
    };
  } catch (err) {
    setStatus("Failed to create a host code: " + (err as Error).message, "err");
  }
};

$("btnJoin").onclick = () => showPane("join");

$("joinGo").onclick = async () => {
  const offer = $<HTMLTextAreaElement>("joinOffer").value.trim();
  if (!offer) return setStatus("Paste the host code first.", "err");
  try {
    setStatus("Building your join code…");
    const guest = await createGuest(offer, stun());
    $<HTMLTextAreaElement>("joinCode").value = guest.code;
    setStatus("Send that back to the host. The match starts as soon as they connect.", "ok");
    const net = await guest.ready;
    setStatus("Connected — waiting for the host to start…", "ok");
    net.onMessage = (msg) => {
      if (msg.t === "start") start("peer", 1, msg.seed, net);
    };
  } catch (err) {
    setStatus("That code did not parse: " + (err as Error).message, "err");
  }
};

$("hostBack").onclick = () => showPane("menu");
$("joinBack").onclick = () => showPane("menu");
$("copyHost").onclick = () => copy($<HTMLTextAreaElement>("hostCode").value, "Host code copied.");
$("copyJoin").onclick = () => copy($<HTMLTextAreaElement>("joinCode").value, "Join code copied.");

function copy(text: string, msg: string) {
  navigator.clipboard.writeText(text).then(
    () => setStatus(msg, "ok"),
    () => setStatus("Clipboard blocked — select the text and copy manually.", "err"),
  );
}

// ------------------------------------------------------------------- game setup

const canvas = $<HTMLCanvasElement>("game");
let runner: Runner | null = null;
let renderer: Renderer;
const cam: Camera = { x: 0, y: 0, zoom: 1 };
const selection = new Set<number>();
const groups = new Map<number, number[]>();
let placing: Kind | null = null;
let attackMoveArmed = false;
let hover: Entity | undefined;
let drag: { x0: number; y0: number; x1: number; y1: number; moved: boolean } | null = null;
let panning: { x: number; y: number } | null = null;
let minimapDrag = false;
const keys = new Set<string>();
let lastClick = { t: 0, id: 0 };

function start(mode: Mode, me: number, seed: number, net?: Net) {
  $("menu").classList.add("hidden");
  $("hud").classList.remove("hidden");
  renderer = new Renderer(canvas, seed);
  runner = createRunner(net ? { mode, me, seed, net } : { mode, me, seed });
  $("netinfo").textContent = mode === "practice" ? "practice vs AI" : me === 0 ? "peer · host" : "peer · guest";
  if (net) {
    net.onClose = () => {
      if (runner && runner.world.winner < 0) finish("DISCONNECTED", "The peer connection dropped.");
    };
  }
  lastSim = performance.now();
  (window as any).rts = { get runner() { return runner; }, cam, selection };
  const home = runner.world.entities.find((e) => e.owner === me && e.kind === "base");
  if (home) centerOn(home.x / FP, home.y / FP);
  toast(mode === "practice" ? "Practice match — build workers, then an army." : "Connected. Good luck.");
  requestAnimationFrame(frame);
}

function centerOn(x: number, y: number) {
  cam.x = x - canvas.clientWidth / cam.zoom / 2;
  cam.y = y - canvas.clientHeight / cam.zoom / 2;
  clampCam();
}

function clampCam() {
  const vw = canvas.clientWidth / cam.zoom, vh = canvas.clientHeight / cam.zoom;
  cam.x = Math.max(-40, Math.min(MAP_PX - vw + 40, cam.x));
  cam.y = Math.max(-40, Math.min(MAP_PX - vh + 40, cam.y));
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  clampCam();
}
window.addEventListener("resize", resize);
resize();

// ---------------------------------------------------------------------- helpers

const screenToWorld = (sx: number, sy: number) => ({
  x: Math.round((sx / cam.zoom + cam.x) * FP),
  y: Math.round((sy / cam.zoom + cam.y) * FP),
});

function pick(world: World, wx: number, wy: number): Entity | undefined {
  let best: Entity | undefined, bestD = Infinity;
  for (const e of world.entities) {
    const r = STATS[e.kind].radius + 4 * FP;
    const dx = e.x - wx, dy = e.y - wy, d2 = dx * dx + dy * dy;
    if (d2 > r * r || d2 >= bestD) continue;
    if (e.owner !== runner!.me && !renderer.isVisible(e.x, e.y)) continue;
    bestD = d2; best = e;
  }
  return best;
}

function issue(cmd: Command) { runner!.issue(cmd); }
const selected = () => [...selection].map((id) => runner!.world.byId.get(id)).filter((e): e is Entity => !!e);
const selectedUnits = () => selected().filter((e) => !STATS[e.kind].building);

function toast(text: string) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function inMinimap(sx: number, sy: number) {
  const m = renderer.minimap;
  return sx >= m.x && sy >= m.y && sx <= m.x + m.size && sy <= m.y + m.size;
}

function minimapJump(sx: number, sy: number) {
  const m = renderer.minimap;
  centerOn(((sx - m.x) / m.size) * MAP_PX, ((sy - m.y) / m.size) * MAP_PX);
}

// ------------------------------------------------------------------------ input

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("pointerdown", (ev) => {
  if (!runner) return;
  canvas.setPointerCapture(ev.pointerId);
  const sx = ev.clientX, sy = ev.clientY;

  if (ev.button === 1) { panning = { x: sx, y: sy }; return; }

  if (inMinimap(sx, sy)) {
    if (ev.button === 0) { minimapDrag = true; minimapJump(sx, sy); }
    else {
      const m = renderer.minimap;
      order(Math.round(((sx - m.x) / m.size) * MAP_PX * FP), Math.round(((sy - m.y) / m.size) * MAP_PX * FP), undefined);
    }
    return;
  }

  const w = screenToWorld(sx, sy);

  if (ev.button === 2) {
    if (placing) { placing = null; return; }
    attackMoveArmed = false;
    order(w.x, w.y, pick(runner.world, w.x, w.y));
    return;
  }

  if (ev.button !== 0) return;

  if (placing) {
    const workers = selectedUnits().filter((e) => e.kind === "worker");
    if (!workers.length) { placing = null; return; }
    if (!siteClear(runner.world, w.x, w.y, STATS[placing].radius)) { toast("Blocked — pick clearer ground."); return; }
    issue({ c: "build", ids: workers.map((e) => e.id), kind: placing, x: w.x, y: w.y });
    if (!ev.shiftKey) placing = null;
    return;
  }

  if (attackMoveArmed) {
    const ids = selectedUnits().map((e) => e.id);
    if (ids.length) issue({ c: "attackMove", ids, x: w.x, y: w.y });
    attackMoveArmed = false;
    return;
  }

  drag = { x0: sx, y0: sy, x1: sx, y1: sy, moved: false };
});

canvas.addEventListener("pointermove", (ev) => {
  if (!runner) return;
  const sx = ev.clientX, sy = ev.clientY;
  if (panning) {
    cam.x -= (sx - panning.x) / cam.zoom;
    cam.y -= (sy - panning.y) / cam.zoom;
    panning = { x: sx, y: sy };
    clampCam();
    return;
  }
  if (minimapDrag) { minimapJump(sx, sy); return; }
  const w = screenToWorld(sx, sy);
  hover = pick(runner.world, w.x, w.y);
  if (drag) {
    drag.x1 = sx; drag.y1 = sy;
    if (Math.abs(drag.x1 - drag.x0) + Math.abs(drag.y1 - drag.y0) > 5) drag.moved = true;
  }
  canvas.style.cursor = placing || attackMoveArmed ? "cell"
    : hover && hover.owner >= 0 && hover.owner !== runner.me ? "not-allowed" : "crosshair";
});

canvas.addEventListener("pointerup", (ev) => {
  if (!runner) return;
  panning = null;
  minimapDrag = false;
  if (!drag) return;
  const box = drag;
  drag = null;
  if (!ev.shiftKey) selection.clear();

  if (box.moved) {
    const a = screenToWorld(Math.min(box.x0, box.x1), Math.min(box.y0, box.y1));
    const b = screenToWorld(Math.max(box.x0, box.x1), Math.max(box.y0, box.y1));
    const hits = runner.world.entities.filter(
      (e) => e.owner === runner!.me && !STATS[e.kind].building &&
        e.x >= a.x && e.x <= b.x && e.y >= a.y && e.y <= b.y);
    for (const e of hits) selection.add(e.id);
    if (!hits.length) {
      // Nothing mobile in the box — fall back to buildings inside it.
      for (const e of runner.world.entities)
        if (e.owner === runner.me && e.x >= a.x && e.x <= b.x && e.y >= a.y && e.y <= b.y) selection.add(e.id);
    }
  } else {
    const w = screenToWorld(box.x0, box.y0);
    const e = pick(runner.world, w.x, w.y);
    if (e && e.owner === runner.me) {
      const now = performance.now();
      const dbl = now - lastClick.t < 320 && lastClick.id === e.id;
      lastClick = { t: now, id: e.id };
      if (dbl && !STATS[e.kind].building) {
        // Double click grabs every visible unit of the same type.
        for (const o of runner.world.entities)
          if (o.owner === runner.me && o.kind === e.kind && onScreen(o)) selection.add(o.id);
      } else selection.add(e.id);
    } else if (e) selection.add(e.id);
  }
  syncCard();
});

function onScreen(e: Entity) {
  const x = e.x / FP - cam.x, y = e.y / FP - cam.y;
  return x >= 0 && y >= 0 && x <= canvas.clientWidth / cam.zoom && y <= canvas.clientHeight / cam.zoom;
}

canvas.addEventListener(
  "wheel",
  (ev) => {
    ev.preventDefault();
    const before = screenToWorld(ev.clientX, ev.clientY);
    cam.zoom = Math.max(0.35, Math.min(2.2, cam.zoom * (ev.deltaY > 0 ? 0.9 : 1.1)));
    const after = screenToWorld(ev.clientX, ev.clientY);
    cam.x += (before.x - after.x) / FP;
    cam.y += (before.y - after.y) / FP;
    clampCam();
  },
  { passive: false },
);

/** Turn a right-click into whichever order makes sense for what is under it. */
function order(wx: number, wy: number, target: Entity | undefined) {
  const units = selectedUnits();
  const buildings = selected().filter((e) => STATS[e.kind].building);
  if (buildings.length && !units.length) {
    issue({ c: "rally", ids: buildings.map((e) => e.id), x: wx, y: wy });
    toast("Rally point set.");
    return;
  }
  if (!units.length) return;
  const ids = units.map((e) => e.id);
  if (target && (target.owner !== runner!.me || target.kind === "crystal" || !target.complete)) {
    issue({ c: "target", ids, id: target.id });
  } else if (target && target.kind === "base" && units.some((u) => u.cargo > 0)) {
    issue({ c: "target", ids, id: target.id });
  } else {
    issue({ c: "move", ids, x: wx, y: wy });
  }
}

window.addEventListener("keydown", (ev) => {
  if (!runner || (ev.target as HTMLElement)?.tagName === "TEXTAREA") return;
  const k = ev.key.toLowerCase();
  keys.add(k);

  if (ev.key === "Escape") { placing = null; attackMoveArmed = false; selection.clear(); syncCard(); return; }
  if (ev.key === "F1") { ev.preventDefault(); toast("LMB drag select · RMB order · A attack-move · B base · R barracks · W/S/A train · Ctrl+1-9 group · Space home"); return; }
  if (k === " ") {
    const home = runner.world.entities.find((e) => e.owner === runner!.me && e.kind === "base");
    if (home) centerOn(home.x / FP, home.y / FP);
    ev.preventDefault();
    return;
  }

  if (/^[0-9]$/.test(ev.key)) {
    const n = Number(ev.key);
    if (ev.ctrlKey || ev.metaKey) {
      groups.set(n, [...selection]);
      toast(`Group ${n} set (${selection.size}).`);
    } else {
      const g = groups.get(n);
      if (g) {
        selection.clear();
        for (const id of g) if (runner.world.byId.has(id)) selection.add(id);
        syncCard();
        const first = selected()[0];
        if (first) centerOn(first.x / FP, first.y / FP);
      }
    }
    return;
  }

  // Training hotkeys act on selected production buildings first.
  const producers = selected().filter((e) => STATS[e.kind].building && e.complete);
  const byHotkey = (Object.keys(STATS) as Kind[]).find((kind) => STATS[kind].hotkey.toLowerCase() === k);
  if (byHotkey && producers.some((b) => canTrain(b.kind, byHotkey))) {
    tryTrain(producers.filter((b) => canTrain(b.kind, byHotkey)), byHotkey);
    return;
  }

  if (k === "a" && selectedUnits().length) { attackMoveArmed = true; placing = null; return; }
  if ((k === "b" || k === "r") && selectedUnits().some((e) => e.kind === "worker")) {
    placing = k === "b" ? "base" : "barracks";
    attackMoveArmed = false;
    return;
  }
  if (k === "s") { const ids = selectedUnits().map((e) => e.id); if (ids.length) issue({ c: "stop", ids }); }
});
window.addEventListener("keyup", (ev) => keys.delete(ev.key.toLowerCase()));

function tryTrain(buildings: Entity[], kind: Kind) {
  const pl = runner!.world.players[runner!.me]!;
  if (pl.crystals < STATS[kind].cost) { toast("Not enough crystals."); return; }
  if (pl.supply >= pl.supplyCap) { toast("Supply capped — build another base or barracks."); return; }
  // Prefer the shortest queue so clicks spread across production.
  const target = [...buildings].sort((a, b) => a.queue.length - b.queue.length)[0]!;
  issue({ c: "train", ids: [target.id], kind });
}

// --------------------------------------------------------------------- HUD card

let cardKey = "";
function syncCard() {
  const sel = selected();
  const card = $("card");
  if (!sel.length) { card.classList.add("hidden"); cardKey = ""; return; }
  card.classList.remove("hidden");

  const kinds = new Set(sel.map((e) => e.kind));
  const key = sel.length + "|" + [...kinds].sort().join(",");
  const title = sel.length === 1 ? STATS[sel[0]!.kind].label : `${sel.length} selected`;
  $("cardTitle").textContent = title;

  if (key === cardKey) return;
  cardKey = key;

  const actions = $("cardActions");
  actions.innerHTML = "";
  const add = (label: string, sub: string, fn: () => void) => {
    const b = document.createElement("button");
    b.innerHTML = `<b>${label}</b><small>${sub}</small>`;
    b.onclick = () => { fn(); canvas.focus(); };
    actions.appendChild(b);
  };

  const producers = sel.filter((e) => STATS[e.kind].building && e.complete);
  const trained = new Set<Kind>();
  for (const b of producers) for (const u of trainableAt(b.kind)) trained.add(u);
  for (const u of trained) {
    add(`${STATS[u].label} [${STATS[u].hotkey}]`, `${STATS[u].cost}◆`,
      () => tryTrain(producers.filter((b) => canTrain(b.kind, u)), u));
  }
  if (producers.some((b) => b.queue.length)) {
    add("Cancel", "refund last", () => issue({ c: "cancel", ids: producers.map((b) => b.id) }));
  }

  if (sel.some((e) => e.kind === "worker")) {
    add("Base [B]", `${STATS.base.cost}◆`, () => (placing = "base"));
    add("Barracks [R]", `${STATS.barracks.cost}◆`, () => (placing = "barracks"));
  }
  if (sel.some((e) => !STATS[e.kind].building)) {
    add("Attack [A]", "move & engage", () => (attackMoveArmed = true));
    add("Stop [S]", "hold position", () => issue({ c: "stop", ids: selectedUnits().map((e) => e.id) }));
  }
}

function syncCardMeta() {
  const sel = selected();
  if (!sel.length) return;
  if (sel.length === 1) {
    const e = sel[0]!;
    const bits = [`${Math.max(0, e.hp)}/${e.maxHp} hp`];
    if (e.kind === "crystal") bits.push(`${e.amount} left`);
    if (e.cargo) bits.push(`carrying ${e.cargo}◆`);
    if (e.queue.length) bits.push(`queue ${e.queue.length} · ${Math.ceil(e.queueLeft / 20)}s`);
    if (!e.complete) bits.push("under construction");
    bits.push(e.order.kind);
    $("cardMeta").textContent = bits.join(" · ");
  } else {
    const hp = sel.reduce((a, e) => a + Math.max(0, e.hp), 0);
    const max = sel.reduce((a, e) => a + e.maxHp, 0);
    $("cardMeta").textContent = `${hp}/${max} hp total`;
  }
}

function finish(title: string, text: string) {
  $("overTitle").textContent = title;
  $("overTitle").style.color = title === "VICTORY" ? "#6ee7a0" : "#ff6b5e";
  $("overText").textContent = text;
  $("over").classList.remove("hidden");
}

// ------------------------------------------------------------------- frame loop

// The simulation runs off a timer rather than the render loop. rAF stops in a
// hidden tab, and in a peer match that would freeze the opponent too.
let lastSim = performance.now();
let alpha = 0;
setInterval(() => {
  if (!runner) return;
  const now = performance.now();
  const dt = now - lastSim;
  lastSim = now;
  alpha = runner.update(dt);
  renderer.addEvents(runner.world.events);
}, 20);

let last = performance.now();
function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(100, now - last);
  last = now;
  if (!runner) return;

  // Keyboard panning.
  const pan = (600 / cam.zoom) * (dt / 1000);
  if (keys.has("arrowleft")) cam.x -= pan;
  if (keys.has("arrowright")) cam.x += pan;
  if (keys.has("arrowup")) cam.y -= pan;
  if (keys.has("arrowdown")) cam.y += pan;
  clampCam();

  // Drop dead entities from the selection.
  for (const id of [...selection]) if (!runner.world.byId.has(id)) selection.delete(id);

  const world = runner.world;
  const me = runner.me;
  const ghost = placing
    ? (() => {
        const p = hoverWorld ?? { x: 0, y: 0 };
        return { kind: placing!, x: p.x, y: p.y, ok: siteClear(world, p.x, p.y, STATS[placing!].radius) };
      })()
    : null;

  renderer.draw(world, cam, me, alpha, selection, hover, ghost, drag?.moved ? drag : null);

  const pl = world.players[me]!;
  $("crystals").textContent = String(pl.crystals);
  $("supply").textContent = `${pl.supply}/${pl.supplyCap}`;
  $("netinfo").textContent =
    runner.mode === "practice"
      ? "practice vs AI"
      : `${me === 0 ? "host" : "guest"} · ${runner.rtt}ms · t${world.tick}`;
  const warn = runner.desync
    ? "DESYNC DETECTED"
    : runner.stalledMs > 400
      ? `waiting for opponent (${(runner.stalledMs / 1000).toFixed(1)}s)`
      : "";
  $("warn").textContent = warn;
  syncCard();
  syncCardMeta();

  if (world.winner >= 0 && $("over").classList.contains("hidden")) {
    if (world.winner === me) finish("VICTORY", "Every enemy structure and unit destroyed.");
    else if (world.winner === 2) finish("DRAW", "Both forces were wiped out.");
    else finish("DEFEAT", `${COLORS[world.winner]!.body === COLORS[0]!.body ? "Blue" : "Orange"} took the field.`);
  }
}

let hoverWorld: { x: number; y: number } | null = null;
canvas.addEventListener("pointermove", (ev) => {
  hoverWorld = screenToWorld(ev.clientX, ev.clientY);
});
