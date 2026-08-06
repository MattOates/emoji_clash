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
    // Some networks never finish gathering; ship what we have.
    setTimeout(() => { pc.removeEventListener("icegatheringstatechange", done); resolve(); }, 4000);
  });
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
  accept(answerCode: string): Promise<void>;
  ready: Promise<Net>;
}

export async function createHost(useStun: boolean): Promise<HostSession> {
  const pc = new RTCPeerConnection(useStun ? ICE_WITH_STUN : ICE_LOCAL_ONLY);
  const ch = pc.createDataChannel("rts", { ordered: true });
  const ready = new Promise<Net>((resolve) => {
    ch.onopen = () => resolve(wrap(pc, ch));
  });
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  return {
    code: await pack({ t: "offer", sdp: pc.localDescription!.sdp }),
    async accept(answerCode: string) {
      const a = await unpack<{ t: string; sdp: string }>(answerCode);
      if (a.t !== "answer") throw new Error("That is a host code, not a join code.");
      await pc.setRemoteDescription({ type: "answer", sdp: a.sdp });
    },
    ready,
  };
}

export async function createGuest(offerCode: string, useStun: boolean): Promise<{ code: string; ready: Promise<Net> }> {
  const o = await unpack<{ t: string; sdp: string }>(offerCode);
  if (o.t !== "offer") throw new Error("That is a join code, not a host code.");
  const pc = new RTCPeerConnection(useStun ? ICE_WITH_STUN : ICE_LOCAL_ONLY);
  const ready = new Promise<Net>((resolve) => {
    pc.ondatachannel = (ev) => {
      ev.channel.onopen = () => resolve(wrap(pc, ev.channel));
      if (ev.channel.readyState === "open") resolve(wrap(pc, ev.channel));
    };
  });
  await pc.setRemoteDescription({ type: "offer", sdp: o.sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  return { code: await pack({ t: "answer", sdp: pc.localDescription!.sdp }), ready };
}
