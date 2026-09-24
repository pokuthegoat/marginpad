import { useMemo } from 'react'
import { useWallets } from '@privy-io/react-auth'
import { createWalletClient, custom, type Address, type WalletClient } from 'viem'
import { PRIVY_APP_ID } from '../lib/config'
import { TARGET_CHAIN } from './config'

export interface WalletAccess {
  /** The connected EVM wallet, if any */
  address?: Address
  /** A viem client that signs with the user's wallet, switched to the target testnet */
  getWalletClient?: () => Promise<WalletClient>
}

const NONE: WalletAccess = {}

/** Reuses the existing Privy wallet connection. Must only run inside <PrivyProvider>. */
function usePrivyWallet(): WalletAccess {
  const { wallets } = useWallets()
  const wallet = wallets[0]
  return useMemo(() => {
    if (!wallet) return NONE
    const address = wallet.address as Address
    return {
      address,
      getWalletClient: async () => {
        await wallet.switchChain(TARGET_CHAIN.id)
        const provider = await wallet.getEthereumProvider()
        return createWalletClient({ account: address, chain: TARGET_CHAIN, transport: custom(provider) })
      },
    }
  }, [wallet])
}

const useNoWallet = (): WalletAccess => NONE

// PRIVY_APP_ID is fixed at build time, so exactly one of these is ever used and hook order never changes.
export const useWalletAccess: () => WalletAccess = PRIVY_APP_ID ? usePrivyWallet : useNoWallet
