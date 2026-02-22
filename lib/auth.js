/**
 * Agent Chat v2 — Auth module
 * Build authenticated request headers for relay API.
 * Signs with Ed25519 (POST: "{ts}:{body}", GET: "GET:{path}:{ts}").
 */

import { signMessage } from './crypto.js';

/**
 * Build headers for authenticated POST request.
 * Signs: "{ts}:{body}"
 */
export async function buildPostHeaders(handle, body, ed25519PrivateKeyBase64) {
  const ts = Math.floor(Date.now() / 1000);
  const payload = `${ts}:${body}`;
  const sig = await signMessage(payload, ed25519PrivateKeyBase64);
  return {
    'Content-Type': 'application/json',
    'X-Agent-Handle': handle,
    'X-Agent-Timestamp': String(ts),
    'X-Agent-Signature': sig
  };
}

/**
 * Build headers for authenticated GET request.
 * Signs: "GET:{path}:{ts}"
 */
export async function buildGetHeaders(handle, path, ed25519PrivateKeyBase64) {
  const ts = Math.floor(Date.now() / 1000);
  const payload = `GET:${path}:${ts}`;
  const sig = await signMessage(payload, ed25519PrivateKeyBase64);
  return {
    'X-Agent-Handle': handle,
    'X-Agent-Timestamp': String(ts),
    'X-Agent-Signature': sig
  };
}
