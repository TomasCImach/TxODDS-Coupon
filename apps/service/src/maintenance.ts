import type { DatabasePool } from "@goaldrop/db";

export interface MaintenanceResult {
  analyticsDeleted: number;
  challengesDeleted: number;
  demoSessionsDeleted: number;
  publicEventsDeleted: number;
  templatesExpired: number;
  faucetReservationsDeleted: number;
}

export async function runApiMaintenance(
  pool: DatabasePool,
): Promise<MaintenanceResult> {
  const [
    analytics,
    challenges,
    demoSessions,
    publicEvents,
    templates,
    faucetReservations,
  ] = await Promise.all([
    pool.query(
      "DELETE FROM analytics_events WHERE collected_at < clock_timestamp() - interval '30 days'",
    ),
    pool.query(
      "DELETE FROM intent_challenges WHERE expires_at < clock_timestamp() - interval '1 day'",
    ),
    pool.query(
      "DELETE FROM demo_sessions WHERE expires_at < clock_timestamp()",
    ),
    pool.query(
      "DELETE FROM application_events WHERE created_at < clock_timestamp() - interval '24 hours'",
    ),
    pool.query(
      `UPDATE sponsored_transaction_templates
          SET status = 'expired', updated_at = clock_timestamp()
        WHERE status = 'built' AND expires_at <= clock_timestamp()`,
    ),
    pool.query(
      `DELETE FROM demo_faucet_claims f
         WHERE (f.status = 'reserved' AND f.updated_at < clock_timestamp() - interval '5 minutes')
            OR (f.status = 'built' AND EXISTS (
              SELECT 1 FROM sponsored_transaction_templates t
              WHERE t.id = f.template_id AND t.status IN ('failed', 'expired')
            ))`,
    ),
  ]);
  return {
    analyticsDeleted: analytics.rowCount ?? 0,
    challengesDeleted: challenges.rowCount ?? 0,
    demoSessionsDeleted: demoSessions.rowCount ?? 0,
    publicEventsDeleted: publicEvents.rowCount ?? 0,
    templatesExpired: templates.rowCount ?? 0,
    faucetReservationsDeleted: faucetReservations.rowCount ?? 0,
  };
}
