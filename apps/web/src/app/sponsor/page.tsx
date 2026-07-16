import type { Metadata } from "next";
import { SponsorDashboard } from "../../components/sponsor-dashboard";
import { getFixtures } from "../../lib/api";

export const metadata: Metadata = {
  title: "Sponsor dashboard",
  description: "Configure and prefund a GoalDrop campaign on Solana Devnet.",
};
export default async function SponsorPage() {
  return <SponsorDashboard fixtures={await getFixtures()} />;
}
