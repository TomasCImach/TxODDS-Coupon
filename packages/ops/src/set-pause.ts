import { setPauseMaskInstruction } from "@goaldrop/solana-client";
import { executeAdminChange, printableConfig } from "./admin-transaction.js";

const value = process.env.PAUSE_MASK ?? "";
if (!/^\d+$/.test(value))
  throw new Error("PAUSE_MASK must be an integer from 0 through 15");
const pauseMask = Number(value);
if (!Number.isInteger(pauseMask) || pauseMask < 0 || pauseMask > 0b1111)
  throw new Error("PAUSE_MASK must be an integer from 0 through 15");

const result = await executeAdminChange({
  instruction: ({ programId, config, admin }) =>
    setPauseMaskInstruction(programId, config, admin, pauseMask),
  verify: (before, after) =>
    after.pauseMask === pauseMask &&
    after.authorityEpoch === before.authorityEpoch,
});

process.stdout.write(
  `${JSON.stringify(
    {
      ...result,
      before: printableConfig(result.before),
      after: printableConfig(result.after),
      requestedPauseMask: pauseMask,
    },
    null,
    2,
  )}\n`,
);
