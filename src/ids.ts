function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function format(bytes: Uint8Array): string {
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uuidv4(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return format(bytes);
}

let lastMs = -1;
let sequence = 0;

/**
 * RFC 9562 UUIDv7 with the monotonic-counter method: `rand_a` holds a 12-bit
 * sequence so ids minted inside one millisecond still sort in creation order.
 * See docs/DEVELOPMENT.md for why the seed leaves counter headroom.
 */
export function uuidv7(): string {
  const now = Date.now();
  if (now > lastMs) {
    lastMs = now;
    sequence = randomBytes(1)[0] & 0x3f;
  } else {
    sequence += 1;
    if (sequence > 0xfff) {
      lastMs += 1;
      sequence = 0;
    }
  }

  const bytes = randomBytes(16);
  let ms = lastMs;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = 0x70 | (sequence >> 8);
  bytes[7] = sequence & 0xff;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return format(bytes);
}

/** W3C Trace Context trace-id: 16 random bytes, 32 lowercase hex. */
export function newTraceId(): string {
  return toHex(randomBytes(16));
}

/** W3C Trace Context span-id: 8 random bytes, 16 lowercase hex. */
export function newSpanId(): string {
  return toHex(randomBytes(8));
}
