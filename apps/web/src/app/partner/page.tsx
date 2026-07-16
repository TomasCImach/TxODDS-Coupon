import type { Metadata } from "next";
import Link from "next/link";
import { FanExperience } from "../../components/fan-experience";
import { getCampaign } from "../../lib/api";

export const metadata: Metadata = {
  title: "Partner embed",
  robots: { index: false, follow: false },
};
export default async function PartnerPage({
  searchParams,
}: {
  searchParams: Promise<{ campaign?: string }>;
}) {
  const { campaign: address } = await searchParams;
  const campaign = address ? await getCampaign(address) : null;
  return (
    <div className="partner-shell">
      <div className="partner-bar">
        <span>ACME SPORTS</span>
        <nav>Match centre · Lineups · Stats</nav>
        <b>Fan rewards by GoalDrop</b>
      </div>
      {campaign ? (
        <FanExperience initialCampaign={campaign} embedded />
      ) : (
        <section className="empty-page">
          <p className="section-kicker">Reusable product seam</p>
          <h1>The GoalDrop race, inside a partner match centre.</h1>
          <p>
            Add <code>?campaign=&lt;Devnet address&gt;</code> to render a live
            campaign with the same honest states and wallet paths.
          </p>
          <Link className="primary-button" href="/demo">
            Prepare demo campaign
          </Link>
        </section>
      )}
    </div>
  );
}
