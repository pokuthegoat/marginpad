import { usePrivy } from '@privy-io/react-auth'
import { PRIVY_APP_ID } from '../lib/config'

/** Connect Wallet. Falls back to a "Coming soon" placeholder when Privy isn't configured. */
export default function ConnectWallet() {
  if (!PRIVY_APP_ID) {
    return (
      <span className="btn btn-glass btn-sm btn-static" title="Wallet connection is not set up yet">
        Connect Wallet
        <span className="tag">Soon</span>
      </span>
    )
  }
  return <PrivyWalletButton />
}

// Rendered only inside <PrivyProvider> (see Providers.tsx), which is what makes usePrivy safe here.
function PrivyWalletButton() {
  const { ready, authenticated, user, login, logout } = usePrivy()

  const address = user?.wallet?.address
  const connected = ready && authenticated

  // Once connected the button is simply "Log out": one click logs out.
  const onClick = () => {
    if (!ready) return
    if (!authenticated) return login()
    void logout()
  }

  const label = connected ? 'Log out' : 'Connect Wallet'
  const title = connected
    ? address
      ? `Connected as ${address}. Click to log out`
      : 'Click to log out'
    : 'Connect your wallet'

  return (
    <button
      type="button"
      className="btn btn-primary btn-sm"
      disabled={!ready}
      aria-disabled={!ready}
      title={title}
      onClick={onClick}
    >
      {label}
    </button>
  )
}
