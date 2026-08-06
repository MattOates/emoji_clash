// Peer-to-peer transport, brokered by PeerJS.
//
// WebRTC cannot bootstrap itself: the host needs the guest's ICE credentials,
// DTLS fingerprint and an address before a single byte can flow, so somebody
// has to introduce them. This uses PeerJS's public broker for that introduction
// and nothing else — the host claims a short room code as its peer id, guests
// connect to it by name, and once the data channel is open the broker is out of
// the picture entirely. No game traffic ever touches a server.
//
// The trade is honest: signalling depends on a free third-party service. If
// 0.peerjs.com is down, nobody can be introduced — though matches already in
// progress carry on regardless.

import Peer, { type DataConnection } from "peerjs";

// No look-alike characters: these codes get read down phone calls.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const NAMESPACE = "emojiclash-"; // keeps us out of other apps' id space
const CONNECT_TIMEOUT = 45000;

// PeerJS ships its own free TURN servers, but they are heavily shared and drop
// out often — and "introduced by the broker, then cannot connect" is exactly
// what a missing relay looks like. Two peers on one LAN hit this too: Chrome
// hides local addresses behind mDNS .local candidates, and if mDNS is blocked
// the only fallback is STUN, which needs a router willing to hairpin traffic
// back inside. Many will not. So a second, independent relay is listed, with
// TCP/443 last because it looks like ordinary HTTPS and survives networks that
// drop everything else.
const ICE: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "turn:eu-0.turn.peerjs.com:3478", username: "peerjs", credential: "peerjsp" },
  { urls: "turn:us-0.turn.peerjs.com:3478", username: "peerjs", credential: "peerjsp" },
  { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
];
const PEER_OPTS = { debug: 2, config: { iceServers: ICE, iceCandidatePoolSize: 4 } };

export function newRoomCode(): string {
  const r = new Uint8Array(5);
  crypto.getRandomValues(r);
  let s = "";
  for (const b of r) s += ALPHABET[b % ALPHABET.length];
  return s;
}

export interface Net {
  send(msg: unknown): void;
  onMessage: ((msg: any) => void) | null;
  onClose: (() => void) | null;
  close(): void;
  stats(): { rtt: number };
}

function wrap(peer: Peer, conn: DataConnection): Net {
  let handler: ((m: any) => void) | null = null;
  let rtt = 0;
  const backlog: any[] = [];
  const net: Net = {
    // Anything arriving before a handler is attached is held, not dropped —
    // the start-of-match handshake depends on it.
    get onMessage() { return handler; },
    set onMessage(fn: ((m: any) => void) | null) {
      handler = fn;
      if (fn) while (backlog.length) fn(backlog.shift());
    },
    onClose: null,
    send(msg) { if (conn.open) conn.send(msg); },
    close() { conn.close(); peer.destroy(); },
    stats: () => ({ rtt }),
  };
  conn.on("data", (data: any) => {
    if (data?.t === "ping") { net.send({ t: "pong", at: data.at }); return; }
    if (data?.t === "pong") { rtt = Date.now() - data.at; return; }
    if (handler) handler(data);
    else backlog.push(data);
  });
  conn.on("close", () => net.onClose?.());
  conn.on("error", () => net.onClose?.());
  const beat = setInterval(() => {
    if (conn.open) net.send({ t: "ping", at: Date.now() });
    else { clearInterval(beat); net.onClose?.(); }
  }, 1000);
  return net;
}

/** Resolve as soon as the channel is usable.
 *
 *  `conn.on("open")` is not safe on its own for an *incoming* connection:
 *  PeerJS can emit "connection" for a channel that is already open, and the
 *  open event never fires again, so a host waiting on it waits forever. Check
 *  the flag first, then fall back to the event. */
function whenOpen(conn: DataConnection, go: () => void) {
  if (conn.open) { go(); return; }
  conn.on("open", go);
}

