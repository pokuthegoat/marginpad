import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { apiDevPlugin } from './vite-api-plugin.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), apiDevPlugin()],
})
