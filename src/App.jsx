import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { initializeApp } from "firebase/app";
import { getDatabase, ref, get, set } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyCI-Sev13rNqgDO6rpcCZPAotLftEeI5uBs",
  authDomain: "sholo-guti-66064.firebaseapp.com",
  databaseURL: "https://sholo-guti-66064-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "sholo-guti-66064",
  storageBucket: "sholo-guti-66064.firebasestorage.app",
  messagingSenderId: "946497734881",
  appId: "1:946497734881:web:e620f33aa1316a3864cfa0"
};

const firebaseApp = initializeApp(firebaseConfig);
const database = getDatabase(firebaseApp);

/* ============================================================================
   SHOLO GUTI — Sixteen Soldiers            v2, reconciled with the reference
   ----------------------------------------------------------------------------
   37 points · 76 lines · two flank forts of 6 · centre column empty at start
   16 marble soldiers a side. Captures are offered, never forced.

     1  BOARD GRAPH     lanes -> edges + jump lanes
     2  RULES
     3  STATE
     4  MOVE / CAPTURE
     5  WIN
     6  AI
     7  AUDIO
     8  RENDER
   ========================================================================== */

/* ============================================================================
   1. BOARD GRAPH
   ----------------------------------------------------------------------------
   The reference board is a set of painted straight LINES. So lines are the
   source of truth here, not coordinates: every lane below is one continuous
   straight line on the physical board, listed in order.

     edges      = consecutive pairs in a lane
     jump lanes = consecutive triples in a lane

   Rendering coordinates are therefore free to breathe (the forts are drawn
   with playable spacing rather than true photographic perspective) without
   ever changing which moves are legal.
   ========================================================================== */

const S = 100;            // lattice spacing
const CX = 460, CY = 300; // board centre
const COLS = ["A", "B", "C", "D", "E"];
const gx = (c) => CX + (c - 2) * S;
const gy = (r) => CY + (r - 2) * S;

const NODES = {};
for (let c = 0; c < 5; c++)
  for (let r = 0; r < 5; r++) NODES[`${COLS[c]}${r + 1}`] = { x: gx(c), y: gy(r) };

/* Each fort is a triangle of 6 points whose apex IS a lattice point — the
   middle of that flank's outer column (A3 / E3). Its two slanted sides run at
   45°, on the same step as the lattice, so each one is a dead-straight
   continuation of a board diagonal: L4-L1-A3-B4-C5 is one unbroken line.
   Every fort point therefore lands on the board's own grid, which keeps all
   32 pieces exactly the same size. */
const FORT = { step: 1 };
const mkFort = (side) => {
  const x0 = side < 0 ? gx(0) : gx(4);
  const k = side < 0 ? "L" : "R";
  const d = FORT.step * S;
  NODES[`${k}1`] = { x: x0 + side * d, y: CY - d };            // crossbar, upper
  NODES[`${k}2`] = { x: x0 + side * d, y: CY };                // crossbar, middle
  NODES[`${k}3`] = { x: x0 + side * d, y: CY + d };            // crossbar, lower
  NODES[`${k}4`] = { x: x0 + side * 2 * d, y: CY - 2 * d };    // base, upper
  NODES[`${k}5`] = { x: x0 + side * 2 * d, y: CY };            // base, middle
  NODES[`${k}6`] = { x: x0 + side * 2 * d, y: CY + 2 * d };    // base, lower
};
mkFort(-1); mkFort(1);

const LANES = [
  // rows — row 3 belongs to the long centre lane at the end
  ["A1", "B1", "C1", "D1", "E1"],
  ["A2", "B2", "C2", "D2", "E2"],
  ["A4", "B4", "C4", "D4", "E4"],
  ["A5", "B5", "C5", "D5", "E5"],
  // columns
  ...COLS.map((c) => [1, 2, 3, 4, 5].map((r) => `${c}${r}`)),
  // the two long lattice diagonals
  ["A1", "B2", "C3", "D4", "E5"],
  ["A5", "B4", "C3", "D2", "E1"],
  // fort sides, each running straight on through the apex into the lattice
  ["L4", "L1", "A3", "B4", "C5"],
  ["L6", "L3", "A3", "B2", "C1"],
  ["C1", "D2", "E3", "R3", "R6"],
  ["C5", "D4", "E3", "R1", "R4"],
  // fort crossbars and bases
  ["L1", "L2", "L3"], ["L4", "L5", "L6"],
  ["R1", "R2", "R3"], ["R4", "R5", "R6"],
  // the centre line runs unbroken from one base to the other
  ["L5", "L2", "A3", "B3", "C3", "D3", "E3", "R2", "R5"],
];

const NODE_IDS = Object.keys(NODES);
const ADJ = {}, JUMPS = {}, EDGES = [];
NODE_IDS.forEach((n) => { ADJ[n] = []; JUMPS[n] = []; });
LANES.forEach((lane) => {
  for (let i = 0; i < lane.length - 1; i++) {
    const [a, b] = [lane[i], lane[i + 1]];
    EDGES.push([a, b]);
    ADJ[a].push(b); ADJ[b].push(a);
  }
  for (let i = 0; i < lane.length - 2; i++) {
    const [a, b, c] = [lane[i], lane[i + 1], lane[i + 2]];
    JUMPS[a].push([b, c]);
    JUMPS[c].push([b, a]);
  }
});

// Pieces shrink where the board tightens, so nothing ever overlaps.
const PIECE_R = {};
NODE_IDS.forEach((n) => {
  const d = Math.min(...ADJ[n].map((m) => Math.hypot(NODES[m].x - NODES[n].x, NODES[m].y - NODES[n].y)));
  PIECE_R[n] = Math.min(34, d * 0.44);
});

/* ============================================================================
   2. RULES
   ========================================================================== */

const DEFAULT_RULES = {
  mandatoryCapture: false,   // captures are offered, never forced
  multipleCapture: true,     // chains are offered too — you may stop any time
  winCondition: "eliminate_or_immobilise",
  drawAfterQuietMoves: 150,
};

const PLAYER_ONE_STARTING_NODES = [
  "D1", "D2", "D3", "D4", "D5", "E1", "E2", "E3", "E4", "E5",
  "R1", "R2", "R3", "R4", "R5", "R6",
];
const PLAYER_TWO_STARTING_NODES = [
  "A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3", "B4", "B5",
  "L1", "L2", "L3", "L4", "L5", "L6",
];

/* ============================================================================
   3. STATE
   ========================================================================== */

let seq = 0;
function newGame(rules = DEFAULT_RULES) {
  const board = {};
  PLAYER_ONE_STARTING_NODES.forEach((n) => (board[n] = { p: 1, id: `p${seq++}` }));
  PLAYER_TWO_STARTING_NODES.forEach((n) => (board[n] = { p: 2, id: `p${seq++}` }));
  return {
    board, turn: 1, chainFrom: null, captured: { 1: 0, 2: 0 },
    history: [], quiet: 0, winner: null, result: null, rules,
  };
}
const SHOWCASE = newGame();
const owner = (st, n) => (st.board[n] ? st.board[n].p : 0);
const countPieces = (st, p) => NODE_IDS.reduce((a, n) => a + (owner(st, n) === p ? 1 : 0), 0);

/* ============================================================================
   4. MOVE + CAPTURE
   ========================================================================== */

