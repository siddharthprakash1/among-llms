import { getLive, subscribeLive } from "@/lib/live";
import { getGame } from "@/lib/games";
import { GameEvent } from "@/lib/engine/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Paced emission so mock games (which simulate instantly) still feel live, and
// real-model games stream at their natural thinking speed.
function delayFor(ev: GameEvent): number {
  switch (ev.kind) {
    case "statement":
      return 1500;
    case "accusation":
    case "defense":
      return 1200;
    case "phase":
      return 900;
    case "death":
      return 1300;
    case "wolf_chat":
      return 900;
    case "seer_check":
    case "doctor_save":
    case "witch_action":
      return 800;
    case "wolf_kill":
      return 700;
    case "vote":
      return 350;
    case "vote_result":
      return 900;
    case "game_over":
      return 500;
    default:
      return 600;
  }
}

// SSE for a game. Emits `meta` (players/config), then paced events from
// Last-Event-ID+1, tailing live events until game_over. Serves both running
// (in-registry) and finished (persisted) games, so joins/reconnects just work.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const lastId = Number(req.headers.get("last-event-id") ?? "-1");
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const safeClose = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const sendMeta = (m: unknown) => {
        if (!closed) controller.enqueue(enc.encode(`event: meta\ndata: ${JSON.stringify(m)}\n\n`));
      };
      const write = (ev: GameEvent, index: number) => {
        if (!closed) controller.enqueue(enc.encode(`id: ${index}\ndata: ${JSON.stringify(ev)}\n\n`));
      };

      const queue: { ev: GameEvent; index: number }[] = [];
      let draining = false;
      let unsub = () => {};

      const drain = async () => {
        if (draining) return;
        draining = true;
        while (queue.length && !closed) {
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
        if (!closed && queue.length === 0) {
          const g = getLive(id);
          if (!g || g.status !== "running") safeClose();
        }
      };
      const enqueue = (ev: GameEvent, index: number) => {
        if (index > lastId) {
          queue.push({ ev, index });
          void drain();
        }
      };

      req.signal.addEventListener("abort", () => {
        unsub();
        safeClose();
      });

      const live = getLive(id);
      if (live) {
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
        return;
      }

      const t = await getGame(id);
      if (!t) {
        safeClose();
        return;
      }
      sendMeta({ id, createdAt: t.createdAt, config: t.config, players: t.players, status: "finished" });
      for (let i = 0; i < t.events.length; i++) enqueue(t.events[i], i);
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
