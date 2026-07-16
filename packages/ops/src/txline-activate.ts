import { chmod, writeFile } from "node:fs/promises";
import nacl from "tweetnacl";
import { Connection, PublicKey } from "@solana/web3.js";
import { devnetConnection, keypairFromEnvironment } from "./keys.js";

const apiOrigin = "https://txline-dev.txodds.com";
const txlineProgram = new PublicKey(
  "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
);
const wallet = await keypairFromEnvironment("TXLINE_SUBSCRIPTION_KEYPAIR");
const txSig = process.env.TXLINE_SUBSCRIPTION_SIGNATURE;
const output = process.env.TXLINE_API_TOKEN_OUTPUT;
if (!txSig)
  throw new Error(
    "TXLINE_SUBSCRIPTION_SIGNATURE is required; create it with the current official Devnet free-tier subscribe flow",
  );
if (!output)
  throw new Error(
    "TXLINE_API_TOKEN_OUTPUT is required so credentials are not printed",
  );
const leagues = (process.env.TXLINE_LEAGUES ?? "")
  .split(",")
  .filter(Boolean)
  .map((value) => Number(value));
if (leagues.some((value) => !Number.isInteger(value) || value <= 0))
  throw new Error(
    "TXLINE_LEAGUES must be comma-separated positive IDs or empty for the bundle default",
  );
const connection = new Connection(devnetConnection(), "confirmed");
const transaction = await connection.getTransaction(txSig, {
  commitment: "confirmed",
  maxSupportedTransactionVersion: 0,
});
if (!transaction || transaction.meta?.err)
  throw new Error("subscription transaction is not confirmed on Devnet");
const keys = transaction.transaction.message.getAccountKeys().staticAccountKeys;
if (!keys.some((key) => key.equals(txlineProgram)))
  throw new Error(
    "subscription transaction does not invoke the configured TxLINE Devnet program",
  );
const walletIndex = keys.findIndex((key) => key.equals(wallet.publicKey));
if (
  walletIndex < 0 ||
  walletIndex >= transaction.transaction.message.header.numRequiredSignatures
)
  throw new Error("subscription wallet was not a required transaction signer");
let jwt = process.env.TXLINE_GUEST_JWT;
if (!jwt) {
  const response = await fetch(`${apiOrigin}/auth/guest/start`, {
    method: "POST",
  });
  if (!response.ok)
    throw new Error(`guest JWT request failed with ${response.status}`);
  const body = (await response.json()) as Record<string, unknown>;
  jwt = String(body.token ?? body.jwt ?? "");
}
if (jwt.length < 20) throw new Error("guest JWT response was invalid");
const message = new TextEncoder().encode(
  `${txSig}:${leagues.join(",")}:${jwt}`,
);
const walletSignature = Buffer.from(
  nacl.sign.detached(message, wallet.secretKey),
).toString("base64");
const activation = await fetch(`${apiOrigin}/api/token/activate`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ txSig, walletSignature, leagues }),
});
if (!activation.ok)
  throw new Error(`TxLINE activation failed with ${activation.status}`);
const activated = (await activation.json()) as Record<string, unknown> | string;
const apiToken =
  typeof activated === "string"
    ? activated
    : String(activated.token ?? activated.apiToken ?? "");
if (apiToken.length < 20)
  throw new Error("TxLINE activation did not return an API token");
await writeFile(
  output,
  `${JSON.stringify({ TXLINE_GUEST_JWT: jwt, TXLINE_API_TOKEN: apiToken })}\n`,
  { mode: 0o600 },
);
await chmod(output, 0o600);
const snapshot = await fetch(`${apiOrigin}/api/fixtures/snapshot`, {
  headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken },
});
if (!snapshot.ok)
  throw new Error(
    `activation saved, but fixture verification failed with ${snapshot.status}`,
  );
const fixtures = await snapshot.json();
process.stdout.write(
  `${JSON.stringify({ network: "solana:devnet", subscriptionSignature: txSig, subscriptionWallet: wallet.publicKey.toBase58(), credentialsFile: output, fixtureCount: Array.isArray(fixtures) ? fixtures.length : null })}\n`,
);
