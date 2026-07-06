import { notFound } from "next/navigation";
import ModelProfile from "@/components/ModelProfile";
import { assembleProfile } from "@/lib/stats";

export const dynamic = "force-dynamic";

export default async function ModelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const model = decodeURIComponent(id);
  const profile = await assembleProfile(model);
  if (!profile) notFound();

  return <ModelProfile profile={profile} />;
}
