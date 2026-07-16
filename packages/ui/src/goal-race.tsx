"use client";

import type { ReactNode } from "react";

export type RaceState =
  | "anticipation"
  | "opening"
  | "open"
  | "accepted"
  | "pending"
  | "confirmed"
  | "missed"
  | "expired"
  | "error";

export interface GoalRaceProps {
  state: RaceState;
  source: "live" | "demo";
  rewardAmount: string;
  tokenSymbol: string;
  remaining: number;
  countdown: number;
  winnerRank?: number;
  explorerUrl?: string;
  reducedMotion: boolean;
  action?: ReactNode;
}

const messages: Record<
  RaceState,
  { eyebrow: string; title: string; detail: string }
> = {
  anticipation: {
    eyebrow: "Match live",
    title: "The next goal unlocks a drop",
    detail: "Stay ready. Registration is your ticket into every funded round.",
  },
  opening: {
    eyebrow: "GOAL",
    title: "Opening the drop on Solana…",
    detail:
      "The celebration is live. Claims unlock only after the Round PDA is confirmed.",
  },
  open: {
    eyebrow: "GOAL — DROP OPEN",
    title: "First valid receipts race",
    detail:
      "Your click is not a win. GoalDrop confirms the final rank on-chain.",
  },
  accepted: {
    eyebrow: "Receipt secured",
    title: "Your request is in order",
    detail:
      "The signed receipt proves acceptance order, not victory. Settlement is next.",
  },
  pending: {
    eyebrow: "On-chain pending",
    title: "Checking the exact payout",
    detail:
      "We will only call this a win after the Claim PDA and token transfer confirm.",
  },
  confirmed: {
    eyebrow: "Confirmed winner",
    title: "The reward landed",
    detail:
      "Your rank and exact token transfer are now independently verifiable.",
  },
  missed: {
    eyebrow: "Round exhausted",
    title: "You missed this drop",
    detail:
      "No fee was charged to you. Stay registered for the next funded goal.",
  },
  expired: {
    eyebrow: "Window closed",
    title: "This round has expired",
    detail:
      "The on-chain two-minute timer is authoritative. The next goal may open another round.",
  },
  error: {
    eyebrow: "Connection issue",
    title: "We could not finish that request",
    detail:
      "Retrying is safe: duplicate intents return their original receipt.",
  },
};

export function GoalRace(props: GoalRaceProps) {
  const message = messages[props.state];
  const hasConfirmedProof = props.state === "confirmed";
  return (
    <section
      className={`goal-race state-${props.state} ${props.reducedMotion ? "reduced" : ""}`}
      aria-live="polite"
      aria-atomic="true"
    >
      {props.source === "demo" ? (
        <div className="simulation-label">SIMULATED DEVNET EVENT</div>
      ) : null}
      <div className="goal-race-glow" aria-hidden="true" />
      <p className="goal-race-eyebrow">{message.eyebrow}</p>
      <h2>{message.title}</h2>
      <p className="goal-race-detail">{message.detail}</p>
      <div className="race-metrics">
        <div>
          <span>Reward</span>
          <strong>
            {props.rewardAmount} {props.tokenSymbol}
          </strong>
        </div>
        <div>
          <span>Remaining</span>
          <strong>{Math.max(0, props.remaining)}</strong>
        </div>
        <div>
          <span>Window</span>
          <strong>{formatCountdown(props.countdown)}</strong>
        </div>
      </div>
      {hasConfirmedProof && props.winnerRank ? (
        <p className="winner-rank">
          Final on-chain rank <strong>#{props.winnerRank}</strong>
        </p>
      ) : null}
      {props.action ? <div className="race-action">{props.action}</div> : null}
      {hasConfirmedProof && props.explorerUrl ? (
        <a
          className="proof-link"
          href={props.explorerUrl}
          target="_blank"
          rel="noreferrer"
        >
          View on Solana Explorer <span aria-hidden="true">↗</span>
        </a>
      ) : null}
    </section>
  );
}

function formatCountdown(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}
