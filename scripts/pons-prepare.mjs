// READ-ONLY. Picks the initial Pons markets for a Marginpad deployment and verifies each one against Pons on Robinhood Chain
// mainnet. It sends no transaction and needs no key.
//
//   npm run pons:prepare                      choose eligible markets (before deploying)
//   npm run pons:prepare -- --from-artifact   rewrite the frontend/keeper registry from the DEPLOYED artifact's initialMarkets
//                                             (contracts/deployments/4663.json), so it can never differ from what is registered
//
// The eligibility rules are NOT defined here. They are the shared rules in src/pons/eligibility.ts, the same code the /trade page
// uses for automatic discovery, so the script and the app can never disagree:
//   - the Pons V2 factory confirms the launch (token, curve and pair token match)
//   - ETH-quoted, 18-decimals ERC-20, the curve belongs to the token
//   - not graduated, and a valid current curve price
//   - at least PONS_MIN_AGE_SECONDS old (default 3600) and below PONS_MAX_GRADUATION_PROGRESS (default 0.5) of graduation
//   - does not impersonate a well-known asset (USDT, USDC, ...) and has a unique symbol
//
// Output: the list, a ready-to-use INITIAL_MARKETS=... line for the deploy script, and src/chain/pons-markets.mainnet.json
// (what the frontend and the keeper read). It prints only public addresses.
import fs from 'node:fs'
import path from 'node:path'
import { createPublicClient, formatUnits, http } from 'viem'
import { DEFAULT_RULES, describeLaunch, findEligible } from '../src/pons/eligibility.ts'
import { root } from './env.mjs'

const PONS_RPC = process.env.PONS_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'
const COUNT = Number(process.env.PONS_MARKETS ?? 4)
const rules = {
  ...DEFAULT_RULES,
  minAgeSeconds: Number(process.env.PONS_MIN_AGE_SECONDS ?? DEFAULT_RULES.minAgeSeconds),
  maxGraduationProgress: Number(process.env.PONS_MAX_GRADUATION_PROGRESS ?? DEFAULT_RULES.maxGraduationProgress),
}

const client = createPublicClient({
  chain: { id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [PONS_RPC] } } },
  transport: http(PONS_RPC, { retryCount: 2 }),
})
if ((await client.getChainId()) !== 4663) {
  console.error(`RPC ${PONS_RPC} is not chain 4663.`)
  process.exit(1)
}
const out = path.join(root, 'src/chain/pons-markets.mainnet.json')

if (process.argv.includes('--from-artifact')) {
  const art = JSON.parse(fs.readFileSync(path.join(root, 'contracts/deployments/4663.json'), 'utf8'))
  const markets = []
  for (const token of art.initialMarkets ?? []) {
    // Every registered market must still be a real Pons V2 launch (admission rules are not re-applied to what is already registered).
    const info = await describeLaunch(client, token)
    if (!info) {
      console.error(`${token} is not a Pons V2 launch. Refusing.`)
      process.exit(1)
    }
    markets.push({ token, curve: info.curve, name: info.name, symbol: info.symbol, initialPrice: Number(formatUnits(info.dynamic.price ?? 0n, 18)) })
  }
  fs.writeFileSync(out, JSON.stringify({ chainId: 4663, note: 'Generated from the deployment artifact initialMarkets.', markets }, null, 2) + '\n')
  console.log(`wrote ${path.relative(root, out)} from the artifact: ${markets.map((m) => m.symbol).join(', ')}`)
  process.exit(0)
}

const { picked, rejected } = await findEligible(client, { count: COUNT, rules })
if (picked.length === 0) {
  console.error('No eligible Pons launches found. Rejections:', rejected)
  process.exit(1)
}

const now = Number((await client.getBlock()).timestamp)
console.log(`Eligible Pons markets (${picked.length}), verified on chain 4663 just now:`)
for (const m of picked) {
  console.log(
    `  ${m.info.symbol.padEnd(10)} token ${m.raw.token}  curve ${m.raw.curve}  price ${formatUnits(m.dynamic.price, 18)} ETH  graduation ${(m.dynamic.progress * 100).toFixed(1)}%  age ${Math.round((now - m.info.launchedAt) / 60)} min`,
  )
}
console.log('Rejected while searching:', rejected)

fs.writeFileSync(
  out,
  JSON.stringify(
    {
      chainId: 4663,
      generatedAt: new Date(now * 1000).toISOString(),
      note: 'Pons V2 launches verified read-only against the Pons factory. Register exactly these with INITIAL_MARKETS at deploy.',
      markets: picked.map((m) => ({ token: m.raw.token, curve: m.raw.curve, name: m.info.name, symbol: m.info.symbol, initialPrice: Number(formatUnits(m.dynamic.price, 18)) })),
    },
    null,
    2,
  ) + '\n',
)
console.log(`\nwrote ${path.relative(root, out)}`)
console.log(`\nINITIAL_MARKETS=${picked.map((m) => m.raw.token).join(',')}`)
