import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy notice" };

export default function PrivacyPage() {
  return (
    <article className="legal-page">
      <p className="section-kicker">Devnet MVP privacy notice</p>
      <h1>Minimal data. Public chain.</h1>
      <p className="lede">
        GoalDrop is a hackathon demonstration on Solana Devnet. It is not a
        production financial service, and its promotional test tokens have no
        represented monetary value.
      </p>

      <h2>What the service processes</h2>
      <p>
        To register, claim, transfer, and show campaign history, the service
        processes public Solana wallet addresses, signed intent hashes,
        transaction signatures, campaign and round identifiers, and the
        resulting public Devnet account state. Solana transactions and addresses
        are public and may remain available independently of GoalDrop.
      </p>

      <h2>Passkeys and wallet providers</h2>
      <p>
        A selected passkey or external wallet provider handles its own
        authentication and key material under that provider&apos;s terms.
        GoalDrop asks the wallet to sign an exact digest or transaction. The
        GoalDrop API does not receive biometrics, passkey private keys, seed
        phrases, or wallet private keys. Instant Demo keys stay in browser
        session storage and are deleted when disconnected or when the session
        ends.
      </p>

      <h2>Analytics, cookies, and retention</h2>
      <p>
        Product analytics are first-party and cookieless. A random identifier
        exists only in session storage, Global Privacy Control disables
        collection, and the event API rejects wallet addresses, signatures,
        nonces, destination addresses, passkey metadata, and similar sensitive
        properties. Session events are deleted after 30 days. Short-lived intent
        challenges and demo sessions expire automatically. Derived public event
        replay is kept for at most 24 hours.
      </p>

      <h2>TxLINE data</h2>
      <p>
        Public pages receive only minimal derived fixture and campaign state.
        Credentials and raw provider records stay server-side. Optional
        diagnostic raw records are disabled by default; if explicitly enabled,
        they are encrypted and their payload bytes are automatically deleted
        within 24 hours while a one-way digest and normalized audit decision
        remain.
      </p>

      <h2>Your choices</h2>
      <p>
        You may use an external wallet, a device passkey wallet, or the
        temporary Instant Demo path. You may enable Global Privacy Control to
        disable analytics. Avoid using a wallet address that you do not want
        associated with public Devnet activity.
      </p>
    </article>
  );
}
