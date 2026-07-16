import { z } from "zod";

const id = z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]);
const sequence = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/),
]);
const timestamp = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/),
]);

export const txlineRecordSchema = z.strictObject({
  action: z.enum([
    "goal",
    "possible",
    "penalty_outcome",
    "score_adjustment",
    "action_amend",
    "action_discarded",
    "game_finalised",
    "heartbeat",
  ]),
  fixtureId: id,
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

export type TxlineRecord = z.infer<typeof txlineRecordSchema>;

export function parseTxlineRecord(value: unknown): TxlineRecord {
  return txlineRecordSchema.parse(value);
}
