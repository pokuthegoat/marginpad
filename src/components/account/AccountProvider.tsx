import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { usePrivy } from '@privy-io/react-auth'
import type { AccountDTO, ApiErrorBody } from '../../lib/account-types'
import { normalizeWallet } from '../../lib/wallet'
import { ApiError } from './api-error'
import { UsernameModal } from './UsernameModal'

/**
 * Client-side view of the Marginpad account. Everything authoritative lives on the server: this only mirrors what
 * the API returns, and every mutation goes back through the API, which re-checks ownership, validation and the
 * name cooldown.
 *
 * ACCOUNT ISOLATION: everything held here is tagged with the wallet it belongs to and is only exposed while that
 * same wallet is the connected one. So after a logout or a switch to another account, the previous account's data
 * is never visible, not even for a single render while the new one loads.
 */

export type AccountStatus = 'signed-out' | 'loading' | 'ready' | 'error'

interface AccountContextValue {
  status: AccountStatus
  account: AccountDTO | null
  error: string | null
  retry: () => void
  chooseUsername: (username: string) => Promise<void>
  updateNames: (input: { username?: string; displayName?: string }) => Promise<void>
  /** Upload a new profile picture (JPEG/PNG/WebP up to 2 MB; the server re-checks both). */
  uploadAvatar: (file: File) => Promise<void>
  /** Remove the profile picture, reverting to the initial-letter default. */
  removeAvatar: () => Promise<void>
}

const signedOut: AccountContextValue = {
  status: 'signed-out',
  account: null,
  error: null,
  retry: () => {},
  chooseUsername: async () => {
    throw new ApiError('UNAUTHENTICATED', 'Connect your wallet first.')
  },
  updateNames: async () => {
    throw new ApiError('UNAUTHENTICATED', 'Connect your wallet first.')
  },
  uploadAvatar: async () => {
    throw new ApiError('UNAUTHENTICATED', 'Connect your wallet first.')
  },
  removeAvatar: async () => {
    throw new ApiError('UNAUTHENTICATED', 'Connect your wallet first.')
  },
}

const AccountContext = createContext<AccountContextValue>(signedOut)

/** Safe anywhere: outside the provider (e.g. Privy not configured) it reports "signed-out". */
// eslint-disable-next-line react-refresh/only-export-components
export const useAccount = () => useContext(AccountContext)

interface State {
  /** The wallet this state was loaded for. */
  wallet: string | null
  status: AccountStatus
  account: AccountDTO | null
  error: string | null
}

const NETWORK_MESSAGE = "Couldn't reach Marginpad. Check your connection and try again."

