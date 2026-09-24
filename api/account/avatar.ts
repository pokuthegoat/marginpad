import { getAccount } from '../../server/accounts.js'
import { errorResponse, okJson, withAuth } from '../../server/api.js'
import { AVATAR_MAX_BYTES, removeAvatar, setAvatar } from '../../server/avatars.js'

/**
 * POST /api/account/avatar: upload a profile picture (multipart/form-data, field "avatar").
 * DELETE /api/account/avatar: remove it, reverting to the initial-letter default.
 *
 * Both answer with the account's fresh AccountDTO (avatarVersion moved), the same shape /api/account already
 * returns, so the browser doesn't need a separate fetch to pick up the new picture.
 */

export async function POST(request: Request) {
  return withAuth(request, async ({ wallet }) => {
    // A fast rejection before reading the whole body: real multipart overhead is small, so this catches an
    // obviously-oversized upload without buffering it first. setAvatar re-checks the real file size regardless.
    const declared = Number(request.headers.get('content-length') ?? '0')
    if (declared > AVATAR_MAX_BYTES * 2) return errorResponse('BAD_REQUEST', 'Images must be 2 MB or smaller.')

    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return errorResponse('BAD_REQUEST', 'Invalid upload.')
    }
    const file = form.get('avatar')
    if (!(file instanceof File)) return errorResponse('BAD_REQUEST', 'No image file given.')

    const bytes = new Uint8Array(await file.arrayBuffer())
    const res = await setAvatar(wallet, bytes)
    if (!res.ok) return errorResponse(res.code, res.message)
    return okJson({ account: await getAccount(wallet) })
  })
}

export async function DELETE(request: Request) {
  return withAuth(request, async ({ wallet }) => {
    const res = await removeAvatar(wallet)
    if (!res.ok) return errorResponse(res.code, res.message)
    return okJson({ account: await getAccount(wallet) })
  })
}
