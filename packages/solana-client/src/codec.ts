import { sha256 } from "@noble/hashes/sha2.js";

export function anchorDiscriminator(
  namespace: "global" | "account" | "event",
  name: string,
): Buffer {
  return Buffer.from(
    sha256(new TextEncoder().encode(`${namespace}:${name}`)).slice(0, 8),
  );
}

export function concat(...values: readonly Uint8Array[]): Buffer {
  return Buffer.concat(values.map((value) => Buffer.from(value)));
}

export function u8(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 255)
    throw new RangeError("u8 out of range");
  return Buffer.from([value]);
}

export function u16(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 65_535)
    throw new RangeError("u16 out of range");
  const output = Buffer.alloc(2);
  output.writeUInt16LE(value);
  return output;
}

export function u32(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff)
    throw new RangeError("u32 out of range");
  const output = Buffer.alloc(4);
  output.writeUInt32LE(value);
  return output;
}

export function u64(value: bigint): Buffer {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn)
    throw new RangeError("u64 out of range");
  const output = Buffer.alloc(8);
  output.writeBigUInt64LE(value);
  return output;
}

export function i64(value: bigint): Buffer {
  if (value < -0x8000_0000_0000_0000n || value > 0x7fff_ffff_ffff_ffffn)
    throw new RangeError("i64 out of range");
  const output = Buffer.alloc(8);
  output.writeBigInt64LE(value);
  return output;
}

export function fixed(
  value: Uint8Array,
  length: number,
  field: string,
): Buffer {
  if (value.length !== length)
    throw new RangeError(`${field} must be ${length} bytes`);
  return Buffer.from(value);
}