/** Narrate the underlying ICE state, which is the only way to tell "the broker
 *  never introduced us" apart from "we were introduced but cannot reach each
 *  other". Those need completely different fixes. */
function traceIce(conn: DataConnection, who: string, log?: (s: string) => void) {
  if (!log) return;
  const pc = conn.peerConnection;
  if (!pc) return;
  const report = () => {
    const st = pc.iceConnectionState;
    if (st === "checking") log(`${who}: introduced, trying to reach each other…`);
    else if (st === "connected" || st === "completed") {
      pc.getStats().then((stats) => {
        let via = "";
        stats.forEach((r: any) => {
          if (r.type === "candidate-pair" && r.state === "succeeded" && r.localCandidateId) {
            stats.forEach((c: any) => { if (c.id === r.localCandidateId) via = c.candidateType; });
          }
        });
        log(`${who}: connected${via ? " via " + (via === "relay" ? "a TURN relay" : via) : ""}.`);
      }).catch(() => log(`${who}: connected.`));
    }
    else if (st === "failed") log(`${who}: could not reach the other browser — you are behind NATs that need a TURN relay.`);
    else if (st === "disconnected") log(`${who}: connection lost.`);
  };
  pc.addEventListener("iceconnectionstatechange", report);
  report();
}

function fail(peer: Peer, err: any): Error {
  peer.destroy();
  const type = err?.type ?? "";
  if (type === "unavailable-id") return new Error("that room code is already taken — try another");
  if (type === "peer-unavailable") return new Error("no such room — check the code, or the host may have closed it");
  if (type === "browser-incompatible") return new Error("this browser cannot do WebRTC data channels");
  if (type === "network" || type === "server-error") return new Error("could not reach the matchmaking broker");
  return new Error(err?.message ?? String(err));
}

/** Claim a room code and wait for somebody to walk in. */
export function hostRoom(code: string, log?: (s: string) => void): Promise<Net> {
  return new Promise((resolve, reject) => {
    const peer = new Peer(NAMESPACE + code, PEER_OPTS);
    let settled = false;
    peer.on("open", () => log?.("Room open — waiting for your opponent…"));
    peer.on("connection", (conn) => {
      if (settled) { conn.close(); return; } // one opponent per room
      log?.("Someone is joining…");
      traceIce(conn, "host", log);
      whenOpen(conn, () => {
        if (settled) return;
        settled = true;
        clearTimeout(giveUp);
        log?.("Opponent connected.");
        resolve(wrap(peer, conn));
      });
      conn.on("error", (err) => log?.("host: " + String((err as any)?.message ?? err)));
    });
    peer.on("error", (err) => { if (!settled) { clearTimeout(giveUp); reject(fail(peer, err)); } });
    const giveUp = setTimeout(() => {
      if (!settled) reject(fail(peer, { message: "nobody managed to connect — if they saw the room, you are both behind NATs that need a TURN relay" }));
    }, 120000);
  });
}

/** Walk into somebody else's room. */
export function joinRoom(code: string, log?: (s: string) => void): Promise<Net> {
  return new Promise((resolve, reject) => {
    const peer = new Peer(PEER_OPTS);
    let settled = false;
    const giveUp = setTimeout(() => {
      if (!settled) reject(fail(peer, { message: "timed out waiting for the channel to open — check the console for PeerJS and ICE lines" }));
    }, CONNECT_TIMEOUT);
    peer.on("open", () => {
      log?.("Found the broker, knocking on the room…");
      const conn = peer.connect(NAMESPACE + code, { reliable: true });
      traceIce(conn, "guest", log);
      whenOpen(conn, () => {
        if (settled) return;
        settled = true;
        clearTimeout(giveUp);
        log?.("Connected.");
        resolve(wrap(peer, conn));
      });
      conn.on("error", (err) => { if (!settled) { clearTimeout(giveUp); reject(fail(peer, err)); } });
    });
    peer.on("error", (err) => { if (!settled) { clearTimeout(giveUp); reject(fail(peer, err)); } });
  });
}