function capturesFrom(st, from) {
  const p = owner(st, from), out = [];
  for (const [over, to] of JUMPS[from])
    if (owner(st, over) && owner(st, over) !== p && !owner(st, to))
      out.push({ from, to, captured: over });
  return out;
}
const stepsFrom = (st, from) =>
  ADJ[from].filter((n) => !owner(st, n)).map((to) => ({ from, to, captured: null }));

function legalMoves(st, player = st.turn) {
  if (st.winner !== null) return [];
  if (st.chainFrom) return capturesFrom(st, st.chainFrom);
  const mine = NODE_IDS.filter((n) => owner(st, n) === player);
  const caps = mine.flatMap((n) => capturesFrom(st, n));
  if (caps.length && st.rules.mandatoryCapture) return caps;
  return [...caps, ...mine.flatMap((n) => stepsFrom(st, n))];
}
const movesForPiece = (st, node) => legalMoves(st).filter((m) => m.from === node);
const capturingPieces = (st) => {
  const s = new Set();
  legalMoves(st).forEach((m) => m.captured && s.add(m.from));
  return s;
};

function applyMove(st, move) {
  const board = { ...st.board };
  board[move.to] = board[move.from];
  delete board[move.from];
  const captured = { ...st.captured };
  if (move.captured) { delete board[move.captured]; captured[st.turn] += 1; }

  const next = {
    ...st, board, captured,
    quiet: move.captured ? 0 : st.quiet + 1,
    history: [...st.history, { player: st.turn, from: move.from, to: move.to, captured: move.captured || null }],
  };
  const chain = move.captured && st.rules.multipleCapture && capturesFrom(next, move.to).length > 0;
  next.chainFrom = chain ? move.to : null;
  next.turn = chain ? st.turn : st.turn === 1 ? 2 : 1;
  return evaluateEnd(next);
}

function endTurn(st) {
  return evaluateEnd({
    ...st,
    chainFrom: null,
    turn: st.turn === 1 ? 2 : 1,
    history: [...st.history, { player: st.turn, end: true }],
  });
}

/* ============================================================================
   5. WIN
   ========================================================================== */

function evaluateEnd(st) {
  const other = st.turn === 1 ? 2 : 1;
  if (countPieces(st, st.turn) === 0) return { ...st, winner: other, result: "elimination" };
  if (countPieces(st, other) === 0) return { ...st, winner: st.turn, result: "elimination" };
  if (st.rules.winCondition === "eliminate_or_immobilise" && legalMoves(st).length === 0)
    return { ...st, winner: other, result: "immobilised" };
  if (st.rules.drawAfterQuietMoves && st.quiet >= st.rules.drawAfterQuietMoves)
    return { ...st, winner: 0, result: "draw" };
  return st;
}

/* ============================================================================
   6. AI
   ========================================================================== */

const CENTRE = {};
NODE_IDS.forEach((n) => {
  CENTRE[n] = Math.max(0, 3.2 - Math.hypot(NODES[n].x - CX, NODES[n].y - CY) / S);
});

function evaluate(st, me) {
  const foe = me === 1 ? 2 : 1;
  if (st.winner === me) return 9000;
  if (st.winner === foe) return -9000;
  if (st.winner === 0) return 0;
  let s = 0;
  for (const n of NODE_IDS) {
    const o = owner(st, n);
    if (!o) continue;
    const sign = o === me ? 1 : -1;
    s += sign * 100;
    s += sign * CENTRE[n] * 4;
    s += sign * ADJ[n].filter((a) => !owner(st, a)).length * 1.5;
    for (const [over, to] of JUMPS[n])
      if (owner(st, over) && owner(st, over) !== o && !owner(st, to)) s += sign * 9;
  }
  return s;
}

function search(st, depth, alpha, beta, me, deadline) {
  if (st.winner !== null || depth === 0 || Date.now() > deadline) return evaluate(st, me);
  const moves = legalMoves(st);
  if (!moves.length) return evaluate(evaluateEnd(st), me);
  moves.sort((a, b) => (b.captured ? 1 : 0) - (a.captured ? 1 : 0));
  if (st.turn === me) {
    let best = -Infinity;
    for (const m of moves) {
      best = Math.max(best, search(applyMove(st, m), depth - 1, alpha, beta, me, deadline));
      alpha = Math.max(alpha, best);
      if (beta <= alpha) break;
    }
    return best;
  }
  let best = Infinity;
  for (const m of moves) {
    best = Math.min(best, search(applyMove(st, m), depth - 1, alpha, beta, me, deadline));
    beta = Math.min(beta, best);
    if (beta <= alpha) break;
  }
  return best;
}

function chooseMove(st, level) {
  const moves = legalMoves(st);
  if (!moves.length) return null;
  if (level === "easy") {
    const caps = moves.filter((m) => m.captured);
    const pool = caps.length && Math.random() < 0.7 ? caps : moves;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  const me = st.turn;
  const maxDepth = level === "hard" ? 6 : 3;
  const deadline = Date.now() + (level === "hard" ? 650 : 320);
  let best = moves[0];
  for (let d = 1; d <= maxDepth; d++) {
    let bm = null, bs = -Infinity;
    for (const m of moves) {
      const v = search(applyMove(st, m), d - 1, -Infinity, Infinity, me, deadline)
        + (level === "medium" ? Math.random() * 6 : 0);
      if (v > bs) { bs = v; bm = m; }
    }
    // a depth cut short by the clock is unreliable — keep the last full result
    if (Date.now() > deadline) break;
    if (bm) best = bm;
  }
  return best;
}

/* ============================================================================
   7. AUDIO — something audible on every single action
   ========================================================================== */

let AC = null;          // one context for the whole page
let ACdead = false;     // the sandbox refused to give us audio

function getAC() {
  if (ACdead) return null;
  try {
    if (!AC) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) { ACdead = true; return null; }
      AC = new C();
    }
    if (AC.state === "suspended") AC.resume();
    return AC;
  } catch { ACdead = true; return null; }
}

