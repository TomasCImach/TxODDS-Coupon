import { describe, expect, it } from "vitest";
import {
  parseStoredDemoSession,
  serializeDemoSession,
  type StoredDemoSession,
} from "./demo-session.js";

const session: StoredDemoSession = {
  id: "capability-that-is-long-enough-to-be-valid",
  campaign: "11111111111111111111111111111111",
  expiresAt: 2_000,
  remainingGoals: 7,
};

describe("demo session persistence", () => {
  it("restores an unexpired capability", () => {
    expect(
      parseStoredDemoSession(serializeDemoSession(session), 1_000),
    ).toEqual(session);
  });

  it("rejects expired or malformed capabilities", () => {
    expect(
      parseStoredDemoSession(serializeDemoSession(session), 2_000),
    ).toBeNull();
    expect(parseStoredDemoSession("not-json", 1_000)).toBeNull();
    expect(
      parseStoredDemoSession(
        JSON.stringify({ ...session, remainingGoals: 9 }),
        1_000,
      ),
    ).toBeNull();
  });
});
