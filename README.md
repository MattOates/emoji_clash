# EMOJI CLASH

A two-player real-time strategy game that runs entirely in the browser, renders
itself in system emoji, and talks peer-to-peer over WebRTC. There is no game
server, no signalling server, no lobby and no backend — the whole thing is one
static HTML file.

```
npm install
npm run dev      # http://localhost:5173
npm run build    # -> dist/index.html, a single self-contained file
```

`dist/index.html` has no external references of any kind. Open it from disk, put
it on a static host, email it to someone — it works the same everywhere.

## Connecting without a server

Two peers normally need a server to swap SDP descriptions. Here that job is given
to the players: the host generates a ~600-character code, the guest pastes it in
and returns a code of their own, and the match begins. Send them over anything —
chat, email, a photo of a screen. ICE gathering is run to completion before the
code is produced, so there is no trickle channel to keep alive.

The public STUN servers (used only to discover a routable address) can be turned
off in the menu. With STUN off, nothing outside the two browsers is contacted at
all, and play works over LAN or on one machine.

## How two browsers stay in agreement

The game uses **deterministic lockstep**: no world state ever crosses the wire,
only player commands. Both peers run the identical simulation over the identical
command stream and independently arrive at the identical world.

- Commands issued now are scheduled to execute six ticks (300 ms) later, which
  gives the packet time to arrive before either side needs it.
- A tick executes only when both players' command sets for it are present. If a
  peer stalls, the HUD says so rather than silently drifting.
- Every 40 ticks the peers exchange a checksum of the whole world. A mismatch is
  reported immediately instead of quietly turning into two different games.

Determinism is enforced by construction, not by hope. Everything under `src/game`
is integer-only fixed-point (1 pixel = 256 units): no floats in state, no
`Math.random`, no `Math.sqrt` in a decision path (there is an integer `isqrt`
whose float seed is corrected by exact integer comparisons), no wall-clock time,
and entity iteration is always in id order. Fog of war and interpolation live in
the renderer, where a disagreement cannot matter.

The simulation is driven by a timer rather than `requestAnimationFrame` — a
backgrounded tab stops painting, and if it stopped simulating it would freeze the
opponent too.

## Rendering

Everything on the field is a system emoji drawn with `fillText` — no sprites, no
image assets, nothing fetched. Each glyph is rasterised once into a small
offscreen canvas and blitted after that, which measured about twice as fast as
calling `fillText` per entity per frame.

Emoji are colour glyphs, so `fillStyle` does nothing to them: team identity comes
from the faint ring behind each one. That ring is drawn at exactly the radius the
simulation separates on, so crowding always looks like what it actually is.

The trade-off is that the same codepoints are drawn by Apple Color Emoji, Segoe
UI Emoji or Noto Color Emoji depending on the machine, so two players see subtly
different art. It is cosmetic only — rendering never feeds back into the
simulation, so it cannot desync a match.

## Movement

Obstacles are rasterised onto the 64×64 tile grid and each goal gets a Dijkstra
flow field flooded out from it, keyed by goal tile — so a squad sent to one place
shares a single field. Units walk in a straight line while the way is clear and
only read the field when a building actually lies across their path, which keeps
open-ground movement looking direct and costs nothing until it matters. Fields
are cached until a building is created or destroyed.

Unit-versus-unit collision is separate: a tile-bucketed separation pass pushes
overlapping units apart in id order. Units that make no headway for 4.5 seconds
stop rather than shoving at an occupied spot forever.

The field is a pure function of the grid and the goal, so caching and eviction
cannot affect the outcome, and the flood is integer-only with ties broken by tile
index — a path that differed by one tile between peers would desync the match.

## Playing

| | |
|---|---|
| Drag / click | select (double-click picks all of that type on screen) |
| Right-click | contextual order: move, attack, mine, deliver, haul, enrol, set rally |
| `A` | attack-move (then left-click a destination) |
| `E` `F` `N` `G` `W` `V` | train Engineer · Smiley · Ninja · Guard · Wizard · Vampire |
| `D` `Y` `K` `C` `X` `B` | place Drive · Gallery · Keyboard · Cloud · Social Feed · Datacenter |
| `Ctrl`/`Cmd`+`A` | select every unit of yours on screen |
| `Ctrl`+`1-9` / `1-9` | assign / recall a control group |
| `Esc` | cancel a pending attack-move or placement |
| Arrows, middle-drag, minimap | pan · wheel zooms · `Space` jumps home |

### The economy

Two raw resources, one refined one.

- **💾 bits** are everywhere and quick to mine. 🧑‍🔧 Engineers deliver them to a
  **🗄️ Drive**.
- **🎨 pixels** are five times scarcer and nearly twice as slow to dig. They go
  to a **🖼️ Gallery**.
- **☁️ A Cloud** turns **2 bits + 1 pixel** into one **🤖 slop**, the premium
  currency. It does not draw from your stockpile by itself — right-click a Cloud
  with an Engineer selected and they become a courier, shuttling from your depots
  into its intake forever. Slop gates the Wizard, the Vampire and the Social Feed.

You start with a Datacenter, a Drive, a Gallery and four Engineers. Losing a
depot means that resource stops arriving until you rebuild one.

### The army

**⌨️ A Keyboard** types fighters into existence: 🙂 Smiley (cheap melee),
🥷 Ninja (fast, fragile, high damage), 💂 Guard (a slow wall), 🧙 Wizard
(outranges everything), 🧛 Vampire (heals for half the damage it deals).

**📱 A Social Feed** is where Smileys go to lose their temper. Right-click one
with a 🙂 selected and — for 30💾 and 2🤖 a time — it sours a step:

> 🙂 → 😐 → 🙁 → 😠 → 😡

Each step adds 40% health and 45% damage. A fully radicalised 😡 detonates when
it dies, 🤯 dealing 70 damage to every enemy within 78 pixels — and you can set
one off deliberately with the Detonate button. Chain reactions are entirely
possible and highly encouraged.

Destroy everything the opponent owns to win.

## Layout

```
src/game/types.ts   stats, costs, commands, fixed-point constants
src/game/sim.ts     the deterministic simulation — integers only
src/game/flow.ts    obstacle grid and cached flow fields for navigation
src/game/ai.ts      practice-mode opponent (deterministic, runs inside the sim)
src/lockstep.ts     turn scheduling, command exchange, checksum comparison
src/net.ts          WebRTC peer setup and the compressed offer/answer codes
src/render.ts       emoji glyph cache, rings, fog of war, minimap
src/main.ts         menu, input, HUD, frame loop
```

`window.rts` exposes the live runner in the console for poking at a running match.
