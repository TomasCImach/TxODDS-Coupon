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

export function DemoConsole() {
  const [session, setSession] = useState<StoredDemoSession | null>(null);
  const [status, setStatus] = useState("Ready for a synthetic Devnet match.");
  const [busy, setBusy] = useState(false);

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
    run(async () => {
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
    run(async () => {
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
    run(async () => {
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
  async function run(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Demo request failed";
      if (
        message.toLowerCase().includes("capability expired") ||
        message.toLowerCase().includes("no reward round remaining")
      )
        clearSession();
      setStatus(message);
    } finally {
      setBusy(false);
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
          {busy && !session ? "Preparing demo session…" : "Start demo session"}
        </button>
        <button
          type="button"
          className="goal-trigger"
          disabled={busy || !session || session.remainingGoals === 0}
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
      {session ? (
        <Link className="proof-link" href={`/campaign/${session.campaign}`}>
          Open the live fan experience →
        </Link>
      ) : (
        <p className="demo-status">
          A fresh funded campaign is prepared automatically when you start.
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
  return readApiJson<T>(response, "Demo service unavailable");
}
