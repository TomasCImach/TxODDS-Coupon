CREATE TABLE fixture_catalog (
  fixture_id bigint PRIMARY KEY CHECK (fixture_id > 0),
  home_name text NOT NULL CHECK (char_length(home_name) BETWEEN 1 AND 100),
  away_name text NOT NULL CHECK (char_length(away_name) BETWEEN 1 AND 100),
  competition_name text NOT NULL CHECK (char_length(competition_name) BETWEEN 1 AND 100),
  scheduled_start timestamptz NOT NULL,
  provider_status text NOT NULL DEFAULT 'scheduled',
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX fixture_catalog_start_idx ON fixture_catalog (scheduled_start);

CREATE TABLE registration_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign text NOT NULL,
  wallet text NOT NULL,
  intent_hash bytea NOT NULL CHECK (octet_length(intent_hash) = 32),
  fan_signature bytea NOT NULL CHECK (octet_length(fan_signature) = 64),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 16),
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted', 'submitted', 'confirmed', 'finalized', 'expired', 'failed')),
  registration_pda text,
  transaction_signature text,
  error_code text,
  trace_id uuid NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (campaign, wallet),
  UNIQUE (intent_hash)
);
CREATE INDEX registration_requests_pending_idx ON registration_requests (accepted_at)
  WHERE status IN ('accepted', 'submitted');
