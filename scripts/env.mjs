// Shared helpers for the local-development scripts.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

export const root = path.resolve(import.meta.dirname, '..')
export const RPC = 'http://127.0.0.1:8545'

/** Anvil's first dev account. Its key is public, so it is only ever used on the local chain. */
export const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

/** Environment with Foundry's default install folder on PATH, so `anvil` and `forge` are found. */
export function withFoundry() {
  const bin = path.join(os.homedir(), '.foundry', 'bin')
  const sep = path.delimiter
  const PATH = fs.existsSync(bin) ? `${bin}${sep}${process.env.PATH ?? ''}` : (process.env.PATH ?? '')
  return { ...process.env, PATH, Path: PATH }
}

export async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = await res.json()
  if (body.error) throw new Error(body.error.message)
  return body.result
}

export async function chainId() {
  try {
    return Number(BigInt(await rpc('eth_chainId')))
  } catch {
    return null
  }
}

export async function waitForAnvil(timeoutMs = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if ((await chainId()) === 31337) return
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('Anvil did not start on ' + RPC)
}
