import { NETWORK_ERROR } from './config'
import { useStore } from '../store/StoreContext'

/** One line under a page title when the chain is not ready, or no wallet is connected. Uses the existing notice style. */
export default function ChainNotice() {
  const { chain } = useStore()
  let text: string | null = null
  if (NETWORK_ERROR) {
    text = `Network configuration error: ${NETWORK_ERROR}`
  } else if (chain.status === 'no-deployment') {
    text = `The Marginpad contracts are not deployed on ${chain.chainName} yet, so there is nothing to trade or deposit into.`
  } else if (chain.status === 'error') {
    text = `Can't reach ${chain.chainName} right now. Retrying…`
  } else if (!chain.connected) {
    text = `Connect your wallet to use ${chain.chainName}. Testnet ETH only, no real funds.`
  }
  if (!text) return null
  return (
    <p className="notice info" role="status">
      {text}
    </p>
  )
}
