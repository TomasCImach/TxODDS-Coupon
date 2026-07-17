import { describe, expect, it } from "vitest";
import {
  connectInstantDemoWallet,
  disconnectInstantDemoWallet,
  instantDemoActiveStorageKey,
  instantDemoSeedStorageKey,
  resetInstantDemoWallet,
  restoreInstantDemoWallet,
} from "./instant-demo-wallet";

describe("Instant Demo browser wallet", () => {
  it("restores the same address across tabs and reconnects", () => {
    const storage = memoryStorage();
    const first = connectInstantDemoWallet(storage, seeded(1));
    const secondTab = restoreInstantDemoWallet(storage);
    expect(secondTab?.publicKey.toBase58()).toBe(first.publicKey.toBase58());

    disconnectInstantDemoWallet(storage);
    expect(restoreInstantDemoWallet(storage)).toBeNull();
    const reconnected = connectInstantDemoWallet(storage, seeded(2));
    expect(reconnected.publicKey.toBase58()).toBe(first.publicKey.toBase58());
  });

  it("rotates only through the explicit reset path", () => {
    const storage = memoryStorage();
    const first = connectInstantDemoWallet(storage, seeded(3));
    const reset = resetInstantDemoWallet(storage, seeded(4));
    expect(reset.publicKey.toBase58()).not.toBe(first.publicKey.toBase58());
    expect(restoreInstantDemoWallet(storage)?.publicKey.toBase58()).toBe(
      reset.publicKey.toBase58(),
    );
  });

  it("rejects corrupted persisted material", () => {
    const storage = memoryStorage();
    storage.setItem(instantDemoSeedStorageKey, "not-base64!");
    storage.setItem(instantDemoActiveStorageKey, "true");
    expect(restoreInstantDemoWallet(storage)).toBeNull();
    expect(storage.getItem(instantDemoSeedStorageKey)).toBeNull();
    expect(storage.getItem(instantDemoActiveStorageKey)).toBeNull();
  });
});

function seeded(byte: number): () => Uint8Array {
  return () => new Uint8Array(32).fill(byte);
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}
