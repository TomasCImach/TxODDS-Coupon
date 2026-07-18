export interface StoredDemoSession {
  id: string;
  campaign: string;
  expiresAt: number;
  remainingGoals: number;
}

export const demoSessionStorageKey = "goaldrop.demo-session.v1";

export function parseStoredDemoSession(
  value: string | null,
  now = Date.now(),
): StoredDemoSession | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return null;
    if (
      typeof parsed.id !== "string" ||
      parsed.id.length < 30 ||
      typeof parsed.campaign !== "string" ||
      parsed.campaign.length < 32 ||
      typeof parsed.expiresAt !== "number" ||
      !Number.isFinite(parsed.expiresAt) ||
      parsed.expiresAt <= now ||
      typeof parsed.remainingGoals !== "number" ||
      !Number.isInteger(parsed.remainingGoals) ||
      parsed.remainingGoals < 0 ||
      parsed.remainingGoals > 8
    )
      return null;
    return {
      id: parsed.id,
      campaign: parsed.campaign,
      expiresAt: parsed.expiresAt,
      remainingGoals: parsed.remainingGoals,
    };
  } catch {
    return null;
  }
}

export function serializeDemoSession(session: StoredDemoSession): string {
  return JSON.stringify(session);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
