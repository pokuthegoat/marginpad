import { ensureAccount, updateProfile } from '../../server/accounts.js'
import { errorResponse, fromResult, ok, readJson, withAuth } from '../../server/api.js'

/** POST /api/account: first connect creates the account for this wallet; later connects load it. */
export async function POST(request: Request) {
  return withAuth(request, async ({ wallet, userId }) => ok(await ensureAccount(wallet, userId)))
}

/** PATCH /api/account: change username and/or display name (7-day shared cooldown, enforced server-side). */
export async function PATCH(request: Request) {
  return withAuth(request, async ({ wallet }) => {
    const body = await readJson(request)
    if (!body) return errorResponse('BAD_REQUEST', 'Invalid request.')
    return fromResult(await updateProfile(wallet, { username: body.username, displayName: body.displayName }))
  })
}
