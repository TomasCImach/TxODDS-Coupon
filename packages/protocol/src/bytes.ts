import bs58 from "bs58";

export type Bytes32 = Uint8Array;
export type Bytes16 = Uint8Array;

export function assertLength(
  value: Uint8Array,
  length: number,
  field: string,
): void {
  if (value.length !== length) {
    throw new RangeError(`${field} must be exactly ${length} bytes`);
  }
}

export function publicKeyBytes(value: string | Uint8Array): Bytes32 {
  const bytes = typeof value === "string" ? bs58.decode(value) : value;
  assertLength(bytes, 32, "public key");
  return new Uint8Array(bytes);
}

export function zeroBytes(length: number): Uint8Array {
  return new Uint8Array(length);
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function encodeU8(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xff)
    throw new RangeError("u8 out of range");
  return Uint8Array.of(value);
}

export function encodeU32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff)
    throw new RangeError("u32 out of range");
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

export function encodeU64(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn)
    throw new RangeError("u64 out of range");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

export function encodeI64(value: bigint): Uint8Array {
  if (value < -0x8000_0000_0000_0000n || value > 0x7fff_ffff_ffff_ffffn) {
    throw new RangeError("i64 out of range");
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, value, true);
  return bytes;
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function bytesFromHex(
  value: string,
  expectedLength?: number,
): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(value))
    throw new TypeError("invalid hexadecimal string");
  const bytes = Uint8Array.from(
    value.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
  if (expectedLength !== undefined)
    assertLength(bytes, expectedLength, "hex value");
  return bytes;
}
