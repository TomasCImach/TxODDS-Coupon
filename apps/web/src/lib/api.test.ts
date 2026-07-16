import { describe, expect, it } from "vitest";
import { normalizeCampaign } from "./api";

describe("campaign API normalization", () => {
  it("preserves configured economics before any round opens", () => {
    const view = normalizeCampaign({
      campaign: {
        campaign: "campaign-address",
        fixture_id: "99",
        sponsor: "sponsor-address",
        state: "active",
        reward_mint: "mint-address",
        refund_wallet: "refund-address",
        scheduled_start: "2026-07-15T20:00:00Z",
        registration_deadline: "2026-07-15T20:00:00Z",
        expected_end: "2026-07-15T23:00:00Z",
        hard_expiry: "2026-07-16T04:00:00Z",
        terminal_reason: "none",
        required_funding: "5000",
        funded_amount: "5000",
        paid_amount: "0",
        refunded_amount: "0",
        external_inflow_total: "0",
        registration_count: 4,
        commitment: "confirmed",
        home_name: "Argentina",
        away_name: "Spain",
        competition_name: "World Cup",
        provider_status: "scheduled",
      },
      configuredRounds: [{ ordinal: 0, rewardAmount: "100", winnerCap: 50 }],
      rounds: [],
      explorer:
        "https://explorer.solana.com/address/campaign-address?cluster=devnet",
    });
    expect(view.configuredRounds).toEqual([
      { ordinal: 0, rewardAmount: "100", winnerCap: 50 },
    ]);
    expect(view.rounds).toEqual([]);
    expect(view.home).toBe("Argentina");
  });
});
