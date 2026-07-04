import { notFound } from "next/navigation";
import ReplayPlayer from "@/components/ReplayPlayer";
import { getGame } from "@/lib/games";

export const dynamic = "force-dynamic";

export default async function GamePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const transcript = await getGame(id);
  if (!transcript) notFound();
  return <ReplayPlayer transcript={transcript} />;
}
