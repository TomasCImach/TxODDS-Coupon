ALTER TABLE outbox ADD COLUMN dead_lettered_at timestamptz;

DROP INDEX outbox_pending_idx;
CREATE INDEX outbox_pending_idx ON outbox (available_at, id)
  WHERE published_at IS NULL AND dead_lettered_at IS NULL;
CREATE INDEX outbox_dead_letter_idx ON outbox (dead_lettered_at, id)
  WHERE dead_lettered_at IS NOT NULL;
