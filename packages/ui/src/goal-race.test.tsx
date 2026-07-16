import { describe, expect, it } from "vitest";
import { GoalRace } from "./goal-race";

describe("GoalRace", () => {
  it("renders an honest pending state without declaring or linking a winner", () => {
    const element = GoalRace({
      state: "pending",
      source: "live",
      rewardAmount: "5",
      tokenSymbol: "GOAL",
      remaining: 4,
      countdown: 38,
      winnerRank: 1,
      explorerUrl: "https://explorer.solana.com/tx/example?cluster=devnet",
      reducedMotion: false,
    });

    expect(element.props.className).toContain("state-pending");
    expect(JSON.stringify(element)).toContain("On-chain pending");
    expect(JSON.stringify(element)).not.toContain("Confirmed winner");
    expect(JSON.stringify(element)).not.toContain("Final on-chain rank");
    expect(JSON.stringify(element)).not.toContain("View on Solana Explorer");
  });

  it("exposes every honest lifecycle announcement and labels demo state", () => {
    const expected = {
      anticipation: "The next goal unlocks a drop",
      opening: "Opening the drop on Solana",
      open: "First valid receipts race",
      accepted: "Your request is in order",
      pending: "Checking the exact payout",
      confirmed: "The reward landed",
      missed: "You missed this drop",
      expired: "This round has expired",
      error: "We could not finish that request",
    } as const;

    for (const [state, title] of Object.entries(expected)) {
      const element = GoalRace({
        state: state as keyof typeof expected,
        source: "demo",
        rewardAmount: "5",
        tokenSymbol: "GOAL",
        remaining: 1,
        countdown: 120,
        winnerRank: state === "confirmed" ? 1 : undefined,
        explorerUrl:
          state === "confirmed"
            ? "https://explorer.solana.com/tx/example?cluster=devnet"
            : undefined,
        reducedMotion: true,
      });
      const rendered = JSON.stringify(element);
      expect(rendered).toContain(title);
      expect(rendered).toContain("SIMULATED DEVNET EVENT");
      expect(element.props.className).toContain("reduced");
    }
  });
});
