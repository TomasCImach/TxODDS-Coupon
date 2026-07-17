import { Keypair } from "@solana/web3.js";

export const instantDemoSeedStorageKey = "goaldrop.instant-demo.seed.v1";
export const instantDemoActiveStorageKey = "goaldrop.instant-demo.active.v1";

type WalletStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function restoreInstantDemoWallet(
  storage: WalletStorage = window.localStorage,
): Keypair | null {
  if (storage.getItem(instantDemoActiveStorageKey) !== "true") return null;
  const wallet = readWallet(storage);
  if (wallet) return wallet;
  storage.removeItem(instantDemoSeedStorageKey);
  storage.removeItem(instantDemoActiveStorageKey);
  return null;
}

export function connectInstantDemoWallet(
  storage: WalletStorage = window.localStorage,
  randomSeed: () => Uint8Array = browserRandomSeed,
): Keypair {
  const wallet = readWallet(storage) ?? createWallet(storage, randomSeed);
  storage.setItem(instantDemoActiveStorageKey, "true");
  return wallet;
}

export function persistInstantDemoSeed(
  seed: Uint8Array,
  storage: WalletStorage = window.localStorage,
): void {
  if (seed.length !== 32) throw new Error("Instant Demo seed must be 32 bytes");
  storage.setItem(instantDemoSeedStorageKey, encodeBase64(seed));
  storage.setItem(instantDemoActiveStorageKey, "true");
}

export function disconnectInstantDemoWallet(
  storage: WalletStorage = window.localStorage,
): void {
  storage.setItem(instantDemoActiveStorageKey, "false");
}

export function resetInstantDemoWallet(
  storage: WalletStorage = window.localStorage,
  randomSeed: () => Uint8Array = browserRandomSeed,
): Keypair {
  storage.removeItem(instantDemoSeedStorageKey);
  return connectInstantDemoWallet(storage, randomSeed);
}

export function isInstantDemoStorageKey(key: string | null): boolean {
  return (
    key === instantDemoSeedStorageKey || key === instantDemoActiveStorageKey
  );
}

function readWallet(storage: WalletStorage): Keypair | null {
  const encoded = storage.getItem(instantDemoSeedStorageKey);
  if (!encoded) return null;
  try {
    const seed = decodeBase64(encoded);
    return seed.length === 32 ? Keypair.fromSeed(seed) : null;
  } catch {
    return null;
  }
}

function createWallet(
  storage: WalletStorage,
  randomSeed: () => Uint8Array,
): Keypair {
  const seed = randomSeed();
  if (seed.length !== 32) throw new Error("Instant Demo seed must be 32 bytes");
  storage.setItem(instantDemoSeedStorageKey, encodeBase64(seed));
  return Keypair.fromSeed(seed);
}

function browserRandomSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

function encodeBase64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
