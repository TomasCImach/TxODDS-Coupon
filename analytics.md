# GoalDrop Devnet MVP Tracking Plan

## Overview

- Tool: first-party PostgreSQL event store; no advertising pixels, third-party analytics, or persistent cookies.
- Purpose: measure onboarding, qualified goal participation, sponsor funnel completion, claim outcomes, and transfer-out while the Devnet MVP is evaluated.
- Privacy: a random session-scoped UUID is stored in `sessionStorage`. Global Privacy Control disables collection. Wallet addresses, signatures, nonces, passkey metadata, destination addresses, IP addresses, and raw referrers are prohibited by API validation.
- Retention assumption: delete raw session events after 30 days; retain only aggregate, non-identifying counts for the hackathon report.

## Events

| Event                    | Decision supported                               | Properties                       | Trigger                                            |
| ------------------------ | ------------------------------------------------ | -------------------------------- | -------------------------------------------------- |
| `campaign_viewed`        | Campaign discovery and participation denominator | `source`, `campaign_state`       | Campaign experience mounts                         |
| `wallet_path_selected`   | Passkey/external/instant path quality            | `method`                         | User selects a wallet path                         |
| `registration_started`   | Registration funnel start                        | `method`                         | Valid registration attempt begins                  |
| `registration_completed` | View-to-registration conversion, onboarding time | `method`, `duration_ms`          | Registration is confirmed                          |
| `claim_started`          | Qualified participation numerator                | `round_source`, `round_ordinal`  | Eligible user signs a claim                        |
| `claim_receipt_accepted` | Acceptance latency and receipt-to-success funnel | `latency_ms`                     | Durable signed receipt returns                     |
| `claim_confirmed`        | Receipt-to-success conversion                    | `winner_rank`, `confirmation_ms` | Confirmed Claim PDA and exact transfer are visible |
| `claim_missed`           | Cap/expiry loss reasons                          | `reason`                         | Claim becomes missed or expired                    |
| `transfer_started`       | Reward utility intent                            | `amount_base_units`              | Transfer template requested                        |
| `transfer_completed`     | Transfer-out rate                                | `amount_base_units`              | Transfer confirms                                  |
| `sponsor_setup_started`  | Sponsor funnel start                             | `fixture_source`                 | Sponsor begins campaign creation                   |
| `campaign_created`       | Sponsor create completion                        | `round_count`                    | Create transaction confirms                        |
| `campaign_funded`        | Funding funnel completion                        | `round_count`                    | Exact liability funding confirms                   |
| `campaign_activated`     | Published-campaign conversion                    | `round_count`                    | Activation confirms                                |
| `campaign_refunded`      | Residual recovery success                        | none                             | Refund transaction confirms                        |
| `demo_session_started`   | Judge demo starts                                | none                             | Demo capability is issued                          |
| `demo_goal_triggered`    | Demo core path use                               | none                             | Synthetic goal request is accepted                 |
| `demo_completed`         | Demo completion                                  | none                             | Completion request is accepted                     |
| `product_error`          | Reliability prioritization                       | `surface`, `error_code`          | User-visible flow error occurs                     |

## Conversions and formulas

- Qualified goal participation rate: distinct sessions with `claim_started` / distinct preregistered sessions with `registration_completed` for a campaign.
- Registration conversion: `registration_completed` / `campaign_viewed`.
- Receipt-to-success conversion: `claim_confirmed` / `claim_receipt_accepted`.
- Sponsor publish conversion: `campaign_activated` / `sponsor_setup_started`.
- Transfer-out rate: sessions with `transfer_completed` / sessions with `claim_confirmed`.

Session analytics are directional because the MVP deliberately avoids stable cross-device identity. Authoritative payout, rank, funding, and refund totals must come from program accounts and indexed SPL transfers—not browser events.
