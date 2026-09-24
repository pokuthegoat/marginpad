import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadEnv, type Plugin } from 'vite'

/**
 * Serves the /api folder during `npm run dev`, so one command runs the site and its API together.
 * Each file in /api exports Web-standard handlers named after the HTTP method (GET, POST, ...), exactly the shape
 * Vercel runs in production, so what works here is what gets deployed.
 *
 * Route files: api/a/b.ts -> /api/a/b, api/a/index.ts -> /api/a, api/a/[name].ts -> /api/a/<anything>.
 */

const API_DIR = path.resolve(process.cwd(), 'api')

/** Find the file that serves this URL path, or null. */
function resolveRoute(pathname: string): string | null {
  const segments = pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean)
  const walk = (dir: string, rest: string[]): string | null => {
    if (rest.length === 0) {
      const index = path.join(dir, 'index.ts')
      return fs.existsSync(index) ? index : null
    }
    const [head, ...tail] = rest
    if (/^[\w.-]+$/.test(head)) {
      if (tail.length === 0) {
        const file = path.join(dir, `${head}.ts`)
        if (fs.existsSync(file)) return file
      }
      const sub = path.join(dir, head)
      if (fs.existsSync(sub) && fs.statSync(sub).isDirectory()) {
        const found = walk(sub, tail)
        if (found) return found
      }
    }
    // A single dynamic segment: [name].ts (last segment) or [name]/ (a folder)
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir)) {
        if (!/^\[[^\]]+\]/.test(entry)) continue
        const full = path.join(dir, entry)
        if (tail.length === 0 && entry.endsWith('.ts')) return full
        if (fs.statSync(full).isDirectory()) {
          const found = walk(full, tail)
          if (found) return found
        }
      }
    }
    return null
  }
  return walk(API_DIR, segments)
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

async function send(res: ServerResponse, response: Response) {
  res.statusCode = response.status
  response.headers.forEach((value, key) => res.setHeader(key, value))
  res.end(Buffer.from(await response.arrayBuffer()))
}

export function apiDevPlugin(): Plugin {
  return {
    name: 'marginpad-api-dev',
    configureServer(server) {
      // Server-only variables (PRIVY_APP_SECRET, TURSO_*) live in .env.local without a VITE_ prefix, so Vite keeps
      // them out of the browser bundle. Load them into process.env for the API handlers, as Vercel does in production.
      const env = loadEnv(server.config.mode, process.cwd(), '')
      for (const [key, value] of Object.entries(env)) if (process.env[key] === undefined) process.env[key] = value

      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith('/api/')) return next()
        try {
          const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
          const file = resolveRoute(url.pathname)
          if (!file) return await send(res, Response.json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, { status: 404 }))

          const mod = (await server.ssrLoadModule(file)) as Record<string, unknown>
          const handler = mod[(req.method ?? 'GET').toUpperCase()]
          if (typeof handler !== 'function') {
            return await send(res, Response.json({ error: { code: 'BAD_REQUEST', message: 'Method not allowed.' } }, { status: 405 }))
          }

          const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
          const headers = new Headers()
          for (const [key, value] of Object.entries(req.headers)) {
            if (Array.isArray(value)) value.forEach((v) => headers.append(key, v))
            else if (value !== undefined) headers.set(key, value)
          }
          const request = new Request(url, {
            method: req.method,
            headers,
            body: hasBody ? new Uint8Array(await readBody(req)) : undefined,
          })
          await send(res, (await (handler as (r: Request) => Promise<Response> | Response)(request)) as Response)
        } catch (e) {
          server.config.logger.error(`[api] ${String(e instanceof Error ? e.stack : e)}`)
          await send(res, Response.json({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } }, { status: 500 }))
        }
      })
    },
  }
}
