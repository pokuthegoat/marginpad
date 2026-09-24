/**
 * The one canonical form of a wallet address, used by BOTH the server (as the account key) and the
 * browser (to tell whether loaded data belongs to the connected wallet).
 *
 * Wallet libraries hand back EVM addresses in mixed-case "checksum" form, while the server stores them
 * lowercase. Comparing the two raw strings never matches, so always normalise first.
 * EVM addresses are case-insensitive (lowercase them); other chains (e.g. Solana base58) are case-sensitive.
 */
export function normalizeWallet(address: string): string {
  const a = address.trim()
  return /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a
}
