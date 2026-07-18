"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { browserApiOrigin, readApiJson } from "../lib/api";
import { track } from "../lib/analytics";
import {
  demoSessionStorageKey,
  parseStoredDemoSession,
  serializeDemoSession,
  type StoredDemoSession,
} from "../lib/demo-session";

export type DemoAction = "start" | "goal" | "complete";

export function DemoConsole() {
  const [session, setSession] = useState<StoredDemoSession | null>(null);
  const [status, setStatus] = useState("Ready for a synthetic Devnet match.");
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<DemoAction | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const restored = parseStoredDemoSession(
        window.sessionStorage.getItem(demoSessionStorageKey),
      );
      if (restored) {
        setSession(restored);
        setStatus(
          "Your active demo session was restored. Continue with the next goal.",
        );
      } else {
        window.sessionStorage.removeItem(demoSessionStorageKey);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const create = async () =>
    run("start", async () => {
      const result = await post<{
        id: string;
        campaign: string;
        expiresInSeconds: number;
        remainingGoals: number;
      }>("/v1/demo/sessions", {});
      const created = {
        id: result.id,
        campaign: result.campaign,
        expiresAt: Date.now() + result.expiresInSeconds * 1_000,
        remainingGoals: result.remainingGoals,
      };
      track("demo_session_started", { campaign: result.campaign });
      persistSession(created);
      setStatus(
        "Demo capability active for 15 minutes. Open the fan view, then trigger a goal.",
      );
    });
  const goal = async () =>
    run("goal", async () => {
      if (!session) return;
      const result = await post<{ remainingGoals: number }>(
        `/v1/demo/sessions/${encodeURIComponent(session.id)}/goal`,
        {},
      );
      track("demo_goal_triggered", { campaign: session.campaign });
      persistSession({ ...session, remainingGoals: result.remainingGoals });
      setStatus(
        "Synthetic goal accepted. The demo authority is opening a real on-chain reward round.",
      );
    });
  const complete = async () =>
    run("complete", async () => {
      if (!session) return;
      await post(
        `/v1/demo/sessions/${encodeURIComponent(session.id)}/complete`,
        {},
      );
      track("demo_completed", { campaign: session.campaign });
      clearSession();
      setStatus(
        "Demo completion queued. Open rounds remain claimable until their on-chain timers close.",
      );
    });
  async function run(action: DemoAction, work: () => Promise<void>) {
    setBusyAction(action);
    setError(null);
    try {
      await work();
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Demo request failed";
      if (shouldClearDemoSession(message)) clearSession();
      setError(message);
    } finally {
      setBusyAction(null);
    }
  }
  function persistSession(next: StoredDemoSession) {
    window.sessionStorage.setItem(
      demoSessionStorageKey,
      serializeDemoSession(next),
    );
    setSession(next);
  }
  function clearSession() {
    window.sessionStorage.removeItem(demoSessionStorageKey);
    setSession(null);
  }
  const busy = busyAction !== null;
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
      <p className="demo-controller-note">
        Each Start creates a fresh 15-minute demo controller. When a previous
        demo is completed or exhausted, GoalDrop can prepare a fresh funded
        campaign while earlier claims and proofs remain auditable on Devnet.
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
          {busyAction === "start" ? busyLabel("start") : "Start demo session"}
        </button>
        <button
          type="button"
          className="goal-trigger"
          disabled={busy || !session || session.remainingGoals === 0}
          onClick={() => void goal()}
        >
          <span>{busyAction === "goal" ? "OPENING…" : "GOAL"}</span>
          <small>
            {busyAction === "goal"
              ? busyLabel("goal")
              : "Open next funded round"}
          </small>
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={busy || !session}
          onClick={() => void complete()}
        >
          {busyAction === "complete"
            ? busyLabel("complete")
            : "Complete demo match"}
        </button>
      </div>
      <p className="demo-status" aria-live="polite">
        {status}
      </p>
      {error ? (
        <div className="error-banner" role="alert">
          <strong>Demo action failed</strong>
          <span>{error}</span>
        </div>
      ) : null}
      {session ? (
        <Link className="proof-link" href={`/campaign/${session.campaign}`}>
          Open the live fan experience →
        </Link>
      ) : (
        <p className="demo-status">
          Start a controller to prepare or resume the available Devnet demo
          campaign.
        </p>
      )}
    </section>
  );
}

export function busyLabel(action: DemoAction): string {
  return {
    start: "Starting fresh controller…",
    goal: "Submitting synthetic goal…",
    complete: "Completing demo match…",
  }[action];
}

export function shouldClearDemoSession(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("capability expired") ||
    normalized.includes("no reward round remaining")
  );
}

async function post<T = unknown>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${browserApiOrigin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readApiJson<T>(response, "Demo service unavailable");
}
