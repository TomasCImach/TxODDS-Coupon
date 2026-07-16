import { rotateAuthorityInstruction } from "@goaldrop/solana-client";
import { PublicKey } from "@solana/web3.js";
import { executeAdminChange, printableConfig } from "./admin-transaction.js";

const roleNames = ["admin", "oracle", "relayer", "demo"] as const;
type RoleName = (typeof roleNames)[number];
const role = process.env.AUTHORITY_ROLE as RoleName | undefined;
if (!role || !roleNames.includes(role))
  throw new Error("AUTHORITY_ROLE must be admin, oracle, relayer, or demo");
const newAuthority = new PublicKey(process.env.NEW_AUTHORITY ?? "");
if (newAuthority.equals(PublicKey.default))
  throw new Error("NEW_AUTHORITY cannot be the default public key");
const roleIndex = roleNames.indexOf(role);

const result = await executeAdminChange({
  instruction: ({ programId, config, admin, before }) => {
    const active = [
      before.admin,
      before.oracle,
      before.relayer,
      before.demoAuthority,
    ];
    if (active.some((authority) => authority.equals(newAuthority)))
      throw new Error("NEW_AUTHORITY must be distinct from every active role");
    return rotateAuthorityInstruction(
      programId,
      config,
      admin,
      roleIndex,
      newAuthority,
    );
  },
  verify: (before, after) => {
    const selected = [
      after.admin,
      after.oracle,
      after.relayer,
      after.demoAuthority,
    ][roleIndex];
    return (
      selected?.equals(newAuthority) === true &&
      after.authorityEpoch === before.authorityEpoch + 1
    );
  },
});

process.stdout.write(
  `${JSON.stringify(
    {
      ...result,
      before: printableConfig(result.before),
      after: printableConfig(result.after),
      role,
      newAuthority: newAuthority.toBase58(),
    },
    null,
    2,
  )}\n`,
);
