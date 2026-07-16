"use client";

import { useState } from "react";
import Link from "next/link";
import { browserApiOrigin } from "../lib/api";
import { track } from "../lib/analytics";

export function DemoConsole({ campaign }: { campaign: string | null }) {
  const [session, setSession] = useState<string | null>(null);
  const [status, setStatus] = useState("Ready for a synthetic Devnet match.");
  const [busy, setBusy] = useState(false);
  const create = async () =>
    run(async () => {
      const result = await post<{ id: string; campaign: string }>(
        "/v1/demo/sessions",
        {},
      );
      track("demo_session_started", { campaign: result.campaign });
      setSession(result.id);
      setStatus(
        "Demo capability active for 15 minutes. Open the fan view, then trigger a goal.",
      );
    });
  const goal = async () =>
    run(async () => {
      if (!session) return;
      await post(`/v1/demo/sessions/${encodeURIComponent(session)}/goal`, {});
      track("demo_goal_triggered", { ...(campaign ? { campaign } : {}) });
      setStatus(
        "Synthetic goal accepted. The demo authority is opening a real on-chain reward round.",
      );
    });
  const complete = async () =>
    run(async () => {
      if (!session) return;
      await post(
        `/v1/demo/sessions/${encodeURIComponent(session)}/complete`,
        {},
      );
      track("demo_completed", { ...(campaign ? { campaign } : {}) });
      setSession(null);
      setStatus(
        "Demo completion queued. Open rounds remain claimable until their on-chain timers close.",
      );
    });
  async function run(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Demo request failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="demo-console">
      <div className="simulation-label">SIMULATED DEVNET EVENT</div>
      <p className="section-kicker">Judge control room</p>
      <h1>
        Trigger the moment.
        <br />
        Audit the real path.
      </h1>
      <p className="lede">
        Demo Mode never fakes a winner. It submits the program’s demo-authority
        instruction, then uses the same registration, receipt, settlement, SPL
        vault, and Claim PDA path.
      </p>
      <div className="demo-timeline">
        <span className={session ? "done" : "active"}>1 · Session</span>
        <span className={session ? "active" : ""}>2 · Goal</span>
        <span>3 · Claim</span>
        <span>4 · Proof</span>
      </div>
      <div className="demo-actions">
        <button
          type="button"
          className="primary-button"
          disabled={busy || Boolean(session)}
          onClick={() => void create()}
        >
          Start demo session
        </button>
        <button
          type="button"
          className="goal-trigger"
          disabled={busy || !session}
          onClick={() => void goal()}
        >
          <span>GOAL</span>
          <small>Open next funded round</small>
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={busy || !session}
          onClick={() => void complete()}
        >
          Complete demo match
        </button>
      </div>
      <p className="demo-status" aria-live="polite">
        {status}
      </p>
      {campaign ? (
        <Link className="proof-link" href={`/campaign/${campaign}`}>
          Open the live fan experience →
        </Link>
      ) : (
        <p className="inline-error">
          Set NEXT_PUBLIC_DEMO_CAMPAIGN after preparing the pre-funded Devnet
          campaign.
        </p>
      )}
    </section>
  );
}

async function post<T = unknown>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${browserApiOrigin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as T & { message?: string };
  if (!response.ok)
    throw new Error(result.message ?? "Demo service unavailable");
  return result;
}
