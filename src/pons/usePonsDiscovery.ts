import { useEffect } from 'react'
import { getPonsDiscovery } from './discover'

/** Keep Pons discovery polling while the calling component (the Trade page) is mounted. It stops when nothing uses it. */
export function usePonsDiscovery() {
  useEffect(() => getPonsDiscovery().retain(), [])
}
