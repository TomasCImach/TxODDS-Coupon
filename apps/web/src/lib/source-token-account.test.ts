import { describe, expect, it } from "vitest";
import { selectFundedSourceTokenAccount } from "./source-token-account";

describe("GOAL source token account selection", () => {
  it("selects the funded account with the largest balance", () => {
    expect(
      selectFundedSourceTokenAccount([
        { address: "empty", amount: 0n },
        { address: "smaller", amount: 5n },
        { address: "larger", amount: 10n },
      ]),
    ).toEqual({ address: "larger", amount: 10n });
  });

  it("returns null when no account has a positive balance", () => {
    expect(
      selectFundedSourceTokenAccount([{ address: "empty", amount: 0n }]),
    ).toBeNull();
  });
});
