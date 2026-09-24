import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react'
import { TOKENS, type Side } from './market'
import { createInitialState, reducer, type State } from './store'

interface Actions {
  open: (tokenId: string, side: Side, collateral: number, leverage: number) => void
  close: (id: number) => void
  deposit: (amount: number) => void
  withdraw: (amount: number) => void
  claim: () => void
  /** Demo control: jump a token's price by a fraction (0.1 = +10%). */
  nudge: (tokenId: string, pct: number) => void
}

interface Store {
  state: State
  actions: Actions
}

const StoreContext = createContext<Store | null>(null)

/** One shared, client-side mock state for every page. */
export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => createInitialState())

  // Mock price feed: a small random walk per token.
  useEffect(() => {
    const timer = setInterval(() => {
      const noise: Record<string, number> = {}
      for (const t of TOKENS) noise[t.id] = (Math.random() - 0.5) * t.vol
      dispatch({ type: 'TICK', noise, at: Date.now() })
    }, 1500)
    return () => clearInterval(timer)
  }, [])

  const actions = useMemo<Actions>(
    () => ({
      open: (tokenId, side, collateral, leverage) =>
        dispatch({ type: 'OPEN', tokenId, side, collateral, leverage, at: Date.now() }),
      close: (id) => dispatch({ type: 'CLOSE', id, at: Date.now() }),
      deposit: (amount) => dispatch({ type: 'DEPOSIT', amount, at: Date.now() }),
      withdraw: (amount) => dispatch({ type: 'WITHDRAW', amount, at: Date.now() }),
      claim: () => dispatch({ type: 'CLAIM', at: Date.now() }),
      nudge: (tokenId, pct) => dispatch({ type: 'NUDGE', tokenId, pct, at: Date.now() }),
    }),
    [],
  )

  const value = useMemo(() => ({ state, actions }), [state, actions])
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useStore() {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used inside <StoreProvider>')
  return ctx
}
