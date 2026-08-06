// Serverless peer-to-peer transport.
//
// There is no signalling server: the SDP offer/answer is compressed into a
// short code that the two players exchange by any means they like (chat, SMS,
// shouting across the room). Once the data channel opens, nothing else is
// contacted for the rest of the match.

const PREFIX = "RTS1:";

const ICE_WITH_STUN: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478" },
  ],
};
// LAN / same-machine play: no external host is contacted at all.
const ICE_LOCAL_ONLY: RTCConfiguration = { iceServers: [] };

async function pack(obj: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const cs = new CompressionStream("deflate-raw");
  const wr = cs.writable.getWriter();
  void wr.write(bytes);
  void wr.close();
  const buf = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return PREFIX + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function unpack<T>(code: string): Promise<T> {
  const body = code.trim().replace(/\s+/g, "").replace(new RegExp("^" + PREFIX), "");
  const b64 = body.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const ds = new DecompressionStream("deflate-raw");
  const wr = ds.writable.getWriter();
  void wr.write(bytes);
  void wr.close();
  const text = await new Response(ds.readable).text();
  return JSON.parse(text) as T;
}

/** Resolve once ICE gathering finishes, so the code we hand over is complete
 *  and no trickle channel is needed. */
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState !== "complete") return;
      pc.removeEventListener("icegatheringstatechange", done);
      resolve();
    };
    pc.addEventListener("icegatheringstatechange", done);
    // Some networks never finish gathering; ship what we have. Eight seconds
    // because a slow or partly-blocked STUN server can take longer than four.
    setTimeout(() => { pc.removeEventListener("icegatheringstatechange", done); resolve(); }, 8000);
  });
}

/** What kinds of address made it into the description. No `srflx` line means
 *  STUN never answered, and the code will only ever work on a local network —
 *  worth saying out loud instead of letting the connection hang. */
export function candidateKinds(sdp: string): { host: number; srflx: number; relay: number } {
  const kinds = { host: 0, srflx: 0, relay: 0 };
  for (const line of sdp.match(/a=candidate:.*/g) ?? []) {
    if (line.includes(" typ host")) kinds.host++;
    else if (line.includes(" typ srflx")) kinds.srflx++;
    else if (line.includes(" typ relay")) kinds.relay++;
  }
  return kinds;
}

export interface Net {
  send(msg: unknown): void;
  onMessage: ((msg: any) => void) | null;
  onClose: (() => void) | null;
  close(): void;
  stats(): { rtt: number };
}

function wrap(pc: RTCPeerConnection, ch: RTCDataChannel): Net {
  let handler: ((m: any) => void) | null = null;
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
    send(msg) {
      if (ch.readyState === "open") ch.send(JSON.stringify(msg));
    },
    close() { ch.close(); pc.close(); },
    stats: () => ({ rtt: rtt }),
  };
  let rtt = 0;
  ch.onmessage = (ev) => {
    const msg = JSON.parse(ev.data as string);
    if (msg.t === "ping") { net.send({ t: "pong", at: msg.at }); return; }
    if (msg.t === "pong") { rtt = Date.now() - msg.at; return; }
    if (handler) handler(msg);
    else backlog.push(msg);
  };
  ch.onclose = () => net.onClose?.();
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") net.onClose?.();
  };
  setInterval(() => net.send({ t: "ping", at: Date.now() }), 1000);
  return net;
}

export interface HostSession {
  code: string;
  kinds: ReturnType<typeof candidateKinds>;
  accept(answerCode: string): Promise<void>;
  ready: Promise<Net>;
}

/** Report ICE progress and give up loudly rather than silently never opening. */
function watch(pc: RTCPeerConnection, log?: (s: string) => void) {
  if (!log) return;
  pc.addEventListener("iceconnectionstatechange", () => {
    const st = pc.iceConnectionState;
    if (st === "checking") log("Punching through NAT…");
    else if (st === "connected" || st === "completed") log("Connected.");
    else if (st === "failed") {
      log("Could not reach the other browser. You are probably both behind " +
          "NATs that need a relay — try again on the same network, or with STUN enabled.");
    } else if (st === "disconnected") log("Connection dropped.");
  });
}

export async function createHost(useStun: boolean, log?: (s: string) => void): Promise<HostSession> {
  const pc = new RTCPeerConnection(useStun ? ICE_WITH_STUN : ICE_LOCAL_ONLY);
  watch(pc, log);
  const ch = pc.createDataChannel("rts", { ordered: true });
  const ready = new Promise<Net>((resolve) => {
    ch.onopen = () => resolve(wrap(pc, ch));
  });
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  return {
    code: await pack({ t: "offer", sdp: pc.localDescription!.sdp }),
    kinds: candidateKinds(pc.localDescription!.sdp),
    async accept(answerCode: string) {
      const a = await unpack<{ t: string; sdp: string }>(answerCode);
      if (a.t !== "answer") throw new Error("That is a host code, not a join code.");
      await pc.setRemoteDescription({ type: "answer", sdp: a.sdp });
    },
    ready,
  };
}

export async function createGuest(offerCode: string, useStun: boolean, log?: (s: string) => void):
    Promise<{ code: string; kinds: ReturnType<typeof candidateKinds>; ready: Promise<Net> }> {
  const o = await unpack<{ t: string; sdp: string }>(offerCode);
  if (o.t !== "offer") throw new Error("That is a join code, not a host code.");
  const pc = new RTCPeerConnection(useStun ? ICE_WITH_STUN : ICE_LOCAL_ONLY);
  watch(pc, log);
  const ready = new Promise<Net>((resolve) => {
    pc.ondatachannel = (ev) => {
      // Wrap exactly once. Wrapping twice installed a second onmessage handler
      // over the first, while the promise had already resolved with the first
      // wrapper — so every inbound message went to a handler nobody had set.
      let wrapped: Net | null = null;
      const settle = () => {
        if (wrapped) return;
        wrapped = wrap(pc, ev.channel);
        resolve(wrapped);
      };
      ev.channel.onopen = settle;
      if (ev.channel.readyState === "open") settle();
    };
  });
  await pc.setRemoteDescription({ type: "offer", sdp: o.sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  return {
    code: await pack({ t: "answer", sdp: pc.localDescription!.sdp }),
    kinds: candidateKinds(pc.localDescription!.sdp),
    ready,
  };
}
