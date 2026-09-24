// Deploys every contract to the running local Anvil, then copies the addresses and ABIs into the frontend.
//   npm run chain:deploy
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { ANVIL_KEY, chainId, root, withFoundry } from './env.mjs'

if ((await chainId()) !== 31337) {
  console.error('No local Anvil on http://127.0.0.1:8545. Start it first:  npm run chain')
  process.exit(1)
}

const env = {
  ...withFoundry(),
  PRIVATE_KEY: ANVIL_KEY,
  RESERVE_ETH: '100000000000000000000', // 100 test ETH to pay trader profits
  WRITE_DEPLOYMENT: 'true',
}
const contracts = path.join(root, 'contracts')
const forge = (args) => spawnSync('forge', args, { cwd: contracts, env, stdio: 'inherit', shell: process.platform === 'win32' })

let r = forge(['build'])
if (r.status === 0) r = forge(['script', 'script/Deploy.s.sol', '--rpc-url', 'http://127.0.0.1:8545', '--broadcast'])
if (r.status !== 0) process.exit(r.status ?? 1)

const sync = spawnSync('node', ['scripts/sync-contracts.mjs'], { cwd: root, stdio: 'inherit' })
process.exit(sync.status ?? 0)
