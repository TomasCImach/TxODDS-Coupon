import { z } from "zod";

const fixtureId = z.union([
  z.number().int().positive(),
  z.string().regex(/^[1-9]\d*$/),
]);
const id = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]);
const sequence = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/),
]);
const timestamp = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/),
]);
const action = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

const canonicalRecordSchema = z.strictObject({
  action,
  fixtureId,
  id: id.optional(),
  seq: sequence,
  ts: timestamp,
  confirmed: z.boolean().optional(),
  statusSoccerId: z.number().int().optional(),
  statusId: z.number().int().optional(),
  period: z.number().int().optional(),
  participant: z.union([z.literal(1), z.literal(2)]).optional(),
  goalType: z.string().nullable().optional(),
  playerId: id.nullable().optional(),
  originalActionId: id.optional(),
  var: z.enum(["stands", "overturned"]).optional(),
});

const wireDataSchema = z
  .object({
    GoalType: z.string().nullable().optional(),
    PlayerId: id.nullable().optional(),
    Outcome: z.string().optional(),
  })
  .passthrough();

// The authenticated Devnet REST/SSE wire format uses PascalCase and includes
// action-specific fields that GoalDrop intentionally does not retain. Parse the
// minimum semantic envelope, discard unrelated provider fields, and normalize
// it before any decision logic runs. The canonical camelCase shape remains
// supported for synthetic fixtures and internal tests.
const wireRecordSchema = z
  .object({
    Action: action,
    FixtureId: fixtureId,
    Id: id.optional(),
    Seq: sequence,
    Ts: timestamp,
    Confirmed: z.boolean().optional(),
    StatusId: z.number().int().optional(),
    Period: z.number().int().optional(),
    Participant: z.union([z.literal(1), z.literal(2)]).optional(),
    OriginalActionId: id.optional(),
    Data: wireDataSchema.optional(),
  })
  .passthrough();

type CanonicalRecord = z.infer<typeof canonicalRecordSchema>;

export const txlineRecordSchema = z
  .union([canonicalRecordSchema, wireRecordSchema])
  .transform((record): CanonicalRecord => {
    if (!("Action" in record)) return record;
    const outcome = record.Data?.Outcome?.toLowerCase();
    return {
      action: record.Action,
      fixtureId: record.FixtureId,
      ...(record.Id === undefined ? {} : { id: record.Id }),
      seq: record.Seq,
      ts: record.Ts,
      ...(record.Confirmed === undefined
        ? {}
        : { confirmed: record.Confirmed }),
      ...(record.StatusId === undefined
        ? {}
        : {
            statusSoccerId: record.StatusId,
            statusId: record.StatusId,
          }),
      ...(record.Period === undefined ? {} : { period: record.Period }),
      ...(record.Participant === undefined
        ? {}
        : { participant: record.Participant }),
      ...(record.Data?.GoalType === undefined
        ? {}
        : { goalType: record.Data.GoalType }),
      ...(record.Data?.PlayerId === undefined
        ? {}
        : { playerId: record.Data.PlayerId }),
      ...(record.OriginalActionId === undefined && record.Id === undefined
        ? {}
        : {
            originalActionId: record.OriginalActionId ?? record.Id,
          }),
      ...(record.Action === "var_end" &&
      (outcome === "stands" || outcome === "overturned")
        ? { var: outcome }
        : {}),
    };
  });

export type TxlineRecord = z.output<typeof txlineRecordSchema>;

export function parseTxlineRecord(value: unknown): TxlineRecord {
  return txlineRecordSchema.parse(value);
}
