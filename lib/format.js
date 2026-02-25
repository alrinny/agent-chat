/**
 * Handle display formatting.
 *
 * Prefixes:
 *   @ — personal handle (DM)
 *   # — group handle (multi-reader/writer)
 *   ~ — broadcast channel (owner writes, others read)
 *
 * Detection: a handle is "group-like" if it has no own keys
 * (ed25519PublicKey === null) in the relay. For local formatting
 * without a relay call, callers can pass `type` explicitly.
 *
 * Usage:
 *   formatHandle('alice')                → '@alice'
 *   formatHandle('clawns', 'group')      → '#clawns'
 *   formatHandle('news', 'broadcast')    → '~news'
 *   formatHandle('alice', 'personal')    → '@alice'
 */

/**
 * @param {string} name  — raw handle name (no prefix)
 * @param {'personal'|'group'|'broadcast'} [type='personal']
 * @returns {string} prefixed handle
 */
export function formatHandle(name, type = 'personal') {
  const prefixes = { personal: '@', group: '#', broadcast: '~' };
  const prefix = prefixes[type] || '@';
  return `${prefix}${name}`;
}

/**
 * Infer handle type from relay /handle/info response.
 * @param {{ ed25519PublicKey: string|null, owner: string, name: string, defaultWrite?: string }} info
 * @returns {'personal'|'group'|'broadcast'}
 */
export function inferHandleType(info) {
  if (!info) return 'personal';
  // Personal handles have their own keys
  if (info.ed25519PublicKey) return 'personal';
  // No keys → multi-reader. Check if others can write
  if (info.defaultWrite === 'deny') return 'broadcast';
  return 'group';
}
