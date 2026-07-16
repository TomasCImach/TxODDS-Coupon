import { createHmac, timingSafeEqual } from "node:crypto";

interface ReceiptCapability {
  receiptId: string;
  expiresAt: number;
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function issueReceiptCapability(
  receiptId: string,
  secret: string,
  ttlSeconds = 86_400,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      receiptId,
      expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
    }),
  ).toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyReceiptCapability(
  token: string,
  receiptId: string,
  secret: string,
): boolean {
  const [payload, supplied] = token.split(".");
  if (!payload || !supplied) return false;
  const expected = signature(payload, secret);
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right))
    return false;
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as ReceiptCapability;
    return (
      decoded.receiptId === receiptId &&
      decoded.expiresAt >= Math.floor(Date.now() / 1000)
    );
  } catch {
    return false;
  }
}