function useSound(on) {
  const primed = useRef(false);

  // Called on the first touch anywhere: builds the context inside a real
  // gesture and pushes one silent buffer through it, which is what iOS wants.
  const unlock = useCallback(() => {
    const c = getAC();
    if (!c || primed.current) return;
    try {
      const b = c.createBuffer(1, 1, 22050);
      const s = c.createBufferSource();
      s.buffer = b; s.connect(c.destination); s.start(0);
      primed.current = true;
    } catch { /* ignore */ }
  }, []);

  const play = useCallback((kind) => {
    if (!on) return;
    const c = getAC();
    if (!c) return;
    const now = c.currentTime;

    const tone = (f, dur, type, vol, delay = 0, f2) => {
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(f, now + delay);
      if (f2) o.frequency.exponentialRampToValueAtTime(f2, now + delay + dur);
      g.gain.setValueAtTime(0.0001, now + delay);
      g.gain.exponentialRampToValueAtTime(vol, now + delay + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, now + delay + dur);
      o.connect(g); g.connect(c.destination);
      o.start(now + delay); o.stop(now + delay + dur + 0.03);
    };
    const knock = (dur, vol, freq) => {
      const n = Math.max(1, Math.floor(c.sampleRate * dur));
      const buf = c.createBuffer(1, n, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
      const src = c.createBufferSource(); src.buffer = buf;
      const f = c.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = freq; f.Q.value = 1.1;
      const g = c.createGain(); g.gain.value = vol;
      src.connect(f); f.connect(g); g.connect(c.destination); src.start(now);
    };
    const buzz = (ms) => { try { navigator.vibrate && navigator.vibrate(ms); } catch { /* ignore */ } };

    if (kind === "select") { tone(900, 0.05, "triangle", 0.09); knock(0.05, 0.10, 2600); }
    if (kind === "move") { knock(0.10, 0.34, 1400); tone(300, 0.12, "triangle", 0.13, 0, 200); buzz(12); }
    if (kind === "capture") { knock(0.16, 0.50, 760); tone(150, 0.32, "sine", 0.26, 0, 68); tone(430, 0.10, "triangle", 0.09); buzz(35); }
    if (kind === "turn") tone(540, 0.07, "sine", 0.06);
    if (kind === "deny") tone(150, 0.11, "sawtooth", 0.06);
    if (kind === "win") [523, 622, 784, 1047].forEach((f, i) => tone(f, 0.55, "triangle", 0.12, i * 0.14));
  }, [on]);

  return { play, unlock, blocked: ACdead };
}

/* ============================================================================
   8. ONLINE ROOMS
   ----------------------------------------------------------------------------
   No game server. Both players are looking at the same published artifact, so
   the match lives in the artifact's shared storage under one key, and each
   client polls it. Only the ACTION LIST travels — never the board — so both
   sides replay the same moves and keep their own piece identities (and their
   own sliding animations).
   ========================================================================== */

const ALPHABET = "ACDEFHJKLMNPQRTUVWXY3479";
const makeCode = () =>
  Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
const roomKey = (code) => `match:${code}`;
const hasStorage = () => typeof window !== "undefined" && !!window.storage;

const encodeActions = (history) =>
  history.map((h) => (h.end ? { e: 1 } : { f: h.from, t: h.to, c: h.captured || 0 }));
const applyAction = (st, a) =>
  a.e ? endTurn(st) : applyMove(st, { from: a.f, to: a.t, captured: a.c || null });

async function roomGet(code) {
  try {
    const snapshot = await get(ref(database, roomKey(code)));
    return snapshot.exists() ? snapshot.val() : null;
  } catch (error) {
    console.error("Firebase roomGet error:", error);
    return null;
  }
}

async function roomSet(code, data) {
  try {
    await set(ref(database, roomKey(code)), data);
  } catch (error) {
    console.error("Firebase roomSet error:", error);
    throw error;
  }
}

/* ============================================================================
   9. RENDER
   ========================================================================== */

const T = {
  ink: "#0F0B09",
  line: "rgba(201,154,63,0.20)",
  brass: "#C99A3F",
  brassLit: "#F4D89A",
  lac: "#C0402F",
  jade: "#5FA98A",
  cream: "#EDE0C6",
  muted: "#9A8871",
  serif: '"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif',
  mono: 'ui-monospace,"SF Mono",Menlo,Consolas,monospace',
};
const META = {
  1: { name: "Ivory", swatch: "radial-gradient(circle at 34% 28%,#FFFDF6,#D6C7A6)" },
  2: { name: "Ebony", swatch: "radial-gradient(circle at 34% 28%,#454B47,#0A0C0B)" },
};

/* ---- one marble token ---------------------------------------------------- */
function Token({ p, r, sel }) {
  const k = r / 34;
  const vein = p === 1 ? "#B0A184" : "#9DB6A7";
  return (
    <g transform={`scale(${k * (sel ? 1.06 : 1)})`}>
      <ellipse cy="6" rx="33" ry="31" fill="#000" opacity="0.45" />
      <circle r="34" fill={p === 1 ? "url(#marbleW)" : "url(#marbleB)"} />
      <g clipPath="url(#pClip)" stroke={vein} fill="none" opacity={p === 1 ? 0.5 : 0.34} strokeLinecap="round">
        <path d="M-36 -12 C -16 -24, -2 2, 36 -8" strokeWidth="2.2" />
        <path d="M-30 14 C -10 4, 6 22, 34 12" strokeWidth="1.3" opacity="0.7" />
        <path d="M-8 -34 C -2 -14, -14 6, -4 34" strokeWidth="1" opacity="0.55" />
      </g>
      <circle r="34" fill="none" stroke="#000" strokeOpacity="0.4" strokeWidth="1.2" />
      <path d="M -23 -17 A 29 29 0 0 1 11 -30" fill="none" stroke="#fff" strokeOpacity="0.4" strokeWidth="3.4" strokeLinecap="round" />
      {p === 1 ? (
        <>
          <circle r="18" fill="none" stroke="#8A7550" strokeOpacity="0.5" strokeWidth="1.7" />
          <circle r="5.5" fill="#8A7550" fillOpacity="0.55" />
        </>
      ) : (
        <>
          <circle r="18" fill="none" stroke="#C6AE7C" strokeOpacity="0.42" strokeWidth="1.5" />
          {[0, 60, 120].map((a) => (
            <line key={a}
              x1={-16 * Math.cos((a * Math.PI) / 180)} y1={-16 * Math.sin((a * Math.PI) / 180)}
              x2={16 * Math.cos((a * Math.PI) / 180)} y2={16 * Math.sin((a * Math.PI) / 180)}
              stroke="#C6AE7C" strokeOpacity="0.4" strokeWidth="1.5" />
          ))}
        </>
      )}
    </g>
  );
}

/* ---- board --------------------------------------------------------------- */
function Board({ state, selected, moves, onNode, interactive = true, reduced, hint, canCapture }) {
  const targets = useMemo(() => {
    const m = {};
    moves.forEach((mv) => (m[mv.to] = mv.captured ? "capture" : "move"));
    return m;
  }, [moves]);

  const forts = ["L", "R"].map((k) => {
    const apex = k === "L" ? NODES.A3 : NODES.E3;
    return `${apex.x},${apex.y} ${NODES[k + "4"].x},${NODES[k + "4"].y} ${NODES[k + "6"].x},${NODES[k + "6"].y}`;
  });

  return (
    <svg viewBox="0 0 920 600" style={{ width: "100%", height: "auto", display: "block" }}>
      <defs>
        <linearGradient id="wood" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#5C3527" />
          <stop offset="48%" stopColor="#3D2018" />
          <stop offset="100%" stopColor="#24110D" />
        </linearGradient>
        <radialGradient id="sheen" cx="34%" cy="22%" r="82%">
          <stop offset="0%" stopColor="#BC8352" stopOpacity="0.30" />
          <stop offset="58%" stopColor="#000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.5" />
        </radialGradient>
        <radialGradient id="marbleW" cx="34%" cy="26%" r="76%">
          <stop offset="0%" stopColor="#FFFDF7" />
          <stop offset="58%" stopColor="#F0E6D2" />
          <stop offset="100%" stopColor="#C6B694" />
        </radialGradient>
        <radialGradient id="marbleB" cx="34%" cy="26%" r="76%">
          <stop offset="0%" stopColor="#4C534E" />
          <stop offset="55%" stopColor="#212724" />
          <stop offset="100%" stopColor="#080A09" />
        </radialGradient>
        <radialGradient id="brassG" cx="34%" cy="30%" r="72%">
          <stop offset="0%" stopColor="#F7E3AC" />
          <stop offset="100%" stopColor="#966D25" />
        </radialGradient>
        <clipPath id="pClip"><circle r="34" /></clipPath>
        <filter id="glow" x="-70%" y="-70%" width="240%" height="240%">
          <feGaussianBlur stdDeviation="5" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      <rect x="12" y="12" width="896" height="576" rx="26" fill="url(#wood)" />
      {Array.from({ length: 24 }).map((_, i) => (
        <path key={i} d={`M 16 ${26 + i * 24} q 230 ${(i % 3) - 1.5} 448 ${(i % 5) - 2} t 440 ${(i % 4) - 1.5}`}
          stroke="#000" strokeOpacity={0.05 + (i % 3) * 0.02} strokeWidth="1.2" fill="none" />
      ))}
      <rect x="12" y="12" width="896" height="576" rx="26" fill="url(#sheen)" />
      <rect x="12" y="12" width="896" height="576" rx="26" fill="none" stroke="#0A0504" strokeWidth="6" />
      <rect x="24" y="24" width="872" height="552" rx="18" fill="none" stroke={T.brass} strokeOpacity="0.26" strokeWidth="1.4" />

      {forts.map((p, i) => <polygon key={i} points={p} fill="#000" opacity="0.16" />)}

      <g strokeLinecap="round">
        {EDGES.map(([a, b], i) => (
          <line key={`g${i}`} x1={NODES[a].x} y1={NODES[a].y} x2={NODES[b].x} y2={NODES[b].y}
            stroke="#160B07" strokeOpacity="0.72" strokeWidth="6" />
        ))}
        {EDGES.map(([a, b], i) => (
          <line key={`l${i}`} x1={NODES[a].x} y1={NODES[a].y} x2={NODES[b].x} y2={NODES[b].y}
            stroke={T.brass} strokeOpacity="0.5" strokeWidth="2.2" />
        ))}
        {selected && moves.map((mv, i) => (
          <line key={`h${i}`} x1={NODES[mv.from].x} y1={NODES[mv.from].y} x2={NODES[mv.to].x} y2={NODES[mv.to].y}
            stroke={mv.captured ? T.lac : T.brassLit} strokeOpacity="0.9" strokeWidth="3" filter="url(#glow)" />
        ))}
        {hint && (
          <line x1={NODES[hint.from].x} y1={NODES[hint.from].y} x2={NODES[hint.to].x} y2={NODES[hint.to].y}
            stroke={T.jade} strokeWidth="4" strokeDasharray="10 8" filter="url(#glow)" />
        )}
      </g>

      {NODE_IDS.map((n) => (
        <g key={n}>
          <circle cx={NODES[n].x} cy={NODES[n].y} r="5.5" fill="url(#brassG)" />
          <circle cx={NODES[n].x} cy={NODES[n].y} r="2" fill="#3A2510" opacity="0.65" />
        </g>
      ))}

      {NODE_IDS.filter((n) => targets[n]).map((n) => {
        const cap = targets[n] === "capture";
        return (
          <g key={`t${n}`} className={cap && !reduced ? "pulse" : ""}>
            <circle cx={NODES[n].x} cy={NODES[n].y} r={cap ? PIECE_R[n] * 0.8 : PIECE_R[n] * 0.62}
              fill={cap ? T.lac : T.jade} fillOpacity="0.16"
              stroke={cap ? T.lac : T.jade} strokeWidth="2.6" />
            {cap && <circle cx={NODES[n].x} cy={NODES[n].y} r={PIECE_R[n] * 1.05} fill="none"
              stroke={T.lac} strokeOpacity="0.45" strokeWidth="1.3" />}
          </g>
        );
      })}

      {NODE_IDS.filter((n) => state.board[n]).map((n, i) => {
        const pc = state.board[n];
        const sel = selected === n;
        const armed = canCapture && canCapture.has(n);
        return (
          <g key={pc.id} style={{
            transform: `translate(${NODES[n].x}px, ${NODES[n].y}px)`,
            transition: reduced ? "none" : "transform 250ms cubic-bezier(.32,.72,.28,1)",
            cursor: interactive ? "pointer" : "default",
          }} onClick={(e) => { e.stopPropagation(); if (interactive) onNode(n); }}>
            <g className={reduced ? "" : "settle"} style={{ animationDelay: `${i * 12}ms` }}>
              {sel && <circle r={PIECE_R[n] + 8} fill="none" stroke={T.brassLit} strokeWidth="2.6" filter="url(#glow)" />}
              {armed && !sel && <circle r={PIECE_R[n] + 5} fill="none" stroke={T.lac} strokeOpacity="0.75" strokeWidth="2"
                strokeDasharray="4 6" className={reduced ? "" : "spin"} />}
              <Token p={pc.p} r={PIECE_R[n]} sel={sel} />
            </g>
          </g>
        );
      })}

      {NODE_IDS.filter((n) => targets[n]).map((n) => (
        <circle key={`hit${n}`} cx={NODES[n].x} cy={NODES[n].y} r={Math.max(26, PIECE_R[n])}
          fill="transparent" style={{ cursor: "pointer" }}
          onClick={(e) => { e.stopPropagation(); onNode(n); }} />
      ))}
    </svg>
  );
}

/* ---- atoms --------------------------------------------------------------- */
const Btn = ({ children, onClick, variant = "solid", style = {}, ...p }) => (
  <button onClick={onClick} style={{
    fontFamily: T.mono, fontSize: 12, letterSpacing: "0.14em", textTransform: "uppercase",
    padding: "14px 22px", borderRadius: 5, cursor: "pointer", minHeight: 46,
    border: variant === "solid" ? "1px solid #E9CE93" : `1px solid ${T.line}`,
    background: variant === "solid" ? "linear-gradient(180deg,#EBD199,#C39A45)" : "rgba(255,255,255,0.025)",
    color: variant === "solid" ? "#2A1A08" : T.muted, transition: "all 150ms ease", ...style,
  }} {...p}>{children}</button>
);
const Eyebrow = ({ children, color = T.muted }) => (
  <div style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: "0.28em", textTransform: "uppercase", color }}>{children}</div>
);

