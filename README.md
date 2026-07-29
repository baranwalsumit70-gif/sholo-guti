# Sholo Guti — Sixteen Soldiers

A traditional South Asian strategy board game, rebuilt as a premium digital tabletop
experience. Thirty-two marble soldiers, thirty-seven points, an empty column down the
middle where the fighting starts.

Local two-player, three levels of computer opponent, and online play with a friend.

---

## The board

**37 points · 76 lines · 112 jump lanes · 16 + 16 soldiers · centre column empty.**

A five-by-five lattice with alternating diagonals, plus a triangular fort of six points
on each flank whose apex is a lattice point (`A3` and `E3`).

The fort's two slanted sides run at 45°, on the same step as the lattice, so each one is
a dead-straight continuation of a board diagonal:

```
L4 — L1 — A3 — B4 — C5      one unbroken line, five points
L6 — L3 — A3 — B2 — C1
C1 — D2 — E3 — R3 — R6
C5 — D4 — E3 — R1 — R4
```

A soldier at `L1` can jump over `A3` and land on `B4`, breaking out of the fort into the
middle of the board in a single move.

### How the geometry is stored

The board is a set of **lanes**. Each lane is one continuous straight line on the physical
board, listed in order:

```js
["L4", "L1", "A3", "B4", "C5"]
```

- **edges** = consecutive pairs in a lane
- **jump lanes** = consecutive triples in a lane

Nothing is ever inferred from how close two points sit on screen. To retune the board,
edit `NODES` and `LANES` and nothing downstream changes.

---

## Rules

| Rule | Default | Configurable |
|---|---|---|
| Move | one step to a neighbouring empty point along a line | — |
| Capture | short jump over one adjacent enemy, landing on the empty point directly beyond, same straight line | — |
| Forced capture | **off** — taking is always your choice | yes |
| Chained jumps | on — keep jumping, stop whenever you like | yes |
| Win | take every enemy soldier, or leave the opponent with no legal move | yes |
| Draw | 150 plies without a capture | yes |

All of these live in `DEFAULT_RULES` and can be toggled mid-match from Settings.

---

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # -> dist/
npm run preview
```

Requires Node 18+.

---

## Deploying

A GitHub Actions workflow is included. Push to `main`, then set
**Settings → Pages → Build and deployment → Source: GitHub Actions**. The workflow sets
the Vite `base` to your repository name automatically.

For a root deploy or a custom domain, leave `GITHUB_PAGES_BASE` unset — `vite.config.js`
falls back to `/`.

---

## A note on online play

The online mode keeps a match in one shared key-value record: both players load the same
page, one creates a room and reads out a five-character code, the other joins. Only the
**action list** travels, never the board, so both sides replay the same moves and keep
their own piece identities and animations.

It reads and writes through `window.storage`, which is provided by the Claude artifacts
runtime. **On a plain static host such as GitHub Pages that object does not exist**, so
the online panel detects this and says so rather than failing quietly. Local two-player
and all three computer levels work anywhere.

To make online play work on your own host, implement the two functions in the
`ONLINE ROOMS` section of `src/App.jsx` against a backend of your choice:

```js
async function roomGet(code)        // -> { v, rules, actions, joined, updated } | null
async function roomSet(code, data)  // -> void
```

Anything with a key-value store and public read/write will do — Supabase, Firebase,
Cloudflare Workers KV, or a twenty-line Express server. The polling loop, replay logic,
turn locking and reconnect handling already exist and need no changes.

---

## File map

`src/App.jsx` is a single file, sectioned so each banner maps cleanly onto a module if you
want to split it:

| Section | What it holds |
|---|---|
| 1 · Board graph | lanes → nodes, edges, jump lanes, piece sizing |
| 2 · Rules | every rule as data |
| 3 · State | setup and immutable transitions |
| 4 · Move / capture | validators, derived only from the graph |
| 5 · Win | elimination, immobilisation, draw |
| 6 · AI | minimax, alpha-beta, iterative deepening under a time budget |
| 7 · Audio | Web Audio cues and haptics |
| 8 · Online rooms | codes, shared record, action replay |
| 9 · Render | SVG board, screens, panels |

### The computer opponent

Easy plays legally and takes most obvious jumps. Medium searches three plies. Hard runs
iterative deepening to six plies under a 650 ms budget, and only accepts a depth that
finished inside the clock — a half-searched depth is discarded rather than trusted.

Evaluation: material, centre control, mobility, and hanging pieces.

---

## Accessibility

Players are distinguished by material **and** by mark — a ring and boss on ivory, three
spokes on ebony — never by colour alone. Reduced motion is honoured from the system
setting and can be toggled. Touch targets are at least 44 px. Sound and haptics are
optional, and the game says so plainly when the browser refuses audio.

---

## Licence

MIT. See `LICENSE`.

The game itself is traditional and belongs to no one. Sixteen-soldier games are played
across South Asia under many names, and house rules vary by region.
