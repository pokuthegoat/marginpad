// One command for the whole local MVP: Anvil + contract deployment + the frontend.
//   npm run local
import { spawn, spawnSync } from 'node:child_process'
import { chainId, root, waitForAnvil, withFoundry } from './env.mjs'

const children = []
const stop = () => {
  for (const c of children) c.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

if ((await chainId()) === 31337) {
  console.log('Using the Anvil already running on 127.0.0.1:8545 (contracts are redeployed on it).')
} else {
  console.log('Starting Anvil...')
  const anvil = spawn('anvil', ['--silent'], { env: withFoundry(), stdio: 'inherit', shell: process.platform === 'win32' })
  anvil.on('exit', (code) => {
    console.error(`Anvil exited (${code}).`)
    process.exit(code ?? 1)
  })
  children.push(anvil)
  await waitForAnvil()
}

const deploy = spawnSync('node', ['scripts/deploy-local.mjs'], { cwd: root, stdio: 'inherit' })
if (deploy.status !== 0) {
  stop()
}

console.log('\nFrontend: http://localhost:5173  (chain: Local Anvil, id 31337, RPC http://127.0.0.1:8545)')
console.log('Give your wallet test ETH:  npm run chain:fund -- 0xYourWalletAddress\n')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const dev = spawn(npm, ['run', 'dev'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
children.push(dev)
dev.on('exit', stop)
