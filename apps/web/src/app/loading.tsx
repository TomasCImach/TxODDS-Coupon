export default function Loading() {
  return (
    <section className="empty-page" aria-live="polite" aria-busy="true">
      <p className="section-kicker">Reading confirmed state</p>
      <h1>Loading the match…</h1>
      <p className="lede">Checking GoalDrop projections and Solana Devnet.</p>
    </section>
  );
}