export function AccountProvider({ children }: { children: ReactNode }) {
  const { ready, authenticated, user, getAccessToken, logout } = usePrivy()
  // Normalised, so it compares equal to the server's copy (account.walletAddress). The raw address from
  // the wallet library is mixed-case, the server's is lowercase; comparing those raw never matches.
  const rawAddress = ready && authenticated ? (user?.wallet?.address ?? null) : null
  const address = rawAddress ? normalizeWallet(rawAddress) : null

  const [state, setState] = useState<State>({ wallet: null, status: 'loading', account: null, error: null })
  const [attempt, setAttempt] = useState(0)

  // Privy's function identities aren't guaranteed stable; keep the latest in a ref.
  const tokenRef = useRef(getAccessToken)
  tokenRef.current = getAccessToken

  /** Authenticated API call for the connected wallet. Returns the parsed JSON body. */
  const request = useCallback(
    async <T,>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<T> => {
      const token = await tokenRef.current()
      if (!token || !address) throw new ApiError('UNAUTHENTICATED', 'Reconnect your wallet and try again.')

      let res: Response
      try {
        res = await fetch(path, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Wallet-Address': address,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          cache: 'no-store',
        })
      } catch {
        throw new ApiError('NETWORK', NETWORK_MESSAGE)
      }

      const data = (await res.json().catch(() => null)) as (Partial<ApiErrorBody> & Record<string, unknown>) | null
      if (!res.ok || !data) {
        const e = data?.error
        throw new ApiError(e?.code ?? 'INTERNAL', e?.message ?? 'Something went wrong. Please try again.', e?.availableAt)
      }
      return data as T
    },
    [address],
  )

  // Wallet connected, switched or disconnected -> create/load the account for THAT wallet.
  useEffect(() => {
    if (!ready) return
    if (!address) {
      setState({ wallet: null, status: 'signed-out', account: null, error: null })
      return
    }
    let cancelled = false
    setState((s) => ({
      wallet: address,
      status: 'loading',
      account: s.wallet === address ? s.account : null,
      error: null,
    }))
    request<{ account: AccountDTO }>('/api/account', 'POST')
      .then(({ account }) => !cancelled && setState({ wallet: address, status: 'ready', account, error: null }))
      .catch((e: Error) => !cancelled && setState({ wallet: address, status: 'error', account: null, error: e.message }))
    return () => {
      cancelled = true
    }
  }, [ready, address, request, attempt])

  const chooseUsername = useCallback(
    async (username: string) => {
      const { account } = await request<{ account: AccountDTO }>('/api/account/setup', 'POST', { username })
      setState({ wallet: account.walletAddress, status: 'ready', account, error: null })
    },
    [request],
  )

  const updateNames = useCallback(
    async (input: { username?: string; displayName?: string }) => {
      try {
        const { account } = await request<{ account: AccountDTO }>('/api/account', 'PATCH', input)
        setState({ wallet: account.walletAddress, status: 'ready', account, error: null })
      } catch (e) {
        // The server is the authority on the cooldown; if it says we're locked, reflect that.
        if (e instanceof ApiError && e.code === 'COOLDOWN' && e.availableAt) {
          const availableAt = e.availableAt
          setState((s) => (s.account ? { ...s, account: { ...s.account, nameChangeAvailableAt: availableAt } } : s))
        }
        throw e
      }
    },
    [request],
  )

  // Not routed through `request` (which always sends JSON): the browser must set its own multipart boundary in
  // Content-Type when the body is a FormData, so nothing here sets Content-Type at all.
  const uploadAvatar = useCallback(
    async (file: File) => {
      const token = await tokenRef.current()
      if (!token || !address) throw new ApiError('UNAUTHENTICATED', 'Reconnect your wallet and try again.')
      const form = new FormData()
      form.append('avatar', file)
      let res: Response
      try {
        res = await fetch('/api/account/avatar', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'X-Wallet-Address': address },
          body: form,
          cache: 'no-store',
        })
      } catch {
        throw new ApiError('NETWORK', NETWORK_MESSAGE)
      }
      const data = (await res.json().catch(() => null)) as (Partial<ApiErrorBody> & { account?: AccountDTO }) | null
      if (!res.ok || !data?.account) {
        const e = data?.error
        throw new ApiError(e?.code ?? 'INTERNAL', e?.message ?? 'Something went wrong. Please try again.', e?.availableAt)
      }
      setState({ wallet: data.account.walletAddress, status: 'ready', account: data.account, error: null })
    },
    [address],
  )

  const removeAvatar = useCallback(async () => {
    const { account } = await request<{ account: AccountDTO }>('/api/account/avatar', 'DELETE')
    setState({ wallet: account.walletAddress, status: 'ready', account, error: null })
  }, [request])

  // What the rest of the app sees: only ever the account of the wallet that is connected right now.
  const view: State = !ready
    ? { wallet: null, status: 'loading', account: null, error: null }
    : !address
      ? { wallet: null, status: 'signed-out', account: null, error: null }
      : state.wallet === address
        ? state
        : { wallet: address, status: 'loading', account: null, error: null }

  const value = useMemo<AccountContextValue>(
    () => ({
      status: view.status,
      account: view.account,
      error: view.error,
      retry: () => setAttempt((n) => n + 1),
      chooseUsername,
      updateNames,
      uploadAvatar,
      removeAvatar,
    }),
    [view.status, view.account, view.error, chooseUsername, updateNames, uploadAvatar, removeAvatar],
  )

  const needsUsername = view.status === 'ready' && view.account !== null && !view.account.setupComplete

  return (
    <AccountContext.Provider value={value}>
      {children}
      {needsUsername && <UsernameModal onSubmit={chooseUsername} onDisconnect={() => void logout()} />}
    </AccountContext.Provider>
  )
}
