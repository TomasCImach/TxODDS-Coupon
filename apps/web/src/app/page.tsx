import Link from "next/link";
import { getFixtures } from "../lib/api";

export default async function HomePage() {
  const fixtures = await getFixtures();
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <p className="section-kicker">Live football × verifiable rewards</p>
          <h1>
            EVERY GOAL
            <br />
            IS A <em>RACE.</em>
          </h1>
          <p className="lede">
            Register before kickoff. When TxLINE detects a goal, a two-minute
            reward drop opens on Solana Devnet. Fast hands earn an auditable
            rank.
          </p>
          <div className="hero-actions">
            <Link className="primary-button" href="/demo">
              Launch Demo Mode
            </Link>
            <Link className="secondary-button" href="/sponsor">
              Build a campaign
            </Link>
          </div>
          <div className="hero-proof">
            <span>
              <b>GASLESS</b> for fans
            </span>
            <span>
              <b>120 SEC</b> per goal
            </span>
            <span>
              <b>ON-CHAIN</b> cap & payout
            </span>
          </div>
        </div>
        <div className="hero-stadium" aria-hidden="true">
          <div className="pitch">
            <i />
            <i />
            <i />
          </div>
          <div className="orb">GOAL</div>
          <div className="crowd-lines" />
        </div>
      </section>

      <section className="fixture-section">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Campaign discovery</p>
            <h2>Choose your match</h2>
          </div>
          <p>
            One sponsor campaign can reserve each normalized TxLINE fixture.
          </p>
        </div>
        <div className="fixture-grid">
          {fixtures.length ? (
            fixtures.map((fixture) => (
              <article className="fixture-card" key={fixture.fixtureId}>
                <div>
                  <span>{fixture.competition}</span>
                  <time dateTime={fixture.scheduledStart}>
                    {new Date(fixture.scheduledStart).toLocaleString("en", {
                      weekday: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                      timeZoneName: "short",
                    })}
                  </time>
                </div>
                <h3>
                  {fixture.home}
                  <i>vs</i>
                  {fixture.away}
                </h3>
                <p>
                  <span
                    className={`status-dot ${fixture.campaignState ?? "available"}`}
                  />{" "}
                  {fixture.campaign
                    ? `Campaign ${fixture.campaignState}`
                    : "Fixture slot available"}
                </p>
                {fixture.campaign ? (
                  <Link href={`/campaign/${fixture.campaign}`}>
                    View campaign →
                  </Link>
                ) : (
                  <Link href="/sponsor">Sponsor this match →</Link>
                )}
              </article>
            ))
          ) : (
            <article className="fixture-card showcase">
              <div>
                <span>WORLD CUP SHOWCASE</span>
                <time>Devnet demo ready</time>
              </div>
              <h3>
                Argentina<i>vs</i>Spain
              </h3>
              <p>
                <span className="status-dot active" /> Synthetic match · real
                economic path
              </p>
              <Link href="/demo">Open Demo Mode →</Link>
            </article>
          )}
        </div>
      </section>

      <section className="how-it-works">
        <div>
          <p className="section-kicker">No crypto maze</p>
          <h2>
            Three beats.
            <br />
            One unforgettable moment.
          </h2>
        </div>
        <ol>
          <li>
            <b>01</b>
            <span>
              <strong>Join before kickoff</strong>Use a device passkey, external
              Solana wallet, or temporary Instant Demo wallet.
            </span>
          </li>
          <li>
            <b>02</b>
            <span>
              <strong>React when the goal lands</strong>The drop unlocks only
              after its Round PDA confirms on Devnet.
            </span>
          </li>
          <li>
            <b>03</b>
            <span>
              <strong>Verify the outcome</strong>A signed receipt shows order;
              only a Claim PDA plus exact SPL transfer proves a win.
            </span>
          </li>
        </ol>
      </section>
    </>
  );
}
