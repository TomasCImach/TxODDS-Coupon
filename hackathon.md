# TxODDS World Cup Hackathon — Consumer and Fan Experiences

> Research and compliance dossier for the TxODDS “Consumer and Fan Experiences” track on Superteam Earn.
>
> **Verified:** July 15, 2026<br>
> **Local timezone used below:** America/Argentina/Tucuman (ART, UTC-03:00)<br>
> **Primary sources:** [track listing](https://superteam.fun/earn/listing/consumer-and-fan-experiences), [World Cup program hub](https://superteam.fun/earn/hackathon/world-cup), [official TxODDS hackathon terms](https://txline.txodds.com/documentation/legal/hackathon-terms), and the [TxLINE documentation](https://txline.txodds.com/documentation/quickstart).

This document is a practical research summary, not legal advice. Rules, pricing, fixtures, data access, and terms can change without notice. Recheck the primary sources and obtain written sponsor clarification for the conflicts identified below before submission.

## Executive snapshot

| Item | Detail |
| --- | --- |
| Sponsor | TxODDS / TxLINE |
| Program | Superteam Earn World Cup Hackathon |
| Track | Consumer and Fan Experiences |
| Track objective | Build an original, polished fan-facing World Cup app, game, bot, or social experience that reacts fluidly to live TxLINE match data. |
| Total program prize pool | USD 50,000 across three tracks |
| Track prize pool | 16,000 USDT |
| 1st / 2nd / 3rd | 10,000 / 4,000 / 2,000 USDT |
| Submission opened | June 24, 2026 at 15:00 UTC / 12:00 ART |
| Submission deadline | **July 19, 2026 at 23:59 UTC / 20:59 ART** |
| Winner announcement | July 29, 2026 at 15:00 UTC / 12:00 ART |
| Team size | 1–3 people |
| Core technical requirement | Use TxLINE data as a live input and sign up through Solana. |
| Required product state | A functional, deployed mainnet or devnet product—not a pitch, mockup, or wireframe. |
| Mandatory evidence | Public repository, working application/API access, technical overview, feedback, and a demo video of at most five minutes. |

The program runs from June 24 through July 19. The deadline is an exact UTC timestamp and should be treated as controlling. July 19, 2026 is a **Sunday**, despite one listing note describing it as Saturday.

## What the track asks builders to create

TxLINE supplies normalized, real-time sports data, including fixtures, live scores, match events, and consensus StablePrice odds. The track asks for a consumer experience that a mainstream, non-technical football fan would repeatedly use during a match. The sponsor explicitly values a small but complete feature over a broad, unfinished system.

The listing offers three starting points, not mandatory product directions:

1. **Group sweepstake:** Assign friends to World Cup teams and update the leaderboard automatically from TxLINE match data.
2. **AI pundit bot:** Send Telegram explanations after goals, red cards, or large odds shifts; text-to-speech earns bonus credit.
3. **Hi-lo stats game:** Let fans predict whether the next match statistic will be higher or lower, build streaks, and share results.

This dossier intentionally does not select a concept or prescribe an application stack.

## Judging criteria

All five published criteria should be visible in the product and the demo:

1. **Fan Accessibility & UX** — Is it engaging, intuitive, and polished enough for a mainstream sports fan to use regularly?
2. **Real-Time Responsiveness** — Does it visibly and fluidly respond to what is happening on the pitch?
3. **Originality & Value Creation** — Does it create a genuinely new interaction instead of merely repackaging a sports feed?
4. **Commercial & Monetization Path** — Is there a credible product utility, business model, or monetization route?
5. **Completeness & Execution** — Does it feel like a functional, end-to-end product even if the technical scope is deliberately small?

### Demo-video emphasis

The listing says entries will be evaluated heavily on the demo video because live activity may not be available when judges review the project. The video should therefore show:

- the user problem and target fan;
- the complete user flow, not isolated screens;
- a live or replayed TxLINE-driven state change;
- which TxLINE inputs power the experience;
- failure/fallback behavior when a stream is quiet or unavailable;
- product polish, sharing/replay value, and the monetization path.

## Submission requirements

The listing defines four required submission artifacts, with additional eligibility requirements around them.

### 1. Demo video — absolute screening requirement

- Maximum length: **five minutes**.
- Host on Loom, YouTube, or another judge-accessible service.
- Cover the problem, live application walkthrough, and how TxLINE powers the backend.
- Ensure the video works without login, payment, access requests, or regional restrictions.

### 2. Application access

- Provide a working deployed website **or** a functional API endpoint.
- Judges must be able to access, test, and evaluate it without paying, acquiring tokens, creating a wallet, or buying a third-party service.
- Supply any safe demo credentials and test environment instructions required for evaluation.

### 3. Brief technical documentation

- Explain the core idea and target user.
- Summarize the business and technical highlights.
- List the exact TxLINE endpoints used.
- Explain how live, snapshot, or replay data moves through the application.
- Document any graceful fallback used when no covered fixture is live.

### 4. Product feedback

- State what worked well in the TxLINE API and schema.
- State where the team encountered friction, bugs, confusing behavior, or missing functionality.
- Report actionable API bugs in the developer chat during the hackathon when possible.

### Additional must-haves

- A public source-code repository.
- A live mainnet or devnet product that works during a match.
- TxLINE data used as a live input.
- Solana-based TxLINE subscription/activation.
- A functional product; pitch-only decks, wireframes, mockups, and non-working concepts are automatically disqualified.

## Pass/fail eligibility and compliance checklist

Treat every unchecked item as a potential submission blocker.

- [ ] Every submitting person is at least 18, has legal capacity, and may participate under the laws of their jurisdiction.
- [ ] No team member is an employee, contractor, director, or officer of TxODDS or an excluded immediate-family/household member under the official terms.
- [ ] The submission is owned, controlled, and submitted by identifiable human participants.
- [ ] The team has no more than three people and has designated one leader as the TxODDS/Superteam contact.
- [ ] The team and structure comply with sanctions, restricted-jurisdiction, KYC, and Superteam account rules.
- [ ] The project was built specifically for this hackathon; significant development occurred during the hackathon period.
- [ ] Any pre-existing components are publicly available, correctly licensed, and clearly attributed.
- [ ] The project does not plagiarize or falsely represent authorship, affiliations, capabilities, or results.
- [ ] The product is deployed and functional rather than a deck, prototype image, wireframe, or mockup.
- [ ] The public repository, deployed product/API, demo video, and technical documentation are accessible to judges.
- [ ] Judges can evaluate the submission without fees, token purchases, subscriptions, or creating a third-party blockchain wallet/account.
- [ ] No guest JWT, activated API token, wallet secret key, or unredacted authorization header is present in the repository, browser bundle, logs, screenshots, or video.
- [ ] The application complies with applicable gambling, gaming, financial, securities, consumer-protection, privacy, advertising, and age-restriction laws.
- [ ] The product does not enable or endorse unlawful betting, wagering, or financial activity.
- [ ] The project uses no unlicensed third-party code, music, images, data, trademarks, or other intellectual property.
- [ ] The name, UI, repository, video, and marketing use no FIFA or tournament-organizer logos, marks, branding, or implied endorsement/affiliation.
- [ ] Data retention, display, caching, and post-hackathon behavior comply with the sponsor’s written interpretation of the TxODDS data licence.

## Source conflicts and safest working interpretation

The public materials contain material inconsistencies. The official hackathon terms incorporate other rules but also say that TxODDS may modify terms at any time. Until the sponsor confirms otherwise in writing, use the stricter interpretation.

| Conflict | Sources | Safe default |
| --- | --- | --- |
| **AI-agent eligibility** | The listing says individuals, teams, and AI agents may enter if a real person/team/entity owns the submission. The official hackathon terms say only natural persons may participate and that bot- or agent-controlled entries may be disqualified. | Humans must make and document all material product, authorship, and submission decisions. Do not register or submit as an AI agent. Ask TxODDS to define permitted AI-assisted development. |
| **Companies vs natural persons** | The program FAQ says companies may participate; official terms say the hackathon is open only to natural persons. | Submit through eligible named humans unless TxODDS confirms company participation in writing. |
| **Multiple prizes** | The program FAQ says a team may win in multiple tracks with separate projects. Official terms say participants may enter multiple tracks but cannot win more than one prize total. | Assume each participant/team can receive only one prize total. Do not rely on the FAQ’s broader promise. |
| **Public fan experience vs data restrictions** | The brief requires a deployed consumer product, and the FAQ says the free tier can support commercial projects. The hackathon terms prohibit publishing, redistributing, sharing, or otherwise making TxODDS Data available and terminate the licence at the hackathon’s conclusion. The general TxLINE terms also restrict Data to internal business use and prohibit public dissemination. | Keep raw TxLINE feeds and credentials server-side, expose only the minimum derived presentation needed for the demo, and obtain written approval for public display, caching, replay, and post-hackathon operation. |
| **Free-access end date** | The listing waives commercial data fees through “Saturday, July 19, 2026 (23:59 UTC).” July 19 is Sunday. | The explicit timestamp—July 19 at 23:59 UTC—is controlling. Confirm whether access ends exactly then and whether any grace period exists. |

### Additional technical documentation inconsistencies

- The OpenAPI 1.5.6 description refers to real-time World Cup odds sampled every 60 seconds, while the current tier table separates mainnet level `1` (60-second delay) from level `12` (real-time). Query the current on-chain pricing matrix and confirm the selected tier rather than relying on prose.
- The OpenAPI server list currently shows the devnet host with `http://`; all current guides and examples use `https://txline-dev.txodds.com`. Use HTTPS.
- The hosted documentation advertises `/llms.txt`, but `https://txline.txodds.com/llms.txt` returned 404 when checked on July 15. Use the maintained [GitHub copy](https://github.com/txodds/tx-on-chain/blob/main/llms.txt).
- The confirmed-fixture schedule is not a complete future calendar and is explicitly subject to change. Discover fixtures through the snapshot API rather than hard-coding the page’s fixture IDs.

## Legal and commercial summary

### Project ownership and licences

- Participants retain ownership of the submitted project, code, designs, and content.
- Submission grants TxODDS and its partners a worldwide, non-exclusive, royalty-free, perpetual, irrevocable, and transferable licence to use, reproduce, distribute, display, and test the submission for hackathon-related purposes, including evaluation and promotion.
- Participants grant publicity rights covering names, likenesses, photographs, voices, and biographical information in connection with the hackathon.
- Submissions are not confidential. Do not include trade secrets or other information that should remain private.
- TxODDS retains all rights in its Data, APIs, software, methodologies, scoring systems, and blockchain infrastructure.
- Under the general TxLINE terms, feedback about TxLINE becomes TxODDS property and may be used without restriction or compensation.

### Data licence and post-hackathon behavior

- Hackathon Data is licensed only for hackathon participation, with all ungranted rights reserved.
- The official hackathon terms state that the Data licence terminates when the hackathon concludes.
- The terms prohibit redistributing, publishing, sublicensing, selling, sharing, or otherwise making the Data available, and prohibit reconstructing or creating competing products from the Data/APIs/methodologies.
- General TxLINE terms additionally prohibit unauthorized public dissemination, caching/mirroring, pass-through access, scraping outside the API, shared access, and unlawful gambling use.
- The API and Data are provided “as is” and may contain delays, outages, corrections, omissions, or inaccurate/dynamic sports information.
- Before leaving the app publicly deployed after the deadline, obtain a continuing commercial/data licence or disable TxLINE-powered public output and delete/expire retained data as required by the sponsor.

### Prizes and payment

- The track advertises 10,000 / 4,000 / 2,000 USDT for first, second, and third.
- TxODDS may substitute another stablecoin or equivalent cash where necessary and may decline to award a prize if no entry meets its standard.
- Network or transfer fees may be deducted from the prize.
- Winners are responsible for taxes, fees, a correct compatible wallet address, and continued wallet access.
- Prize payment can require identity, eligibility, sanctions, and compliance verification.
- A winning team may need to nominate one recipient and handle its own internal distribution.
- A potential winner who cannot be contacted or does not return required documents within 30 days may forfeit the prize.
- Superteam acts as a platform provider and generally disclaims responsibility for sponsor non-payment or disputes between users.

### Governing terms and risk

- TxODDS hackathon and TxLINE terms use English law and English courts.
- Superteam’s terms use Singapore law and Singapore courts for platform disputes.
- Participants assume blockchain, wallet, transaction, network, smart-contract, stablecoin, and regulatory risks.
- TxODDS may restrict access, require KYC, screen wallets/sanctions, throttle service, or terminate access for legal, compliance, reputational, or operational reasons.
- Both TxODDS and Superteam place tax compliance on the participant.

### Privacy

- Participants must comply with applicable privacy and data-protection laws for any fan data their product collects.
- Prefer anonymous or local-only fan state unless personal information is essential.
- Disclose analytics, cookies, wallets, social handles, notifications, or account data collected by the product and provide an appropriate privacy notice.
- Superteam’s platform privacy policy says it may collect account, device, IP/geolocation, email, username, wallet, public blockchain, support, cookie, and usage data and may share it for operations, compliance, fraud prevention, and service delivery.

## TxLINE integration reference

### What TxLINE provides

TxLINE combines hosted TxODDS APIs with Solana subscriptions and on-chain Merkle roots. The World Cup bundle includes fixtures, scheduling, scores, match events, status/period changes, StablePrice odds, historical replay where available, and proof endpoints for on-chain validation.

StablePrice aggregates and de-margins prices from multiple operators, filters stale/outlier/bad data, and emits the actual markets present for each fixture. Never assume that corners, cards, both-teams-to-score, player props, or another market exists; branch from the returned `SuperOddsType` and market parameters.

### Network matrix

Use every value from one row. Mixing networks is the most common activation failure.

| Value | Mainnet | Devnet |
| --- | --- | --- |
| Solana RPC | `https://api.mainnet-beta.solana.com` | `https://api.devnet.solana.com` |
| Program ID | `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` | `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` |
| TxL mint | `Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL` | `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG` |
| Guest auth | `https://txline.txodds.com/auth/guest/start` | `https://txline-dev.txodds.com/auth/guest/start` |
| Activation | `https://txline.txodds.com/api/token/activate` | `https://txline-dev.txodds.com/api/token/activate` |
| API base | `https://txline.txodds.com/api/` | `https://txline-dev.txodds.com/api/` |
| Current free tiers | Level `1`: 60-second delay; level `12`: real-time | Level `1`: currently reports `samplingIntervalSec = 0` |

Free means no TxL subscription payment. A wallet still needs SOL on the selected network for the subscription transaction and possible account rent. Devnet users need devnet SOL.

Subscriptions are purchased in four-week increments. The current docs say free renewals remain free, but pricing and on-chain rows can change; query the `pricing_matrix` PDA before relying on a service level.

### Subscription and activation flow

1. Select mainnet or devnet and load matching RPC, program ID, TxL mint, IDL, generated types, and API host.
2. Fund the wallet with enough SOL on that network for transaction fees and possible rent.
3. Request a guest JWT with `POST /auth/guest/start` on the matching host.
4. Submit and confirm the on-chain `subscribe(serviceLevelId, durationWeeks)` transaction. For the standard free World Cup bundle use an empty league list.
5. Construct the exact message:

   ```text
   ${txSig}:${selectedLeagues.join(",")}:${jwt}
   ```

   With `selectedLeagues = []`, the exact signed value contains two colons:

   ```text
   ${txSig}::${jwt}
   ```

6. Sign the message with the same wallet that submitted `subscribe`, using a detached signature encoded as Base64.
7. Send `txSig`, `walletSignature`, and `leagues` to `POST /api/token/activate` with the guest JWT as the Bearer token.
8. Store the returned API token securely and call data endpoints with both credentials:

   ```http
   Authorization: Bearer <guest-jwt>
   X-Api-Token: <activated-api-token>
   ```

The guest JWT is documented as expiring after 30 days. On a data request returning `401`, acquire a fresh guest JWT from the same host and retry with the existing activated API token. A `403` more often indicates a network, subscription, entitlement, or API-token mismatch.

### Credential and deployment safety

- Keep guest JWTs, API tokens, and wallet signing material on a trusted server; do not ship them in a browser/mobile bundle.
- Proxy only the minimum normalized/derived data needed by the fan experience.
- Never commit `.env` files, wallet keypairs, tokens, or full request logs.
- Redact credentials and transaction details before sharing support output.
- Do not reuse a mainnet token on devnet or vice versa.
- Give judges a zero-cost test path that does not require them to hold SOL or create a wallet.

### Snapshot, stream, and replay behavior

- Use fixture snapshots for current discovery; do not hard-code the documentation schedule.
- Use snapshots to initialize state before opening a stream.
- Odds and scores streams use Server-Sent Events (SSE).
- An accepted SSE connection may emit only heartbeats or remain quiet when no covered fixture is actively updating; this is not automatically a connection failure.
- Reconnect after credential refresh and treat events as an ordered stream that can be duplicated or corrected.
- Optional gzip response encoding can materially reduce stream bandwidth; ensure the selected client can decompress chunks correctly.
- `/api/scores/historical/{fixtureId}` is documented for fixtures that started between **two weeks and six hours ago**. Use live/current endpoints inside the six-hour boundary.
- Historical fixtures and a deterministic replay mode are valuable for the demo, but retention and public replay require sponsor confirmation under the data licence.

### Soccer feed semantics

#### Game phases

| ID | Code | Meaning |
| ---: | --- | --- |
| 1 | `NS` | Not started |
| 2 | `H1` | First half in play |
| 3 | `HT` | Halftime |
| 4 | `H2` | Second half in play |
| 5 | `F` | Finished |
| 6 | `WET` | Waiting for extra time |
| 7 | `ET1` | Extra-time first half |
| 8 | `HTET` | Extra-time halftime |
| 9 | `ET2` | Extra-time second half |
| 10 | `FET` | Finished after extra time |
| 11 | `WPE` | Waiting for penalties |
| 12 | `PE` | Penalty shootout in progress |
| 13 | `FPE` | Finished after penalties |
| 14 | `I` | Interrupted |
| 15 | `A` | Abandoned |
| 16 | `C` | Cancelled |
| 17 | `TXCC` | TxODDS coverage cancelled |
| 18 | `TXCS` | TxODDS coverage suspended |
| 19 | `P` | Postponed |

#### Stat keys and period prefixes

Base full-game keys are:

| Key | Statistic |
| ---: | --- |
| 1 / 2 | Participant 1 / 2 total goals |
| 3 / 4 | Participant 1 / 2 total yellow cards |
| 5 / 6 | Participant 1 / 2 total red cards |
| 7 / 8 | Participant 1 / 2 total corners |

Period-specific keys are `period_prefix + base_key`:

| Prefix | Period |
| ---: | --- |
| 0 | Full match total |
| 1000 | First half (`H1`) |
| 2000 | Halftime (`HT`) |
| 3000 | Second half (`H2`) |
| 4000 | Extra-time first half (`ET1`) |
| 5000 | Extra-time second half (`ET2`) |
| 6000 | Penalty shootout (`PE`) |
| 7000 | Extra-time total |

Other integration details:

- A final score record currently uses `action=game_finalised`, `statusId=100`, and `period=100`, regardless of regulation, extra time, penalties, or abandonment.
- Fixture `GameState` values currently documented are `1` for scheduled and `6` for cancelled.
- `Participant1IsHome` is a feed designation, not a claim that the match is in that participant’s country.
- Hydration breaks arrive as `comment` with `Data.Text = "Water-drinking break"`.
- Fouls do not have a separate documented action; use `free_kick` and distinguish offside with `Data.FreeKickType = "Offside"`.
- Shot outcomes include `OnTarget`, `OffTarget`, `Woodwork`, and `Blocked`.
- VAR types include `Goal`, `Penalty`, `RedCard`, `SecondYellowCard`, `CornerKick`, `MistakenIdentity`, and `Other`; `var_end` can be `Stands` or `Overturned`.

### On-chain validation notes

Consumer experiences do not have to settle markets, but proof-backed UI can demonstrate TxLINE’s differentiator.

- Fixture proofs anchor to `ten_daily_fixtures_roots`.
- Odds proofs anchor to `daily_batch_roots`.
- Score proofs anchor to `daily_scores_roots`.
- Derive the epoch day from the exact proof timestamp, not from `Date.now()`.
- Use a real observed fixture ID and score `Seq`/`seq`; never pass placeholder `0`.
- Decode proof hashes to exactly 32 bytes.
- Legacy `/api/scores/stat-validation` requests use `statKey` and optional `statKey2` with `validateStat`.
- V2 requests use ordered `statKeys=1,2,...` with `validateStatV2`; strategy indexes refer to array positions, not numeric key values.
- The OpenAPI also exposes `/api/scores/stat-validation-v3` for a Merkle multiproof. Use the current schema and matching network program reference before implementation.

## Complete OpenAPI endpoint catalog

Canonical source: [TxLINE OpenAPI YAML, version 1.5.6 when verified](https://txline.txodds.com/docs/docs.yaml). Every data request should use the host matching the activated subscription.

### Access and purchase — 3 endpoints

1. `POST /auth/guest/start` — start an anonymous guest session and receive a JWT.
2. `POST /api/token/activate` — activate a confirmed on-chain subscription and receive an API token.
3. `POST /api/guest/purchase/quote` — request a partially signed TxL purchase transaction; not required for the free World Cup tier.

### Fixture retrieval — 2 endpoints

4. `GET /api/fixtures/snapshot` — retrieve the latest fixture snapshot, optionally filtered by `startEpochDay` and `competitionId`.
5. `GET /api/fixtures/updates/{epochDay}/{hourOfDay}` — retrieve fixture updates for a fixture/day using the documented query parameters.

### Odds retrieval — 3 endpoints

6. `GET /api/odds/snapshot/{fixtureId}` — retrieve the latest odds snapshots for a fixture, optionally as of a timestamp.
7. `GET /api/odds/updates/{fixtureId}` — retrieve current live odds updates for a fixture.
8. `GET /api/odds/updates/{epochDay}/{hourOfDay}/{interval}` — retrieve odds updates for a historical five-minute interval.

### Score retrieval and replay — 4 endpoints

9. `GET /api/scores/snapshot/{fixtureId}` — retrieve the latest snapshot for each score-event action.
10. `GET /api/scores/updates/{epochDay}/{hourOfDay}/{interval}` — retrieve historical score updates for a five-minute interval.
11. `GET /api/scores/updates/{fixtureId}` — retrieve the sequence of score updates for the fixture in the current five-minute interval.
12. `GET /api/scores/historical/{fixtureId}` — retrieve the full available historical score sequence for a fixture.

### Real-time streams — 2 endpoints

13. `GET /api/odds/stream` — receive odds updates over SSE.
14. `GET /api/scores/stream` — receive score updates over SSE.

### Validation and proofs — 5 endpoints

15. `GET /api/fixtures/validation` — retrieve a Merkle proof for a specific fixture update.
16. `GET /api/fixtures/batch-validation` — retrieve a proof for an hourly fixture batch.
17. `GET /api/odds/validation` — retrieve a Merkle proof for a specific odds update.
18. `GET /api/scores/stat-validation` — retrieve score-stat proofs for legacy single/two-stat or V2 ordered multi-stat validation.
19. `GET /api/scores/stat-validation-v3` — retrieve a score-stat Merkle multiproof using the current OpenAPI schema.

## Troubleshooting quick reference

| Symptom | First checks |
| --- | --- |
| Activation `504` | Network mismatch or backend timeout; align transaction, JWT, program ID, and activation host. |
| Activation `403 signature verification failed` | Exact signed string, same subscription wallet, Base64 detached signature, and same-host JWT. |
| Data `401` | Guest JWT missing/expired; renew it on the same host and retain the API token. |
| Data `403` | API token, subscription, network, or bundle mismatch/expiry. |
| SSE opens but no data | Check covered fixture time, keep the stream open, or use historical replay. |
| `InvalidMainTreeProof` | Proof timestamp, epoch-day PDA, fixture/sequence, and 32-byte proof decoding. |
| V2 validates wrong value | Preserve `statKeys` order and use positional strategy indexes. |
| Final result is wrong | Select `game_finalised` with `statusId=100` and `period=100`. |

When requesting support, include the network, endpoint, status code, program ID, service level, redacted transaction signature, fixture/sequence/stat/timestamp/PDA details, and a redacted response body. Never send a JWT, API token, secret key, or unredacted authorization log.

## Official resource directory

### Hackathon and platform

- [Consumer and Fan Experiences track listing](https://superteam.fun/earn/listing/consumer-and-fan-experiences) — authoritative brief, judging, deliverables, prizes, and timeline.
- [World Cup Hackathon program hub](https://superteam.fun/earn/hackathon/world-cup) — overall prize pool, three tracks, and program FAQ.
- [TxODDS World Cup Hackathon Terms and Conditions](https://txline.txodds.com/documentation/legal/hackathon-terms) — eligibility, conduct, judging, IP, data, prizes, publicity, liability, and governing law.
- [Superteam Earn Terms of Use](https://superteam.fun/earn/terms-of-use.pdf) — platform eligibility, conduct, payment, risk, liability, and dispute terms.
- [Superteam Earn Privacy Policy](https://superteam.fun/earn/privacy-policy.pdf) — platform data collection, use, sharing, cookies, security, and privacy rights.
- [Superteam Earn FAQ](https://superteamdao.notion.site/Superteam-Earn-FAQ-aedaa039b25741b1861167d68aa880b1?pvs=4) — general platform guidance.

### TxLINE getting started

- [Quickstart](https://txline.txodds.com/documentation/quickstart) — network setup, optional purchase, subscribe, activation, and credential lifecycle.
- [World Cup Free Tier](https://txline.txodds.com/documentation/worldcup) — free World Cup/International Friendlies tiers and end-to-end activation.
- [Subscription Tiers](https://txline.txodds.com/documentation/subscription-tiers) — service levels, delays, pricing, and on-chain matrix verification.
- [FAQ overview source](https://github.com/txodds/tx-on-chain/blob/main/faq-overview.mdx) — wallet, free tier, coverage, rate limits, commercial use, and support FAQ. The hosted root FAQ route was not reliably fetchable during verification.

### Odds documentation

- [Odds overview](https://txline.txodds.com/documentation/odds/overview) — StablePrice consensus, filtering, proof model, and performance tiers.
- [StablePrice feed and coverage](https://txline.txodds.com/documentation/odds/odds-coverage) — covered competitions and per-fixture market-discovery guidance.

### Scores documentation

- [Scores overview](https://txline.txodds.com/documentation/scores/overview) — deterministic score/event data, proofs, and finalization semantics.
- [Current scores schedule](https://txline.txodds.com/documentation/scores/schedule) — confirmed covered fixtures and IDs; subject to change.
- [Soccer feed](https://txline.txodds.com/documentation/scores/soccer-feed) — World Cup event, phase, stat, and proof encodings.
- [Soccer feed v1.1 PDF](https://txodds.github.io/tx-on-chain/assets/txodds-soccer-feed-v1.1.pdf) — downloadable full soccer feed specification.
- [American football feed](https://txline.txodds.com/documentation/scores/football-feed) — out-of-track reference included by the official index.
- [Basketball feed](https://txline.txodds.com/documentation/scores/basketball-feed) — out-of-track reference included by the official index.

### Solana program references

- [Program addresses](https://txline.txodds.com/documentation/programs/addresses) — current network values, activation hosts, and public validation accounts.
- [Mainnet program reference](https://txline.txodds.com/documentation/programs/mainnet) — mainnet integration values, PDAs, and validation guidance.
- [Devnet program reference](https://txline.txodds.com/documentation/programs/devnet) — devnet integration values, PDAs, and validation guidance.

### Integration examples

- [Fetching snapshots](https://txline.txodds.com/documentation/examples/fetching-snapshots) — fixtures, odds, and scores REST examples.
- [Streaming data](https://txline.txodds.com/documentation/examples/streaming-data) — SSE parsing, odds/scores streams, and historical scores.
- [On-chain validation](https://txline.txodds.com/documentation/examples/onchain-validation) — proof retrieval and `validateStat`/`validateStatV2` flows.
- [Runnable devnet examples](https://txline.txodds.com/documentation/examples/devnet-examples) — environment, script index, and current validation approaches.
- [Troubleshooting](https://txline.txodds.com/documentation/examples/troubleshooting) — activation, authentication, stream, and validation diagnostics.

### API specification and source repository

- [OpenAPI YAML](https://txline.txodds.com/docs/docs.yaml) — canonical REST/SSE contract and schemas.
- [TxLINE GitHub repository](https://github.com/txodds/tx-on-chain) — public documentation sources, IDLs, generated types, examples, and assets.
- [Documentation index on GitHub](https://github.com/txodds/tx-on-chain/blob/main/llms.txt) — maintained replacement for the currently broken hosted `/llms.txt` link.
- [Devnet example directory](https://github.com/txodds/tx-on-chain/tree/main/examples/devnet) — matching devnet IDL/types, helpers, and scripts.
- [Devnet scripts](https://github.com/txodds/tx-on-chain/tree/main/examples/devnet/scripts) — free-tier, scores, V2, and fixture-validation examples.
- [Mainnet IDL](https://github.com/txodds/tx-on-chain/blob/main/idl/txoracle.json) and [mainnet generated type](https://github.com/txodds/tx-on-chain/blob/main/types/txoracle.ts).
- [Devnet IDL](https://github.com/txodds/tx-on-chain/blob/main/examples/devnet/idl/txoracle.json) and [devnet generated type](https://github.com/txodds/tx-on-chain/blob/main/examples/devnet/types/txoracle.ts).

The current runnable script set includes:

- [`subscription_free_tier.ts`](https://github.com/txodds/tx-on-chain/blob/main/examples/devnet/scripts/subscription_free_tier.ts) — activation, odds snapshots, and odds SSE.
- [`subscription_scores.ts`](https://github.com/txodds/tx-on-chain/blob/main/examples/devnet/scripts/subscription_scores.ts) — score snapshots, legacy validation, and score SSE.
- [`subscription_scores_1stat.ts`](https://github.com/txodds/tx-on-chain/blob/main/examples/devnet/scripts/subscription_scores_1stat.ts) — one-stat V2 validation.
- [`subscription_scores_v2.ts`](https://github.com/txodds/tx-on-chain/blob/main/examples/devnet/scripts/subscription_scores_v2.ts) — two-stat and geometric V2 strategies.
- [`subscription_scores_v2a.ts`](https://github.com/txodds/tx-on-chain/blob/main/examples/devnet/scripts/subscription_scores_v2a.ts) — multi-leg V2 strategies.
- [`fixture_validation_view_only.ts`](https://github.com/txodds/tx-on-chain/blob/main/examples/devnet/scripts/fixture_validation_view_only.ts) — fixture proof simulation.

### Legal documentation

- [General TxLINE Terms and Conditions](https://txline.txodds.com/documentation/legal/terms-and-conditions) — API/Data licence and acceptable-use rules.
- [World Cup Hackathon Terms and Conditions](https://txline.txodds.com/documentation/legal/hackathon-terms) — hackathon-specific rules.

### Support and feedback

- [TxODDS Discord](https://discord.gg/txodds) — developer support and real-time bug reports.
- [TxLINE Telegram](https://t.me/TxLINEChat) — the track listing’s direct contact channel.
- TxODDS support email: [hello@txodds.com](mailto:hello@txodds.com).
- Superteam support/privacy email: [support@superteam.fun](mailto:support@superteam.fun).

## Sponsor questions requiring written clarification

Ask these in Telegram or Discord early enough to act on the answers, and retain the reply/link with the submission records.

1. What use of AI coding tools is permitted without a submission being considered “generated, submitted or materially controlled” by an agent?
2. Can a company participate, or must every entry be submitted only by named natural persons?
3. Can one team or participant win prizes in more than one track, given the program FAQ and official terms conflict?
4. What TxLINE fields may a public fan-facing application display, cache, transform, or replay without violating the no-publication/no-redistribution clauses?
5. Does the hackathon data licence end at July 19 at 23:59 UTC, the winner announcement, the end of judging, or another date?
6. What must a deployed app do with retained/replayed Data after the licence ends, and what licence is needed to remain online?
7. Is a server-side proxy returning derived fan-facing state explicitly permitted?
8. How should judges test Solana-backed behavior without establishing a wallet/account or paying any fee?
9. Does mainnet free service level `12` remain the intended real-time World Cup tier through judging, and what availability follows the deadline?
10. Is the Sunday July 19 timestamp correct despite the listing’s Saturday label?

## Final pre-submission checklist

### Product and reliability

- [ ] The core fan loop works end-to-end on a phone-sized viewport.
- [ ] A visible UI change is driven by real TxLINE data, not only local mock data.
- [ ] Snapshot hydration, SSE reconnection, quiet-stream behavior, corrections, and unavailable-data fallbacks are tested.
- [ ] A deterministic replay can demonstrate the experience when no covered fixture is live, subject to written data-use approval.
- [ ] No fixture ID, market catalog, service interval, schedule, or odds type is incorrectly assumed or hard-coded.
- [ ] TxLINE credentials and wallet secrets are server-side and excluded from repository history and logs.

### Judging and submission

- [ ] The five judging criteria are explicitly demonstrated or explained.
- [ ] The deployed URL/API works in a clean browser without payment, wallet creation, or manual approval.
- [ ] The public repository is accessible and contains setup/run instructions plus third-party attribution.
- [ ] The demo is five minutes or shorter and shows the problem, full flow, live/replayed response, TxLINE integration, polish, and monetization path.
- [ ] The technical overview names every TxLINE endpoint actually used.
- [ ] API feedback includes both strengths and concrete friction/bugs.
- [ ] Submission content contains no unlicensed branding, assets, or implied FIFA/tournament affiliation.
- [ ] All team members, team leader, wallet/payee plan, and contact email are correct.
- [ ] The submission is sent before **July 19, 2026 at 23:59 UTC / 20:59 ART**.

### Final compliance audit

- [ ] Re-read the live track listing, official hackathon terms, TxLINE terms, Superteam terms, and privacy policy on submission day.
- [ ] Recheck current on-chain pricing/service rows and current TxLINE fixture coverage.
- [ ] Resolve the AI, prize, company, data-display, replay, and post-deadline conflicts in writing.
- [ ] Verify all links and video permissions from a signed-out session.
- [ ] Confirm no secrets or private data appear in the repository, deployment output, demo, screenshots, or support threads.
- [ ] Keep the team leader’s email monitored for winner/interview requests and any 30-day document deadline.

## Source-verification notes

- The track listing and program hub were inspected as rendered pages because important brief and FAQ content is loaded dynamically.
- The TxLINE documentation pages, OpenAPI 1.5.6 source, GitHub repository, TxODDS terms, and Superteam PDFs were cross-checked on July 15, 2026.
- Link availability is not proof that an account, region, or future date will retain access.
- Facts marked “current,” especially service levels, pricing, fixtures, API schemas, and legal terms, must be revalidated before implementation and again before submission.
