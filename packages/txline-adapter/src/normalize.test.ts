import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { decideRecord, goalEventKey, parseTxlineRecord } from "./index.js";

const raw = new TextEncoder().encode("synthetic-goal");
const baseGoal = {
  action: "goal" as const,
  fixtureId: "2026061101",
  id: "7001",
  seq: 42,
  ts: "1900000000000",
  confirmed: false,
  statusSoccerId: 2,
  participant: 1 as const,
  goalType: "Shot",
  playerId: "9001",
};

describe("TxLINE soccer adapter", () => {
  it("uses stable fixture/action identity before and after confirmation", () => {
    const first = decideRecord(parseTxlineRecord(baseGoal), raw, 1n);
    const confirmed = decideRecord(
      parseTxlineRecord({ ...baseGoal, seq: 43, confirmed: true }),
      raw,
      2n,
    );
    expect(first.kind).toBe("qualifying_goal");
    expect(confirmed.kind).toBe("qualifying_goal");
    if (
      first.kind === "qualifying_goal" &&
      confirmed.kind === "qualifying_goal"
    ) {
      expect(first.goal.eventKey).toEqual(confirmed.goal.eventKey);
    }
  });

  it.each([2, 4, 7, 9])("qualifies status %i", (statusSoccerId) => {
    expect(
      decideRecord(parseTxlineRecord({ ...baseGoal, statusSoccerId }), raw)
        .kind,
    ).toBe("qualifying_goal");
  });

  it("includes own goals", () => {
    const decision = decideRecord(
      parseTxlineRecord({ ...baseGoal, goalType: "Own" }),
      raw,
    );
    expect(decision.kind).toBe("qualifying_goal");
    if (decision.kind === "qualifying_goal")
      expect(decision.goal.goalType).toBe("Own");
  });

  it.each([
    [{ ...baseGoal, action: "possible" as const }, "possible_goal_excluded"],
    [
      { ...baseGoal, action: "penalty_outcome" as const },
      "shootout_penalty_excluded",
    ],
    [
      { ...baseGoal, action: "score_adjustment" as const },
      "score_adjustment_excluded",
    ],
    [
      { ...baseGoal, statusSoccerId: 11 },
      "goal_outside_regulation_or_extra_time",
    ],
  ])("excludes nonqualifying event %#", (record, reason) => {
    expect(decideRecord(parseTxlineRecord(record), raw)).toMatchObject({
      kind: "ignored",
      reason,
    });
  });

  it.each(["action_amend", "action_discarded"] as const)(
    "audits %s without reopening",
    (action) => {
      const record = parseTxlineRecord({
        action,
        fixtureId: baseGoal.fixtureId,
        id: "8000",
        originalActionId: baseGoal.id,
        seq: 44,
        ts: baseGoal.ts,
      });
      expect(decideRecord(record, raw)).toMatchObject({
        kind: "audit_only",
        originalActionId: 7001n,
      });
    },
  );

  it("accepts only the exact finalisation marker", () => {
    const final = parseTxlineRecord({
      action: "game_finalised",
      fixtureId: baseGoal.fixtureId,
      seq: 90,
      ts: baseGoal.ts,
      statusId: 100,
      period: 100,
    });
    expect(decideRecord(final, raw)).toEqual({
      kind: "terminal",
      reason: "provider_finalised",
    });
    expect(decideRecord({ ...final, period: 99 }, raw)).toMatchObject({
      kind: "ignored",
    });
  });

  it("rejects malformed or unknown records instead of guessing", () => {
    expect(() =>
      parseTxlineRecord({ ...baseGoal, id: undefined }),
    ).not.toThrow();
    expect(() =>
      decideRecord(parseTxlineRecord({ ...baseGoal, id: undefined }), raw),
    ).toThrow(/id/);
    expect(() =>
      parseTxlineRecord({ ...baseGoal, action: "mystery" }),
    ).toThrow();
    expect(goalEventKey(1n, 2n)).toHaveLength(32);
  });

  it("keeps the committed synthetic match fixture compatible with the adapter contract", async () => {
    const fixtureUrl = new URL(
      "../../../tests/fixtures/synthetic-txline/match-sequence.json",
      import.meta.url,
    );
    const records = JSON.parse(await readFile(fixtureUrl, "utf8")) as unknown[];
    const decisions = records.map((record) =>
      decideRecord(
        parseTxlineRecord(record),
        new TextEncoder().encode(JSON.stringify(record)),
      ),
    );
    expect(
      decisions.filter((decision) => decision.kind === "qualifying_goal"),
    ).toHaveLength(3);
    expect(
      decisions.filter((decision) => decision.kind === "audit_only"),
    ).toHaveLength(1);
    expect(decisions.at(-1)).toEqual({
      kind: "terminal",
      reason: "provider_finalised",
    });
  });
});
