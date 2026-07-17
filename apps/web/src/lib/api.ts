export const serverApiOrigin =
  process.env.API_ORIGIN ??
  process.env.NEXT_PUBLIC_API_ORIGIN ??
  "http://localhost:4000";
export const browserApiOrigin =
  process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

export async function readApiJson<T>(
  response: Response,
  fallbackMessage: string,
): Promise<T> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(
      "GoalDrop API returned a non-JSON response. Check that the API is running on port 4000 and NEXT_PUBLIC_API_ORIGIN points to it.",
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("GoalDrop API returned malformed JSON.");
  }
  if (!response.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "message" in payload &&
      typeof payload.message === "string"
        ? payload.message
        : `${fallbackMessage} (${response.status})`;
    throw new Error(message);
  }
  return payload as T;
}

export interface FixtureSummary {
  fixtureId: string;
  home: string;
  away: string;
  competition: string;
  scheduledStart: string;
  providerStatus: string;
  fixtureSlotAvailable: boolean;
  campaign: string | null;
  campaignState: string | null;
}

export interface CampaignRound {
  round: string;
  ordinal: number;
  source: "live" | "demo";
  openedAt: string;
  closesAt: string;
  rewardAmount: string;
  winnerCap: number;
  winnerCount: number;
  state: "open" | "exhausted" | "expired";
  commitment: "processed" | "confirmed" | "finalized";
}

export interface CampaignView {
  campaign: string;
  fixtureId: string;
  sponsor: string;
  state: string;
  rewardMint: string;
  refundWallet: string;
  scheduledStart: string;
  registrationDeadline: string;
  expectedEnd: string;
  hardExpiry: string;
  terminalReason: string;
  requiredFunding: string;
  fundedAmount: string;
  paidAmount: string;
  refundedAmount: string;
  externalInflowTotal: string;
  registrationCount: number;
  commitment: string;
  explorer: string;
  rounds: CampaignRound[];
  configuredRounds: {
    ordinal: number;
    rewardAmount: string;
    winnerCap: number;
  }[];
  home: string;
  away: string;
  competition: string;
  providerStatus: string;
}

export async function getFixtures(): Promise<FixtureSummary[]> {
  try {
    const response = await fetch(`${serverApiOrigin}/v1/fixtures`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    const payload = await readApiJson<{ fixtures: FixtureSummary[] }>(
      response,
      "Fixture API unavailable",
    );
    return payload.fixtures;
  } catch {
    return [];
  }
}

export async function getCampaign(
  address: string,
): Promise<CampaignView | null> {
  try {
    const response = await fetch(
      `${serverApiOrigin}/v1/campaigns/${encodeURIComponent(address)}`,
      { cache: "no-store", signal: AbortSignal.timeout(3_000) },
    );
    if (!response.ok) return null;
    const data = await readApiJson<{
      campaign: Record<string, unknown>;
      rounds: Record<string, unknown>[];
      configuredRounds: {
        ordinal: number;
        rewardAmount: string;
        winnerCap: number;
      }[];
      explorer: string;
    }>(response, "Campaign API unavailable");
    return normalizeCampaign(data);
  } catch {
    return null;
  }
}

export function normalizeCampaign(data: {
  campaign: Record<string, unknown>;
  rounds: Record<string, unknown>[];
  configuredRounds: {
    ordinal: number;
    rewardAmount: string;
    winnerCap: number;
  }[];
  explorer: string;
}): CampaignView {
  const c = data.campaign;
  const text = (key: string) => String(c[key] ?? "");
  return {
    campaign: text("campaign"),
    fixtureId: text("fixture_id"),
    sponsor: text("sponsor"),
    state: text("state"),
    rewardMint: text("reward_mint"),
    refundWallet: text("refund_wallet"),
    scheduledStart: text("scheduled_start"),
    registrationDeadline: text("registration_deadline"),
    expectedEnd: text("expected_end"),
    hardExpiry: text("hard_expiry"),
    terminalReason: text("terminal_reason"),
    requiredFunding: text("required_funding"),
    fundedAmount: text("funded_amount"),
    paidAmount: text("paid_amount"),
    refundedAmount: text("refunded_amount"),
    externalInflowTotal: text("external_inflow_total"),
    registrationCount: Number(c.registration_count ?? 0),
    commitment: text("commitment"),
    explorer: data.explorer,
    configuredRounds: data.configuredRounds ?? [],
    home: text("home_name") || "Argentina",
    away: text("away_name") || "Spain",
    competition: text("competition_name") || "World Cup Showcase",
    providerStatus: text("provider_status") || "scheduled",
    rounds: data.rounds.map((round) => ({
      round: String(round.round),
      ordinal: Number(round.ordinal),
      source: String(round.source) as "live" | "demo",
      openedAt: String(round.opened_at),
      closesAt: String(round.closes_at),
      rewardAmount: String(round.reward_amount),
      winnerCap: Number(round.winner_cap),
      winnerCount: Number(round.winner_count),
      state: String(round.state) as CampaignRound["state"],
      commitment: String(round.commitment) as CampaignRound["commitment"],
    })),
  };
}
