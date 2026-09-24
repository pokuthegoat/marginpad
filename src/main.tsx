import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import '@fontsource-variable/dm-sans'
import '@fontsource/geist/700.css'
import './index.css'
import App from './App.tsx'
import Trade from './trade/Trade.tsx'
import Pool from './pool/Pool.tsx'
import Dashboard from './dashboard/Dashboard.tsx'
import Shell from './components/Shell.tsx'
import { StoreProvider } from './store/StoreContext.tsx'
import Providers from './components/Providers.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers>
      <StoreProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<Shell />}>
              <Route path="/" element={<App />} />
              <Route path="/trade" element={<Trade />} />
              <Route path="/pool" element={<Pool />} />
              <Route path="/dashboard" element={<Dashboard />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </StoreProvider>
    </Providers>
  </StrictMode>,
)
