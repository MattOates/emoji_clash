# CRYSTAL FRONT

A two-player real-time strategy game that runs entirely in the browser and talks
peer-to-peer over WebRTC. There is no game server, no signalling server, no lobby
and no backend — the whole thing is one static HTML file.

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
| Right-click | contextual order: move, attack, harvest, deliver, set rally |
| `A` | attack-move (then left-click a destination) |
| `B` / `R` | place a Command Base / Barracks with a worker selected |
| `W` / `S` / `A` | train from selected production buildings |
| `Ctrl`/`Cmd`+`A` | select every unit of yours on screen |
| `Ctrl`+`1-9` / `1-9` | assign / recall a control group |
| `Esc` | cancel a pending attack-move or placement |
| Arrows, middle-drag, minimap | pan · wheel zooms · `Space` jumps home |

Workers mine crystal and deliver it to a base. Bases train workers and add 15
supply; barracks train soldiers and archers and add 10. Soldiers hit hard up
close, archers outrange everything and die quickly. Destroy everything the
opponent owns to win.

## Layout

```
src/game/types.ts   stats, commands, fixed-point constants
src/game/sim.ts     the deterministic simulation — integers only
src/game/flow.ts    obstacle grid and cached flow fields for navigation
src/game/ai.ts      practice-mode opponent (deterministic, runs inside the sim)
src/lockstep.ts     turn scheduling, command exchange, checksum comparison
src/net.ts          WebRTC peer setup and the compressed offer/answer codes
src/render.ts       canvas rendering, fog of war, minimap
src/main.ts         menu, input, HUD, frame loop
```

`window.rts` exposes the live runner in the console for poking at a running match.
