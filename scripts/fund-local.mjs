// Gives a wallet test ETH on the local Anvil chain (local chain only).
//   npm run chain:fund -- 0xYourWalletAddress [amountInEth]
import { chainId, rpc } from './env.mjs'

const [address, amount = '1000'] = process.argv.slice(2)
if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? '')) {
  console.error('Usage: npm run chain:fund -- 0xYourWalletAddress [amountInEth]')
  process.exit(1)
}
if ((await chainId()) !== 31337) {
  console.error('No local Anvil on http://127.0.0.1:8545. Start it first:  npm run chain')
  process.exit(1)
}
const wei = BigInt(Math.round(Number(amount) * 1e6)) * 10n ** 12n
await rpc('anvil_setBalance', [address, '0x' + wei.toString(16)])
console.log(`Set ${address} to ${amount} test ETH on local Anvil.`)
