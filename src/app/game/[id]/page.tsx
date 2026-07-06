import { notFound } from "next/navigation";
import ReplayPlayer from "@/components/ReplayPlayer";
import LiveGame from "@/components/LiveGame";
import { getGame } from "@/lib/games";
import { getLive } from "@/lib/live";

export const dynamic = "force-dynamic";

export default async function GamePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const transcript = await getGame(id);
  if (transcript) return <ReplayPlayer transcript={transcript} />;
  // Not persisted yet — if it's a live (running or just-finished) game, stream it.
  if (getLive(id)) return <LiveGame id={id} />;
  notFound();
}
