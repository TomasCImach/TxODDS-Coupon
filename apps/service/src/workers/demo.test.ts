import { describe, expect, it } from "vitest";
import { demoCampaignTimes } from "./demo.js";

describe("rotating demo campaign timing", () => {
  it("keeps registration open and stays inside the on-chain 24 hour bound", () => {
    const now = 1_700_000_000;
    const times = demoCampaignTimes(now, 82_800);
    expect(times.registrationDeadline).toBeGreaterThan(BigInt(now));
    expect(times.registrationDeadline).toBeLessThanOrEqual(
      times.scheduledStart,
    );
    expect(times.scheduledStart).toBeLessThan(times.expectedEnd);
    expect(times.expectedEnd).toBeLessThan(times.hardExpiry);
    expect(times.hardExpiry - times.scheduledStart).toBeLessThanOrEqual(
      86_400n,
    );
  });

  it("rejects lifetimes that cannot provide safe session margins", () => {
    expect(() => demoCampaignTimes(1_700_000_000, 14_399)).toThrow(
      "outside the safe range",
    );
    expect(() => demoCampaignTimes(1_700_000_000, 82_801)).toThrow(
      "outside the safe range",
    );
  });
});
