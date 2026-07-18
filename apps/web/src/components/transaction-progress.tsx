import {
  transactionProgressSteps,
  type TransactionAction,
  type TransactionPhase,
} from "../lib/transaction-progress";

export function TransactionProgress({
  action,
  phase,
  requiresApproval = true,
}: {
  action: TransactionAction;
  phase: TransactionPhase;
  requiresApproval?: boolean;
}) {
  const steps = transactionProgressSteps(action, phase, requiresApproval);

  return (
    <ol
      className="transaction-progress"
      role="status"
      aria-live="polite"
      aria-label={`${action} transaction progress`}
    >
      {steps.map((step) => (
        <li
          key={step.phase}
          data-state={step.state}
          aria-current={step.state === "current" ? "step" : undefined}
        >
          <span aria-hidden="true" />
          {step.label}
        </li>
      ))}
    </ol>
  );
}
