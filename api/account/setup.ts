import { completeSetup } from '../../server/accounts.js'
import { errorResponse, fromResult, readJson, withAuth } from '../../server/api.js'

/** POST /api/account/setup: choose the first username (also becomes the display name). */
export async function POST(request: Request) {
  return withAuth(request, async ({ wallet }) => {
    const body = await readJson(request)
    if (!body) return errorResponse('BAD_REQUEST', 'Invalid request.')
    return fromResult(await completeSetup(wallet, body.username))
  })
}
