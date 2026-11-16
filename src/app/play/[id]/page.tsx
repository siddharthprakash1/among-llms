import PlayGame from "@/components/PlayGame";

export const dynamic = "force-dynamic";

export default async function PlayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PlayGame id={id} />;
}
