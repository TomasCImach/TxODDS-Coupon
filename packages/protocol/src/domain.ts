export const PROGRAM_VERSION = 1 as const;
export const MAX_ROUNDS = 8 as const;
export const ROUND_DURATION_SECONDS = 120 as const;
export const MAX_WINNERS_PER_ROUND = 100 as const;

export const CampaignState = {
  Draft: 0,
  Funded: 1,
  Active: 2,
  Cancelled: 3,
  Refundable: 4,
  Refunded: 5,
} as const;

export const TerminalReason = {
  None: 0,
  ProviderFinalised: 1,
  ProviderCancelled: 2,
  ProviderAbandoned: 3,
  HardTimeout: 4,
} as const;

export const RoundState = { Open: 0, Exhausted: 1, Expired: 2 } as const;
export const RoundSource = { Live: 0, Demo: 1 } as const;
export const IntentAction = { Register: 1, Claim: 2 } as const;
export const SkipReason = {
  InvalidAfterAcceptance: 1,
  RecipientAccountFailure: 2,
  PermanentProgramMismatch: 3,
  OperatorIncident: 255,
} as const;

export type CampaignStateValue =
  (typeof CampaignState)[keyof typeof CampaignState];
export type RoundStateValue = (typeof RoundState)[keyof typeof RoundState];
export type RoundSourceValue = (typeof RoundSource)[keyof typeof RoundSource];
export type IntentActionValue =
  (typeof IntentAction)[keyof typeof IntentAction];

export type ClaimStatus =
  | "accepted"
  | "submitted"
  | "confirmed"
  | "finalized"
  | "missed"
  | "expired"
  | "failed"
  | "skipped";

export type PublicEventType =
  | "campaign.updated"
  | "goal.detected"
  | "round.opened"
  | "round.exhausted"
  | "round.expired"
  | "claim.accepted"
  | "claim.submitted"
  | "claim.confirmed"
  | "claim.missed"
  | "campaign.refundable"
  | "campaign.refunded"
  | "service.degraded";
