import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { FanExperience } from "../../../components/fan-experience";
import { getCampaign } from "../../../lib/api";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string }>;
}): Promise<Metadata> {
  const { address } = await params;
  return {
    title: `Live campaign ${address.slice(0, 6)}…`,
    description: "Register gaslessly and race the next GoalDrop reward round.",
  };
}

export default async function CampaignPage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  const campaign = await getCampaign(address);
  if (!campaign) notFound();
  return <FanExperience initialCampaign={campaign} />;
}
