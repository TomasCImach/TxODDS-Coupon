import { browserApiOrigin } from "./api";

export type ProductEvent =
  | "campaign_viewed"
  | "wallet_path_selected"
  | "registration_started"
  | "registration_completed"
  | "claim_started"
  | "claim_receipt_accepted"
  | "claim_confirmed"
  | "claim_missed"
  | "transfer_started"
  | "transfer_completed"
  | "sponsor_setup_started"
  | "campaign_created"
  | "campaign_funded"
  | "campaign_activated"
  | "campaign_refunded"
  | "demo_session_started"
  | "demo_goal_triggered"
  | "demo_completed"
  | "product_error";

export function track(
  eventName: ProductEvent,
  input: {
    campaign?: string;
    properties?: Record<string, string | number | boolean>;
  } = {},
): void {
  if (
    typeof window === "undefined" ||
    (navigator as Navigator & { globalPrivacyControl?: boolean })
      .globalPrivacyControl
  )
    return;
  const sessionId = analyticsSession();
  void fetch(`${browserApiOrigin}/v1/analytics/events`, {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      events: [
        {
          eventId: crypto.randomUUID(),
          eventName,
          campaign: input.campaign,
          occurredAt: new Date().toISOString(),
          properties: input.properties ?? {},
        },
      ],
    }),
  }).catch(() => undefined);
}

function analyticsSession(): string {
  const key = "goaldrop.analytics-session";
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  sessionStorage.setItem(key, created);
  return created;
}
