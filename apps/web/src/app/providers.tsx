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
import {
  WalletModalProvider,
  WalletMultiButton,
} from "@solana/wallet-adapter-react-ui";
import {
  WalletProvider as PasskeyWalletProvider,
  WalletWidget,
} from "@passkeys/react";
import { createWallet } from "@passkeys/core";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { track } from "../lib/analytics";

type EmbeddedWallet = ReturnType<typeof createWallet>;
type WalletMode = "passkey" | "external" | "instant-demo" | null;

interface FanSignerValue {
  address: string | null;
  mode: WalletMode;
  connected: boolean;
  canSignMessage: boolean;
  canSignTransaction: boolean;
  signDigest(digest: Uint8Array): Promise<Uint8Array>;
  signTransaction(
    transaction: VersionedTransaction,
  ): Promise<VersionedTransaction>;
  connectInstantDemo(): void;
  disconnect(): Promise<void>;
}

const FanSignerContext = createContext<FanSignerValue | null>(null);

export function AppProviders({ children }: { children: ReactNode }) {
  const [embeddedWallet, setEmbeddedWallet] = useState<EmbeddedWallet | null>(
    null,
  );
  useEffect(() => {
    const appId = process.env.NEXT_PUBLIC_PASSKEY_APP_ID;
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
      <WalletWidget
        theme={{ variant: "dark", colors: { accentColor: "#a7ff45" } }}
        experimental_mode="modal"
      />
      <StandardSolanaLayer>{children}</StandardSolanaLayer>
    </PasskeyWalletProvider>
  ) : (
    <StandardSolanaLayer>{children}</StandardSolanaLayer>
  );
  return content;
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
  const connectInstantDemo = useCallback(() => {
    setInstant(Keypair.generate());
  }, []);
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
      signDigest,
      signTransaction,
      connectInstantDemo,
      disconnect,
    }),
    [
      instant,
      wallet.connected,
      wallet.publicKey,
      wallet.signMessage,
      wallet.signTransaction,
      mode,
      signDigest,
      signTransaction,
      connectInstantDemo,
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
  const trackedMode = useRef<WalletMode>(null);
  const [copied, setCopied] = useState(false);
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
      </div>
    );
  }
  return (
    <div className="wallet-choices">
      <WalletMultiButton>Continue with passkey or wallet</WalletMultiButton>
      <button
        type="button"
        className="secondary-button"
        onClick={signer.connectInstantDemo}
      >
        Instant Demo — no extension
      </button>
      <p>
        Passkeys use your device security. Instant Demo is a temporary
        Devnet-only browser wallet and is not for real assets.
      </p>
    </div>
  );
}

function shortAddress(address: string): string {
  return address ? `${address.slice(0, 4)}…${address.slice(-4)}` : "";
}
