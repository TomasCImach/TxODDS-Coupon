CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE txline_cursors (
  fixture_id bigint PRIMARY KEY CHECK (fixture_id > 0),
  subscription_key text NOT NULL,
  last_sse_id text,
  last_seq bigint CHECK (last_seq IS NULL OR last_seq >= 0),
  connected_at timestamptz,
  heartbeat_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE txline_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fixture_id bigint NOT NULL CHECK (fixture_id > 0),
  action_id bigint,
  seq bigint NOT NULL CHECK (seq >= 0),
  provider_ts_ms bigint,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  action text NOT NULL,
  adapter_version text NOT NULL,
  normalized jsonb NOT NULL,
  raw_digest bytea NOT NULL CHECK (octet_length(raw_digest) = 32),
  encrypted_raw_payload bytea,
  raw_delete_after timestamptz,
  decision text NOT NULL DEFAULT 'pending' CHECK (decision IN (
    'pending', 'qualifying_goal', 'duplicate', 'correction', 'discarded',
    'terminal', 'ignored', 'malformed', 'late'
  )),
  UNIQUE (fixture_id, seq)
);
CREATE INDEX txline_events_fixture_received_idx ON txline_events (fixture_id, received_at DESC);
CREATE INDEX txline_events_raw_ttl_idx ON txline_events (raw_delete_after)
  WHERE encrypted_raw_payload IS NOT NULL;

