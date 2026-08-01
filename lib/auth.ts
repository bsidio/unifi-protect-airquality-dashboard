/**
 * Single-account auth, entirely driven by .env:
 *
 *   AUTH_ENABLED=false -> the dashboard is public, no login screen
 *   AUTH_ENABLED=true  -> AUTH_USER / AUTH_PASSWORD gate every page
 *
 * The session is a signed cookie (HMAC-SHA256 via Web Crypto, so the same code
 * runs in middleware and in Node route handlers). No session store, no users
 * table — sign out is just deleting the cookie.
 */

export const SESSION_COOKIE = "aq_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  // Allocate a concrete ArrayBuffer so the result satisfies BufferSource.
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Timing-safe string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export async function createSession(username: string, secret: string): Promise<string> {
  const payload = b64url(
    new TextEncoder().encode(
      JSON.stringify({ u: username, exp: Date.now() + MAX_AGE_SECONDS * 1000 }),
    ),
  );
  const sig = await crypto.subtle.sign("HMAC", await key(secret), new TextEncoder().encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

export async function verifySession(token: string | undefined, secret: string): Promise<string | null> {
  if (!token || !secret) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await key(secret),
      fromB64url(sig),
      new TextEncoder().encode(payload),
    );
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    if (typeof data?.exp !== "number" || data.exp < Date.now()) return null;
    return typeof data.u === "string" ? data.u : null;
  } catch {
    return null;
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: MAX_AGE_SECONDS,
};
