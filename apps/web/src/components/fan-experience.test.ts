import { describe, expect, it } from "vitest";
import type { CampaignRound } from "../lib/api";
import {
  isRoundSelectionLocked,
  partitionRounds,
  shouldAutoFocusRound,
} from "./fan-experience";

function round(ordinal: number, state: CampaignRound["state"]): CampaignRound {
  return {
    round: `round-${ordinal}`,
    ordinal,
    source: "live",
    openedAt: "2026-07-18T12:00:00.000Z",
    closesAt: "2026-07-18T12:02:00.000Z",
    rewardAmount: "1000000",
    winnerCap: 3,
    winnerCount: 0,
    state,
    commitment: "confirmed",
  };
}

describe("fan round hierarchy", () => {
  it("keeps open rounds current and preserves past-round order", () => {
    const expired = round(0, "expired");
    const current = round(1, "open");
    const exhausted = round(2, "exhausted");

    expect(partitionRounds([expired, current, exhausted])).toEqual({
      current: [current],
      past: [expired, exhausted],
    });
  });

  it("locks round selection throughout an in-flight claim", () => {
    expect(isRoundSelectionLocked(null)).toBe(false);
    expect(isRoundSelectionLocked("preparing")).toBe(true);
    expect(isRoundSelectionLocked("approval")).toBe(true);
    expect(isRoundSelectionLocked("submitting")).toBe(true);
  });

  it("defers SSE round auto-focus only while a claim is active", () => {
    expect(shouldAutoFocusRound(true)).toBe(false);
    expect(shouldAutoFocusRound(false)).toBe(true);
  });
});
