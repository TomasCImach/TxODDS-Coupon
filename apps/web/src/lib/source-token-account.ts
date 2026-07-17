export interface SourceTokenAccountCandidate {
  address: string;
  amount: bigint;
}

export function selectFundedSourceTokenAccount(
  candidates: SourceTokenAccountCandidate[],
): SourceTokenAccountCandidate | null {
  return candidates.reduce<SourceTokenAccountCandidate | null>(
    (selected, candidate) =>
      candidate.amount > 0n && (!selected || candidate.amount > selected.amount)
        ? candidate
        : selected,
    null,
  );
}
