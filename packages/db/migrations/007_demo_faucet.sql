ALTER TABLE sponsored_transaction_templates
  DROP CONSTRAINT sponsored_transaction_templates_action_check;
ALTER TABLE sponsored_transaction_templates
  ADD CONSTRAINT sponsored_transaction_templates_action_check
  CHECK (action IN ('create', 'fund', 'activate', 'cancel', 'refund', 'transfer', 'faucet'));

CREATE TABLE demo_faucet_claims (
  wallet text PRIMARY KEY,
  mint text NOT NULL,
  token_account text NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  status text NOT NULL CHECK (status IN ('reserved', 'built', 'submitted')),
  template_id uuid UNIQUE REFERENCES sponsored_transaction_templates(id),
  transaction_signature text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX demo_faucet_claims_status_idx
  ON demo_faucet_claims (status, updated_at);
