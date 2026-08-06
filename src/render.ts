import { FP, MAP_TILES, TILE, STATS as S, type Entity, type Kind } from "./game/types";
import type { World } from "./game/sim";

export interface Camera { x: number; y: number; zoom: number }

const MAP_PX = MAP_TILES * TILE;

export const COLORS = [
  { body: "#57c9ff", dark: "#155e7d", glow: "rgba(87,201,255,0.35)" },
  { body: "#ff8a5c", dark: "#7d3415", glow: "rgba(255,138,92,0.35)" },
];
const NEUTRAL = { body: "#c58bff", dark: "#4a2a70", glow: "rgba(197,139,255,0.3)" };

interface Puff { x: number; y: number; life: number; max: number; kind: string }

export class Renderer {
  private terrain: HTMLCanvasElement;
  private fogCanvas: HTMLCanvasElement;
  private explored = new Uint8Array(MAP_TILES * MAP_TILES);
  private visible = new Uint8Array(MAP_TILES * MAP_TILES);
  private puffs: Puff[] = [];
  minimap = { x: 0, y: 0, size: 190 };

  constructor(private canvas: HTMLCanvasElement, seed: number) {
    this.terrain = buildTerrain(seed);
    this.fogCanvas = document.createElement("canvas");
    this.fogCanvas.width = this.fogCanvas.height = MAP_TILES;
  }

  addEvents(events: { x: number; y: number; kind: string }[]) {
    for (const e of events) {
      const max = e.kind === "death" ? 26 : e.kind === "built" ? 30 : 12;
      this.puffs.push({ x: e.x / FP, y: e.y / FP, life: max, max, kind: e.kind });
    }
    if (this.puffs.length > 400) this.puffs.splice(0, this.puffs.length - 400);
  }

