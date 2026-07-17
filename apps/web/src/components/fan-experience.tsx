"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GoalRace, type RaceState } from "@goaldrop/ui";
import {
  browserApiOrigin,
  readApiJson,
  type CampaignRound,
  type CampaignView,
} from "../lib/api";
import { useFanSigner, WalletChoices } from "../app/providers";
import { TransferPanel } from "./transfer-panel";
import { track } from "../lib/analytics";

type RegistrationState =
  "not-registered" | "signing" | "registering" | "confirmed" | "error";

export function FanExperience({
  initialCampaign,
  embedded = false,
}: {
  initialCampaign: CampaignView;
  embedded?: boolean;
}) {
  const signer = useFanSigner();
  const [campaign, setCampaign] = useState(initialCampaign);
  const [focusedRound, setFocusedRound] = useState<CampaignRound | null>(() =>
    newestOpen(initialCampaign.rounds),
  );
  const [raceState, setRaceState] = useState<RaceState>(() =>
    focusedRoundState(newestOpen(initialCampaign.rounds)),
  );
  const [registration, setRegistration] =
    useState<RegistrationState>("not-registered");
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{
    id: string;
    capability: string;
  } | null>(null);
  const [winner, setWinner] = useState<{
    rank: number;
    explorer: string;
  } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [reducedMotion, setReducedMotion] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const registrationPollTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const registrationPollGeneration = useRef(0);
  const openingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const registrationStartedAt = useRef<number | null>(null);
  const claimStartedAt = useRef<number | null>(null);
  const trackedRegistration = useRef(false);

  useEffect(() => {
    track("campaign_viewed", {
      campaign: campaign.campaign,
      properties: {
        source: embedded ? "partner" : "direct",
        campaign_state: campaign.state,
      },
    });
  }, [campaign.campaign, campaign.state, embedded]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const frame = requestAnimationFrame(() =>
      setReducedMotion(
        media.matches ||
          localStorage.getItem("goaldrop.reduced-motion") === "true",
      ),
    );
    const update = () =>
      setReducedMotion(
        media.matches ||
          localStorage.getItem("goaldrop.reduced-motion") === "true",
      );
    media.addEventListener("change", update);
    return () => {
      cancelAnimationFrame(frame);
      media.removeEventListener("change", update);
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const source = new EventSource(
      `${browserApiOrigin}/v1/campaigns/${campaign.campaign}/events`,
    );
    source.addEventListener("goal.detected", () => {
      setRaceState("opening");
      setWinner(null);
      if (openingTimer.current) clearTimeout(openingTimer.current);
      openingTimer.current = setTimeout(() => {
        setRaceState("error");
        setError(
          "The goal was detected, but no confirmed Devnet round opened within ten seconds.",
        );
      }, 10_000);
    });
    source.addEventListener("round.opened", (event) => {
      const payload = JSON.parse(
        (event as MessageEvent<string>).data,
      ) as Record<string, unknown>;
      const round: CampaignRound = {
        round: String(payload.round),
        ordinal: Number(payload.ordinal),
        source: String(payload.source) as "live" | "demo",
        openedAt: epochOrIso(payload.openedAt),
        closesAt: epochOrIso(payload.closesAt),
        rewardAmount: String(payload.rewardAmount),
        winnerCap: Number(payload.winnerCap),
        winnerCount: 0,
        state: "open",
        commitment: "confirmed",
      };
      if (openingTimer.current) clearTimeout(openingTimer.current);
      setCampaign((current) => ({
        ...current,
        rounds: [
          ...current.rounds.filter((item) => item.round !== round.round),
          round,
        ],
      }));
      setFocusedRound(round);
      setRaceState("open");
      setReceipt(null);
    });
    source.addEventListener("campaign.updated", (event) => {
      const payload = JSON.parse(
        (event as MessageEvent<string>).data,
      ) as Record<string, unknown>;
      if (
        payload.registration === "confirmed" &&
        payload.wallet === signer.address
      ) {
        setRegistration("confirmed");
        if (!trackedRegistration.current) {
          track("registration_completed", {
            campaign: campaign.campaign,
            properties: {
              method: signer.mode ?? "unknown",
              duration_ms: registrationStartedAt.current
                ? Date.now() - registrationStartedAt.current
                : 0,
            },
          });
          trackedRegistration.current = true;
        }
      }
    });
    source.addEventListener("claim.confirmed", (event) => {
      const payload = JSON.parse(
        (event as MessageEvent<string>).data,
      ) as Record<string, unknown>;
      if (payload.wallet === signer.address) {
        setRaceState("confirmed");
        setWinner({
          rank: Number(payload.winnerRank),
          explorer: `https://explorer.solana.com/tx/${String(payload.transactionSignature)}?cluster=devnet`,
        });
        track("claim_confirmed", {
          campaign: campaign.campaign,
          properties: {
            winner_rank: Number(payload.winnerRank),
            confirmation_ms: claimStartedAt.current
              ? Date.now() - claimStartedAt.current
              : 0,
          },
        });
      }
    });
    source.addEventListener("claim.missed", (event) => {
      const payload = JSON.parse(
        (event as MessageEvent<string>).data,
      ) as Record<string, unknown>;
      if (payload.wallet === signer.address) {
        setRaceState(payload.status === "expired" ? "expired" : "missed");
        track("claim_missed", {
          campaign: campaign.campaign,
          properties: { reason: String(payload.status) },
        });
      }
    });
    source.addEventListener("service.degraded", () => {
      setError(
        "Live services are degraded. No claim will be shown as won without on-chain confirmation.",
      );
    });
    source.addEventListener("resnapshot", () => {
      window.location.reload();
    });
    return () => source.close();
  }, [campaign.campaign, signer.address, signer.mode]);

  const beginRegistrationPoll = useCallback(
    (wallet: string, retryNetworkErrors = false) => {
      registrationPollGeneration.current += 1;
      const generation = registrationPollGeneration.current;
      if (registrationPollTimer.current)
        clearTimeout(registrationPollTimer.current);

      const schedule = (delay: number) => {
        if (generation !== registrationPollGeneration.current) return;
        registrationPollTimer.current = setTimeout(() => {
          void poll();
        }, delay);
      };
      const poll = async (): Promise<void> => {
        try {
          const response = await fetch(
            `${browserApiOrigin}/v1/campaigns/${campaign.campaign}/registrations/${wallet}`,
            { cache: "no-store" },
          );
          const result = await readApiJson<{
            registered: boolean;
            status: string;
          }>(response, "Could not refresh registration status");
          if (generation !== registrationPollGeneration.current) return;
          if (result.registered) {
            setRegistration("confirmed");
            setError(null);
            return;
          }
          if (result.status === "accepted" || result.status === "submitted") {
            setRegistration("registering");
            schedule(750);
            return;
          }
          if (result.status === "expired" || result.status === "failed") {
            setRegistration("error");
            setError(
              result.status === "expired"
                ? "Registration expired before it reached Devnet. Try Join again."
                : "Registration failed before it reached Devnet. Try Join again.",
            );
            return;
          }
          setRegistration("not-registered");
        } catch {
          if (retryNetworkErrors) schedule(1_500);
        }
      };
      void poll();
    },
    [campaign.campaign],
  );

  useEffect(
    () => () => {
      registrationPollGeneration.current += 1;
      if (pollTimer.current) clearTimeout(pollTimer.current);
      if (registrationPollTimer.current)
        clearTimeout(registrationPollTimer.current);
      if (openingTimer.current) clearTimeout(openingTimer.current);
    },
    [],
  );

  useEffect(() => {
    registrationPollGeneration.current += 1;
    if (registrationPollTimer.current)
      clearTimeout(registrationPollTimer.current);
    if (!signer.address) {
      registrationPollTimer.current = setTimeout(
        () => setRegistration("not-registered"),
        0,
      );
      return () => {
        if (registrationPollTimer.current)
          clearTimeout(registrationPollTimer.current);
      };
    }
    beginRegistrationPoll(signer.address);
    return () => {
      registrationPollGeneration.current += 1;
      if (registrationPollTimer.current)
        clearTimeout(registrationPollTimer.current);
    };
  }, [beginRegistrationPoll, signer.address]);

  const countdown = focusedRound
    ? Math.max(
        0,
        Math.floor((new Date(focusedRound.closesAt).getTime() - now) / 1_000),
      )
    : 120;
  const displayRaceState: RaceState =
    focusedRound &&
    countdown <= 0 &&
    ["open", "accepted", "pending"].includes(raceState)
      ? "expired"
      : raceState;

  const nextConfigured =
    campaign.configuredRounds[campaign.rounds.length] ??
    campaign.configuredRounds[0];
  const reward = formatTokenAmount(
    focusedRound?.rewardAmount ?? nextConfigured?.rewardAmount ?? "0",
  );
  const remaining = focusedRound
    ? focusedRound.winnerCap - focusedRound.winnerCount
    : (nextConfigured?.winnerCap ?? 0);

  const register = useCallback(async () => {
    if (!signer.address) {
      setError("Choose a passkey, wallet, or Instant Demo wallet first.");
      return;
    }
    registrationStartedAt.current = Date.now();
    track("registration_started", {
      campaign: campaign.campaign,
      properties: { method: signer.mode ?? "unknown" },
    });
    setError(null);
    setRegistration("signing");
    try {
      const challenge = await postJson<IntentChallenge>(
        "/v1/intents/registration",
        { campaign: campaign.campaign, wallet: signer.address },
      );
      const signature = await signer.signDigest(fromHex(challenge.intentHash));
      setRegistration("registering");
      const result = await postJson<{ status: string }>("/v1/registrations", {
        campaign: campaign.campaign,
        wallet: signer.address,
        nonce: challenge.nonce,
        expiresAt: challenge.expiresAt,
        intentHash: challenge.intentHash,
        signature: toBase64(signature),
      });
      if (result.status === "confirmed" || result.status === "finalized")
        setRegistration("confirmed");
      else beginRegistrationPoll(signer.address, true);
    } catch (caught) {
      setRegistration("error");
      setError(message(caught));
    }
  }, [beginRegistrationPoll, campaign.campaign, signer]);

  async function pollReceipt(id: string, capability: string): Promise<void> {
    try {
      const response = await fetch(
        `${browserApiOrigin}/v1/receipts/${id}?cap=${encodeURIComponent(capability)}`,
        { cache: "no-store" },
      );
      const status = await readApiJson<{
        status: string;
        winnerRank: number | null;
        explorer: string | null;
      }>(response, "Could not refresh receipt status");
      if (status.status === "confirmed" || status.status === "finalized") {
        setRaceState("confirmed");
        setWinner({
          rank: status.winnerRank ?? 0,
          explorer: status.explorer ?? "",
        });
        return;
      }
      if (
        status.status === "missed" ||
        status.status === "expired" ||
        status.status === "failed"
      ) {
        setRaceState(
          status.status === "expired"
            ? "expired"
            : status.status === "missed"
              ? "missed"
              : "error",
        );
        return;
      }
      setRaceState(status.status === "submitted" ? "pending" : "accepted");
      pollTimer.current = setTimeout(() => {
        void pollReceipt(id, capability);
      }, 750);
    } catch (caught) {
      setError(message(caught));
      pollTimer.current = setTimeout(() => {
        void pollReceipt(id, capability);
      }, 1_500);
    }
  }

  const claim = async () => {
    if (!signer.address || !focusedRound) return;
    claimStartedAt.current = Date.now();
    track("claim_started", {
      campaign: campaign.campaign,
      properties: {
        round_source: focusedRound.source,
        round_ordinal: focusedRound.ordinal,
      },
    });
    setError(null);
    try {
      const challenge = await postJson<IntentChallenge>("/v1/intents/claim", {
        campaign: campaign.campaign,
        round: focusedRound.round,
        wallet: signer.address,
      });
      const signature = await signer.signDigest(fromHex(challenge.intentHash));
      const accepted = await postJson<{
        receiptId: string;
        capability: string;
        status: string;
      }>("/v1/claims", {
        campaign: campaign.campaign,
        round: focusedRound.round,
        wallet: signer.address,
        nonce: challenge.nonce,
        expiresAt: challenge.expiresAt,
        intentHash: challenge.intentHash,
        signature: toBase64(signature),
      });
      setReceipt({ id: accepted.receiptId, capability: accepted.capability });
      setRaceState("accepted");
      track("claim_receipt_accepted", {
        campaign: campaign.campaign,
        properties: {
          latency_ms: claimStartedAt.current
            ? Date.now() - claimStartedAt.current
            : 0,
        },
      });
      pollTimer.current = setTimeout(() => {
        void pollReceipt(accepted.receiptId, accepted.capability);
      }, 400);
    } catch (caught) {
      setRaceState("error");
      setError(message(caught));
    }
  };

  const toggleMotion = () => {
    const next = !reducedMotion;
    setReducedMotion(next);
    localStorage.setItem("goaldrop.reduced-motion", String(next));
  };

  return (
    <div className={embedded ? "fan-experience embedded" : "fan-experience"}>
      <div className="match-broadcast">
        <div className="broadcast-topline">
          <span className="live-flag">
            {campaign.providerStatus === "scheduled" ? "SOON" : "LIVE"}
          </span>
          <span>{campaign.competition} · TxLINE</span>
          <button
            type="button"
            className="motion-toggle"
            onClick={toggleMotion}
          >
            {reducedMotion ? "Enable motion" : "Reduce motion"}
          </button>
        </div>
        <div className="scoreboard">
          <div>
            <span className="team-code">{teamCode(campaign.home)}</span>
            <strong>{campaign.home}</strong>
          </div>
          <p>
            <b>—</b>
            <span>Match linked</span>
          </p>
          <div>
            <span className="team-code away">{teamCode(campaign.away)}</span>
            <strong>{campaign.away}</strong>
          </div>
        </div>
        <p className="fixture-id">
          TxLINE fixture #{campaign.fixtureId} · Campaign{" "}
          {short(campaign.campaign)}
        </p>
      </div>

      <GoalRace
        state={displayRaceState}
        source={focusedRound?.source ?? "live"}
        rewardAmount={reward}
        tokenSymbol="GOAL"
        remaining={remaining}
        countdown={countdown}
        winnerRank={winner?.rank}
        explorerUrl={winner?.explorer}
        reducedMotion={reducedMotion}
        action={
          displayRaceState === "open" ? (
            <button
              type="button"
              className="claim-button"
              disabled={registration !== "confirmed" || !signer.canSignMessage}
              onClick={() => void claim()}
            >
              <span>Claim reward</span>
              <small>
                {registration === "confirmed"
                  ? "Gasless · signed intent"
                  : "Register before claiming"}
              </small>
            </button>
          ) : receipt ? (
            <p className="receipt-note">
              Receipt {short(receipt.id)} · This is not a win confirmation.
            </p>
          ) : undefined
        }
      />

      <aside className="join-card">
        <div>
          <p className="section-kicker">Your fan pass</p>
          <h2>
            {registration === "confirmed"
              ? "You’re in"
              : "Register once. Race every goal."}
          </h2>
        </div>
        <WalletChoices />
        <button
          type="button"
          className="join-button"
          disabled={
            !signer.connected ||
            ["signing", "registering", "confirmed"].includes(registration)
          }
          onClick={() => void register()}
        >
          {registration === "signing"
            ? "Approve registration…"
            : registration === "registering"
              ? "Confirming on Devnet…"
              : registration === "confirmed"
                ? "Registered ✓"
                : "Join this match — free"}
        </button>
        <ul className="trust-list">
          <li>No SOL required</li>
          <li>One registration per wallet</li>
          <li>Rewards settle on Solana Devnet</li>
        </ul>
        {error ? (
          <p className="inline-error" role="alert">
            {error}
          </p>
        ) : null}
      </aside>

      <section className="round-strip" aria-label="Campaign rounds">
        <div>
          <p className="section-kicker">Funded goal drops</p>
          <h2>
            {campaign.rounds.length} of {campaign.configuredRounds.length}{" "}
            rounds opened
          </h2>
        </div>
        <div className="round-list">
          {campaign.rounds.map((round) => (
            <button
              type="button"
              key={round.round}
              className={
                focusedRound?.round === round.round
                  ? "round-chip active"
                  : "round-chip"
              }
              onClick={() => {
                setFocusedRound(round);
                setRaceState(focusedRoundState(round));
              }}
            >
              <span>
                Round {round.ordinal + 1} · {round.source}
              </span>
              <strong>{round.state}</strong>
              <small>
                {round.winnerCount}/{round.winnerCap} winners
              </small>
            </button>
          ))}
          {campaign.configuredRounds
            .slice(campaign.rounds.length)
            .map((round) => (
              <div
                className="round-chip planned"
                key={`planned-${round.ordinal}`}
              >
                <span>Round {round.ordinal + 1} · funded</span>
                <strong>{formatTokenAmount(round.rewardAmount)} GOAL</strong>
                <small>{round.winnerCap} winner cap · awaiting goal</small>
              </div>
            ))}
        </div>
      </section>
      <TransferPanel />
    </div>
  );
}

interface IntentChallenge {
  nonce: string;
  expiresAt: number;
  intentHash: string;
}
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${browserApiOrigin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readApiJson<T>(response, "Request failed");
}
function newestOpen(rounds: CampaignRound[]): CampaignRound | null {
  return [...rounds].reverse().find((round) => round.state === "open") ?? null;
}
function focusedRoundState(round: CampaignRound | null): RaceState {
  return !round
    ? "anticipation"
    : round.state === "open"
      ? "open"
      : round.state === "exhausted"
        ? "missed"
        : "expired";
}
function epochOrIso(value: unknown): string {
  return typeof value === "number"
    ? new Date(value * 1_000).toISOString()
    : String(value);
}
function formatTokenAmount(amount: string): string {
  const decimals = Number(process.env.NEXT_PUBLIC_REWARD_DECIMALS ?? 6);
  const value = BigInt(amount || "0");
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = (value % divisor)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
function fromHex(value: string): Uint8Array {
  return Uint8Array.from(
    value.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
}
function toBase64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}
function short(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}
function teamCode(value: string): string {
  return (
    value
      .replace(/[^A-Za-z]/g, "")
      .slice(0, 3)
      .toUpperCase() || "FC"
  );
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}
