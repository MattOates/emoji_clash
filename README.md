# EMOJI CLASH

**[▶ Play it in your browser](https://mattoates.github.io/emoji_clash/play/)** · [about the game](https://mattoates.github.io/emoji_clash/)


A two-player real-time strategy game that runs entirely in the browser, renders
itself in system emoji, and talks peer-to-peer over WebRTC. There is no game
server, no signalling server, no lobby and no backend — the whole thing is one
static HTML file.

```
make install
make dev         # http://localhost:5173
make build       # -> dist/index.html, a single self-contained file
make pages       # preview the Pages site locally
make deploy      # scp it to a server of your own
```

`dist/index.html` has no external references of any kind. Open it from disk, put
it on a static host, email it to someone — it works the same everywhere, at any
URL prefix.

Deployment settings stay out of the repo. With [direnv](https://direnv.net),
copy `.envrc.example` to `.envrc`, fill it in and run `direnv allow` — the
variables are then picked up automatically whenever you are in the directory.
Exporting them by hand or passing them inline works just as well:
`make deploy EC_DEPLOY_HOST=myserver EC_DEPLOY_DIR=/var/www/game`.

### Music

Drop any mp3 at `public/music.mp3` and it becomes looping background music with
a 🔊 toggle in the HUD, remembered in localStorage. It is deliberately *not*
inlined — at several megabytes it would wreck the single-file build — so it
ships as a sibling file and the game plays silent if it is missing. The repo
ignores `public/*.mp3`: supply your own, and mind the licence of whatever you
use.

## Connecting

WebRTC cannot bootstrap itself. Before one byte flows, the host needs the
guest's ICE credentials, its DTLS fingerprint and an address to aim at — so a
link alone can never be enough, because a URL travels one way and there is
nowhere for the answer to land. Something has to introduce the two browsers.

That introduction is the only thing outsourced here: the host claims a
five-character room code as its id on PeerJS's public broker, the guest connects
to it by name, and once the data channel opens the broker is out of the picture.
No game traffic ever touches a server.

- Host clicks **Host**, gets a code like `RM94W` and a link
- Guest opens the link, or types the code
- That is the whole flow

The honest trade: signalling depends on a free third-party service. If it is
down, nobody new can be introduced — matches already running are unaffected. And
a broker solves discovery, not reachability: if both players sit behind NATs
that refuse an inbound punch the connection still needs a TURN relay, which
nothing here provides. That case reports a timeout rather than hanging.

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

## Stigmergy

Carriers leave pheromone on the ground and read what other crews left. This does
*not* replace the flow field — Dijkstra already returns the shortest route, so
trail-laying could only be worse at that job. It adds the things exact
shortest-path cannot express.

Four lane grids — bits-out, bits-home, pixels-out, pixels-home — plus a friction
grid marking where units actually collided. Everything decays on a ~5.5 second
half-life (`v -= v>>4`, ten ticks apart), so the map reflects the last few
seconds of real traffic and adapts on its own as deposits run dry and routes
move. All integer, fixed iteration order: this feeds movement, so both peers must
agree on it exactly.

Three effects, and what each one is actually worth. Measured by total resources
gathered over 5000 ticks on the standard map, mixed bit and pixel crews, against
the same run with the feature off:

| crew | crowd-aware deposit choice | collision-friction routing |
|---|---|---|
| 8  | +49% | — |
| 16 | +48% | −3% |
| 24 | +48% | +11% |
| 32 | +27% | +14% |

- **Crowd-aware deposit choice** is the big win. A deposit already committed to
  by other crew "feels" 70px further away, so miners spread out instead of
  stacking on the nearest pile, and they stay on the resource they were already
  working rather than collapsing into one crew after a delivery.
- **Collision friction** marks where units genuinely bump. Raw traffic volume is
  a bad signal — a busy lane flowing freely costs nothing — but collisions are
  the real jams, and folding them into the flow field's edge costs bends later
  routes around them. It pays once there is enough crew to actually jam.
- **Directional lanes** steer a carrier away from every *other* crew's trail, so
  a shared corridor separates into parallel lanes. Two guards: it only fires
  where collisions are actually happening, and never within three tiles of a
  goal, because crowding at a deposit or a depot is units correctly converging
  rather than a jam to solve.

Honest result on that third one: **lane separation does not pay for itself.** On
its own it was worth +8–10%, but stacked on crowd-aware deposit choice it ranges
from −5% to +1% — the corridors are no longer contested enough to be worth the
lateral distance. It ships at a low bias (12% of a step) because it looks right
and costs nothing measurable, not because it earns its keep. `LANE_BIAS = 0`
turns it off.

Press `T` to see the pheromone: blue for bit crews, violet for pixel crews,
brighter on the laden side, red where units keep colliding.

## Playing

| | |
|---|---|
| Drag / click | select (double-click picks all of that type on screen) |
| Right-click | contextual order: move, attack, mine, deliver, haul, enrol, set rally |
| `A` | attack-move (then left-click a destination) |
| `E` `J` `F` `N` `G` `M` `W` `V` | train Engineer · Janitor · Smiley · Ninja · Guard · Monkey · Wizard · Vampire |
| `D` `Y` `K` `C` `X` `B` | place Drive · Gallery · Keyboard · Cloud · Social Feed · Datacenter |
| `Ctrl`/`Cmd`+`A` | select every unit of yours on screen |
| `Ctrl`+`1-9` / `1-9` | assign / recall a control group |
| `R` | recycle selected structures for 60% back |
| `P` | Monkey: foul the ground you click |
| `T` | show/hide the pheromone trails |
| `Esc` | cancel a pending attack-move or placement |
| Arrows, middle-drag, minimap | pan · wheel zooms · `Space` jumps home |

### The economy

Two raw resources, one refined one.

- **💾 bits** are everywhere and quick to mine. 🧑‍🔧 Engineers deliver them to a
  **🗄️ Drive**.
- **🎨 pixels** are five times scarcer and nearly twice as slow to dig. They go
  to a **🖼️ Gallery**.
- **☁️ A Cloud** turns **2 bits + 1 pixel** into one **🤖 slop**, the premium
  currency. Nothing here moves by itself. Right-click a Cloud with an Engineer
  selected and they become a courier: bits and pixels in from your depots,
  finished slop out to the Datacenter, forever. Slop gates the Wizard and the
  Vampire, and it is the only thing that levels a Smiley.

You start with a Datacenter, a Drive, a Gallery and four Engineers. Losing a
depot means that resource stops arriving until you rebuild one.

### The army

Two fighting units come out of a **⌨️ Keyboard**, and both are levelled at a
**📱 Social Feed** — but the Feed does opposite things to them. Each step costs
one 🤖 physically sitting in that building, carried there by an Engineer.

**🙂 Smileys trade their body for their temper.** They start as cheerful sacks
of hitpoints that can barely hurt anyone, and every step down the mood makes
them frailer and nastier:

| | 🙂 | 😐 | 🙁 | 😠 | 😡 |
|---|---|---|---|---|---|
| health | 220 | 165 | 115 | 78 | 48 |
| damage | 4 | 10 | 17 | 25 | 34 |
| attack | melee | melee | **ranged** | ranged | ranged |

From 🙁 they stop closing to melee and start throwing 💢, so a mixed army sorts
itself out without being told: happy faces soak at the front while sour ones
shoot over their shoulders. A 😡 dies to almost anything and hits like a truck,
and detonates for 135 damage across 96 pixels when it goes — enough to take a
clump of anything with it, deliberately or otherwise.

**🙈 Monkeys level the ordinary way**, getting tougher and faster so they stay
alive to keep harassing: 🙈 → 🙉 → 🙊 → 🐵, 65 to 152 health and 1.6 to 2.3
speed. They keep their thrown 💩 and their ability to foul ground with `P`.

**👨🏻‍🔧 Janitors** and **🧑‍🔧 Engineers** round out the roster: one scrubs 💩 away,
the other mines, builds and hauls.

Destroy everything the opponent owns to win.

## Layout

```
src/game/types.ts   stats, costs, commands, fixed-point constants
src/game/sim.ts     the deterministic simulation — integers only
src/game/flow.ts    obstacle grid and cached flow fields for navigation
src/game/trails.ts  pheromone lanes, collision friction, evaporation
src/game/ai.ts      practice-mode opponent (deterministic, runs inside the sim)
src/lockstep.ts     turn scheduling, command exchange, checksum comparison
src/net.ts          WebRTC peer setup and the compressed offer/answer codes
src/render.ts       emoji glyph cache, rings, fog of war, minimap
src/main.ts         menu, input, HUD, frame loop
```

`window.rts` exposes the live runner in the console for poking at a running match.

## GitHub Pages

Publishing is done by CI, not by committing a build. `.github/workflows/pages.yml`
typechecks, builds and deploys on every push to `main`, assembling
`docs/index.html` as the landing page and the freshly built game at `/play/`.
Set **Settings → Pages → Source** to **GitHub Actions**.

Nothing built is committed, so what is published can never drift from source.
`make pages` produces the same layout locally for previewing. The soundtrack is
never committed, so the published copy is silent unless you add one yourself.

## Licence

MIT — see [LICENSE](LICENSE). The emoji themselves are drawn by whichever system
font the player has; no artwork ships with this repo.
