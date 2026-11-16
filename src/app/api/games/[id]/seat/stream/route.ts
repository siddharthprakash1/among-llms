import { parseLastEventId, subscribeSeat } from "@/lib/live";
import { delayFor } from "@/lib/pacing";
import { armPrompt, seatMeta, seatStatus, verifySeat } from "@/lib/human/seat";
import type { GameEvent } from "@/lib/engine/types";
import type { SeatEvent } from "@/lib/human/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PING_MS = 15_000;
const MAX_LIVE_DELAY_MS = 800;

type Item = { type: "event"; ev: SeatEvent; seq: number; live: boolean } | { type: "state" };

// Per-seat SSE. Fed only from the seat's projected buffer (never the raw event
// log), so it carries nothing the seat's role may not know, and no decision
// frames. One ordered queue per connection: a `seat` status item for a new
// prompt is always queued behind the events the player must read first, and the
// prompt's clock starts only when that item is written.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const v = verifySeat(id, req.headers.get("cookie"));
  if (!v.ok) {
    return Response.json(
      { error: v.status === 401 ? "This seat belongs to another browser." : "Game not found" },
      { status: v.status }
    );
  }
  const { game, seat } = v;
  const enc = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsub = () => {};
      let ping: ReturnType<typeof setInterval> | null = null;
      const queue: Item[] = [];
      let draining = false;

      const onState = () => {
        queue.push({ type: "state" });
        void drain();
      };
      cleanup = () => {
        if (closed) return;
        closed = true;
        if (ping) clearInterval(ping);
        unsub();
        seat.stateListeners.delete(onState);
        try {
          controller.close();
        } catch {
          /* already closed or cancelled */
        }
      };
      // Every write goes through here, so a write after close or cancel is a
      // no-op instead of an uncaught exception in a timer.
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          cleanup();
        }
      };

      const lastId = Math.min(
        parseLastEventId(req.headers.get("last-event-id")),
        seat.events.length - 1
      );
      let written = lastId + 1;

      async function drain() {
        if (draining) return;
        draining = true;
        try {
          while (queue.length && !closed) {
            const item = queue.shift()!;
            if (item.type === "event") {
              send(`id: ${item.seq}\ndata: ${JSON.stringify(item.ev)}\n\n`);
              written = item.seq + 1;
              if (item.ev.kind === "game_over") {
                unsub();
                await sleep(60);
                cleanup();
                return;
              }
              if (item.live) {
                await sleep(
                  item.ev.kind === "seat_reveal"
                    ? 600
                    : Math.min(delayFor(item.ev as GameEvent), MAX_LIVE_DELAY_MS)
                );
              }
            } else {
              const pending = seat.pending;
              if (pending && pending.prompt.afterSeq <= written) armPrompt(id, pending.prompt.id);
              send(`event: seat\ndata: ${JSON.stringify(seatStatus(seat, written))}\n\n`);
              if (game.status === "abandoned") {
                cleanup();
                return;
              }
            }
          }
          if (!closed && queue.length === 0 && game.status !== "running") cleanup();
        } catch {
          cleanup();
        } finally {
          draining = false;
        }
      }

      req.signal.addEventListener("abort", () => cleanup());

      send(`event: meta\ndata: ${JSON.stringify(seatMeta(game))}\n\n`);
      if (game.status === "abandoned") {
        cleanup();
        return;
      }

      // No await between these: the backlog, the first state item and the live
      // subscriptions must form one gapless sequence.
      for (let i = lastId + 1; i < seat.events.length; i++) {
        queue.push({ type: "event", ev: seat.events[i], seq: i, live: false });
      }
      queue.push({ type: "state" });
      unsub = subscribeSeat(id, (ev, seq) => {
        queue.push({ type: "event", ev, seq, live: true });
        void drain();
      });
      seat.stateListeners.add(onState);
      ping = setInterval(() => send(": ping\n\n"), PING_MS);
      ping.unref?.();
      void drain();
    },
    cancel() {
      cleanup();
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