function PlayerBar({ player, state, active, label }) {
  const remaining = countPieces(state, player);
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 13, padding: "12px 16px", borderRadius: 6, flex: 1,
      border: `1px solid ${active ? "rgba(244,216,154,0.55)" : T.line}`,
      background: active ? "rgba(201,154,63,0.10)" : "rgba(255,255,255,0.015)", transition: "all 200ms ease",
    }}>
      <div style={{ width: 30, height: 30, borderRadius: "50%", flexShrink: 0, background: META[player].swatch, border: "1px solid rgba(0,0,0,0.45)" }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: T.serif, fontSize: 17, color: T.cream, lineHeight: 1.15 }}>{label}</div>
        <Eyebrow>{META[player].name} · {remaining} left</Eyebrow>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontFamily: T.mono, fontSize: 19, color: T.brassLit }}>{state.captured[player]}</div>
        <Eyebrow>taken</Eyebrow>
      </div>
    </div>
  );
}

const TUTORIAL = [
  { t: "Tap one of your soldiers", b: "Every line it can travel lights up. Those lines are the only routes on the board — nothing moves through empty space." },
  { t: "Move one point along a line", b: "A soldier slides to a neighbouring empty point. The centre column starts empty, so that is where the first moves go." },
  { t: "Jump to capture", b: "Enemy beside you, empty point directly beyond on the same line? Jump it. The enemy leaves the board — but you are never forced to take." },
  { t: "Chain if you want to", b: "After a jump you may jump again from where you landed, as long as more are available. Stop whenever you like and end your turn." },
  { t: "Win the board", b: "Take every enemy soldier, or leave your opponent with no legal move. Forts are safe but slow — a soldier at the tip has few ways out." },
];
function demoState(step) {
  const st = newGame(); st.board = {};
  const put = (n, p) => (st.board[n] = { p, id: n });
  if (step <= 1) { put("C3", 1); put("A1", 2); put("E5", 2); put("L5", 2); }
  else if (step === 2) { put("C4", 1); put("C3", 2); put("B2", 2); }
  else if (step === 3) { put("C2", 1); put("C3", 2); put("D4", 2); put("B4", 2); }
  else { put("C3", 1); put("B3", 2); put("D3", 1); }
  return st;
}

