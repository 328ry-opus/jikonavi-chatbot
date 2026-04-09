/**
 * Authentication utilities — timing-safe comparison & HMAC signing
 */

const encoder = new TextEncoder();

/**
 * Timing-safe string comparison using HMAC.
 * Computes HMAC of both inputs with a random key, then compares byte-by-byte.
 * This prevents timing attacks that exploit early-exit in normal === comparison.
 */
export async function timingSafeEqual(
  a: string,
  b: string,
): Promise<boolean> {
  const keyData = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const [sigA, sigB] = await Promise.all([
    crypto.subtle.sign("HMAC", key, encoder.encode(a)),
    crypto.subtle.sign("HMAC", key, encoder.encode(b)),
  ]);
  const arrA = new Uint8Array(sigA);
  const arrB = new Uint8Array(sigB);
  if (arrA.length !== arrB.length) return false;
  let result = 0;
  for (let i = 0; i < arrA.length; i++) result |= arrA[i] ^ arrB[i];
  return result === 0;
}

/**
 * Generate HMAC-SHA256 signature for webhook payloads.
 * Used by Edge Functions when calling GAS webhooks.
 */
export async function generateHmacSignature(
  payload: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
