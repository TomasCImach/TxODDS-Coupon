import Link from "next/link";

export default function CampaignNotFound() {
  return (
    <section className="empty-page">
      <p className="section-kicker">Campaign unavailable</p>
      <h1>That drop is not on our Devnet board.</h1>
      <p>It may not be indexed yet, or the address may be incorrect.</p>
      <Link className="primary-button" href="/">
        Return to matches
      </Link>
    </section>
  );
}