CREATE TABLE goal_decisions (
  event_key bytea PRIMARY KEY CHECK (octet_length(event_key) = 32),
  fixture_id bigint NOT NULL CHECK (fixture_id > 0),
  action_id bigint NOT NULL CHECK (action_id > 0),
  qualifying boolean NOT NULL,
  reason text NOT NULL,
  campaign text,
  oracle_status text NOT NULL DEFAULT 'not_required' CHECK (oracle_status IN (
    'not_required', 'queued', 'submitted', 'confirmed', 'finalized', 'failed', 'late'
  )),
  oracle_signature text,
  raw_digest bytea NOT NULL CHECK (octet_length(raw_digest) = 32),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX goal_decisions_fixture_action_idx ON goal_decisions (fixture_id, action_id);

CREATE TABLE campaign_projections (
  campaign text PRIMARY KEY,
  fixture_id bigint NOT NULL CHECK (fixture_id > 0),
  sponsor text NOT NULL,
  state text NOT NULL CHECK (state IN ('draft', 'funded', 'active', 'cancelled', 'refundable', 'refunded')),
  reward_mint text NOT NULL,
  refund_wallet text NOT NULL,
  scheduled_start timestamptz NOT NULL,
  registration_deadline timestamptz NOT NULL,
  expected_end timestamptz NOT NULL,
  hard_expiry timestamptz NOT NULL,
  terminal_reason text NOT NULL DEFAULT 'none',
  required_funding numeric(20, 0) NOT NULL CHECK (required_funding >= 0),
  funded_amount numeric(20, 0) NOT NULL DEFAULT 0 CHECK (funded_amount >= 0),
  paid_amount numeric(20, 0) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  refunded_amount numeric(20, 0) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  external_inflow_total numeric(39, 0) NOT NULL DEFAULT 0 CHECK (external_inflow_total >= 0),
  registration_count integer NOT NULL DEFAULT 0 CHECK (registration_count >= 0),
  last_slot bigint NOT NULL CHECK (last_slot >= 0),
  commitment text NOT NULL CHECK (commitment IN ('processed', 'confirmed', 'finalized')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX campaign_projections_active_fixture_idx ON campaign_projections (fixture_id)
  WHERE state <> 'refunded';

CREATE TABLE round_projections (
  round text PRIMARY KEY,
  campaign text NOT NULL,
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 7),
  source text NOT NULL CHECK (source IN ('live', 'demo')),
  event_key bytea NOT NULL CHECK (octet_length(event_key) = 32),
  opened_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  reward_amount numeric(20, 0) NOT NULL CHECK (reward_amount > 0),
  winner_cap smallint NOT NULL CHECK (winner_cap BETWEEN 1 AND 100),
  winner_count smallint NOT NULL DEFAULT 0 CHECK (winner_count BETWEEN 0 AND 100),
  next_chain_sequence bigint NOT NULL DEFAULT 1 CHECK (next_chain_sequence > 0),
  skipped_count integer NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  paid_total numeric(20, 0) NOT NULL DEFAULT 0 CHECK (paid_total >= 0),
  state text NOT NULL CHECK (state IN ('open', 'exhausted', 'expired')),
  last_slot bigint NOT NULL CHECK (last_slot >= 0),
  commitment text NOT NULL CHECK (commitment IN ('processed', 'confirmed', 'finalized')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (campaign, ordinal),
  UNIQUE (campaign, event_key)
);
CREATE INDEX round_projections_campaign_idx ON round_projections (campaign, ordinal);
CREATE INDEX round_projections_open_idx ON round_projections (closes_at) WHERE state = 'open';

CREATE TABLE registration_projections (
  campaign text NOT NULL,
  wallet text NOT NULL,
  registration_pda text NOT NULL UNIQUE,
  confirmed_slot bigint NOT NULL CHECK (confirmed_slot >= 0),
  transaction_signature text NOT NULL,
  commitment text NOT NULL CHECK (commitment IN ('confirmed', 'finalized')),
  registered_at timestamptz NOT NULL,
  PRIMARY KEY (campaign, wallet)
);

CREATE TABLE intent_challenges (
  nonce_hash bytea PRIMARY KEY CHECK (octet_length(nonce_hash) = 32),
  action text NOT NULL CHECK (action IN ('register', 'claim')),
  wallet text NOT NULL,
  campaign text NOT NULL,
  round text,
  origin text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((action = 'register' AND round IS NULL) OR (action = 'claim' AND round IS NOT NULL))
);
CREATE INDEX intent_challenges_expiry_idx ON intent_challenges (expires_at);
CREATE UNIQUE INDEX intent_challenges_live_scope_idx ON intent_challenges (action, wallet, campaign, COALESCE(round, ''))
  WHERE used_at IS NULL;

CREATE TABLE round_sequences (
  round text PRIMARY KEY,
  next_sequence bigint NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE claim_requests (
  receipt_id uuid PRIMARY KEY,
  campaign text NOT NULL,
  round text NOT NULL,
  wallet text NOT NULL,
  recipient text NOT NULL,
  intent_hash bytea NOT NULL CHECK (octet_length(intent_hash) = 32),
  fan_signature bytea NOT NULL CHECK (octet_length(fan_signature) = 64),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 16),
  expires_at timestamptz NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  status text NOT NULL CHECK (status IN (
    'accepted', 'submitted', 'confirmed', 'finalized', 'missed', 'expired', 'failed', 'skipped'
  )),
  transaction_signature text,
  claim_pda text,
  winner_rank smallint CHECK (winner_rank BETWEEN 1 AND 100),
  error_code text,
  trace_id uuid NOT NULL,
  accepted_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (round, wallet),
  UNIQUE (round, sequence),
  UNIQUE (intent_hash),
  CHECK (recipient = wallet)
);
CREATE INDEX claim_requests_settlement_idx ON claim_requests (round, sequence)
  WHERE status IN ('accepted', 'submitted');

CREATE TABLE receipts (
  receipt_id uuid PRIMARY KEY REFERENCES claim_requests(receipt_id) ON DELETE RESTRICT,
  version smallint NOT NULL CHECK (version = 1),
  authority_epoch integer NOT NULL CHECK (authority_epoch >= 0),
  canonical_payload bytea NOT NULL,
  signature bytea NOT NULL CHECK (octet_length(signature) = 64),
  relayer_authority bytea NOT NULL CHECK (octet_length(relayer_authority) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE chain_transactions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purpose text NOT NULL,
  aggregate_key text NOT NULL,
  signature text UNIQUE,
  blockhash text,
  last_valid_block_height bigint,
  accounts jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL CHECK (status IN ('built', 'submitted', 'confirmed', 'finalized', 'failed', 'ambiguous', 'expired')),
  submitted_at timestamptz,
  confirmed_at timestamptz,
  finalized_at timestamptz,
  error_code text,
  error_detail text,
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX chain_transactions_aggregate_idx ON chain_transactions (aggregate_key, created_at DESC);

CREATE TABLE program_events (
  signature text NOT NULL,
  instruction_index integer NOT NULL CHECK (instruction_index >= 0),
  event_index integer NOT NULL CHECK (event_index >= 0),
  slot bigint NOT NULL CHECK (slot >= 0),
  commitment text NOT NULL CHECK (commitment IN ('confirmed', 'finalized')),
  event_name text NOT NULL,
  event_data jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (signature, instruction_index, event_index)
);
CREATE INDEX program_events_slot_idx ON program_events (slot, signature);

CREATE TABLE outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_key text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  trace_id uuid NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  last_error text
);
CREATE INDEX outbox_pending_idx ON outbox (available_at, id) WHERE published_at IS NULL;

CREATE TABLE application_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign text,
  event_type text NOT NULL CHECK (event_type IN (
    'campaign.updated', 'goal.detected', 'round.opened', 'round.exhausted',
    'round.expired', 'claim.accepted', 'claim.submitted', 'claim.confirmed',
    'claim.missed', 'campaign.refundable', 'campaign.refunded', 'service.degraded'
  )),
  safe_payload jsonb NOT NULL,
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX application_events_campaign_replay_idx ON application_events (campaign, id);
CREATE INDEX application_events_retention_idx ON application_events (created_at);

CREATE TABLE demo_sessions (
  session_hash bytea PRIMARY KEY CHECK (octet_length(session_hash) = 32),
  campaign text NOT NULL,
  origin text NOT NULL,
  step smallint NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 32),
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  last_request_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX demo_sessions_expiry_idx ON demo_sessions (expires_at);

CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_type text NOT NULL,
  actor_key text,
  action text NOT NULL,
  target_type text NOT NULL,
  target_key text NOT NULL,
  before_digest bytea CHECK (before_digest IS NULL OR octet_length(before_digest) = 32),
  after_digest bytea CHECK (after_digest IS NULL OR octet_length(after_digest) = 32),
  reason text,
  request_id text,
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_key, created_at DESC);
CREATE INDEX audit_log_trace_idx ON audit_log (trace_id);
