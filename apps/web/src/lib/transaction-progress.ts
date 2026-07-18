export type TransactionPhase = "preparing" | "approval" | "submitting";

export type TransactionAction =
  | "create"
  | "fund"
  | "activate"
  | "cancel"
  | "refund"
  | "faucet"
  | "transfer"
  | "registration"
  | "claim";

export interface TransactionProgressStep {
  phase: TransactionPhase;
  label: string;
  state: "complete" | "current" | "upcoming";
}

const actionLabels: Record<
  TransactionAction,
  [preparing: string, approval: string, submitting: string]
> = {
  create: [
    "Preparing campaign",
    "Approve campaign in wallet",
    "Submitting & confirming campaign",
  ],
  fund: [
    "Preparing exact funding",
    "Approve GOAL funding in wallet",
    "Submitting & confirming funding",
  ],
  activate: [
    "Preparing activation",
    "Approve activation in wallet",
    "Submitting & confirming activation",
  ],
  cancel: [
    "Preparing cancellation",
    "Approve cancellation in wallet",
    "Submitting & confirming cancellation",
  ],
  refund: [
    "Preparing residual refund",
    "Approve refund in wallet",
    "Submitting & confirming refund",
  ],
  faucet: [
    "Preparing Devnet reward request",
    "Approve request in wallet",
    "Submitting & confirming rewards",
  ],
  transfer: [
    "Preparing reward transfer",
    "Approve transfer in wallet",
    "Submitting & confirming transfer",
  ],
  registration: [
    "Preparing registration",
    "Approve registration signature",
    "Submitting & confirming registration",
  ],
  claim: [
    "Preparing claim",
    "Approve claim signature",
    "Submitting & confirming claim",
  ],
};

export function transactionProgressSteps(
  action: TransactionAction,
  current: TransactionPhase,
  requiresApproval = true,
): TransactionProgressStep[] {
  const phases: TransactionPhase[] = requiresApproval
    ? ["preparing", "approval", "submitting"]
    : ["preparing", "submitting"];
  const labels = actionLabels[action];
  const currentIndex = phases.indexOf(current);

  return phases.map((phase, index) => ({
    phase,
    label: labels[phase === "preparing" ? 0 : phase === "approval" ? 1 : 2],
    state:
      index < currentIndex
        ? "complete"
        : index === currentIndex
          ? "current"
          : "upcoming",
  }));
}
