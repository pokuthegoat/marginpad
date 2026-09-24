# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.

## Deploying to Vercel (testnet only)

**This is NOT mainnet and NOT ready for real user funds.** It is an unaudited testnet MVP with a centralized,
owner-controlled price oracle. Use test ETH only.

**A. Project setup.** Import the Git repo in Vercel. Framework preset: *Vite* (auto-detected). Every file the app needs must be
committed, including `src/chain/` (generated ABIs and `deployments.json`).

**B. Build command:** `npm run build` (type-checks, then builds). **C. Output directory:** `dist`. Install command: the default
(`npm install`). `vercel.json` rewrites every non-`/api` path to `index.html`, so `/trade`, `/pool` and `/dashboard` work on a
direct visit or refresh.

**D. Environment variables** (Project Settings → Environment Variables; see `.env.example`):

| Variable | Public? | Value |
|---|---|---|
| `VITE_PRIVY_APP_ID` | yes | your Privy App ID |
| `VITE_CHAIN_ID` | yes | `46630` (Robinhood Chain Testnet). **Required in production**: there is no default and no fallback. |
| `VITE_RPC_URL` | yes, optional | an https RPC URL to replace the rate-limited public RPC |
| `PRIVY_APP_SECRET` | **secret** | your Privy App Secret (server-only, never `VITE_`) |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | **secret** | production database for accounts |

Never put a private key in any variable, and never use the `VITE_` prefix for a secret. Redeploy after changing any `VITE_` value
(they are baked in at build time).

**E. Privy.** In the Privy dashboard → your app → Settings → Domains / Allowed origins, add your production origin (for example
`https://marginpad.vercel.app` and any custom domain). Without it Privy fails with "Origin not allowed".

**F. Target testnet.** The frontend needs the deployed contract addresses in `src/chain/deployments.json`. Deploy from your own
machine with a funded throwaway testnet wallet (see `BLOCKCHAIN.md`), run `npm run contracts:sync`, then commit
`src/chain/deployments.json` and redeploy. Until then the site loads but shows that the contracts are not deployed.
Local development is unchanged: `npm run local` (Local Anvil, chain 31337, never used in production builds).
