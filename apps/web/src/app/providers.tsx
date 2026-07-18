"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
  useWallet,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  WalletProvider as PasskeyWalletProvider,
  useWallet as usePasskeyWallet,
} from "@passkeys/react";
import { createWallet } from "@passkeys/core";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { track } from "../lib/analytics";
import { resolvePasskeyDeploymentConfig } from "../lib/deployment-config";
import {
  connectInstantDemoWallet,
  disconnectInstantDemoWallet,
  isInstantDemoStorageKey,
  persistInstantDemoSeed,
  resetInstantDemoWallet,
  restoreInstantDemoWallet,
} from "../lib/instant-demo-wallet";

type EmbeddedWallet = ReturnType<typeof createWallet>;
type WalletMode = "passkey" | "external" | "instant-demo" | null;

interface FanSignerValue {
  address: string | null;
  mode: WalletMode;
  connected: boolean;
  canSignMessage: boolean;
  canSignTransaction: boolean;
  instantDemoEnabled: boolean;
  signDigest(digest: Uint8Array): Promise<Uint8Array>;
  signTransaction(
    transaction: VersionedTransaction,
  ): Promise<VersionedTransaction>;
  connectInstantDemo(): void;
  resetInstantDemo(): void;
  disconnect(): Promise<void>;
}

const FanSignerContext = createContext<FanSignerValue | null>(null);
const PasskeySurfaceContext = createContext<(() => void) | null>(null);

