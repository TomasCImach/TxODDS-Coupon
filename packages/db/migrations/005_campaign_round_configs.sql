CREATE TABLE campaign_round_configs (
  campaign text NOT NULL,
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 7),
  reward_amount numeric(20, 0) NOT NULL CHECK (reward_amount > 0),
  winner_cap smallint NOT NULL CHECK (winner_cap BETWEEN 1 AND 100),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (campaign, ordinal)
);
