"use client";

import { useEffect, useMemo, useState } from "react";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  PublicKey,
  type ParsedAccountData,
  VersionedTransaction,
} from "@solana/web3.js";
import { GoalRace } from "@goaldrop/ui";
import { browserApiOrigin, readApiJson, type FixtureSummary } from "../lib/api";
import { track } from "../lib/analytics";
import { selectFundedSourceTokenAccount } from "../lib/source-token-account";
import { parseTokenAmount } from "../lib/token-amount";

interface RoundDraft {
  reward: string;
  cap: number;
}
interface CampaignStats {
  state: string;
  requiredFunding: string;
  fundedAmount: string;
  paidAmount: string;
  refundedAmount: string;
  registrationCount: number;
  roundCount: number;
  winnerCount: number;
}

export function SponsorDashboard({ fixtures }: { fixtures: FixtureSummary[] }) {
  const wallet = useWallet();
  const { connection } = useConnection();
  const [fixtureId, setFixtureId] = useState(
    fixtures.find((fixture) => fixture.fixtureSlotAvailable)?.fixtureId ?? "",
  );
  const [refundWallet, setRefundWallet] = useState("");
  const [registrationDeadline, setRegistrationDeadline] = useState("");
  const [rounds, setRounds] = useState<RoundDraft[]>([
    { reward: "5", cap: 25 },
    { reward: "5", cap: 25 },
    { reward: "10", cap: 10 },
  ]);
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [orderingAccepted, setOrderingAccepted] = useState(false);
  const [status, setStatus] = useState(
    "Connect the sponsor wallet to build the campaign transaction.",
  );
  const [busy, setBusy] = useState(false);
  const [campaign, setCampaign] = useState<string | null>(null);
  const [sourceTokenSelection, setSourceTokenSelection] = useState({
    wallet: "",
    address: "",
  });
  const [sourceTokenStatus, setSourceTokenStatus] = useState(
    "Connect a sponsor wallet to detect its GOAL account.",
  );
  const [campaignStage, setCampaignStage] = useState<
    "none" | "draft" | "funded" | "active" | "terminal"
  >("none");
  const [campaignStats, setCampaignStats] = useState<CampaignStats | null>(
    null,
  );
  const decimals = Number(process.env.NEXT_PUBLIC_REWARD_DECIMALS ?? 6);
  const rewardMint =
    process.env.NEXT_PUBLIC_REWARD_MINT ?? "Configured GoalDrop mint";
  const sponsorAddress = wallet.publicKey?.toBase58() ?? "";
  const sourceTokenAccount =
    sourceTokenSelection.wallet === sponsorAddress
      ? sourceTokenSelection.address
      : "";
  const liability = useMemo(
    () =>
      rounds.reduce(
        (sum, round) =>
          sum +
          parseDraftTokens(round.reward, decimals) * BigInt(round.cap || 0),
        0n,
      ),
    [rounds, decimals],
  );

  useEffect(() => {
    const sponsor = wallet.publicKey;
    if (!sponsor) return;

    let rewardMintAddress: PublicKey;
    try {
      rewardMintAddress = new PublicKey(rewardMint);
    } catch {
      return;
    }

    let cancelled = false;
    void connection
      .getParsedTokenAccountsByOwner(
        sponsor,
        { mint: rewardMintAddress },
        "confirmed",
      )
      .then(({ value }) => {
        if (cancelled) return;
        const selected = selectFundedSourceTokenAccount(
          value
            .filter(({ account }) => account.owner.equals(TOKEN_PROGRAM_ID))
            .map(({ pubkey, account }) => {
              const parsed = account.data as ParsedAccountData;
              return {
                address: pubkey.toBase58(),
                amount: BigInt(String(parsed.parsed.info.tokenAmount.amount)),
              };
            }),
        );
        if (!selected) {
          setSourceTokenStatus(
            "No funded classic SPL GOAL account was found. Use the Devnet faucet or enter one manually.",
          );
          return;
        }
        setSourceTokenSelection({
          wallet: sponsor.toBase58(),
          address: selected.address,
        });
        setSourceTokenStatus(
          `Detected ${formatBaseUnits(selected.amount, decimals)} GOAL in ${short(selected.address)}.`,
        );
      })
      .catch(() => {
        if (!cancelled)
          setSourceTokenStatus(
            "GOAL account detection failed. You can still enter the token account manually.",
          );
      });

    return () => {
      cancelled = true;
    };
  }, [connection, decimals, rewardMint, wallet.publicKey]);

  useEffect(() => {
    if (!campaign) return;
    const controller = new AbortController();
    const refresh = async () => {
      const response = await fetch(
        `${browserApiOrigin}/v1/campaigns/${campaign}`,
        { cache: "no-store", signal: controller.signal },
      );
      if (!response.ok) return;
      const result = await readApiJson<{
        campaign: Record<string, unknown>;
        rounds: Record<string, unknown>[];
        configuredRounds?: unknown[];
      }>(response, "Could not refresh campaign");
      setCampaignStats({
        state: String(result.campaign.state),
        requiredFunding: String(result.campaign.required_funding),
        fundedAmount: String(result.campaign.funded_amount),
        paidAmount: String(result.campaign.paid_amount),
        refundedAmount: String(result.campaign.refunded_amount),
        registrationCount: Number(result.campaign.registration_count),
        roundCount: result.configuredRounds?.length ?? result.rounds.length,
        winnerCount: result.rounds.reduce(
          (total, round) => total + Number(round.winner_count ?? 0),
          0,
        ),
      });
    };
    const frame = requestAnimationFrame(() => {
      void refresh().catch(() => undefined);
    });
    const timer = setInterval(() => {
      void refresh().catch(() => undefined);
    }, 3_000);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(timer);
      controller.abort();
    };
  }, [campaign]);

  const updateRound = (index: number, patch: Partial<RoundDraft>) =>
    setRounds((items) =>
      items.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
    );
  const addRound = () => {
    if (rounds.length < 8)
      setRounds((items) => [...items, { reward: "5", cap: 25 }]);
  };

  const create = async () => {
    if (!wallet.publicKey || !wallet.signTransaction) {
      setStatus("Select a transaction-capable sponsor wallet first.");
      return;
    }
    if (!fixtureId || !riskAccepted || !orderingAccepted) {
      setStatus("Choose a fixture and accept both campaign risks.");
      return;
    }
    const start =
      fixtures.find((fixture) => fixture.fixtureId === fixtureId)
        ?.scheduledStart ?? new Date(Date.now() + 3_600_000).toISOString();
    const deadline = registrationDeadline
      ? new Date(registrationDeadline)
      : new Date(start);
    if (
      Number.isNaN(deadline.getTime()) ||
      deadline.getTime() > new Date(start).getTime()
    ) {
      setStatus(
        "Registration deadline must be a valid time no later than kickoff.",
      );
      return;
    }
    setBusy(true);
    track("sponsor_setup_started", {
      properties: { fixture_source: fixtures.length ? "txline" : "manual" },
    });
    try {
      const result = await buildAndSubmit(wallet.signTransaction, "create", {
        sponsor: wallet.publicKey.toBase58(),
        refundWallet: refundWallet || wallet.publicKey.toBase58(),
        fixtureId,
        campaignNonce: String(BigInt(Date.now())),
        scheduledStart: Math.floor(new Date(start).getTime() / 1_000),
        registrationDeadline: Math.floor(deadline.getTime() / 1_000),
        expectedEnd: Math.floor(new Date(start).getTime() / 1_000) + 10_800,
        hardExpiry: Math.floor(new Date(start).getTime() / 1_000) + 28_800,
        rounds: rounds.map((round) => ({
          rewardAmount: parseTokenAmount(round.reward, decimals).toString(),
          winnerCap: round.cap,
        })),
      });
      setCampaign(String(result.campaign));
      setCampaignStage("draft");
      setStatus(
        `Campaign ${short(String(result.campaign))} created. Fund the exact ${formatBaseUnits(liability, decimals)} GOAL liability next.`,
      );
      track("campaign_created", {
        campaign: String(result.campaign),
        properties: { round_count: rounds.length },
      });
    } catch (error) {
      setStatus(message(error));
    } finally {
      setBusy(false);
    }
  };

  const campaignAction = async (
    action: "fund" | "activate" | "cancel" | "refund",
  ) => {
    if (!campaign || !wallet.publicKey || !wallet.signTransaction) {
      setStatus("Connect the sponsor wallet and enter a campaign address.");
      return;
    }
    setBusy(true);
    try {
      const result = await buildAndSubmit(
        wallet.signTransaction,
        action,
        action === "fund"
          ? {
              sponsor: wallet.publicKey.toBase58(),
              campaign,
              sourceTokenAccount,
            }
          : action === "refund"
            ? { campaign }
            : { sponsor: wallet.publicKey.toBase58(), campaign },
        action !== "refund",
      );
      if (action === "fund") setCampaignStage("funded");
      if (action === "activate") setCampaignStage("active");
      if (action === "cancel" || action === "refund")
        setCampaignStage("terminal");
      if (action === "fund")
        track("campaign_funded", {
          campaign,
          properties: { round_count: rounds.length },
        });
      if (action === "activate")
        track("campaign_activated", {
          campaign,
          properties: { round_count: rounds.length },
        });
      if (action === "refund") track("campaign_refunded", { campaign });
      setStatus(
        `${action[0]?.toUpperCase()}${action.slice(1)} confirmed: ${short(String(result.signature))}`,
      );
    } catch (error) {
      setStatus(message(error));
    } finally {
      setBusy(false);
    }
  };

  const claimFaucetTokens = async () => {
    if (!wallet.publicKey || !wallet.signTransaction) {
      setStatus("Select a transaction-capable sponsor wallet first.");
      return;
    }
    setBusy(true);
    try {
      const built = await json<{
        templateId: string;
        transaction: string;
      }>("/v1/faucet/build", { wallet: wallet.publicKey.toBase58() });
      const transaction = VersionedTransaction.deserialize(
        fromBase64(built.transaction),
      );
      const signed = await wallet.signTransaction(transaction);
      const result = await json<Record<string, unknown>>("/v1/faucet/submit", {
        templateId: built.templateId,
        signedTransaction: toBase64(signed.serialize()),
      });
      setSourceTokenSelection({
        wallet: wallet.publicKey.toBase58(),
        address: String(result.tokenAccount),
      });
      setStatus(
        `Devnet faucet confirmed: ${formatBaseUnits(BigInt(String(result.amount)), decimals)} valueless GOAL in ${short(String(result.tokenAccount))}.`,
      );
    } catch (error) {
      setStatus(message(error));
    } finally {
      setBusy(false);
    }
  };

  const funded = BigInt(campaignStats?.fundedAmount ?? 0);
  const paid = BigInt(campaignStats?.paidAmount ?? 0);
  const refunded = BigInt(campaignStats?.refundedAmount ?? 0);
  const residual = funded > paid + refunded ? funded - paid - refunded : 0n;
  const required = BigInt(campaignStats?.requiredFunding ?? liability);
  const utilization =
    required > 0n ? Number((paid * 10_000n) / required) / 100 : 0;
  const previewRound = rounds[0] ?? { reward: "0", cap: 0 };

  return (
    <div className="sponsor-shell">
      <header className="dashboard-heading">
        <div>
          <p className="section-kicker">Sponsor campaign studio</p>
          <h1>
            Fund the roar.
            <br />
            Cap the liability.
          </h1>
        </div>
        <div className="sponsor-wallet">
          <WalletMultiButton>Connect sponsor wallet</WalletMultiButton>
          <span>
            Solana Devnet ·{" "}
            {wallet.publicKey
              ? short(wallet.publicKey.toBase58())
              : "external wallet required"}
          </span>
        </div>
      </header>
      <div className="dashboard-grid">
        <section className="dashboard-panel fixture-picker">
          <span className="step-number">01</span>
          <h2>Select a TxLINE fixture</h2>
          <p>Only one non-refunded campaign can reserve a fixture slot.</p>
          <div className="fixture-options">
            {fixtures.length ? (
              fixtures.map((fixture) => (
                <label
                  key={fixture.fixtureId}
                  className={!fixture.fixtureSlotAvailable ? "disabled" : ""}
                >
                  <input
                    type="radio"
                    name="fixture"
                    value={fixture.fixtureId}
                    checked={fixtureId === fixture.fixtureId}
                    disabled={!fixture.fixtureSlotAvailable}
                    onChange={() => setFixtureId(fixture.fixtureId)}
                  />
                  <span>
                    <b>
                      {fixture.home} <i>vs</i> {fixture.away}
                    </b>
                    <small>
                      {fixture.competition} ·{" "}
                      {new Date(fixture.scheduledStart).toLocaleString()}
                    </small>
                  </span>
                  <em>
                    {fixture.fixtureSlotAvailable ? "Available" : "Reserved"}
                  </em>
                </label>
              ))
            ) : (
              <label>
                <input type="radio" checked readOnly />
                <span>
                  <b>World Cup Showcase</b>
                  <small>Configure fixture ID manually for Devnet</small>
                </span>
                <em>Demo</em>
              </label>
            )}
          </div>
          {!fixtures.length ? (
            <input
              className="field"
              aria-label="TxLINE fixture ID"
              placeholder="TxLINE fixture ID"
              value={fixtureId}
              onChange={(event) =>
                setFixtureId(event.target.value.replace(/\D/g, ""))
              }
            />
          ) : null}
          <label className="input-label">
            Preregistration deadline
            <input
              className="field"
              type="datetime-local"
              value={registrationDeadline}
              max={fixtureLocalDate(
                fixtures.find((fixture) => fixture.fixtureId === fixtureId)
                  ?.scheduledStart,
              )}
              onChange={(event) => setRegistrationDeadline(event.target.value)}
            />
            <small>
              Defaults to kickoff. The program rejects every later registration.
            </small>
          </label>
        </section>

        <section className="dashboard-panel economics">
          <span className="step-number">02</span>
          <h2>Configure funded rounds</h2>
          <p>
            Amounts are immutable after activation. Classic SPL reward mint
            only.
          </p>
          <label className="input-label">
            Approved Devnet reward mint
            <select className="field" value={rewardMint} disabled>
              <option value={rewardMint}>GOAL · {short(rewardMint)}</option>
            </select>
            <small>
              The Devnet MVP uses the single mint in PlatformConfig; Token-2022
              is rejected.
            </small>
          </label>
          <div className="round-table">
            <div className="round-table-head">
              <span>Goal round</span>
              <span>GOAL / winner</span>
              <span>Winner cap</span>
              <span>Max liability</span>
            </div>
            {rounds.map((round, index) => (
              <div className="round-row" key={index}>
                <strong>#{index + 1}</strong>
                <input
                  aria-label={`Round ${index + 1} reward`}
                  inputMode="decimal"
                  value={round.reward}
                  onChange={(event) =>
                    updateRound(index, { reward: event.target.value })
                  }
                />
                <input
                  aria-label={`Round ${index + 1} winner cap`}
                  type="number"
                  min={1}
                  max={100}
                  value={round.cap}
                  onChange={(event) =>
                    updateRound(index, {
                      cap: Math.min(
                        100,
                        Math.max(1, Number(event.target.value)),
                      ),
                    })
                  }
                />
                <span>
                  {formatBaseUnits(
                    parseDraftTokens(round.reward, decimals) *
                      BigInt(round.cap),
                    decimals,
                  )}{" "}
                  GOAL
                </span>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="text-button"
            onClick={addRound}
            disabled={rounds.length >= 8}
          >
            + Add funded goal round
          </button>
          <div className="liability-total">
            <span>Maximum prefunded liability</span>
            <strong>
              {formatBaseUnits(liability, decimals)} <small>GOAL</small>
            </strong>
            <p>
              Σ reward amount × winner cap · {rounds.length} rounds ·{" "}
              {rounds.reduce((sum, round) => sum + round.cap, 0)} maximum
              winners
            </p>
          </div>
        </section>

        <section className="dashboard-panel fan-preview">
          <div className="fan-preview-heading">
            <div>
              <p className="section-kicker">Fan campaign preview</p>
              <h2>The exact first-goal race fans will see</h2>
            </div>
            <p>
              Preview only · a real claim appears after a confirmed Round PDA
              opens.
            </p>
          </div>
          <GoalRace
            state="open"
            source="live"
            rewardAmount={formatBaseUnits(
              parseDraftTokens(previewRound.reward, decimals),
              decimals,
            )}
            tokenSymbol="GOAL"
            remaining={previewRound.cap}
            countdown={120}
            reducedMotion
            action={
              <button type="button" className="claim-button" disabled>
                <span>Claim reward</span>
                <small>Preview · registration required</small>
              </button>
            }
          />
        </section>

        <section className="dashboard-panel publish-panel">
          <span className="step-number">03</span>
          <h2>Review and sign</h2>
          <label className="input-label">
            Immutable refund wallet
            <input
              className="field"
              placeholder={
                wallet.publicKey?.toBase58() ?? "Connect sponsor wallet"
              }
              value={refundWallet}
              onChange={(event) => setRefundWallet(event.target.value)}
            />
          </label>
          <label className="risk-check">
            <input
              type="checkbox"
              checked={riskAccepted}
              onChange={(event) => setRiskAccepted(event.target.checked)}
            />
            <span>
              <b>Immediate goal risk</b>A VAR reversal or provider correction
              will not claw back an opened round or completed payout.
            </span>
          </label>
          <label className="risk-check">
            <input
              type="checkbox"
              checked={orderingAccepted}
              onChange={(event) => setOrderingAccepted(event.target.checked)}
            />
            <span>
              <b>Trusted first-come ordering</b>The relayer’s durable acceptance
              order—not click time—defines sequence. Sybil resistance is
              best-effort.
            </span>
          </label>
          <button
            type="button"
            className="primary-button full"
            disabled={
              busy || !wallet.connected || !riskAccepted || !orderingAccepted
            }
            onClick={() => void create()}
          >
            {busy ? "Waiting for wallet…" : "Create campaign transaction"}
          </button>
          <p className="dashboard-status" aria-live="polite">
            {status}
          </p>
          <div className="campaign-lifecycle">
            <label className="input-label">
              Campaign to manage
              <input
                className="field"
                value={campaign ?? ""}
                onChange={(event) => {
                  setCampaign(event.target.value.trim() || null);
                  setCampaignStage("none");
                }}
                placeholder="Created campaign address"
              />
            </label>
            <label className="input-label">
              Sponsor classic SPL source token account
              <input
                className="field"
                value={sourceTokenAccount}
                onChange={(event) =>
                  setSourceTokenSelection({
                    wallet: sponsorAddress,
                    address: event.target.value.trim(),
                  })
                }
                placeholder="Required for exact funding"
              />
              <small>
                {sourceTokenStatus} The wallet-signed Devnet faucet supplies 500
                valueless GOAL once per sponsor wallet; it never distributes
                real assets.
              </small>
            </label>
            <button
              type="button"
              className="secondary-button"
              disabled={busy || !wallet.connected || !wallet.signTransaction}
              onClick={() => void claimFaucetTokens()}
            >
              Get 500 free Devnet GOAL
            </button>
            <div className="lifecycle-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={
                  busy ||
                  !campaign ||
                  !sourceTokenAccount ||
                  (campaignStats
                    ? campaignStats.state !== "draft"
                    : campaignStage === "active")
                }
                onClick={() => void campaignAction("fund")}
              >
                Fund exact liability
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={
                  busy ||
                  !campaign ||
                  (campaignStats
                    ? campaignStats.state !== "funded"
                    : campaignStage === "active")
                }
                onClick={() => void campaignAction("activate")}
              >
                Activate
              </button>
              <button
                type="button"
                className="text-button danger"
                disabled={
                  busy ||
                  !campaign ||
                  (campaignStats
                    ? !["draft", "funded"].includes(campaignStats.state)
                    : campaignStage === "active")
                }
                onClick={() => void campaignAction("cancel")}
              >
                Cancel before kickoff
              </button>
              <button
                type="button"
                className="text-button"
                disabled={
                  busy || !campaign || campaignStats?.state !== "refundable"
                }
                onClick={() => void campaignAction("refund")}
              >
                Claim refundable residual
              </button>
            </div>
            {campaign ? (
              <a className="proof-link" href={`/campaign/${campaign}`}>
                Open campaign view →
              </a>
            ) : null}
          </div>
        </section>

        <aside className="dashboard-panel audit-preview">
          <p className="section-kicker">Live campaign audit</p>
          <dl>
            <div>
              <dt>Program state</dt>
              <dd>{campaignStats?.state ?? "Draft preview"}</dd>
            </div>
            <div>
              <dt>Required funding</dt>
              <dd>
                {formatBaseUnits(
                  BigInt(campaignStats?.requiredFunding ?? liability),
                  decimals,
                )}{" "}
                GOAL
              </dd>
            </div>
            <div>
              <dt>Funded</dt>
              <dd>
                {formatBaseUnits(
                  BigInt(campaignStats?.fundedAmount ?? 0),
                  decimals,
                )}{" "}
                GOAL
              </dd>
            </div>
            <div>
              <dt>Paid to winners</dt>
              <dd>
                {formatBaseUnits(
                  BigInt(campaignStats?.paidAmount ?? 0),
                  decimals,
                )}{" "}
                GOAL
              </dd>
            </div>
            <div>
              <dt>Residual / utilization</dt>
              <dd>
                {formatBaseUnits(residual, decimals)} GOAL ·{" "}
                {utilization.toFixed(2)}%
              </dd>
            </div>
            <div>
              <dt>Registrations / wins</dt>
              <dd>
                {campaignStats
                  ? `${campaignStats.registrationCount} / ${campaignStats.winnerCount}`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>Configured rounds</dt>
              <dd>{campaignStats?.roundCount ?? rounds.length}</dd>
            </div>
            <div>
              <dt>Round duration</dt>
              <dd>120 sec</dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd>Solana Devnet</dd>
            </div>
            <div>
              <dt>Refund path</dt>
              <dd>Fixed wallet only</dd>
            </div>
          </dl>
          <p>
            Funding, activation, payout, residual, and refund remain auditable
            from program accounts and Explorer links.
          </p>
        </aside>
      </div>
    </div>
  );
}

async function buildAndSubmit(
  signTransaction: NonNullable<ReturnType<typeof useWallet>["signTransaction"]>,
  action: string,
  payload: unknown,
  requiresWalletSignature = true,
): Promise<Record<string, unknown>> {
  const built = await json<{ templateId: string; transaction: string }>(
    `/v1/sponsor/transactions/${action}`,
    payload,
  );
  const transaction = VersionedTransaction.deserialize(
    fromBase64(built.transaction),
  );
  const signed = requiresWalletSignature
    ? await signTransaction(transaction)
    : transaction;
  return json("/v1/sponsor/transactions/submit", {
    templateId: built.templateId,
    signedTransaction: toBase64(signed.serialize()),
  });
}
async function json<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(`${browserApiOrigin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readApiJson<T>(response, "Sponsor transaction request failed");
}
function parseDraftTokens(value: string, decimals: number): bigint {
  try {
    return parseTokenAmount(value, decimals);
  } catch {
    return 0n;
  }
}
function formatBaseUnits(value: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = (value % divisor)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return fraction
    ? `${whole.toLocaleString()}.${fraction}`
    : whole.toLocaleString();
}
function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
function toBase64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}
function short(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
function fixtureLocalDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected sponsor error";
}
