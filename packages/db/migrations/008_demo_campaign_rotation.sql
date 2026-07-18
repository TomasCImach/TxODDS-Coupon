CREATE TABLE demo_campaigns (
  campaign text PRIMARY KEY,
  generation bigint NOT NULL UNIQUE CHECK (generation >= 0),
  fixture_id bigint NOT NULL UNIQUE CHECK (fixture_id > 0),
  campaign_nonce numeric(20, 0) NOT NULL UNIQUE CHECK (campaign_nonce > 0),
  status text NOT NULL CHECK (status IN ('preparing', 'ready', 'retiring', 'retired', 'failed')),
  is_current boolean NOT NULL DEFAULT false,
  error_detail text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX demo_campaigns_current_idx
  ON demo_campaigns (is_current) WHERE is_current;
CREATE INDEX demo_campaigns_cleanup_idx
  ON demo_campaigns (status, updated_at);

CREATE TABLE demo_runtime (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  status text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'preparing', 'ready', 'failed')),
  campaign text,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'ready' AND campaign IS NOT NULL) OR status <> 'ready')
);
INSERT INTO demo_runtime (singleton) VALUES (true)
  ON CONFLICT (singleton) DO NOTHING;
