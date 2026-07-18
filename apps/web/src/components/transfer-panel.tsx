"use client";

import { useCallback, useEffect, useState } from "react";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { useFanSigner } from "../app/providers";
import { browserApiOrigin, readApiJson } from "../lib/api";
import { track } from "../lib/analytics";
import { formatTokenAmount, parseTokenAmount } from "../lib/token-amount";
import {
  transactionProgressSteps,
  type TransactionPhase,
} from "../lib/transaction-progress";
import { TransactionProgress } from "./transaction-progress";

interface RewardView {
  balance: string;
  decimals: number;
  tokenAccount: string;
  claims: {
    round: string;
    amount: string;
    winnerRank: number;
    explorer: string;
  }[];
}
interface TransferReview {
  destination: string;
  amount: string;
  baseUnits: bigint;
}

export function TransferPanel({
  refreshKey = "",
}: {
  refreshKey?: string | number;
}) {
  const signer = useFanSigner();
  const [rewards, setRewards] = useState<RewardView | null>(null);
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState(
    "Confirmed rewards are held in your own classic SPL token account.",
  );
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<TransactionPhase | null>(null);
  const [review, setReview] = useState<TransferReview | null>(null);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!signer.address) return;
      const response = await fetch(
        `${browserApiOrigin}/v1/wallets/${signer.address}/rewards`,
        { cache: "no-store", signal },
      );
      if (response.ok)
        setRewards(
          await readApiJson<RewardView>(response, "Could not refresh rewards"),
        );
    },
    [signer.address],
  );

  useEffect(() => {
    const controller = new AbortController();
    const frame = requestAnimationFrame(() => {
      void refresh(controller.signal).catch(() => undefined);
    });
    return () => {
      cancelAnimationFrame(frame);
      controller.abort();
    };
  }, [refresh, refreshKey]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible")
        void refresh().catch(() => undefined);
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refresh]);

  if (!signer.address) return null;
  const decimals =
    rewards?.decimals ?? Number(process.env.NEXT_PUBLIC_REWARD_DECIMALS ?? 6);
  const balance = rewards
    ? formatTokenAmount(BigInt(rewards.balance), decimals)
    : "—";
  const reviewDisabledReason = busy
    ? "Wait for the current transfer to finish."
    : !destination
      ? "Enter the recipient wallet address."
      : !amount
        ? "Enter the GOAL amount to transfer."
        : !rewards
          ? "Wait for the confirmed reward balance to load."
          : BigInt(rewards.balance) === 0n
            ? "A confirmed GOAL reward balance is required."
            : null;
  const activeProgressLabel = phase
    ? transactionProgressSteps("transfer", phase).find(
        (step) => step.state === "current",
      )?.label
    : null;

  const transfer = async () => {
    if (!review) return;
    if (!signer.canSignTransaction) {
      setStatus("This wallet cannot sign a token transfer transaction.");
      return;
    }
    setBusy(true);
    setPhase("preparing");
    try {
      track("transfer_started", {
        properties: { amount_base_units: review.baseUnits.toString() },
      });
      const built = await json<{ templateId: string; transaction: string }>(
        "/v1/transfers/build",
        {
          wallet: signer.address,
          destination: review.destination,
          amount: review.baseUnits.toString(),
        },
      );
      const transaction = VersionedTransaction.deserialize(
        fromBase64(built.transaction),
      );
      setPhase("approval");
      const signed = await signer.signTransaction(transaction);
      setPhase("submitting");
      const submitted = await json<{ signature: string; explorer: string }>(
        "/v1/transfers/submit",
        {
          templateId: built.templateId,
          signedTransaction: toBase64(signed.serialize()),
        },
      );
      setStatus(`Transfer confirmed: ${short(submitted.signature)}`);
      track("transfer_completed", {
        properties: { amount_base_units: review.baseUnits.toString() },
      });
      setAmount("");
      setDestination("");
      setReview(null);
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Transfer failed");
      track("product_error", {
        properties: {
          surface: "reward_transfer",
          error_code: "transfer_failed",
        },
      });
    } finally {
      setBusy(false);
      setPhase(null);
    }
  };

  const prepareReview = () => {
    try {
      const destinationKey = new PublicKey(destination);
      if (destinationKey.toBase58() === signer.address)
        throw new Error("Choose a destination other than this wallet");
      const baseUnits = parseTokenAmount(amount, decimals);
      if (baseUnits <= 0n) throw new Error("Enter a positive transfer amount");
      if (rewards && baseUnits > BigInt(rewards.balance))
        throw new Error("Transfer amount exceeds confirmed balance");
      setReview({ destination: destinationKey.toBase58(), amount, baseUnits });
      setStatus(
        "Review every locked field below, then explicitly confirm in your wallet.",
      );
    } catch (error) {
      setReview(null);
      setStatus(
        error instanceof Error ? error.message : "Transfer details are invalid",
      );
    }
  };

  return (
    <section className="reward-wallet">
      <div className="reward-summary">
        <p className="section-kicker">Your Devnet reward wallet</p>
        <h2>
          {balance} <small>GOAL</small>
        </h2>
        <p>
          Fan-owned balance · {rewards?.claims.length ?? 0} confirmed payout
          {rewards?.claims.length === 1 ? "" : "s"}
        </p>
        {rewards?.tokenAccount ? (
          <a
            className="proof-link"
            href={`https://explorer.solana.com/address/${rewards.tokenAccount}?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
          >
            Inspect token account ↗
          </a>
        ) : null}
      </div>
      <div className="transfer-form">
        <h3>Transfer your reward</h3>
        <p>
          The destination, exact GOAL amount, and mint are locked before your
          wallet signs. The platform only pays the Devnet fee.
        </p>
        <label className="input-label">
          Destination Solana address
          <input
            className="field"
            value={destination}
            disabled={busy || review !== null}
            onChange={(event) => {
              setDestination(event.target.value.trim());
              setReview(null);
            }}
            placeholder="Recipient wallet"
          />
        </label>
        <label className="input-label">
          Amount in GOAL
          <input
            className="field"
            inputMode="decimal"
            value={amount}
            disabled={busy || review !== null}
            onChange={(event) => {
              setAmount(event.target.value);
              setReview(null);
            }}
            placeholder="0.00"
          />
        </label>
        {review ? (
          <div className="transfer-review">
            <p className="section-kicker">Explicit transfer confirmation</p>
            <dl>
              <div>
                <dt>Token</dt>
                <dd>GOAL · classic SPL</dd>
              </div>
              <div>
                <dt>Amount</dt>
                <dd>{review.amount} GOAL</dd>
              </div>
              <div>
                <dt>Network</dt>
                <dd>Solana Devnet</dd>
              </div>
              <div>
                <dt>Destination</dt>
                <dd>
                  <code>{review.destination}</code>
                </dd>
              </div>
            </dl>
            <button
              type="button"
              className="primary-button full"
              disabled={busy || !signer.canSignTransaction}
              onClick={() => void transfer()}
            >
              {phase
                ? activeProgressLabel
                : "Confirm locked transfer in wallet"}
            </button>
            {!signer.canSignTransaction ? (
              <p className="disabled-reason">
                This wallet cannot sign a token transfer transaction.
              </p>
            ) : null}
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => setReview(null)}
            >
              Edit transfer
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="secondary-button full"
            disabled={Boolean(reviewDisabledReason)}
            onClick={prepareReview}
          >
            Lock and review reward transfer
          </button>
        )}
        {!review && reviewDisabledReason ? (
          <p className="disabled-reason">{reviewDisabledReason}</p>
        ) : null}
        {phase ? <TransactionProgress action="transfer" phase={phase} /> : null}
        <p className="dashboard-status" aria-live="polite">
          {status}
        </p>
      </div>
    </section>
  );
}

async function json<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(`${browserApiOrigin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readApiJson<T>(response, "Transfer request failed");
}
function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
function toBase64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}
function short(value: string): string {
  return `${value.slice(0, 7)}…${value.slice(-5)}`;
}
