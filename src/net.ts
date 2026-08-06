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
const CONNECT_TIMEOUT = 25000;

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
    const peer = new Peer(NAMESPACE + code);
    let settled = false;
    peer.on("open", () => log?.("Room open — waiting for your opponent…"));
    peer.on("connection", (conn) => {
      if (settled) { conn.close(); return; } // one opponent per room
      conn.on("open", () => {
        settled = true;
        log?.("Opponent connected.");
        resolve(wrap(peer, conn));
      });
    });
    peer.on("error", (err) => { if (!settled) reject(fail(peer, err)); });
  });
}

/** Walk into somebody else's room. */
export function joinRoom(code: string, log?: (s: string) => void): Promise<Net> {
  return new Promise((resolve, reject) => {
    const peer = new Peer();
    let settled = false;
    const giveUp = setTimeout(() => {
      if (!settled) reject(fail(peer, { message: "timed out — the host may be behind a NAT that needs a relay" }));
    }, CONNECT_TIMEOUT);
    peer.on("open", () => {
      log?.("Found the broker, knocking on the room…");
      const conn = peer.connect(NAMESPACE + code, { reliable: true });
      conn.on("open", () => {
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
