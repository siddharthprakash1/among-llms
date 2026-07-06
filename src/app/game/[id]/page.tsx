import ReplayPlayer from "@/components/ReplayPlayer";
import LiveGame from "@/components/LiveGame";
import { getGame } from "@/lib/games";

export const dynamic = "force-dynamic";

export default async function GamePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const transcript = await getGame(id);
  if (transcript) return <ReplayPlayer transcript={transcript} />;
  // Not persisted — it may be a running (or just-finished) live game. The SSE
  // route handler owns the in-process live registry (Next renders RSC pages in a
  // separate module context, so the page can't read it reliably); let the client
  // connect and resolve live vs. not-found itself.
  return <LiveGame id={id} />;
}
