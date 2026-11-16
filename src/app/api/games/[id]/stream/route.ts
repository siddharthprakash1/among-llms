import {
  decisionsRemaining,
  decisionsThrough,
  getLive,
  isSealed,
  parseLastEventId,
  subscribeLive,
} from "@/lib/live";
import { delayFor } from "@/lib/pacing";
import { getGame } from "@/lib/games";
import { DecisionRecord, GameEvent, Transcript } from "@/lib/engine/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PING_MS = 20_000;

// SSE for a game. Emits `meta` (players/config), then paced events from
// Last-Event-ID+1, tailing live events until game_over. Serves both running
// (in-registry) and finished (persisted) games, so joins/reconnects just work.
// Reasoning records ride along as named `decision` frames with no `id:` line,
// written just before the event they are anchored to, so Last-Event-ID stays an
// event index and clients that predate the inspector ignore them.
// A stream that can never produce another event ends with a named `end` frame
// (`not_found` or `abandoned`) so the viewer stops reconnecting.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const lastId = parseLastEventId(req.headers.get("last-event-id"));
  const enc = new TextEncoder();

  // Shared with cancel(), which runs outside start().
  let closed = false;
  let ending = false;
  let tailing = false; // true only on the live-registry path
  let unsub = () => {};
  let ping: ReturnType<typeof setInterval> | undefined;
  let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;

  const safeClose = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    unsub();
    try {
      ctrl?.close();
    } catch {
      /* already closed or errored */
    }
  };
  // A throw from enqueue means the consumer is gone; never let it escape a timer.
  const send = (chunk: string) => {
    if (closed) return;
    try {
      ctrl!.enqueue(enc.encode(chunk));
    } catch {
      safeClose();
    }
  };
  const sendEnd = (reason: "not_found" | "abandoned") => {
    if (closed || ending) return;
    ending = true;
    unsub();
    send(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
    setTimeout(safeClose, 60); // same flush delay as after game_over
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      ctrl = controller;
      const sendMeta = (m: unknown) => send(`event: meta\ndata: ${JSON.stringify(m)}\n\n`);
      let decisionSource: () => DecisionRecord[] = () => [];
      let cursor = 0;
      const sendDecisions = (out: { send: DecisionRecord[]; cursor: number }) => {
        cursor = out.cursor;
        for (const d of out.send) send(`event: decision\ndata: ${JSON.stringify(d)}\n\n`);
      };
      const write = (ev: GameEvent, index: number) => {
        if (closed) return;
        sendDecisions(decisionsThrough(decisionSource(), cursor, index, lastId));
        send(`id: ${index}\ndata: ${JSON.stringify(ev)}\n\n`);
      };

      const queue: { ev: GameEvent; index: number }[] = [];
      let draining = false;

      const drain = async () => {
        if (draining) return;
        draining = true;
        while (queue.length && !closed && !ending) {
          const { ev, index } = queue.shift()!;
          write(ev, index);
          if (ev.kind === "game_over") {
            unsub();
            setTimeout(safeClose, 60);
            draining = false;
            return;
          }
          await sleep(delayFor(ev));
        }
        draining = false;
        // Stream exhausted with no game_over — close if the game is no longer running.
        if (!closed && !ending && queue.length === 0) {
          const g = getLive(id);
          if (!g || g.status !== "running") {
            // An abandoned game can leave decisions (passes, a witch hold) with no
            // event after them; they are not persisted, so this is their only way out.
            sendDecisions(decisionsRemaining(decisionSource(), cursor, lastId));
            if (g?.status === "abandoned") sendEnd("abandoned");
            else safeClose();
          }
        }
      };
      const enqueue = (ev: GameEvent, index: number) => {
        if (index > lastId) {
          queue.push({ ev, index });
          void drain();
        }
      };

      // SSE comments are ignored by EventSource. The ping keeps a quiet
      // real-model game alive through proxy idle timeouts; because it also keeps
      // dead streams alive, the same tick is what ends them. It is the only
      // thing that notices a game abandoned while this viewer's queue was empty.
      ping = setInterval(() => {
        send(": ping\n\n");
        if (closed || ending || !tailing || draining || queue.length > 0) return;
        const g = getLive(id);
        if (g?.status === "abandoned") {
          sendDecisions(decisionsRemaining(decisionSource(), cursor, lastId));
          sendEnd("abandoned");
        } else if (!g || g.status !== "running") safeClose(); // nothing more can arrive
      }, PING_MS);
      ping.unref?.();

      req.signal.addEventListener("abort", () => safeClose());

      const live = getLive(id);
      if (live) {
        // A running human game is sealed: the god stream (and its decision
        // frames) would let the player peek from a second tab.
        if (isSealed(live)) {
          sendMeta({ id, status: "running", sealed: true });
          safeClose();
          return;
        }
        tailing = true;
        decisionSource = () => live.decisions ?? [];
        sendMeta({
          id,
          createdAt: live.createdAt,
          config: live.config,
          players: live.players,
          status: live.status,
        });
        if (live.status === "running") {
          unsub = subscribeLive(id, (ev, index) => enqueue(ev, index));
        }
        for (let i = 0; i < live.events.length; i++) enqueue(live.events[i], i);
        void drain(); // nothing left to send to this client: still flush and close if the game is over
        return;
      }

      let t: Transcript | null;
      try {
        t = await getGame(id);
      } catch {
        // A store error is transient: no `end`, so EventSource retries instead
        // of the viewer being told the game does not exist.
        safeClose();
        return;
      }
      if (closed) return;
      if (!t) {
        sendEnd("not_found");
        return;
      }
      decisionSource = () => t.decisions ?? [];
      sendMeta({ id, createdAt: t.createdAt, config: t.config, players: t.players, status: "finished" });
      for (let i = 0; i < t.events.length; i++) enqueue(t.events[i], i);
      void drain();
    },
    cancel() {
      safeClose();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
