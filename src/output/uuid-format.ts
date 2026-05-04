/**
 * UUID formatting helpers — shared across all command renderers.
 *
 * Centralises the "shorten to first 8 chars + ellipsis" convention
 * that was previously inlined in `human.ts`'s Skills section.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Shorten a UUID string to its first 8 hex chars followed by `…`.
 * Returns the input unchanged when it doesn't look like a UUID.
 * Used in default (non-verbose) mode; `--verbose` passes the full UUID.
 */
export function shortId(id: string): string {
  return UUID_RE.test(id) ? `${id.slice(0, 8)}…` : id;
}
