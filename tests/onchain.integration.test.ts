import { readFileSync } from "node:fs";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  CampaignState,
  DEVNET_NETWORK_DOMAIN,
  IntentAction,
  RoundState,
  TerminalReason,
  canonicalizeIntent,
  intentHash,
} from "@goaldrop/protocol";
import {
  campaignPda,
  claimPda,
  configPda,
  createCampaignInstruction,
  decodeCampaignAccount,
  decodeClaimAccount,
  decodePlatformConfigAccount,
  decodeRegistrationAccount,
  decodeRoundAccount,
  fanSignatureVerificationInstruction,
  fixtureSlotPda,
  finalizeAfterTimeoutInstruction,
  fundCampaignInstruction,
  goalReceiptPda,
  initializeConfigInstruction,
  makeRefundableInstruction,
  markMatchCompleteInstruction,
  openDemoRoundInstruction,
  openLiveRoundInstruction,
  refundCampaignInstruction,
  registerFanInstruction,
  registrationPda,
  releaseFixtureSlotInstruction,
  rotateAuthorityInstruction,
  roundPda,
  setPauseMaskInstruction,
  settleClaimInstruction,
  sponsorCampaignInstruction,
  vaultPda,
} from "@goaldrop/solana-client";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";

const validatorUrl = process.env.ANCHOR_PROVIDER_URL;
const anchorWallet = process.env.ANCHOR_WALLET;
const validator = validatorUrl && anchorWallet ? describe : describe.skip;