/* ---- app ----------------------------------------------------------------- */
export default function App() {
  const [screen, setScreen] = useState("home");
  const [mode, setMode] = useState("local");
  const [level, setLevel] = useState("medium");
  const [rules, setRules] = useState(DEFAULT_RULES);
  const [state, setState] = useState(() => newGame(DEFAULT_RULES));
  const [selected, setSelected] = useState(null);
  const [past, setPast] = useState([]);
  const [soundOn, setSoundOn] = useState(true);
  const [reduced, setReduced] = useState(false);
  const [panel, setPanel] = useState(null);
  const [step, setStep] = useState(0);
  const [narrow, setNarrow] = useState(false);
  const [clock, setClock] = useState(0);
  const [hint, setHint] = useState(null);
  const [note, setNote] = useState("");
  const [online, setOnline] = useState(null); // { code, role, joined, sync }
  const startRef = useRef(Date.now());
  const { play, unlock, blocked } = useSound(soundOn);

  useEffect(() => {
    const f = () => setNarrow(window.innerWidth < 940);
    f(); window.addEventListener("resize", f);
    setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    return () => window.removeEventListener("resize", f);
  }, []);
  useEffect(() => {
    if (screen !== "game" || state.winner !== null) return;
    const i = setInterval(() => setClock(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    return () => clearInterval(i);
  }, [screen, state.winner]);
  useEffect(() => { if (!hint) return; const t = setTimeout(() => setHint(null), 2200); return () => clearTimeout(t); }, [hint]);

  const moves = useMemo(() => (selected ? movesForPiece(state, selected) : []), [state, selected]);
  const armed = useMemo(() => capturingPieces(state), [state]);
  const aiTurn = mode === "ai" && state.turn === 2 && state.winner === null;
  const isOnline = mode === "online" && !!online;
  const myTurn = state.winner === null && (isOnline ? state.turn === online.role : !aiTurn);

  // Publish my action list to the shared room, never clobbering a longer one.
  const pushRoom = useCallback(async (next) => {
    if (!online) return;
    setOnline((o) => o && { ...o, sync: "saving" });
    try {
      const room = await roomGet(online.code);
      const mine = encodeActions(next.history);
      if (room && room.actions.length > mine.length) return; // they are ahead; next poll wins
      await roomSet(online.code, {
        v: 1, rules: next.rules, actions: mine,
        joined: room ? room.joined || online.role === 2 : online.role === 2,
        updated: Date.now(),
      });
      setOnline((o) => o && { ...o, sync: "ok" });
    } catch {
      setOnline((o) => o && { ...o, sync: "error" });
    }
  }, [online]);

  const commit = useCallback((mv) => {
    setPast((p) => [...p.slice(-60), state]);
    const next = applyMove(state, mv);
    play(mv.captured ? "capture" : "move");
    if (next.turn !== state.turn && next.winner === null) setTimeout(() => play("turn"), 200);
    if (next.winner !== null) setTimeout(() => play("win"), 320);
    setNote(mv.captured
      ? `${META[state.turn].name} captured a soldier at ${mv.captured}.`
      : `${META[state.turn].name} played ${mv.from} to ${mv.to}.`);
    setState(next);
    setSelected(next.chainFrom || null);
    setHint(null);
    if (mode === "online") pushRoom(next);
  }, [state, play, mode, pushRoom]);

  // Poll the room and replay whatever the other side has played.
  useEffect(() => {
    if (!isOnline || state.winner !== null) return;
    let alive = true;
    const tick = async () => {
      const room = await roomGet(online.code);
      if (!room || !alive) return;
      if (room.joined && !online.joined) setOnline((o) => o && { ...o, joined: true });
      if (room.actions.length > state.history.length) {
        let s = state;
        const fresh = room.actions.slice(state.history.length);
        for (const a of fresh) s = applyAction(s, a);
        play(fresh.some((a) => a.c) ? "capture" : "move");
        setState(s);
        setSelected(null);
        setNote("Your friend played.");
      }
    };
    tick();
    const iv = setInterval(tick, myTurn ? 6000 : 2500);
    return () => { alive = false; clearInterval(iv); };
  }, [isOnline, online, state, myTurn, play]);

  useEffect(() => {
    if (!aiTurn) return;
    const t = setTimeout(() => { const mv = chooseMove(state, level); if (mv) commit(mv); }, 320 + Math.random() * 420);
    return () => clearTimeout(t);
  }, [aiTurn, state, level, commit]);

  const onNode = (n) => {
    unlock();
    if (state.winner !== null || !myTurn) return;
    const mv = selected && moves.find((m) => m.to === n);
    if (mv) return commit(mv);
    if (owner(state, n) === state.turn) {
      if (state.chainFrom && state.chainFrom !== n) { play("deny"); return; }
      if (!movesForPiece(state, n).length) { play("deny"); setNote("That soldier has nowhere to go."); return; }
      play("select"); setSelected(n === selected ? null : n); return;
    }
    if (owner(state, n)) { play("deny"); setNote("That one belongs to your opponent."); }
    setSelected(state.chainFrom || null);
  };

  const stop = () => {
    play("turn");
    const next = endTurn(state);
    setState(next); setSelected(null); setNote("Turn ended.");
    if (mode === "online") pushRoom(next);
  };
  const askHint = () => { const mv = chooseMove(state, "medium"); if (mv) { setHint(mv); play("select"); } };
  const startMatch = (m, lv) => {
    unlock(); setMode(m); if (lv) setLevel(lv);
    setOnline(null);
    setState(newGame(rules)); setSelected(null); setPast([]); setNote("");
    startRef.current = Date.now(); setClock(0); setScreen("game");
  };

  const hostRoom = async () => {
    unlock();
    const code = makeCode();
    const fresh = newGame(rules);
    try {
      await roomSet(code, { v: 1, rules, actions: [], joined: false, updated: Date.now() });
    } catch {
      setNote("Online play only works in the published version of this game.");
      return false;
    }
    setMode("online"); setOnline({ code, role: 1, joined: false, sync: "ok" });
    setState(fresh); setSelected(null); setPast([]); setNote("");
    startRef.current = Date.now(); setClock(0); setPanel(null); setScreen("game");
    return true;
  };

  const joinRoom = async (raw) => {
    unlock();
    const code = raw.trim().toUpperCase();
    const room = await roomGet(code);
    if (!room) return "No match found with that code.";
    let s = newGame(room.rules || rules);
    for (const a of room.actions) s = applyAction(s, a);
    try {
      await roomSet(code, { ...room, joined: true, updated: Date.now() });
    } catch { return "Could not join. Try again."; }
    setMode("online"); setOnline({ code, role: 2, joined: true, sync: "ok" });
    setState(s); setSelected(null); setPast([]); setNote("You are Ebony, on the left.");
    startRef.current = Date.now(); setClock(0); setPanel(null); setScreen("game");
    return null;
  };
  const restart = () => {
    setState(newGame(rules)); setSelected(null); setPast([]); setPanel(null); setNote("");
    startRef.current = Date.now(); setClock(0);
  };
  const undo = () => {
    if (!past.length) return;
    const stack = [...past]; let s = stack.pop();
    if (mode === "ai") while (stack.length && s.turn !== 1) s = stack.pop();
    setPast(stack); setState(s); setSelected(null); setNote("Took a move back.");
  };
  const setRule = (k, v) => { const r = { ...rules, [k]: v }; setRules(r); setState((s) => ({ ...s, rules: r })); };

  const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  const label = (p) =>
    isOnline ? (p === online.role ? "You" : "Your friend")
    : mode === "ai" ? (p === 1 ? "You" : `Computer · ${level}`)
    : `Player ${p}`;
  const guidance = state.winner !== null ? "Match over."
    : isOnline && !online.joined ? "Send the code to your friend — the match starts when they join."
    : isOnline && !myTurn ? "Waiting for your friend's move…"
    : aiTurn ? "Computer is thinking…"
    : state.chainFrom ? "You can jump again from here — or end your turn."
    : selected ? "Tap a glowing point to move there."
    : armed.size ? `${armed.size} of your soldiers can capture. Taking is your choice.`
    : "Tap one of your soldiers to see where it can go.";

  const css = `
    .pulse{animation:pl 1.5s ease-in-out infinite}
    @keyframes pl{0%,100%{opacity:.55}50%{opacity:1}}
    .spin{animation:sp 9s linear infinite;transform-box:fill-box;transform-origin:center}
    @keyframes sp{to{transform:rotate(360deg)}}
    .settle{animation:st 420ms cubic-bezier(.2,.9,.25,1) both;transform-box:fill-box;transform-origin:center}
    @keyframes st{from{opacity:0;transform:scale(.5)}to{opacity:1;transform:scale(1)}}
    .rise{animation:rs 550ms cubic-bezier(.2,.8,.2,1) both}
    @keyframes rs{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
    button:hover{filter:brightness(1.12)}
    button:focus-visible{outline:2px solid ${T.brassLit};outline-offset:3px}
    ::-webkit-scrollbar{width:6px}::-webkit-scrollbar-thumb{background:${T.line};border-radius:3px}
    @media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
  `;
  const shell = {
    minHeight: "100vh", background: `radial-gradient(1100px 680px at 50% -8%,#241813 0%,${T.ink} 62%)`,
    color: T.cream, fontFamily: T.serif, boxSizing: "border-box",
    padding: narrow ? "16px 12px 26px" : "26px 30px 36px",
  };

  if (screen === "home") return (
    <div style={shell} onPointerDown={unlock}>
      <style>{css}</style>
      <div className="rise" style={{ maxWidth: 1120, margin: "0 auto", display: "grid",
        gridTemplateColumns: narrow ? "1fr" : "0.85fr 1.15fr", gap: narrow ? 26 : 50, alignItems: "center", minHeight: "84vh" }}>
        <div>
          <Eyebrow color={T.brass}>Sixteen soldiers · thirty-seven points</Eyebrow>
          <h1 style={{ fontSize: narrow ? 50 : 76, margin: "14px 0 0", lineHeight: 0.92, fontWeight: 400, letterSpacing: "-0.02em", color: "#F5E9D0" }}>
            Sholo<br />Guti
          </h1>
          <div style={{ height: 1, width: 84, background: T.brass, opacity: 0.6, margin: "20px 0" }} />
          <p style={{ fontSize: 18, lineHeight: 1.62, color: "#BCA98B", maxWidth: 420, margin: 0 }}>
            An ancient game of position, strategy and capture. Sixteen marble soldiers a side,
            a fort on each flank, and an empty column down the middle where the fighting starts.
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 30 }}>
            <Btn onClick={() => setScreen("setup")} style={{ padding: "17px 36px" }}>Play</Btn>
            <Btn variant="ghost" onClick={() => { setStep(0); setPanel("howto"); }}>How to play</Btn>
            <Btn variant="ghost" onClick={() => setPanel("about")}>About the board</Btn>
          </div>
        </div>
        <Board state={SHOWCASE} selected={null} moves={[]} onNode={() => {}} interactive={false} reduced />
      </div>
      {panel && <Overlay onClose={() => setPanel(null)}>
        {panel === "howto" ? <HowTo step={step} setStep={setStep} reduced={reduced} /> : <About />}
      </Overlay>}
    </div>
  );

  if (screen === "setup") return (
    <div style={shell} onPointerDown={unlock}>
      <style>{css}</style>
      <div className="rise" style={{ maxWidth: 620, margin: "7vh auto 0" }}>
        <Eyebrow color={T.brass}>Choose a match</Eyebrow>
        <h2 style={{ fontSize: 38, fontWeight: 400, margin: "10px 0 24px" }}>Who is sitting across from you?</h2>
        <div style={{ display: "grid", gap: 10 }}>
          <Card title="Play with a friend online" sub="One creates a room, the other joins with the code" onClick={() => setPanel("online")} />
          <Card title="Two players, one device" sub="Pass the board back and forth" onClick={() => startMatch("local")} />
          <Card title="Computer · Easy" sub="Plays legally, takes the obvious jumps" onClick={() => startMatch("ai", "easy")} />
          <Card title="Computer · Medium" sub="Thinks three moves ahead" onClick={() => startMatch("ai", "medium")} />
          <Card title="Computer · Hard" sub="Searches six moves deep" onClick={() => startMatch("ai", "hard")} />
        </div>
        <div style={{ marginTop: 22 }}><Btn variant="ghost" onClick={() => setScreen("home")}>Back</Btn></div>
      </div>
      {panel === "online" && <Overlay onClose={() => setPanel(null)}>
        <OnlinePanel onHost={hostRoom} onJoin={joinRoom} />
      </Overlay>}
    </div>
  );

  return (
    <div style={shell} onPointerDown={unlock}>
      <style>{css}</style>
      <div style={{ maxWidth: 1340, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, minWidth: 0 }}>
            <span style={{ fontSize: 21 }}>Sholo Guti</span>
            <Eyebrow>{mode === "ai" ? `vs computer · ${level}` : "two players"}</Eyebrow>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="ghost" onClick={() => { unlock(); setSoundOn(!soundOn); }} style={{ padding: "10px 14px" }}>
              {blocked ? "No audio" : soundOn ? "Sound on" : "Sound off"}</Btn>
            <Btn variant="ghost" onClick={() => setScreen("home")} style={{ padding: "10px 14px" }}>Menu</Btn>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <PlayerBar player={2} state={state} active={state.turn === 2} label={label(2)} />
          {!narrow && <PlayerBar player={1} state={state} active={state.turn === 1} label={label(1)} />}
        </div>

        <div style={{ display: "flex", gap: 18, alignItems: "flex-start", flexDirection: narrow ? "column" : "row" }}>
          <div style={{ position: "relative", flex: 1, minWidth: 0, width: "100%" }}>
            <Board state={state} selected={selected} moves={moves} onNode={onNode} hint={hint}
              canCapture={myTurn ? armed : null} interactive={myTurn} reduced={reduced} />
            {state.winner !== null && (
              <Victory state={state} clock={clock} mmss={mmss} label={label} onAgain={restart}
                onHome={() => { setScreen("home"); setPanel(null); }} />
            )}
          </div>

          <div style={{ width: narrow ? "100%" : 300, display: "flex", flexDirection: "column", gap: 10 }}>
            {isOnline && (
              <div style={{ border: `1px solid ${T.line}`, borderRadius: 6, padding: 14, background: "rgba(95,169,138,0.07)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <Eyebrow color={T.jade}>Room code</Eyebrow>
                  <Eyebrow color={online.sync === "error" ? T.lac : T.muted}>
                    {online.sync === "error" ? "not syncing" : online.joined ? "friend connected" : "waiting"}
                  </Eyebrow>
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 30, letterSpacing: "0.24em", color: T.cream, margin: "6px 0 4px" }}>
                  {online.code}
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>
                  You play {META[online.role].name}. Anyone with this code can open the match.
                </div>
              </div>
            )}
            <div style={{ border: `1px solid ${T.line}`, borderRadius: 6, padding: 15, background: "rgba(255,255,255,0.02)" }}>
              <Eyebrow color={T.brass}>{state.winner !== null ? "Match over" : `${label(state.turn)} to move`}</Eyebrow>
              <div style={{ fontSize: 20, marginTop: 7, lineHeight: 1.35, color: T.cream }}>{guidance}</div>
              {note && <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, marginTop: 8 }}>{note}</div>}
              <div style={{ display: "flex", gap: 20, marginTop: 12 }}>
                <div><Eyebrow>Move</Eyebrow><div style={{ fontFamily: T.mono, fontSize: 16 }}>{state.history.length}</div></div>
                <div><Eyebrow>Clock</Eyebrow><div style={{ fontFamily: T.mono, fontSize: 16 }}>{mmss(clock)}</div></div>
              </div>
              {state.chainFrom && !aiTurn && (
                <div style={{ marginTop: 12 }}><Btn onClick={stop} style={{ width: "100%" }}>End my turn</Btn></div>
              )}
            </div>

            <div style={{ border: `1px solid ${T.line}`, borderRadius: 6, background: "rgba(255,255,255,0.015)",
              maxHeight: narrow ? 140 : 210, overflow: "auto", padding: "12px 14px" }}>
              <Eyebrow color={T.brass}>Record</Eyebrow>
              {!state.history.length && <div style={{ color: T.muted, fontSize: 14, marginTop: 8 }}>No moves yet.</div>}
              <div style={{ fontFamily: T.mono, fontSize: 12.5, lineHeight: 1.85, marginTop: 6 }}>
                {state.history.map((h, i) => (
                  <div key={i} style={{ display: "flex", gap: 9, color: h.captured ? T.lac : "#C7B694" }}>
                    <span style={{ color: T.muted }}>{String(i + 1).padStart(2, "0")}</span>
                    <span>{h.player === 1 ? "I" : "E"}</span>
                    <span>{h.from} {h.captured ? "×" : "→"} {h.to}</span>
                    {h.captured && <span style={{ color: T.muted }}>({h.captured})</span>}
                  </div>
                ))}
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <Btn variant="ghost" onClick={askHint} disabled={!myTurn}>Show a move</Btn>
              <Btn variant="ghost" onClick={undo} disabled={!past.length || isOnline}
                style={{ opacity: past.length && !isOnline ? 1 : 0.4 }}>Undo</Btn>
              <Btn variant="ghost" onClick={restart} disabled={isOnline} style={{ opacity: isOnline ? 0.4 : 1 }}>Restart</Btn>
              <Btn variant="ghost" onClick={() => setPanel("settings")}>Settings</Btn>
            </div>
          </div>
        </div>

        {narrow && <div style={{ display: "flex", marginTop: 10 }}>
          <PlayerBar player={1} state={state} active={state.turn === 1} label={label(1)} />
        </div>}
      </div>

      {panel && <Overlay onClose={() => setPanel(null)}>
        {panel === "howto" && <HowTo step={step} setStep={setStep} reduced={reduced} />}
        {panel === "settings" && <Settings rules={rules} setRule={setRule} soundOn={soundOn} setSoundOn={setSoundOn}
          reduced={reduced} setReduced={setReduced} onRestart={restart} />}
      </Overlay>}
    </div>
  );
}

