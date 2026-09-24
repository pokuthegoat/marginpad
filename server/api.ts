import type { AccountDTO, ApiErrorBody, ApiErrorCode } from '../src/lib/account-types.js'
import type { ServiceResult } from './accounts.js'
import { AuthError, authenticate, type Authed } from './auth.js'

/** Small helpers shared by the account API routes. */

const NO_STORE = { 'Cache-Control': 'no-store' }

const STATUS: Record<ApiErrorCode, number> = {
  UNAUTHENTICATED: 401,
  NOT_CONFIGURED: 503,
  BAD_REQUEST: 400,
  INVALID_USERNAME: 400,
  INVALID_DISPLAY_NAME: 400,
  NO_CHANGES: 400,
  USERNAME_TAKEN: 409,
  SETUP_REQUIRED: 409,
  ALREADY_SET_UP: 409,
  COOLDOWN: 429,
  NOT_FOUND: 404,
  INTERNAL: 500,
}

export function ok(account: AccountDTO) {
  return Response.json({ account }, { headers: NO_STORE })
}

/** A 200 JSON response that must never be cached (per-account data). */
export function okJson(body: unknown) {
  return Response.json(body, { headers: NO_STORE })
}

export function errorResponse(code: ApiErrorCode, message: string, availableAt?: number) {
  const body: ApiErrorBody = { error: { code, message, ...(availableAt ? { availableAt } : {}) } }
  const headers: Record<string, string> = { ...NO_STORE }
  if (code === 'COOLDOWN' && availableAt) {
    headers['Retry-After'] = String(Math.max(1, Math.ceil((availableAt - Date.now()) / 1000)))
  }
  return Response.json(body, { status: STATUS[code], headers })
}

export function fromResult(result: ServiceResult) {
  return result.ok ? ok(result.account) : errorResponse(result.code, result.message, result.availableAt)
}

/** Parse a small JSON object body, or null if it's missing/oversized/malformed. */
export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text()
    if (text.length > 4096) return null
    const body: unknown = JSON.parse(text)
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Run a handler only for an authenticated wallet; map auth and unexpected failures to safe responses. */
export async function withAuth(request: Request, handler: (auth: Authed) => Response | Promise<Response>) {
  try {
    return await handler(await authenticate(request))
  } catch (e) {
    if (e instanceof AuthError) return errorResponse(e.code, e.message)
    console.error('[api/account]', e) // details stay in the server log, never in the response
    return errorResponse('INTERNAL', 'Something went wrong. Please try again.')
  }
}
