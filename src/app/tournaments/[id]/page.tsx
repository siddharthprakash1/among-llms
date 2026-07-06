import TournamentView from "@/components/TournamentView";

export const dynamic = "force-dynamic";

export default async function TournamentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TournamentView id={id} />;
}