  draw(world: World, cam: Camera, me: number, alpha: number, sel: Set<number>, hover: Entity | undefined,
       placing: { kind: Kind; x: number; y: number; ok: boolean } | null,
       dragBox: { x0: number; y0: number; x1: number; y1: number } | null) {
    const ctx = this.canvas.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr, h = this.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = "#05080d";
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(-cam.x * cam.zoom, -cam.y * cam.zoom);
    ctx.scale(cam.zoom, cam.zoom);

    ctx.drawImage(this.terrain, 0, 0);
    this.gridOverlay(ctx, cam, w, h);

    const lerp = (a: number, b: number) => (a + (b - a) * alpha) / FP;

    // Shadows under everything, then bodies.
    for (const e of world.entities) {
      const x = lerp(e.px, e.x), y = lerp(e.py, e.y), r = S[e.kind].radius / FP;
      ctx.fillStyle = "rgba(0,0,0,0.32)";
      ctx.beginPath();
      ctx.ellipse(x + 2, y + r * 0.55, r * 0.95, r * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const e of world.entities) {
      const x = lerp(e.px, e.x), y = lerp(e.py, e.y);
      if (sel.has(e.id)) this.selectionRing(ctx, e, x, y);
      this.entity(ctx, e, x, y, me);
      if (hover?.id === e.id && !sel.has(e.id)) {
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.lineWidth = 1.5 / cam.zoom;
        ctx.beginPath();
        ctx.arc(x, y, S[e.kind].radius / FP + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Order lines for the current selection.
    ctx.lineWidth = 1.2 / cam.zoom;
    for (const id of sel) {
      const e = world.byId.get(id);
      if (!e || e.order.kind === "idle") continue;
      const o = e.order;
      const t = o.target ? world.byId.get(o.target) : undefined;
      const tx = (t ? t.x : o.x) / FP, ty = (t ? t.y : o.y) / FP;
      ctx.strokeStyle = o.kind === "attack" || o.kind === "attackMove"
        ? "rgba(255,110,90,0.55)"
        : o.kind === "harvest" || o.kind === "returnCargo" ? "rgba(197,139,255,0.5)" : "rgba(255,255,255,0.35)";
      ctx.setLineDash([5 / cam.zoom, 5 / cam.zoom]);
      ctx.beginPath();
      ctx.moveTo(e.x / FP, e.y / FP);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    this.effects(ctx, cam);

    if (placing) {
      const r = S[placing.kind].radius / FP;
      ctx.fillStyle = placing.ok ? "rgba(120,255,170,0.18)" : "rgba(255,90,90,0.2)";
      ctx.strokeStyle = placing.ok ? "rgba(120,255,170,0.8)" : "rgba(255,90,90,0.85)";
      ctx.lineWidth = 2 / cam.zoom;
      ctx.beginPath();
      ctx.rect(placing.x / FP - r, placing.y / FP - r, r * 2, r * 2);
      ctx.fill();
      ctx.stroke();
    }

    this.fog(ctx, world, me, cam);
    ctx.restore();

    if (dragBox) {
      const x = Math.min(dragBox.x0, dragBox.x1), y = Math.min(dragBox.y0, dragBox.y1);
      const bw = Math.abs(dragBox.x1 - dragBox.x0), bh = Math.abs(dragBox.y1 - dragBox.y0);
      ctx.fillStyle = "rgba(120,220,255,0.12)";
      ctx.strokeStyle = "rgba(150,235,255,0.9)";
      ctx.lineWidth = 1;
      ctx.fillRect(x, y, bw, bh);
      ctx.strokeRect(x + 0.5, y + 0.5, bw, bh);
    }

    this.drawMinimap(ctx, world, cam, me, w, h);
  }

  private gridOverlay(ctx: CanvasRenderingContext2D, cam: Camera, w: number, h: number) {
    if (cam.zoom < 0.55) return;
    const x0 = Math.max(0, Math.floor(cam.x / TILE) * TILE);
    const y0 = Math.max(0, Math.floor(cam.y / TILE) * TILE);
    const x1 = Math.min(MAP_PX, cam.x + w / cam.zoom);
    const y1 = Math.min(MAP_PX, cam.y + h / cam.zoom);
    ctx.strokeStyle = "rgba(255,255,255,0.035)";
    ctx.lineWidth = 1 / cam.zoom;
    ctx.beginPath();
    for (let x = x0; x <= x1; x += TILE) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    for (let y = y0; y <= y1; y += TILE) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    ctx.stroke();
  }

  private selectionRing(ctx: CanvasRenderingContext2D, e: Entity, x: number, y: number) {
    const r = S[e.kind].radius / FP + 5;
    ctx.strokeStyle = "rgba(150,255,190,0.95)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(x, y + r * 0.25, r, r * 0.62, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  private entity(ctx: CanvasRenderingContext2D, e: Entity, x: number, y: number, me: number) {
    const c = e.owner < 0 ? NEUTRAL : COLORS[e.owner]!;
    const r = S[e.kind].radius / FP;
    ctx.save();
    ctx.translate(x, y);

    if (e.flash > 0) { ctx.shadowColor = "#fff"; ctx.shadowBlur = 12; }

    switch (e.kind) {
      case "crystal": {
        ctx.fillStyle = c.body;
        ctx.strokeStyle = c.dark;
        ctx.lineWidth = 2;
        const n = 3 + (e.id % 3);
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + e.id;
          const ox = Math.cos(a) * r * 0.4, oy = Math.sin(a) * r * 0.3;
          const hgt = r * (0.9 + ((e.id + i) % 3) * 0.25) * (e.amount > 400 ? 1 : 0.6);
          ctx.beginPath();
          ctx.moveTo(ox, oy - hgt);
          ctx.lineTo(ox + r * 0.28, oy);
          ctx.lineTo(ox, oy + r * 0.22);
          ctx.lineTo(ox - r * 0.28, oy);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
        break;
      }
      case "base":
      case "barracks": {
        const alpha = e.complete ? 1 : 0.45;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = c.dark;
        roundRect(ctx, -r, -r, r * 2, r * 2, 6);
        ctx.fill();
        ctx.fillStyle = c.body;
        roundRect(ctx, -r * 0.72, -r * 0.72, r * 1.44, r * 1.44, 4);
        ctx.fill();
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        if (e.kind === "base") {
          ctx.beginPath(); ctx.arc(0, 0, r * 0.34, 0, Math.PI * 2); ctx.fill();
        } else {
          ctx.fillRect(-r * 0.5, -r * 0.16, r, r * 0.32);
        }
        ctx.globalAlpha = 1;
        if (!e.complete) {
          const p = e.progress / S[e.kind].buildTime;
          ctx.strokeStyle = "rgba(255,255,255,0.85)";
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(0, 0, r + 6, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
          ctx.stroke();
        }
        break;
      }
      case "archer": {
        ctx.fillStyle = c.body; ctx.strokeStyle = c.dark; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, -r); ctx.lineTo(r * 0.92, r * 0.75); ctx.lineTo(-r * 0.92, r * 0.75);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        break;
      }
      case "soldier": {
        ctx.fillStyle = c.body; ctx.strokeStyle = c.dark; ctx.lineWidth = 2;
        roundRect(ctx, -r * 0.82, -r * 0.82, r * 1.64, r * 1.64, 3);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = c.dark;
        ctx.fillRect(-r * 0.2, -r * 0.55, r * 0.4, r * 1.1);
        break;
      }
      default: { // worker
        ctx.fillStyle = c.body; ctx.strokeStyle = c.dark; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        if (e.cargo > 0) {
          ctx.fillStyle = NEUTRAL.body;
          ctx.beginPath(); ctx.arc(0, -r - 3, 3.2, 0, Math.PI * 2); ctx.fill();
        }
        break;
      }
    }
    ctx.shadowBlur = 0;

    if (e.kind !== "crystal" && e.hp < e.maxHp) {
      const bw = r * 2, hp = Math.max(0, e.hp / e.maxHp);
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(-r, -r - 8, bw, 4);
      ctx.fillStyle = hp > 0.5 ? "#5ddc86" : hp > 0.25 ? "#e8c650" : "#e8564f";
      ctx.fillRect(-r, -r - 8, bw * hp, 4);
    }
    if (e.owner === me && e.queue.length) {
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      for (let i = 0; i < e.queue.length; i++) ctx.fillRect(-r + i * 6, r + 4, 4, 3);
    }
    ctx.restore();
  }

  private effects(ctx: CanvasRenderingContext2D, cam: Camera) {
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i]!;
      p.life--;
      if (p.life <= 0) { this.puffs.splice(i, 1); continue; }
      const k = p.life / p.max;
      ctx.globalAlpha = k;
      if (p.kind === "death") {
        ctx.strokeStyle = "#ffb066";
        ctx.lineWidth = 2 / cam.zoom;
        ctx.beginPath(); ctx.arc(p.x, p.y, (1 - k) * 26 + 4, 0, Math.PI * 2); ctx.stroke();
      } else if (p.kind === "built" || p.kind === "spawn") {
        ctx.strokeStyle = "#9dfbc0";
        ctx.lineWidth = 2 / cam.zoom;
        ctx.beginPath(); ctx.arc(p.x, p.y, (1 - k) * 34 + 6, 0, Math.PI * 2); ctx.stroke();
      } else if (p.kind === "deposit" || p.kind === "depleted") {
        ctx.fillStyle = NEUTRAL.body;
        ctx.beginPath(); ctx.arc(p.x, p.y - (1 - k) * 14, 3, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = p.kind === "shot" ? "#fff0c0" : "#ffd08a";
        ctx.beginPath(); ctx.arc(p.x, p.y, 2 + k * 3, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  /** Fog is presentation only — the simulation never reads it, so it can never
   *  cause the two peers to disagree. */
  private fog(ctx: CanvasRenderingContext2D, world: World, me: number, cam: Camera) {
    this.visible.fill(0);
    for (const e of world.entities) {
      if (e.owner !== me) continue;
      const s = S[e.kind].sight / FP / TILE;
      const cx = e.x / FP / TILE, cy = e.y / FP / TILE;
      const r = Math.ceil(s);
      for (let y = Math.max(0, (cy - r) | 0); y <= Math.min(MAP_TILES - 1, cy + r); y++) {
        for (let x = Math.max(0, (cx - r) | 0); x <= Math.min(MAP_TILES - 1, cx + r); x++) {
          const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
          if (dx * dx + dy * dy > s * s) continue;
          const i = y * MAP_TILES + x;
          this.visible[i] = 1;
          this.explored[i] = 1;
        }
      }
    }
    const fc = this.fogCanvas.getContext("2d")!;
    const img = fc.createImageData(MAP_TILES, MAP_TILES);
    for (let i = 0; i < this.visible.length; i++) {
      const a = this.visible[i] ? 0 : this.explored[i] ? 150 : 245;
      img.data[i * 4 + 3] = a;
      img.data[i * 4] = 2; img.data[i * 4 + 1] = 4; img.data[i * 4 + 2] = 8;
    }
    fc.putImageData(img, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(this.fogCanvas, -TILE / 2, -TILE / 2, MAP_PX + TILE, MAP_PX + TILE);
    ctx.restore();
    void cam;
  }

  isVisible(worldX: number, worldY: number): boolean {
    const x = (worldX / FP / TILE) | 0, y = (worldY / FP / TILE) | 0;
    if (x < 0 || y < 0 || x >= MAP_TILES || y >= MAP_TILES) return false;
    return this.visible[y * MAP_TILES + x] === 1;
  }

  private drawMinimap(ctx: CanvasRenderingContext2D, world: World, cam: Camera, me: number, w: number, h: number) {
    const size = this.minimap.size;
    const x0 = 14, y0 = h - size - 14;
    this.minimap.x = x0; this.minimap.y = y0;
    const k = size / MAP_PX;
    ctx.save();
    ctx.fillStyle = "rgba(6,10,16,0.9)";
    roundRect(ctx, x0 - 6, y0 - 6, size + 12, size + 12, 10);
    ctx.fill();
    ctx.strokeStyle = "rgba(120,200,255,0.25)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0, size, size); ctx.clip();
    ctx.drawImage(this.terrain, x0, y0, size, size);
    for (let ty = 0; ty < MAP_TILES; ty++) {
      for (let tx = 0; tx < MAP_TILES; tx++) {
        const i = ty * MAP_TILES + tx;
        if (this.visible[i]) continue;
        ctx.fillStyle = this.explored[i] ? "rgba(3,6,10,0.55)" : "rgba(3,6,10,0.93)";
        ctx.fillRect(x0 + tx * TILE * k, y0 + ty * TILE * k, TILE * k + 1, TILE * k + 1);
      }
    }
    for (const e of world.entities) {
      if (!this.isVisible(e.x, e.y) && e.owner !== me) continue;
      const c = e.owner < 0 ? NEUTRAL.body : COLORS[e.owner]!.body;
      ctx.fillStyle = c;
      const s = S[e.kind].building ? 5 : 2.5;
      ctx.fillRect(x0 + (e.x / FP) * k - s / 2, y0 + (e.y / FP) * k - s / 2, s, s);
    }
    const vw = (w / cam.zoom) * k, vh = (h / cam.zoom) * k;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0 + cam.x * k, y0 + cam.y * k, vw, vh);
    ctx.restore();
    ctx.restore();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** One-off procedural ground, baked to an offscreen canvas at map resolution. */
function buildTerrain(seed: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = MAP_PX;
  const ctx = c.getContext("2d")!;
  let s = seed >>> 0 || 1;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

  ctx.fillStyle = "#14211c";
  ctx.fillRect(0, 0, MAP_PX, MAP_PX);
  for (let y = 0; y < MAP_TILES; y++) {
    for (let x = 0; x < MAP_TILES; x++) {
      const n = rand();
      const edge = Math.min(x, y, MAP_TILES - 1 - x, MAP_TILES - 1 - y) / 10;
      const lum = 0.82 + n * 0.28 + Math.min(0.25, edge * 0.08);
      ctx.fillStyle = `rgb(${Math.round(22 * lum)},${Math.round(37 * lum)},${Math.round(31 * lum)})`;
      ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
    }
  }
  // Scattered rock and scrub for a sense of scale.
  for (let i = 0; i < 900; i++) {
    const x = rand() * MAP_PX, y = rand() * MAP_PX, r = 2 + rand() * 7;
    ctx.fillStyle = rand() > 0.45 ? "rgba(40,64,52,0.55)" : "rgba(14,24,20,0.55)";
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.7, rand() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  const g = ctx.createRadialGradient(MAP_PX / 2, MAP_PX / 2, MAP_PX * 0.2, MAP_PX / 2, MAP_PX / 2, MAP_PX * 0.75);
  g.addColorStop(0, "rgba(90,160,255,0.05)");
  g.addColorStop(1, "rgba(0,0,0,0.35)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, MAP_PX, MAP_PX);
  return c;
}
