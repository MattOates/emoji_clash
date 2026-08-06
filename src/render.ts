import {
  FP, MAP_TILES, TILE, STATS as S, FACE_FACES, MAX_LEVEL, BLAST_RADIUS,
  type Entity, type Kind,
} from "./game/types";
import type { World } from "./game/sim";
import { BITS_OUT, BITS_HOME, PIX_OUT, PIX_HOME, TRAIL_MAX } from "./game/trails";

export interface Camera { x: number; y: number; zoom: number }

const MAP_PX = MAP_TILES * TILE;

export const COLORS = [
  { body: "#5bd0ff", dark: "#0f4c68", glow: "rgba(91,208,255,0.5)", name: "Blue" },
  { body: "#ff9a5c", dark: "#7a3a15", glow: "rgba(255,154,92,0.5)", name: "Orange" },
];
const NEUTRAL = { body: "#c58bff", dark: "#4a2a70", glow: "rgba(197,139,255,0.4)", name: "Neutral" };

interface Puff { x: number; y: number; life: number; max: number; kind: string; text?: string }

// Emoji are colour glyphs — fillStyle does nothing to them — so team identity
// comes from the ring behind, and each glyph is rasterised once and blitted
// after that (measured at roughly half the cost of fillText per frame).
const glyphCache = new Map<string, HTMLCanvasElement>();
function glyph(emoji: string, size: number): HTMLCanvasElement {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const key = `${emoji}|${size}|${dpr}`;
  const hit = glyphCache.get(key);
  if (hit) return hit;
  const pad = Math.ceil(size * 0.3);
  const c = document.createElement("canvas");
  c.width = c.height = Math.ceil((size + pad * 2) * dpr);
  const ctx = c.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.font = `${size}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, (size + pad * 2) / 2, (size + pad * 2) / 2);
  glyphCache.set(key, c);
  return c;
}

function drawGlyph(ctx: CanvasRenderingContext2D, emoji: string, x: number, y: number, size: number) {
  const g = glyph(emoji, roundSize(size));
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const w = g.width / dpr, h = g.height / dpr;
  ctx.drawImage(g, x - w / 2, y - h / 2, w, h);
}

// Snap to a few sizes so the cache stays small across zoom levels.
function roundSize(size: number): number {
  return Math.max(8, Math.round(size / 2) * 2);
}

export function emojiFor(e: Entity): string {
  return e.kind === "face" ? FACE_FACES[Math.min(e.level, MAX_LEVEL)]! : S[e.kind].emoji;
}

export class Renderer {
  private terrain: HTMLCanvasElement;
  private fogCanvas: HTMLCanvasElement;
  private explored = new Uint8Array(MAP_TILES * MAP_TILES);
  private visible = new Uint8Array(MAP_TILES * MAP_TILES);
  private fogImage: ImageData | null = null;
  private trailCanvas: HTMLCanvasElement;
  private trailImage: ImageData | null = null;
  showTrails = true;
  private puffs: Puff[] = [];
  minimap = { x: 0, y: 0, size: 190 };

  constructor(private canvas: HTMLCanvasElement, seed: number) {
    this.terrain = buildTerrain(seed);
    this.fogCanvas = document.createElement("canvas");
    this.fogCanvas.width = this.fogCanvas.height = MAP_TILES;
    this.trailCanvas = document.createElement("canvas");
    this.trailCanvas.width = this.trailCanvas.height = MAP_TILES;
  }

  addEvents(events: { x: number; y: number; kind: string; text?: string }[]) {
    for (const e of events) {
      const max = e.kind === "blast" ? 34 : e.kind === "death" ? 26
        : e.kind === "built" || e.kind === "levelup" ? 34 : e.kind === "float" ? 40 : 14;
      this.puffs.push({ x: e.x / FP, y: e.y / FP, life: max, max, kind: e.kind, text: e.text });
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
    ctx.fillStyle = "#04060b";
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(-cam.x * cam.zoom, -cam.y * cam.zoom);
    ctx.scale(cam.zoom, cam.zoom);

    ctx.drawImage(this.terrain, 0, 0);
    this.gridOverlay(ctx, cam, w, h);
    if (this.showTrails) this.trails(world);
    if (this.showTrails) {
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.42;
      ctx.drawImage(this.trailCanvas, -TILE / 2, -TILE / 2, MAP_PX + TILE, MAP_PX + TILE);
      ctx.restore();
    }

    const lerp = (a: number, b: number) => (a + (b - a) * alpha) / FP;

    for (const e of world.entities) {
      const x = lerp(e.px, e.x), y = lerp(e.py, e.y), r = S[e.kind].radius / FP;
      ctx.fillStyle = "rgba(0,0,0,0.34)";
      ctx.beginPath();
      ctx.ellipse(x, y + r * 0.62, r * 0.92, r * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const e of world.entities) {
      const x = lerp(e.px, e.x), y = lerp(e.py, e.y);
      this.entity(ctx, e, x, y, me, sel.has(e.id), hover?.id === e.id);
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
        : o.kind === "harvest" || o.kind === "returnCargo" || o.kind === "haul"
          ? "rgba(197,139,255,0.5)" : "rgba(255,255,255,0.35)";
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
      ctx.globalAlpha = 0.55;
      drawGlyph(ctx, S[placing.kind].emoji, placing.x / FP, placing.y / FP, r * 1.7);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = placing.ok ? "rgba(120,255,170,0.85)" : "rgba(255,90,90,0.9)";
      ctx.fillStyle = placing.ok ? "rgba(120,255,170,0.12)" : "rgba(255,90,90,0.14)";
      ctx.lineWidth = 2 / cam.zoom;
      ctx.beginPath();
      ctx.arc(placing.x / FP, placing.y / FP, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    this.fog(ctx, world, me);
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
    ctx.strokeStyle = "rgba(120,220,255,0.045)";
    ctx.lineWidth = 1 / cam.zoom;
    ctx.beginPath();
    for (let x = x0; x <= x1; x += TILE) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    for (let y = y0; y <= y1; y += TILE) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    ctx.stroke();
  }

  /** The ring is the unit's collision circle, drawn at exactly the radius the
   *  simulation separates on — so crowding always looks like what it is. */
  private entity(ctx: CanvasRenderingContext2D, e: Entity, x: number, y: number, me: number,
                 selected: boolean, hovered: boolean) {
    const c = e.owner < 0 ? NEUTRAL : COLORS[e.owner]!;
    const r = S[e.kind].radius / FP;
    const building = S[e.kind].building;

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = e.owner < 0 ? "rgba(150,110,200,0.10)" : c.body;
    ctx.globalAlpha = e.owner < 0 ? 1 : e.complete ? 0.13 : 0.07;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = c.body;
    ctx.globalAlpha = e.complete ? (building ? 0.5 : 0.42) : 0.22;
    ctx.lineWidth = building ? 2 : 1.6;
    ctx.stroke();
    ctx.globalAlpha = 1;

    if (selected) {
      ctx.strokeStyle = "rgba(150,255,190,0.95)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    } else if (hovered) {
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (e.flash > 0) { ctx.shadowColor = "#fff"; ctx.shadowBlur = 14; }
    ctx.globalAlpha = e.complete ? 1 : 0.45;
    drawGlyph(ctx, emojiFor(e), x, y, r * (building ? 1.5 : 1.75));
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;

    // A maxed-out face is about to be somebody's problem.
    if (e.kind === "face" && e.level >= MAX_LEVEL) {
      ctx.strokeStyle = "rgba(255,90,70,0.75)";
      ctx.lineWidth = 1.4;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(x, y, r + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (!e.complete) {
      const p = e.progress / S[e.kind].buildTime;
      ctx.strokeStyle = "rgba(160,255,200,0.9)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, r + 5, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
      ctx.stroke();
    }

    if (e.owner >= 0 && e.hp < e.maxHp) {
      const hp = Math.max(0, e.hp / e.maxHp);
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(x - r, y - r - 9, r * 2, 4);
      ctx.fillStyle = hp > 0.5 ? "#5ddc86" : hp > 0.25 ? "#e8c650" : "#e8564f";
      ctx.fillRect(x - r, y - r - 9, r * 2 * hp, 4);
    }
    if (e.cargo > 0) drawGlyph(ctx, e.cargoRes === "bits" ? "💾" : "🎨", x + r * 0.8, y - r * 0.8, 11);
    if (e.owner === me && e.queue.length) {
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      for (let i = 0; i < e.queue.length; i++) ctx.fillRect(x - r + i * 6, y + r + 3, 4, 3);
    }
    // Stock on hand, so you can see a Cloud backing up or a Feed running dry.
    if (e.complete && (e.kind === "cloud" || e.kind === "feed")) {
      const label = e.kind === "cloud"
        ? (e.stockSlop ? `${e.stockBits}·${e.stockPixels} → ${e.stockSlop}🤖` : `${e.stockBits}·${e.stockPixels}`)
        : `${e.stockSlop}🤖`;
      ctx.font = "9px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillStyle = e.kind === "feed" && e.stockSlop === 0 ? "rgba(255,140,120,0.9)" : "rgba(255,255,255,0.8)";
      ctx.fillText(label, x, y + r + 12);
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
      switch (p.kind) {
        case "blast": {
          ctx.strokeStyle = "rgba(255,140,60,0.95)";
          ctx.lineWidth = 3 / cam.zoom;
          ctx.beginPath();
          ctx.arc(p.x, p.y, (1 - k) * BLAST_RADIUS, 0, Math.PI * 2);
          ctx.stroke();
          drawGlyph(ctx, "🤯", p.x, p.y, 18 + (1 - k) * 26);
          break;
        }
        case "float":
        case "levelup":
        case "spawn":
          drawGlyph(ctx, p.text ?? "✨", p.x, p.y - (1 - k) * 22, 15);
          break;
        case "built":
          ctx.strokeStyle = "rgba(160,255,200,0.9)";
          ctx.lineWidth = 2 / cam.zoom;
          ctx.beginPath();
          ctx.arc(p.x, p.y, (1 - k) * 40 + 6, 0, Math.PI * 2);
          ctx.stroke();
          drawGlyph(ctx, "✨", p.x, p.y, 18);
          break;
        case "death":
          ctx.strokeStyle = "rgba(255,150,90,0.8)";
          ctx.lineWidth = 2 / cam.zoom;
          ctx.beginPath();
          ctx.arc(p.x, p.y, (1 - k) * 24 + 4, 0, Math.PI * 2);
          ctx.stroke();
          break;
        case "depleted":
          drawGlyph(ctx, "🕳️", p.x, p.y, 16);
          break;
        default:
          ctx.fillStyle = p.kind === "shot" ? "#fff0c0" : "#ffd08a";
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2 + k * 3, 0, Math.PI * 2);
          ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  /** The pheromone made visible: blue for the bit crews, violet for the pixel
   *  crews, brighter on the laden side, red where units keep colliding. The
   *  lanes you can see are literally the ones the simulation is steering by. */
  private trails(world: World) {
    const t = world.trails;
    const c = this.trailCanvas.getContext("2d")!;
    const img = this.trailImage ?? (this.trailImage = c.createImageData(MAP_TILES, MAP_TILES));
    const d = img.data;
    const scale = (v: number, k: number) => Math.min(255, (v * k) / TRAIL_MAX | 0);
    for (let i = 0; i < MAP_TILES * MAP_TILES; i++) {
      const bo = t.lanes[BITS_OUT]![i]!, bh = t.lanes[BITS_HOME]![i]!;
      const po = t.lanes[PIX_OUT]![i]!, ph = t.lanes[PIX_HOME]![i]!;
      const fr = t.friction[i]!;
      const blue = scale(bo, 700) + scale(bh, 1500);
      const viol = scale(po, 700) + scale(ph, 1500);
      const red = scale(fr, 1400);
      const o = i * 4;
      d[o] = Math.min(255, viol * 0.7 + red);
      d[o + 1] = Math.min(255, blue * 0.35 + viol * 0.2);
      d[o + 2] = Math.min(255, blue + viol * 0.9);
      d[o + 3] = Math.min(150, Math.max(blue, viol, red));
    }
    c.putImageData(img, 0, 0);
  }

  /** Fog is presentation only — the simulation never reads it, so it can never
   *  cause the two peers to disagree. */
  private fog(ctx: CanvasRenderingContext2D, world: World, me: number) {
    this.visible.fill(0);
    for (const e of world.entities) {
      if (e.owner !== me) continue;
      const s = S[e.kind].sight / FP / TILE;
      if (s <= 0) continue;
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
    const img = this.fogImage ?? (this.fogImage = fc.createImageData(MAP_TILES, MAP_TILES));
    for (let i = 0; i < this.visible.length; i++) {
      img.data[i * 4] = 2; img.data[i * 4 + 1] = 4; img.data[i * 4 + 2] = 9;
      img.data[i * 4 + 3] = this.visible[i] ? 0 : this.explored[i] ? 150 : 245;
    }
    fc.putImageData(img, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.fogCanvas, -TILE / 2, -TILE / 2, MAP_PX + TILE, MAP_PX + TILE);
    ctx.restore();
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
      ctx.fillStyle = e.owner < 0 ? NEUTRAL.body : COLORS[e.owner]!.body;
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

/** The battlefield is a desktop: dark panels, faint scanlines, a few stray
 *  glyphs someone left lying around. Baked once at map resolution. */
function buildTerrain(seed: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = MAP_PX;
  const ctx = c.getContext("2d")!;
  let s = seed >>> 0 || 1;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

  ctx.fillStyle = "#0a1420";
  ctx.fillRect(0, 0, MAP_PX, MAP_PX);
  for (let y = 0; y < MAP_TILES; y++) {
    for (let x = 0; x < MAP_TILES; x++) {
      const n = rand();
      const lum = 0.85 + n * 0.3;
      ctx.fillStyle = `rgb(${Math.round(13 * lum)},${Math.round(26 * lum)},${Math.round(40 * lum)})`;
      ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
    }
  }
  ctx.fillStyle = "rgba(255,255,255,0.012)";
  for (let y = 0; y < MAP_PX; y += 3) ctx.fillRect(0, y, MAP_PX, 1);
  for (let i = 0; i < 420; i++) {
    const x = rand() * MAP_PX, y = rand() * MAP_PX, r = 3 + rand() * 9;
    ctx.fillStyle = rand() > 0.5 ? "rgba(60,110,150,0.10)" : "rgba(8,16,26,0.55)";
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.72, rand() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // Litter: cold, low-contrast glyphs scattered as scenery.
  const litter = ["📁", "🔗", "📎", "🗑️", "⌘", "🖱️", "🔌", "📶", "🧊", "🪟"];
  ctx.globalAlpha = 0.075;
  for (let i = 0; i < 130; i++) {
    const g = litter[(rand() * litter.length) | 0]!;
    const size = 16 + rand() * 26;
    ctx.font = `${size}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(g, rand() * MAP_PX, rand() * MAP_PX);
  }
  ctx.globalAlpha = 1;
  const g = ctx.createRadialGradient(MAP_PX / 2, MAP_PX / 2, MAP_PX * 0.2, MAP_PX / 2, MAP_PX / 2, MAP_PX * 0.78);
  g.addColorStop(0, "rgba(90,180,255,0.05)");
  g.addColorStop(1, "rgba(0,0,0,0.42)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, MAP_PX, MAP_PX);
  return c;
}