/* ---- supporting views ---------------------------------------------------- */
const Card = ({ title, sub, onClick, disabled }) => (
  <button onClick={disabled ? undefined : onClick} disabled={disabled} style={{
    textAlign: "left", padding: "17px 19px", borderRadius: 6, cursor: disabled ? "default" : "pointer",
    border: `1px solid ${T.line}`, background: "rgba(255,255,255,0.02)", color: "inherit",
    opacity: disabled ? 0.42 : 1, transition: "all 150ms ease",
  }}>
    <div style={{ fontFamily: T.serif, fontSize: 20 }}>{title}</div>
    <div style={{ fontFamily: T.mono, fontSize: 11, letterSpacing: "0.08em", color: T.muted, marginTop: 5 }}>{sub}</div>
  </button>
);

function Overlay({ children, onClose }) {
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(8,5,4,0.84)", backdropFilter: "blur(6px)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 18, zIndex: 40,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="rise" style={{
        background: "linear-gradient(180deg,#1C1512,#120D0B)", border: `1px solid ${T.line}`,
        borderRadius: 10, padding: 26, maxWidth: 640, width: "100%", maxHeight: "88vh", overflow: "auto",
      }}>
        {children}
        <div style={{ marginTop: 20 }}><Btn variant="ghost" onClick={onClose}>Close</Btn></div>
      </div>
    </div>
  );
}

