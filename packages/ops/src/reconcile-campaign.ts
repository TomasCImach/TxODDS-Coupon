import {
  getAssociatedTokenAddressSync,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { decodeCampaignAccount, vaultPda } from "@goaldrop/solana-client";
import { Connection } from "@solana/web3.js";
import { devnetConnection, publicKeyFromEnvironment } from "./keys.js";

const connection = new Connection(devnetConnection(), "confirmed");
const programId = publicKeyFromEnvironment("GOALDROP_PROGRAM_ID");
const address = publicKeyFromEnvironment("CAMPAIGN");
const info = await connection.getAccountInfo(address, "confirmed");
if (!info || !info.owner.equals(programId))
  throw new Error("campaign is absent or owned by another program");
const campaign = decodeCampaignAccount(info.data);
const [vault] = vaultPda(programId, address);
const vaultAccount =
  campaign.state === 5
    ? null
    : await getAccount(connection, vault, "confirmed", TOKEN_PROGRAM_ID);
const expected =
  campaign.fundedAmount +
  campaign.externalInflowTotal -
  campaign.paidAmount -
  campaign.refundedAmount;
const actual = vaultAccount?.amount ?? 0n;
if (campaign.state !== 5 && actual < expected)
  throw new Error(
    `vault deficit: expected at least ${expected}, observed ${actual}`,
  );
const refundToken = getAssociatedTokenAddressSync(
  campaign.rewardMint,
  campaign.refundWallet,
  true,
  TOKEN_PROGRAM_ID,
);
process.stdout.write(
  `${JSON.stringify(
    {
      network: "solana:devnet",
      campaign: address.toBase58(),
      state: campaign.state,
      terminalReason: campaign.terminalReason,
      sponsor: campaign.sponsor.toBase58(),
      fixtureId: campaign.fixtureId.toString(),
      rewardMint: campaign.rewardMint.toBase58(),
      refundWallet: campaign.refundWallet.toBase58(),
      refundToken: refundToken.toBase58(),
      vault: vault.toBase58(),
      requiredFunding: campaign.requiredFunding.toString(),
      fundedAmount: campaign.fundedAmount.toString(),
      paidAmount: campaign.paidAmount.toString(),
      refundedAmount: campaign.refundedAmount.toString(),
      externalInflowTotal: campaign.externalInflowTotal.toString(),
      expectedVault: expected.toString(),
      actualVault: actual.toString(),
      openRoundCount: campaign.openRoundCount,
      nextRound: campaign.nextRound,
      rounds: campaign.rounds.map((round, ordinal) => ({
        ordinal,
        rewardAmount: round.rewardAmount.toString(),
        winnerCap: round.winnerCap,
      })),
    },
    null,
    2,
  )}\n`,
);
