CREATE TABLE sponsored_transaction_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL CHECK (action IN ('create', 'fund', 'activate', 'cancel', 'refund', 'transfer')),
  actor text,
  fee_payer text NOT NULL,
  message_bytes bytea NOT NULL CHECK (octet_length(message_bytes) > 0),
  allowed_program_ids text[] NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'built' CHECK (status IN ('built', 'submitting', 'submitted', 'failed', 'ambiguous', 'expired')),
  transaction_signature text,
  error_detail text,
  expires_at timestamptz NOT NULL,
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  submitted_at timestamptz
);
CREATE INDEX sponsored_transaction_templates_expiry_idx
  ON sponsored_transaction_templates (expires_at) WHERE status = 'built';
CREATE INDEX sponsored_transaction_templates_actor_idx
  ON sponsored_transaction_templates (actor, created_at DESC);