function OnlinePanel({ onHost, onJoin }) {
  const [tab, setTab] = useState(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const available = true;

  const host = async () => { setBusy(true); setErr(""); const ok = await onHost(); if (!ok) setErr("Online play only works in the published version of this game."); setBusy(false); };
  const join = async () => {
    if (code.trim().length < 4) return setErr("Enter the full code.");
    setBusy(true); setErr("");
    const e = await onJoin(code); if (e) setErr(e);
    setBusy(false);
  };

  return (
    <div>
      <Eyebrow color={T.jade}>Play with a friend</Eyebrow>
      <h3 style={{ fontFamily: T.serif, fontSize: 28, fontWeight: 400, margin: "8px 0 8px" }}>Two phones, one board</h3>
      <p style={{ color: "#BCA98B", fontSize: 15.5, lineHeight: 1.6, margin: "0 0 16px" }}>
        Send your friend the link to this game, then one of you creates a room and reads out the
        code. Moves cross over in a couple of seconds. Anyone who has the code can open the match,
        so keep it between the two of you.
      </p>

      {!available && (
        <div style={{ border: `1px solid ${T.lac}`, borderRadius: 6, padding: 14, marginBottom: 14, color: "#E3B9AE", fontSize: 14 }}>
          This copy is running outside a published page, so rooms cannot sync. Publish the game first,
          then open the published link.
        </div>
      )}

      {tab === null && (
        <div style={{ display: "grid", gap: 10 }}>
          <Card title="Create a room" sub="You play Ivory and move first" onClick={host} disabled={busy || !available} />
          <Card title="Join with a code" sub="You play Ebony" onClick={() => setTab("join")} disabled={busy || !available} />
        </div>
      )}

      {tab === "join" && (
        <div>
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCDE" maxLength={6}
            style={{
              width: "100%", boxSizing: "border-box", padding: "16px 18px", borderRadius: 6,
              background: "rgba(255,255,255,0.04)", border: `1px solid ${T.line}`, color: T.cream,
              fontFamily: T.mono, fontSize: 26, letterSpacing: "0.28em", textAlign: "center", outline: "none",
            }} />
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <Btn onClick={join} style={{ flex: 1 }} disabled={busy}>{busy ? "Joining…" : "Join match"}</Btn>
            <Btn variant="ghost" onClick={() => { setTab(null); setErr(""); }}>Back</Btn>
          </div>
        </div>
      )}

      {err && <div style={{ fontFamily: T.mono, fontSize: 12, color: T.lac, marginTop: 12 }}>{err}</div>}
    </div>
  );
}

function HowTo({ step, setStep, reduced }) {
  const st = demoState(step);
  const sel = ["C3", "C3", "C4", "C2", "C3"][step];
  const s = TUTORIAL[step];
  return (
    <div>
      <Eyebrow color={T.brass}>Step {step + 1} of {TUTORIAL.length}</Eyebrow>
      <h3 style={{ fontFamily: T.serif, fontSize: 28, fontWeight: 400, margin: "8px 0 6px" }}>{s.t}</h3>
      <p style={{ color: "#BCA98B", fontSize: 16, lineHeight: 1.6, margin: "0 0 14px" }}>{s.b}</p>
      <Board state={st} selected={sel} moves={movesForPiece(st, sel)} onNode={() => {}} interactive={false} reduced={reduced} />
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <Btn variant="ghost" onClick={() => setStep(Math.max(0, step - 1))} style={{ opacity: step ? 1 : 0.4 }}>Previous</Btn>
        <Btn onClick={() => setStep(Math.min(TUTORIAL.length - 1, step + 1))} style={{ opacity: step === TUTORIAL.length - 1 ? 0.4 : 1 }}>Next step</Btn>
      </div>
    </div>
  );
}

const About = () => (
  <div>
    <Eyebrow color={T.brass}>About the board</Eyebrow>
    <h3 style={{ fontFamily: T.serif, fontSize: 28, fontWeight: 400, margin: "8px 0 12px" }}>Thirty-seven points</h3>
    <p style={{ color: "#BCA98B", fontSize: 16, lineHeight: 1.65 }}>
      Sixteen-soldier games are played across South Asia on a five-by-five lattice with a triangular
      fort on each flank. Names and house rules vary by region, and the boards are commonly painted
      on cloth or scratched into wood, stone or earth.
    </p>
    <p style={{ color: "#BCA98B", fontSize: 16, lineHeight: 1.65 }}>
      This build takes the painted lines themselves as its source of truth: each line is stored in
      order, and both the connections and the jump lanes are read off it. Nothing is inferred from
      how close two points happen to sit on screen.
    </p>
    <div style={{ fontFamily: T.mono, fontSize: 12, color: T.muted, marginTop: 14, lineHeight: 1.9 }}>
      <div>points · {NODE_IDS.length}</div>
      <div>lines · {EDGES.length}</div>
      <div>jump lanes · {Object.values(JUMPS).reduce((a, b) => a + b.length, 0)}</div>
      <div>soldiers · 16 + 16, centre column empty</div>
    </div>
  </div>
);

function Settings({ rules, setRule, soundOn, setSoundOn, reduced, setReduced, onRestart }) {
  const Row = ({ label, hint, on, toggle }) => (
    <button onClick={toggle} style={{
      display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
      padding: "15px 0", background: "none", border: "none", borderBottom: `1px solid ${T.line}`,
      color: "inherit", cursor: "pointer", textAlign: "left",
    }}>
      <span>
        <span style={{ fontFamily: T.serif, fontSize: 18 }}>{label}</span>
        <span style={{ display: "block", fontFamily: T.mono, fontSize: 11, color: T.muted, marginTop: 3 }}>{hint}</span>
      </span>
      <span style={{
        width: 46, height: 26, borderRadius: 13, flexShrink: 0, position: "relative", transition: "all 180ms ease",
        background: on ? "linear-gradient(180deg,#EBD199,#C39A45)" : "rgba(255,255,255,0.07)",
        border: `1px solid ${on ? "#E9CE93" : T.line}`,
      }}>
        <span style={{ position: "absolute", top: 2, left: on ? 22 : 2, width: 20, height: 20, borderRadius: "50%",
          background: on ? "#2A1A08" : "#7A6A55", transition: "left 180ms ease" }} />
      </span>
    </button>
  );
  return (
    <div>
      <Eyebrow color={T.brass}>Settings</Eyebrow>
      <h3 style={{ fontFamily: T.serif, fontSize: 28, fontWeight: 400, margin: "8px 0 8px" }}>House rules</h3>
      <Row label="Force the capture" hint="Off: taking is always your choice"
        on={rules.mandatoryCapture} toggle={() => setRule("mandatoryCapture", !rules.mandatoryCapture)} />
      <Row label="Chained jumps" hint="Keep jumping from where you land, stop when you like"
        on={rules.multipleCapture} toggle={() => setRule("multipleCapture", !rules.multipleCapture)} />
      <Row label="Blocked player loses" hint="Off: only elimination ends the match"
        on={rules.winCondition === "eliminate_or_immobilise"}
        toggle={() => setRule("winCondition", rules.winCondition === "eliminate" ? "eliminate_or_immobilise" : "eliminate")} />
      <Row label="Sound" hint="A tap on every move, a thud on every capture" on={soundOn} toggle={() => setSoundOn(!soundOn)} />
      <Row label="Reduced motion" hint="Pieces appear instead of sliding" on={reduced} toggle={() => setReduced(!reduced)} />
      <div style={{ marginTop: 18 }}><Btn onClick={onRestart}>Restart with these rules</Btn></div>
    </div>
  );
}

function Victory({ state, clock, mmss, label, onAgain, onHome }) {
  const w = state.winner;
  return (
    <div className="rise" style={{
      position: "absolute", inset: 0, background: "rgba(10,6,5,0.87)", backdropFilter: "blur(4px)",
      borderRadius: 26, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      textAlign: "center", padding: 22,
    }}>
      <Eyebrow color={T.brass}>
        {state.result === "draw" ? "Drawn" : state.result === "immobilised" ? "No legal moves left" : "Board cleared"}
      </Eyebrow>
      <div style={{ fontFamily: T.serif, fontSize: 44, margin: "10px 0 2px", color: "#F5E9D0" }}>
        {w === 0 ? "A draw" : `${label(w)} wins`}
      </div>
      <div style={{ fontFamily: T.mono, fontSize: 11.5, color: T.muted, letterSpacing: "0.12em", margin: "12px 0 22px" }}>
        {state.captured[1]} ivory captures · {state.captured[2]} ebony captures · {state.history.length} moves · {mmss(clock)}
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <Btn onClick={onAgain}>Play again</Btn>
        <Btn variant="ghost" onClick={onHome}>Main menu</Btn>
      </div>
    </div>
  );
}