validator("GoalDrop local-validator economic path", () => {
  it("settles overlapping rounds and refunds after provider or hard-timeout finalization", async () => {
    const connection = new Connection(validatorUrl!, "confirmed");
    const feePayer = keypairFromFile(anchorWallet!);
    const programId = keypairFromFile(
      "target/deploy/goaldrop-keypair.json",
    ).publicKey;
    const oracle = Keypair.generate();
    const relayer = Keypair.generate();
    const demoAuthority = Keypair.generate();
    const sponsor = Keypair.generate();
    const fan = Keypair.generate();
    const capFan = Keypair.generate();
    const measuredCompute = {
      registration: 0,
      claimCreateAta: 0,
      claimExistingAta: 0,
      refund: 0,
    };

    const rewardMint = await createMint(
      connection,
      feePayer,
      feePayer.publicKey,
      null,
      6,
    );
    const frozenMint = await createMint(
      connection,
      feePayer,
      feePayer.publicKey,
      feePayer.publicKey,
      6,
    );
    const token2022Mint = await createMint(
      connection,
      feePayer,
      feePayer.publicKey,
      null,
      6,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    const [config] = configPda(programId);
    const configFields = {
      oracle: oracle.publicKey,
      relayer: relayer.publicKey,
      demoAuthority: demoAuthority.publicKey,
      networkDomain: DEVNET_NETWORK_DOMAIN,
      rewardDecimals: 6,
    };
    await expect(
      send(connection, feePayer, [
        initializeConfigInstruction(
          programId,
          { config, admin: feePayer.publicKey, rewardMint },
          { ...configFields, networkDomain: new Uint8Array(32) },
        ),
      ]),
    ).rejects.toThrow();
    await expect(
      send(connection, feePayer, [
        initializeConfigInstruction(
          programId,
          { config, admin: feePayer.publicKey, rewardMint },
          { ...configFields, rewardDecimals: 5 },
        ),
      ]),
    ).rejects.toThrow();
    await expect(
      send(connection, feePayer, [
        initializeConfigInstruction(
          programId,
          { config, admin: feePayer.publicKey, rewardMint: frozenMint },
          configFields,
        ),
      ]),
    ).rejects.toThrow();
    await expect(
      send(connection, feePayer, [
        initializeConfigInstruction(
          programId,
          { config, admin: feePayer.publicKey, rewardMint: token2022Mint },
          configFields,
        ),
      ]),
    ).rejects.toThrow();
    await send(connection, feePayer, [
      initializeConfigInstruction(
        programId,
        { config, admin: feePayer.publicKey, rewardMint },
        configFields,
      ),
    ]);
    await expect(
      send(connection, feePayer, [
        rotateAuthorityInstruction(
          programId,
          config,
          feePayer.publicKey,
          3,
          oracle.publicKey,
        ),
      ]),
    ).rejects.toThrow();
    const rotatedDemoAuthority = Keypair.generate();
    await send(connection, feePayer, [
      rotateAuthorityInstruction(
        programId,
        config,
        feePayer.publicKey,
        3,
        rotatedDemoAuthority.publicKey,
      ),
    ]);
    let configState = decodePlatformConfigAccount(
      (await requiredAccount(connection, config)).data,
    );
    expect(configState.authorityEpoch).toBe(1);
    expect(
      configState.demoAuthority.equals(rotatedDemoAuthority.publicKey),
    ).toBe(true);
    await send(connection, feePayer, [
      rotateAuthorityInstruction(
        programId,
        config,
        feePayer.publicKey,
        3,
        demoAuthority.publicKey,
      ),
    ]);
    configState = decodePlatformConfigAccount(
      (await requiredAccount(connection, config)).data,
    );
    expect(configState.authorityEpoch).toBe(2);
    expect(configState.demoAuthority.equals(demoAuthority.publicKey)).toBe(
      true,
    );
    await expect(
      send(connection, feePayer, [
        setPauseMaskInstruction(
          programId,
          config,
          feePayer.publicKey,
          0b1_0000,
        ),
      ]),
    ).rejects.toThrow();

    const sponsorToken = await getOrCreateAssociatedTokenAccount(
      connection,
      feePayer,
      rewardMint,
      sponsor.publicKey,
    );
    await mintTo(
      connection,
      feePayer,
      rewardMint,
      sponsorToken.address,
      feePayer,
      3_000n,
    );
    expect(await connection.getBalance(sponsor.publicKey)).toBe(0);

    const fixtureId = 20_260_715n;
    const campaignNonce = 1n;
    const [campaign] = campaignPda(programId, sponsor.publicKey, campaignNonce);
    const [fixtureSlot] = fixtureSlotPda(programId, fixtureId);
    const [vault] = vaultPda(programId, campaign);
    const now = BigInt(Math.floor(Date.now() / 1_000));
    await send(
      connection,
      feePayer,
      [
        createCampaignInstruction(
          programId,
          {
            config,
            sponsor: sponsor.publicKey,
            feePayer: feePayer.publicKey,
            refundWallet: sponsor.publicKey,
            rewardMint,
            fixtureSlot,
            campaign,
            vault,
          },
          {
            fixtureId,
            campaignNonce,
            registrationDeadline: now + 60n,
            scheduledStart: now + 120n,
            expectedEnd: now + 360n,
            hardExpiry: now + 600n,
            rounds: [
              { rewardAmount: 1_000n, winnerCap: 1 },
              { rewardAmount: 1_000n, winnerCap: 1 },
              { rewardAmount: 1_000n, winnerCap: 1 },
            ],
          },
        ),
      ],
      [sponsor],
    );
    expect(await connection.getBalance(sponsor.publicKey)).toBe(0);

    let campaignState = decodeCampaignAccount(
      (await requiredAccount(connection, campaign)).data,
    );
    expect(campaignState.state).toBe(CampaignState.Draft);
    expect(campaignState.requiredFunding).toBe(3_000n);
    await send(
      connection,
      feePayer,
      [
        fundCampaignInstruction(
          programId,
          {
            config,
            sponsor: sponsor.publicKey,
            campaign,
            sponsorSource: sponsorToken.address,
            rewardMint,
            vault,
          },
          3_000n,
        ),
      ],
      [sponsor],
    );
    await send(
      connection,
      feePayer,
      [
        sponsorCampaignInstruction(programId, "activate_campaign", {
          config,
          sponsor: sponsor.publicKey,
          campaign,
          vault,
        }),
      ],
      [sponsor],
    );

    const registrationNonce = new Uint8Array(16).fill(9);
    const registrationExpiry = now + 300n;
    const registrationIntent = intentHash(
      canonicalizeIntent({
        programId: programId.toBytes(),
        action: IntentAction.Register,
        campaign: campaign.toBytes(),
        wallet: fan.publicKey.toBytes(),
        nonce: registrationNonce,
        expiresAt: registrationExpiry,
      }),
    );
    const registrationSignature = nacl.sign.detached(
      registrationIntent,
      fan.secretKey,
    );
    const [registration] = registrationPda(programId, campaign, fan.publicKey);
    await send(
      connection,
      feePayer,
      [
        fanSignatureVerificationInstruction(
          fan.publicKey,
          registrationIntent,
          registrationSignature,
        ),
        registerFanInstruction(
          programId,
          {
            config,
            campaign,
            wallet: fan.publicKey,
            registration,
            relayer: relayer.publicKey,
            feePayer: feePayer.publicKey,
          },
          {
            nonce: registrationNonce,
            expiresAt: registrationExpiry,
            intentHash: registrationIntent,
          },
        ),
      ],
      [relayer],
      {
        captureUnits: (units) => {
          measuredCompute.registration = units;
        },
      },
    );
    const registrationState = decodeRegistrationAccount(
      (await requiredAccount(connection, registration)).data,
    );
    expect(registrationState.wallet.equals(fan.publicKey)).toBe(true);
    await expect(
      registerOnchainFan({
        connection,
        feePayer,
        programId,
        config,
        campaign,
        wallet: fan,
        relayer,
        nonce: registrationNonce,
        expiresAt: registrationExpiry,
      }),
    ).rejects.toThrow();

    await expect(
      registerOnchainFan({
        connection,
        feePayer,
        programId,
        config,
        campaign,
        wallet: Keypair.generate(),
        relayer: Keypair.generate(),
        nonce: new Uint8Array(16).fill(17),
        expiresAt: registrationExpiry,
      }),
    ).rejects.toThrow();

    await expect(
      registerOnchainFan({
        connection,
        feePayer,
        programId,
        config,
        campaign,
        wallet: Keypair.generate(),
        relayer,
        nonce: new Uint8Array(16).fill(18),
        expiresAt: now - 1n,
      }),
    ).rejects.toThrow();

    const capRegistration = await registerOnchainFan({
      connection,
      feePayer,
      programId,
      config,
      campaign,
      wallet: capFan,
      relayer,
      nonce: new Uint8Array(16).fill(10),
      expiresAt: registrationExpiry,
    });
    expect(await connection.getBalance(capFan.publicKey)).toBe(0);

    const eventHash = new Uint8Array(32).fill(7);
    const [round] = roundPda(programId, campaign, 0);
    const [goalReceipt] = goalReceiptPda(programId, campaign, eventHash);
    const liveRoundFields = {
      fixtureId,
      eventHash,
      providerActionId: 7_001n,
      providerSeq: 42,
      providerStatus: 2,
      confirmedAtOpen: false,
      providerTsMs: now * 1_000n,
      rawDigest: new Uint8Array(32).fill(8),
    };
    await expect(
      send(
        connection,
        feePayer,
        [
          openLiveRoundInstruction(
            programId,
            {
              config,
              oracle: demoAuthority.publicKey,
              feePayer: feePayer.publicKey,
              campaign,
              round,
              goalReceipt,
            },
            liveRoundFields,
          ),
        ],
        [demoAuthority],
      ),
    ).rejects.toThrow();
    await send(
      connection,
      feePayer,
      [
        openLiveRoundInstruction(
          programId,
          {
            config,
            oracle: oracle.publicKey,
            feePayer: feePayer.publicKey,
            campaign,
            round,
            goalReceipt,
          },
          liveRoundFields,
        ),
      ],
      [oracle],
    );
    expect(await connection.getBalance(oracle.publicKey)).toBe(0);
    const [nextRound] = roundPda(programId, campaign, 1);
    await expect(
      send(
        connection,
        feePayer,
        [
          openLiveRoundInstruction(
            programId,
            {
              config,
              oracle: oracle.publicKey,
              feePayer: feePayer.publicKey,
              campaign,
              round: nextRound,
              goalReceipt,
            },
            liveRoundFields,
          ),
        ],
        [oracle],
      ),
    ).rejects.toThrow();
    const secondEventHash = new Uint8Array(32).fill(12);
    const [secondGoalReceipt] = goalReceiptPda(
      programId,
      campaign,
      secondEventHash,
    );
    const demoRoundFields = {
      fixtureId,
      eventHash: secondEventHash,
      demoNonce: 2n,
      providerTsMs: now * 1_000n + 1n,
      rawDigest: new Uint8Array(32).fill(13),
    };
    await expect(
      send(
        connection,
        feePayer,
        [
          openDemoRoundInstruction(
            programId,
            {
              config,
              demoAuthority: oracle.publicKey,
              feePayer: feePayer.publicKey,
              campaign,
              round: nextRound,
              goalReceipt: secondGoalReceipt,
            },
            demoRoundFields,
          ),
        ],
        [oracle],
      ),
    ).rejects.toThrow();
    await send(
      connection,
      feePayer,
      [
        openDemoRoundInstruction(
          programId,
          {
            config,
            demoAuthority: demoAuthority.publicKey,
            feePayer: feePayer.publicKey,
            campaign,
            round: nextRound,
            goalReceipt: secondGoalReceipt,
          },
          demoRoundFields,
        ),
      ],
      [demoAuthority],
    );
    expect(await connection.getBalance(demoAuthority.publicKey)).toBe(0);
    campaignState = decodeCampaignAccount(
      (await requiredAccount(connection, campaign)).data,
    );
    expect(campaignState.nextRound).toBe(2);
    expect(campaignState.openRoundCount).toBe(2);

    await send(connection, feePayer, [
      setPauseMaskInstruction(programId, config, feePayer.publicKey, 0b1111),
    ]);
    await expect(
      registerOnchainFan({
        connection,
        feePayer,
        programId,
        config,
        campaign,
        wallet: Keypair.generate(),
        relayer,
        nonce: new Uint8Array(16).fill(16),
        expiresAt: registrationExpiry,
      }),
    ).rejects.toThrow();

    await send(
      connection,
      feePayer,
      [
        markMatchCompleteInstruction(
          programId,
          { config, campaign, oracle: oracle.publicKey },
          {
            terminalReason: TerminalReason.ProviderFinalised,
            providerActionId: 99n,
            providerSeq: 10,
          },
        ),
      ],
      [oracle],
    );
    await send(connection, feePayer, [
      setPauseMaskInstruction(programId, config, feePayer.publicKey, 0),
    ]);
    const terminalEventHash = new Uint8Array(32).fill(19);
    const [terminalRound] = roundPda(programId, campaign, 2);
    const [terminalReceipt] = goalReceiptPda(
      programId,
      campaign,
      terminalEventHash,
    );
    await expect(
      send(
        connection,
        feePayer,
        [
          openLiveRoundInstruction(
            programId,
            {
              config,
              oracle: oracle.publicKey,
              feePayer: feePayer.publicKey,
              campaign,
              round: terminalRound,
              goalReceipt: terminalReceipt,
            },
            {
              ...liveRoundFields,
              eventHash: terminalEventHash,
              providerActionId: 7_002n,
            },
          ),
        ],
        [oracle],
      ),
    ).rejects.toThrow();
    await expect(
      send(connection, feePayer, [
        makeRefundableInstruction(programId, campaign, vault),
      ]),
    ).rejects.toThrow();
    const recipientToken = {
      address: getAssociatedTokenAddressSync(rewardMint, fan.publicKey),
    };
    const claimNonce = new Uint8Array(16).fill(11);
    const claimExpiry = now + 300n;
    const claimIntent = intentHash(
      canonicalizeIntent({
        programId: programId.toBytes(),
        action: IntentAction.Claim,
        campaign: campaign.toBytes(),
        round: round.toBytes(),
        wallet: fan.publicKey.toBytes(),
        nonce: claimNonce,
        expiresAt: claimExpiry,
      }),
    );
    const claimSignature = nacl.sign.detached(claimIntent, fan.secretKey);
    const [claim] = claimPda(programId, round, fan.publicKey);
    const claimInstructions = (sequence: bigint) => [
      createAssociatedTokenAccountIdempotentInstruction(
        feePayer.publicKey,
        recipientToken.address,
        fan.publicKey,
        rewardMint,
      ),
      fanSignatureVerificationInstruction(
        fan.publicKey,
        claimIntent,
        claimSignature,
      ),
      settleClaimInstruction(
        programId,
        {
          config,
          campaign,
          round,
          wallet: fan.publicKey,
          registration,
          claim,
          relayer: relayer.publicKey,
          feePayer: feePayer.publicKey,
          vault,
          rewardMint,
          recipientToken: recipientToken.address,
        },
        {
          sequence,
          nonce: claimNonce,
          expiresAt: claimExpiry,
          intentHash: claimIntent,
        },
      ),
    ];
    await expect(
      send(connection, feePayer, claimInstructions(2n), [relayer]),
    ).rejects.toThrow();
    expect(await connection.getAccountInfo(claim, "confirmed")).toBeNull();
    expect((await getAccount(connection, vault)).amount).toBe(3_000n);
    await send(connection, feePayer, claimInstructions(1n), [relayer], {
      captureUnits: (units) => {
        measuredCompute.claimCreateAta = units;
      },
    });

    const claimState = decodeClaimAccount(
      (await requiredAccount(connection, claim)).data,
    );
    const roundState = decodeRoundAccount(
      (await requiredAccount(connection, round)).data,
    );
    expect(claimState.amount).toBe(1_000n);
    expect(claimState.winnerRank).toBe(1);
    expect(roundState.state).toBe(RoundState.Exhausted);
    expect((await getAccount(connection, recipientToken.address)).amount).toBe(
      1_000n,
    );

    const capRecipientToken = await getOrCreateAssociatedTokenAccount(
      connection,
      feePayer,
      rewardMint,
      capFan.publicKey,
    );
    const capClaimNonce = new Uint8Array(16).fill(15);
    const capClaimIntent = intentHash(
      canonicalizeIntent({
        programId: programId.toBytes(),
        action: IntentAction.Claim,
        campaign: campaign.toBytes(),
        round: round.toBytes(),
        wallet: capFan.publicKey.toBytes(),
        nonce: capClaimNonce,
        expiresAt: claimExpiry,
      }),
    );
    const [capClaim] = claimPda(programId, round, capFan.publicKey);
    await expect(
      send(
        connection,
        feePayer,
        [
          fanSignatureVerificationInstruction(
            capFan.publicKey,
            capClaimIntent,
            nacl.sign.detached(capClaimIntent, capFan.secretKey),
          ),
          settleClaimInstruction(
            programId,
            {
              config,
              campaign,
              round,
              wallet: capFan.publicKey,
              registration: capRegistration,
              claim: capClaim,
              relayer: relayer.publicKey,
              feePayer: feePayer.publicKey,
              vault,
              rewardMint,
              recipientToken: capRecipientToken.address,
            },
            {
              sequence: 1n,
              nonce: capClaimNonce,
              expiresAt: claimExpiry,
              intentHash: capClaimIntent,
            },
          ),
        ],
        [relayer],
      ),
    ).rejects.toThrow();
    expect(await connection.getAccountInfo(capClaim, "confirmed")).toBeNull();
    expect(
      (await getAccount(connection, capRecipientToken.address)).amount,
    ).toBe(0n);
    expect((await getAccount(connection, vault)).amount).toBe(2_000n);
    await expect(
      send(connection, feePayer, claimInstructions(1n), [relayer]),
    ).rejects.toThrow();
    expect((await getAccount(connection, recipientToken.address)).amount).toBe(
      1_000n,
    );

    const secondClaimNonce = new Uint8Array(16).fill(14);
    const secondClaimIntent = intentHash(
      canonicalizeIntent({
        programId: programId.toBytes(),
        action: IntentAction.Claim,
        campaign: campaign.toBytes(),
        round: nextRound.toBytes(),
        wallet: fan.publicKey.toBytes(),
        nonce: secondClaimNonce,
        expiresAt: claimExpiry,
      }),
    );
    const secondClaimSignature = nacl.sign.detached(
      secondClaimIntent,
      fan.secretKey,
    );
    const [secondClaim] = claimPda(programId, nextRound, fan.publicKey);
    await send(
      connection,
      feePayer,
      [
        fanSignatureVerificationInstruction(
          fan.publicKey,
          secondClaimIntent,
          secondClaimSignature,
        ),
        settleClaimInstruction(
          programId,
          {
            config,
            campaign,
            round: nextRound,
            wallet: fan.publicKey,
            registration,
            claim: secondClaim,
            relayer: relayer.publicKey,
            feePayer: feePayer.publicKey,
            vault,
            rewardMint,
            recipientToken: recipientToken.address,
          },
          {
            sequence: 1n,
            nonce: secondClaimNonce,
            expiresAt: claimExpiry,
            intentHash: secondClaimIntent,
          },
        ),
      ],
      [relayer],
      {
        captureUnits: (units) => {
          measuredCompute.claimExistingAta = units;
        },
      },
    );
    const secondRoundState = decodeRoundAccount(
      (await requiredAccount(connection, nextRound)).data,
    );
    expect(secondRoundState.state).toBe(RoundState.Exhausted);
    expect((await getAccount(connection, recipientToken.address)).amount).toBe(
      2_000n,
    );

    const wrongRefundWallet = Keypair.generate();
    const wrongRefundToken = await getOrCreateAssociatedTokenAccount(
      connection,
      feePayer,
      rewardMint,
      wrongRefundWallet.publicKey,
    );
    await send(connection, feePayer, [
      setPauseMaskInstruction(programId, config, feePayer.publicKey, 0b1111),
    ]);
    await send(connection, feePayer, [
      makeRefundableInstruction(programId, campaign, vault),
    ]);
    await expect(
      send(connection, feePayer, [
        refundCampaignInstruction(programId, {
          campaign,
          vault,
          rewardMint,
          refundWallet: wrongRefundWallet.publicKey,
          refundToken: wrongRefundToken.address,
        }),
      ]),
    ).rejects.toThrow();
    expect((await getAccount(connection, vault)).amount).toBe(1_000n);
    await send(
      connection,
      feePayer,
      [
        refundCampaignInstruction(programId, {
          campaign,
          vault,
          rewardMint,
          refundWallet: sponsor.publicKey,
          refundToken: sponsorToken.address,
        }),
      ],
      [],
      {
        captureUnits: (units) => {
          measuredCompute.refund = units;
        },
      },
    );
    expect(measuredCompute.registration).toBeGreaterThan(0);
    expect(measuredCompute.registration).toBeLessThanOrEqual(30_000);
    expect(measuredCompute.claimCreateAta).toBeGreaterThan(0);
    expect(measuredCompute.claimCreateAta).toBeLessThanOrEqual(100_000);
    expect(measuredCompute.claimExistingAta).toBeGreaterThan(0);
    expect(measuredCompute.claimExistingAta).toBeLessThanOrEqual(70_000);
    expect(measuredCompute.refund).toBeGreaterThan(0);
    expect(measuredCompute.refund).toBeLessThanOrEqual(40_000);
    campaignState = decodeCampaignAccount(
      (await requiredAccount(connection, campaign)).data,
    );
    expect(campaignState.state).toBe(CampaignState.Refunded);
    expect(campaignState.paidAmount).toBe(2_000n);
    expect(campaignState.refundedAmount).toBe(1_000n);
    expect((await getAccount(connection, sponsorToken.address)).amount).toBe(
      1_000n,
    );
    expect(await connection.getAccountInfo(vault, "confirmed")).toBeNull();
    await expect(
      send(connection, feePayer, [
        refundCampaignInstruction(programId, {
          campaign,
          vault,
          rewardMint,
          refundWallet: sponsor.publicKey,
          refundToken: sponsorToken.address,
        }),
      ]),
    ).rejects.toThrow();
    await expect(
      send(connection, feePayer, claimInstructions(1n), [relayer]),
    ).rejects.toThrow();

    await send(connection, feePayer, [
      releaseFixtureSlotInstruction(programId, {
        campaign,
        fixtureSlot,
        rentRecipient: sponsor.publicKey,
      }),
    ]);
    expect(
      await connection.getAccountInfo(fixtureSlot, "confirmed"),
    ).toBeNull();
    await send(connection, feePayer, [
      setPauseMaskInstruction(programId, config, feePayer.publicKey, 0),
    ]);

    const timeoutFixtureId = 20_260_716n;
    const [timeoutCampaign] = campaignPda(programId, sponsor.publicKey, 2n);
    const [timeoutFixtureSlot] = fixtureSlotPda(programId, timeoutFixtureId);
    const [timeoutVault] = vaultPda(programId, timeoutCampaign);
    const timeoutNow = BigInt(Math.floor(Date.now() / 1_000));
    const hardExpiry = timeoutNow + 5n;
    await send(
      connection,
      feePayer,
      [
        createCampaignInstruction(
          programId,
          {
            config,
            sponsor: sponsor.publicKey,
            feePayer: feePayer.publicKey,
            refundWallet: sponsor.publicKey,
            rewardMint,
            fixtureSlot: timeoutFixtureSlot,
            campaign: timeoutCampaign,
            vault: timeoutVault,
          },
          {
            fixtureId: timeoutFixtureId,
            campaignNonce: 2n,
            registrationDeadline: timeoutNow + 2n,
            scheduledStart: timeoutNow + 3n,
            expectedEnd: timeoutNow + 4n,
            hardExpiry,
            rounds: [{ rewardAmount: 1_000n, winnerCap: 1 }],
          },
        ),
      ],
      [sponsor],
    );
    await send(
      connection,
      feePayer,
      [
        fundCampaignInstruction(
          programId,
          {
            config,
            sponsor: sponsor.publicKey,
            campaign: timeoutCampaign,
            sponsorSource: sponsorToken.address,
            rewardMint,
            vault: timeoutVault,
          },
          1_000n,
        ),
      ],
      [sponsor],
    );
    await send(
      connection,
      feePayer,
      [
        sponsorCampaignInstruction(programId, "activate_campaign", {
          config,
          sponsor: sponsor.publicKey,
          campaign: timeoutCampaign,
          vault: timeoutVault,
        }),
      ],
      [sponsor],
    );
    await expect(
      send(connection, feePayer, [
        finalizeAfterTimeoutInstruction(programId, timeoutCampaign),
      ]),
    ).rejects.toThrow();

    await waitForChainTimestamp(connection, Number(hardExpiry));
    await send(connection, feePayer, [
      finalizeAfterTimeoutInstruction(programId, timeoutCampaign),
    ]);
    await send(connection, feePayer, [
      makeRefundableInstruction(programId, timeoutCampaign, timeoutVault),
    ]);
    await send(connection, feePayer, [
      refundCampaignInstruction(programId, {
        campaign: timeoutCampaign,
        vault: timeoutVault,
        rewardMint,
        refundWallet: sponsor.publicKey,
        refundToken: sponsorToken.address,
      }),
    ]);
    const timeoutCampaignState = decodeCampaignAccount(
      (await requiredAccount(connection, timeoutCampaign)).data,
    );
    expect(timeoutCampaignState.terminalReason).toBe(
      TerminalReason.HardTimeout,
    );
    expect(timeoutCampaignState.state).toBe(CampaignState.Refunded);
    expect(timeoutCampaignState.refundedAmount).toBe(1_000n);
    expect((await getAccount(connection, sponsorToken.address)).amount).toBe(
      1_000n,
    );
    expect(
      await connection.getAccountInfo(timeoutVault, "confirmed"),
    ).toBeNull();
  });
});

async function waitForChainTimestamp(
  connection: Connection,
  expectedTimestamp: number,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const slot = await connection.getSlot("confirmed");
    const timestamp = await connection.getBlockTime(slot);
    if (timestamp !== null && timestamp >= expectedTimestamp) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(
    `validator clock did not reach ${expectedTimestamp} within 20 seconds`,
  );
}

async function registerOnchainFan(input: {
  connection: Connection;
  feePayer: Keypair;
  programId: PublicKey;
  config: PublicKey;
  campaign: PublicKey;
  wallet: Keypair;
  relayer: Keypair;
  nonce: Uint8Array;
  expiresAt: bigint;
}): Promise<PublicKey> {
  const hash = intentHash(
    canonicalizeIntent({
      programId: input.programId.toBytes(),
      action: IntentAction.Register,
      campaign: input.campaign.toBytes(),
      wallet: input.wallet.publicKey.toBytes(),
      nonce: input.nonce,
      expiresAt: input.expiresAt,
    }),
  );
  const [registration] = registrationPda(
    input.programId,
    input.campaign,
    input.wallet.publicKey,
  );
  await send(
    input.connection,
    input.feePayer,
    [
      fanSignatureVerificationInstruction(
        input.wallet.publicKey,
        hash,
        nacl.sign.detached(hash, input.wallet.secretKey),
      ),
      registerFanInstruction(
        input.programId,
        {
          config: input.config,
          campaign: input.campaign,
          wallet: input.wallet.publicKey,
          registration,
          relayer: input.relayer.publicKey,
          feePayer: input.feePayer.publicKey,
        },
        {
          nonce: input.nonce,
          expiresAt: input.expiresAt,
          intentHash: hash,
        },
      ),
    ],
    [input.relayer],
  );
  return registration;
}

function keypairFromFile(path: string): Keypair {
  const secret = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function requiredAccount(connection: Connection, address: PublicKey) {
  const account = await connection.getAccountInfo(address, "confirmed");
  if (!account) throw new Error(`account ${address.toBase58()} was not found`);
  return account;
}

async function send(
  connection: Connection,
  feePayer: Keypair,
  instructions: TransactionInstruction[],
  signers: Keypair[] = [],
  options?: { captureUnits?: (units: number) => void },
): Promise<string> {
  const blockhash = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: feePayer.publicKey,
    recentBlockhash: blockhash.blockhash,
  }).add(...instructions);
  const unique = [feePayer, ...signers].filter(
    (signer, index, all) =>
      all.findIndex((candidate) =>
        candidate.publicKey.equals(signer.publicKey),
      ) === index,
  );
  transaction.sign(...unique);
  if (options?.captureUnits) {
    const simulation = await connection.simulateTransaction(transaction);
    if (simulation.value.err)
      throw new Error(
        `transaction simulation failed: ${JSON.stringify(simulation.value.err)}`,
      );
    const units = simulation.value.unitsConsumed;
    if (units === undefined)
      throw new Error("transaction simulation did not report compute units");
    options.captureUnits(units);
  }
  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    { skipPreflight: false, maxRetries: 3 },
  );
  const confirmation = await connection.confirmTransaction(
    { signature, ...blockhash },
    "confirmed",
  );
  if (confirmation.value.err)
    throw new Error(
      `transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`,
    );
  return signature;
}
