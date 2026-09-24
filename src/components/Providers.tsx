import type { ReactNode } from 'react'
import { PrivyProvider } from '@privy-io/react-auth'
import { PRIVY_APP_ID } from '../lib/config'
import { AccountProvider } from './account/AccountProvider'

/**
 * App-wide client providers.
 *
 * Privy is configured for external-wallet login only: no embedded wallets are created and no chain / network is
 * chosen here. Those are separate product decisions for later.
 */
export default function Providers({ children }: { children: ReactNode }) {
  // Without an App ID, skip Privy entirely so the site behaves exactly as before.
  if (!PRIVY_APP_ID) return <>{children}</>

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ['wallet'],
        appearance: { theme: 'dark', accentColor: '#1d4ed8', showWalletLoginFirst: true },
      }}
    >
      <AccountProvider>{children}</AccountProvider>
    </PrivyProvider>
  )
}
