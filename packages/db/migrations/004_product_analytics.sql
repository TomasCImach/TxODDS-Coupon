CREATE TABLE analytics_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  session_id uuid NOT NULL,
  event_name text NOT NULL CHECK (event_name IN (
    'campaign_viewed', 'wallet_path_selected', 'registration_started', 'registration_completed',
    'claim_started', 'claim_receipt_accepted', 'claim_confirmed', 'claim_missed',
    'transfer_started', 'transfer_completed', 'sponsor_setup_started', 'campaign_created',
    'campaign_funded', 'campaign_activated', 'campaign_refunded', 'demo_session_started',
    'demo_goal_triggered', 'demo_completed', 'product_error'
  )),
  campaign text,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX analytics_events_name_time_idx ON analytics_events (event_name, collected_at DESC);
CREATE INDEX analytics_events_campaign_time_idx ON analytics_events (campaign, collected_at DESC) WHERE campaign IS NOT NULL;

COMMENT ON TABLE analytics_events IS
  'First-party, cookieless MVP product events. Wallet addresses, signatures, nonces, passkey metadata, IP addresses, and raw referrers are prohibited.';
