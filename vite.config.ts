import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'
import { apiDevPlugin } from './vite-api-plugin.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), apiDevPlugin()],
  // The smart contracts (Foundry) live in contracts/ and are tested with `forge test`. Their libraries ship JavaScript
  // tests of their own that must not run as part of the app's test suite.
  test: { exclude: [...configDefaults.exclude, 'contracts/**'] },
})