export function AppProviders({ children }: { children: ReactNode }) {
  const [embeddedWallet, setEmbeddedWallet] = useState<EmbeddedWallet | null>(
    null,
  );
  useEffect(() => {
    const { appId } = resolvePasskeyDeploymentConfig({
      deploymentTier: process.env.NEXT_PUBLIC_DEPLOYMENT_TIER,
      appId: process.env.NEXT_PUBLIC_PASSKEY_APP_ID,
    });
    const frame = requestAnimationFrame(() => {
      setEmbeddedWallet(
        createWallet({
          ...(appId ? { appId } : {}),
          providers: { solana: true },
        }),
      );
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const content = embeddedWallet ? (
    <PasskeyWalletProvider wallet={embeddedWallet}>
      <PasskeySurface>
        <StandardSolanaLayer>{children}</StandardSolanaLayer>
      </PasskeySurface>
    </PasskeyWalletProvider>
  ) : (
    <StandardSolanaLayer>{children}</StandardSolanaLayer>
  );
  return content;
}

function PasskeySurface({ children }: { children: ReactNode }) {
  const wallet = usePasskeyWallet();
  const hostRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const openSurface = useCallback(() => {
    setOpen(true);
    wallet.experimental_expand({});
  }, [wallet]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    wallet.setWidgetConfig({
      theme: { variant: "dark", colors: { accentColor: "#a7ff45" } },
      size: "medium",
      shape: "rounded",
      compact: false,
      noAutoCompact: false,
      smallScreen: window.matchMedia("(max-width: 540px)").matches,
    });
    wallet.renderWidget(host);
    const synchronizeVisibility = (event: MessageEvent) => {
      if (
        event.data?.type === "wallet:resize" &&
        (event.origin === window.location.origin ||
          event.origin === "https://embedded.passkeys.foundation")
      )
        setOpen(Boolean(event.data.expanded));
    };
    const closeAfterConnect = () => setOpen(false);
    window.addEventListener("message", synchronizeVisibility);
    window.addEventListener("wallet:connected", closeAfterConnect);
    return () => {
      window.removeEventListener("message", synchronizeVisibility);
      window.removeEventListener("wallet:connected", closeAfterConnect);
      wallet.renderWidget(null);
    };
  }, [wallet]);
  return (
    <PasskeySurfaceContext.Provider value={openSurface}>
      {children}
      <div
        className={`passkey-surface${open ? " passkey-surface-open" : ""}`}
        aria-hidden={!open}
      >
        <div
          ref={hostRef}
          className="passkey-surface-host"
          role="dialog"
          aria-modal="true"
          aria-label="Passkey wallet"
        />
      </div>
    </PasskeySurfaceContext.Provider>
  );
}

function StandardSolanaLayer({ children }: { children: ReactNode }) {
  const adapters = useMemo(() => [], []);
  const endpoint =
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  return (
    <ConnectionProvider endpoint={endpoint}>
      <SolanaWalletProvider wallets={adapters} autoConnect>
        <WalletModalProvider>
          <FanSignerProvider>{children}</FanSignerProvider>
        </WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}

function FanSignerProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const [instant, setInstant] = useState<Keypair | null>(null);
  const instantDemoEnabled =
    (process.env.NEXT_PUBLIC_DEPLOYMENT_TIER ?? "devnet") !== "production";
  useEffect(() => {
    if (!instantDemoEnabled) return;
    const frame = requestAnimationFrame(() => {
      setInstant((current) => {
        try {
          if (current) {
            persistInstantDemoSeed(current.secretKey.slice(0, 32));
            return current;
          }
          return restoreInstantDemoWallet();
        } catch {
          return current;
        }
      });
    });
    const synchronize = (event: StorageEvent) => {
      if (!isInstantDemoStorageKey(event.key)) return;
      setInstant((current) => {
        let restored: Keypair | null = null;
        try {
          restored = restoreInstantDemoWallet();
        } catch {
          return current;
        }
        if (
          current &&
          (!restored || !current.publicKey.equals(restored.publicKey))
        )
          current.secretKey.fill(0);
        return restored;
      });
    };
    window.addEventListener("storage", synchronize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("storage", synchronize);
    };
  }, [instantDemoEnabled]);
  const connectInstantDemo = useCallback(() => {
    if (!instantDemoEnabled) return;
    try {
      setInstant(connectInstantDemoWallet());
    } catch {
      setInstant(Keypair.generate());
    }
  }, [instantDemoEnabled]);
  const resetInstantDemo = useCallback(() => {
    if (!instant || !instantDemoEnabled) return;
    try {
      const replacement = resetInstantDemoWallet();
      instant.secretKey.fill(0);
      setInstant(replacement);
    } catch {
      // Keep the current signer if browser persistence is unavailable.
    }
  }, [instant, instantDemoEnabled]);
  const signDigest = useCallback(
    async (digest: Uint8Array) => {
      if (instant) return nacl.sign.detached(digest, instant.secretKey);
      if (!wallet.signMessage)
        throw new Error("This wallet does not support message signing");
      return wallet.signMessage(digest);
    },
    [instant, wallet],
  );
  const signTransaction = useCallback(
    async (transaction: VersionedTransaction) => {
      if (instant) {
        transaction.sign([instant]);
        return transaction;
      }
      if (!wallet.signTransaction)
        throw new Error("This wallet does not support transaction signing");
      return wallet.signTransaction(transaction);
    },
    [instant, wallet],
  );
  const disconnect = useCallback(async () => {
    if (instant) {
      try {
        disconnectInstantDemoWallet();
      } catch {
        // In-memory disconnect still succeeds when storage is unavailable.
      }
      instant.secretKey.fill(0);
      setInstant(null);
    }
    if (wallet.connected) await wallet.disconnect();
  }, [instant, wallet]);
  const adapterName = wallet.wallet?.adapter.name ?? "";
  const mode: WalletMode = instant
    ? "instant-demo"
    : wallet.connected
      ? /passkeys/i.test(adapterName)
        ? "passkey"
        : "external"
      : null;
  const value = useMemo<FanSignerValue>(
    () => ({
      address:
        instant?.publicKey.toBase58() ?? wallet.publicKey?.toBase58() ?? null,
      mode,
      connected: Boolean(instant || wallet.connected),
      canSignMessage: Boolean(instant || wallet.signMessage),
      canSignTransaction: Boolean(instant || wallet.signTransaction),
      instantDemoEnabled,
      signDigest,
      signTransaction,
      connectInstantDemo,
      resetInstantDemo,
      disconnect,
    }),
    [
      instant,
      wallet.connected,
      wallet.publicKey,
      wallet.signMessage,
      wallet.signTransaction,
      instantDemoEnabled,
      mode,
      signDigest,
      signTransaction,
      connectInstantDemo,
      resetInstantDemo,
      disconnect,
    ],
  );
  return (
    <FanSignerContext.Provider value={value}>
      {children}
    </FanSignerContext.Provider>
  );
}

export function useFanSigner(): FanSignerValue {
  const context = useContext(FanSignerContext);
  if (!context)
    throw new Error("useFanSigner must be used inside AppProviders");
  return context;
}

export function WalletChoices() {
  const signer = useFanSigner();
  const wallet = useWallet();
  const openPasskeySurface = useContext(PasskeySurfaceContext);
  const trackedMode = useRef<WalletMode>(null);
  const [copied, setCopied] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [showExternalWallets, setShowExternalWallets] = useState(false);
  const [pendingWallet, setPendingWallet] = useState<string | null>(null);
  const passkeyWallet = wallet.wallets.find((candidate) =>
    candidate.adapter.name.toLowerCase().includes("passkey"),
  );
  const externalWallets = wallet.wallets.filter(
    (candidate) => candidate !== passkeyWallet,
  );
  const reportConnectionError = useCallback((error: unknown) => {
    setConnectError(
      error instanceof Error ? error.message : "Wallet connection failed.",
    );
  }, []);
  const chooseWallet = useCallback(
    (walletName: (typeof wallet.wallets)[number]["adapter"]["name"]) => {
      setConnectError(null);
      setShowExternalWallets(false);
      if (wallet.wallet?.adapter.name === walletName && !wallet.connecting) {
        setPendingWallet(null);
        void wallet.connect().catch(reportConnectionError);
        return;
      }
      setPendingWallet(walletName);
      wallet.select(walletName);
    },
    [reportConnectionError, wallet],
  );
  useEffect(() => {
    if (
      !pendingWallet ||
      wallet.wallet?.adapter.name !== pendingWallet ||
      wallet.connecting
    )
      return;
    const frame = requestAnimationFrame(() => {
      setPendingWallet(null);
      void wallet.connect().catch(reportConnectionError);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingWallet, reportConnectionError, wallet]);
  useEffect(() => {
    if (signer.mode && trackedMode.current !== signer.mode) {
      track("wallet_path_selected", { properties: { method: signer.mode } });
      trackedMode.current = signer.mode;
    }
    if (!signer.mode) trackedMode.current = null;
  }, [signer.mode]);
  if (signer.connected) {
    const copyAddress = async () => {
      if (!signer.address) return;
      await navigator.clipboard.writeText(signer.address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    };
    return (
      <div className="connected-wallet">
        <span>
          <i aria-hidden="true" />{" "}
          {signer.mode === "instant-demo"
            ? "Instant Demo wallet"
            : signer.mode === "passkey"
              ? "Passkey wallet"
              : "External wallet"}
        </span>
        <code>{shortAddress(signer.address ?? "")}</code>
        <button
          type="button"
          className="text-button"
          onClick={() => void copyAddress()}
        >
          {copied ? "Address copied" : "Copy full address"}
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => void signer.disconnect()}
        >
          Disconnect
        </button>
        {signer.mode === "instant-demo" ? (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              if (
                window.confirm(
                  "Create a new Instant Demo wallet? The current Devnet wallet and its rewards will no longer be available in this browser.",
                )
              )
                signer.resetInstantDemo();
            }}
          >
            Reset demo wallet
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="wallet-choices">
      <button
        type="button"
        className="primary-button"
        disabled={!passkeyWallet || !openPasskeySurface}
        onClick={() => {
          if (!passkeyWallet || !openPasskeySurface) {
            setConnectError(
              "Passkey wallet is still loading. Please try again.",
            );
            return;
          }
          openPasskeySurface();
          chooseWallet(passkeyWallet.adapter.name);
        }}
      >
        Continue with passkey
      </button>
      <button
        type="button"
        className="secondary-button"
        onClick={() => {
          setConnectError(null);
          if (externalWallets.length === 0) {
            setConnectError(
              "No browser wallet detected. Use a passkey or Instant Demo instead.",
            );
            return;
          }
          if (externalWallets.length === 1) {
            const [onlyWallet] = externalWallets;
            if (onlyWallet) chooseWallet(onlyWallet.adapter.name);
            return;
          }
          setShowExternalWallets((current) => !current);
        }}
      >
        Use installed wallet
      </button>
      {showExternalWallets ? (
        <div className="external-wallet-list" aria-label="Installed wallets">
          {externalWallets.map((candidate) => (
            <button
              type="button"
              className="secondary-button"
              key={candidate.adapter.name}
              onClick={() => chooseWallet(candidate.adapter.name)}
            >
              {candidate.adapter.name}
            </button>
          ))}
        </div>
      ) : null}
      {signer.instantDemoEnabled ? (
        <button
          type="button"
          className="secondary-button"
          onClick={signer.connectInstantDemo}
        >
          Instant Demo — no extension
        </button>
      ) : null}
      {connectError ? (
        <p className="inline-error" role="alert">
          {connectError}
        </p>
      ) : null}
      <p>
        {signer.instantDemoEnabled
          ? "Passkeys use your device security. Instant Demo is a browser-saved, Devnet-only wallet and is not for real assets."
          : "Passkeys and external wallets use their own device security."}
      </p>
    </div>
  );
}

function shortAddress(address: string): string {
  return address ? `${address.slice(0, 4)}…${address.slice(-4)}` : "";
}
