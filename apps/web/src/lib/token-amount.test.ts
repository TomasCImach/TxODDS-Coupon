import { describe, expect, it } from "vitest";
import { formatTokenAmount, parseTokenAmount } from "./token-amount";

describe("classic SPL token amounts", () => {
  it("round-trips integer base units without floating point", () => {
    const units = parseTokenAmount("12.340001", 6);
    expect(units).toBe(12_340_001n);
    expect(formatTokenAmount(units, 6)).toBe("12.340001");
  });

  it("rejects precision that would otherwise be silently truncated", () => {
    expect(() => parseTokenAmount("1.0000001", 6)).toThrow(
      /at most 6 decimal places/,
    );
    expect(() => parseTokenAmount("1e3", 6)).toThrow(/plain positive/);
  });
});
