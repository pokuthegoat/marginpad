// Runs the chain integration test against the local Anvil that `npm run local` (or npm run chain + chain:deploy) set up.
import { spawnSync } from 'node:child_process'
import { root } from './env.mjs'

const r = spawnSync('npx', ['vitest', 'run', 'src/chain'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, CHAIN_TEST: '1' },
})
process.exit(r.status ?? 1)
