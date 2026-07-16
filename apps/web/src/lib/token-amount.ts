export function parseTokenAmount(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18)
    throw new Error("Token decimal configuration is invalid");
  if (!/^\d+(?:\.\d+)?$/.test(value))
    throw new Error("Enter a plain positive token amount");
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > decimals)
    throw new Error(`GOAL supports at most ${decimals} decimal places`);
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0")
  );
}

export function formatTokenAmount(value: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = (value % divisor)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
