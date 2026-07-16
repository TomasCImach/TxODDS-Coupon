import { sha256 } from "@noble/hashes/sha2.js";
import type { TxlineRecord } from "./schema.js";

export const ADAPTER_VERSION = "txline-soccer-v1" as const;
export const QUALIFYING_GOAL_STATUSES = new Set([2, 4, 7, 9]);

export interface NormalizedGoal {
  adapterVersion: typeof ADAPTER_VERSION;
  fixtureId: bigint;
  actionId: bigint;
  seq: number;
  providerTsMs: bigint;
  receivedAtMs: bigint;
  confirmed: boolean;
  statusSoccerId: 2 | 4 | 7 | 9;
  participant: 1 | 2;
  goalType: "Shot" | "Head" | "Own" | "Other" | null;
  playerId: bigint | null;
  rawDigest: Uint8Array;
  eventKey: Uint8Array;
}

export type GoalDecision =
  | {
      kind: "qualifying_goal";
      goal: NormalizedGoal;
      reason: "qualifying_status";
    }
  | {
      kind: "audit_only";
      reason: "amendment" | "discard" | "var";
      originalActionId: bigint;
    }
  | { kind: "terminal"; reason: "provider_finalised" }
  | { kind: "ignored"; reason: string };

function asBigInt(
  value: string | number | undefined | null,
  field: string,
): bigint {
  if (value === undefined || value === null)
    throw new Error(`${field} is required`);
  const result = BigInt(value);
  if (result < 0n) throw new Error(`${field} cannot be negative`);
  return result;
}

function asSafeNumber(value: string | number, field: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error(`${field} exceeds safe integer range`);
  return result;
}

function encodeU64(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn)
    throw new RangeError("provider ID exceeds u64");
  const output = new Uint8Array(8);
  new DataView(output.buffer).setBigUint64(0, value, true);
  return output;
}

export function goalEventKey(fixtureId: bigint, actionId: bigint): Uint8Array {
  const input = new Uint8Array(16);
  input.set(encodeU64(fixtureId), 0);
  input.set(encodeU64(actionId), 8);
  return sha256(input);
}

export function normalizeGoal(
  record: TxlineRecord,
  rawBytes: Uint8Array,
  receivedAtMs = BigInt(Date.now()),
): NormalizedGoal {
  if (record.action !== "goal") throw new Error("record is not a goal");
  if (record.id === undefined) throw new Error("goal id is required");
  if (!QUALIFYING_GOAL_STATUSES.has(record.statusSoccerId ?? -1)) {
    throw new Error("goal status is not qualifying");
  }
  if (record.participant !== 1 && record.participant !== 2)
    throw new Error("goal participant is required");
  const fixtureId = asBigInt(record.fixtureId, "fixtureId");
  const actionId = asBigInt(record.id, "id");
  if (actionId === 0n) throw new Error("id must be positive for a goal");
  const goalType =
    record.goalType === null || record.goalType === undefined
      ? null
      : record.goalType === "Shot" ||
          record.goalType === "Head" ||
          record.goalType === "Own"
        ? record.goalType
        : "Other";
  return {
    adapterVersion: ADAPTER_VERSION,
    fixtureId,
    actionId,
    seq: asSafeNumber(record.seq, "seq"),
    providerTsMs: asBigInt(record.ts, "ts"),
    receivedAtMs,
    confirmed: record.confirmed ?? false,
    statusSoccerId: record.statusSoccerId as 2 | 4 | 7 | 9,
    participant: record.participant,
    goalType,
    playerId:
      record.playerId === undefined || record.playerId === null
        ? null
        : asBigInt(record.playerId, "playerId"),
    rawDigest: sha256(rawBytes),
    eventKey: goalEventKey(fixtureId, actionId),
  };
}

export function decideRecord(
  record: TxlineRecord,
  rawBytes: Uint8Array,
  receivedAtMs = BigInt(Date.now()),
): GoalDecision {
  if (record.action === "goal") {
    if (!QUALIFYING_GOAL_STATUSES.has(record.statusSoccerId ?? -1)) {
      return {
        kind: "ignored",
        reason: "goal_outside_regulation_or_extra_time",
      };
    }
    return {
      kind: "qualifying_goal",
      goal: normalizeGoal(record, rawBytes, receivedAtMs),
      reason: "qualifying_status",
    };
  }
  if (
    record.action === "action_amend" ||
    record.action === "action_discarded" ||
    record.action === "var" ||
    record.action === "var_end" ||
    record.var !== undefined
  ) {
    const originalActionId = asBigInt(
      record.originalActionId ?? record.id,
      "originalActionId",
    );
    return {
      kind: "audit_only",
      reason:
        record.var !== undefined
          ? "var"
          : record.action === "action_amend"
            ? "amendment"
            : "discard",
      originalActionId,
    };
  }
  if (record.action === "game_finalised") {
    return (record.statusId === undefined || record.statusId === 100) &&
      (record.period === undefined || record.period === 100)
      ? { kind: "terminal", reason: "provider_finalised" }
      : { kind: "ignored", reason: "invalid_finalisation_marker" };
  }
  const reasons: Record<string, string> = {
    possible: "possible_goal_excluded",
    penalty_outcome: "shootout_penalty_excluded",
    score_adjustment: "score_adjustment_excluded",
    heartbeat: "heartbeat",
  };
  return {
    kind: "ignored",
    reason: reasons[record.action] ?? "unsupported_action",
  };
}
