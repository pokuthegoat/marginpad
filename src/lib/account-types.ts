/** Shapes shared by the API and the browser. */

export interface AccountDTO {
  walletAddress: string
  /** null until the user has chosen a username (account setup incomplete). */
  username: string | null
  displayName: string | null
  setupComplete: boolean
  /** Epoch ms of the last username/display-name change, or null if never changed. */
  nameChangedAt: number | null
  /** Epoch ms when names can be changed again; null when changing is allowed now. */
  nameChangeAvailableAt: number | null
  createdAt: number
  /** 0 = no profile picture uploaded (show the initial-letter default). Bumps on every upload/removal; put it in the
   * avatar's own URL as a cache-buster (see avatarUrl in src/lib/avatar.ts) so a changed picture is never served stale. */
  avatarVersion: number
}

export type ApiErrorCode =
  | 'UNAUTHENTICATED'
  | 'NOT_CONFIGURED'
  | 'BAD_REQUEST'
  | 'INVALID_USERNAME'
  | 'INVALID_DISPLAY_NAME'
  | 'USERNAME_TAKEN'
  | 'COOLDOWN'
  | 'NO_CHANGES'
  | 'SETUP_REQUIRED'
  | 'ALREADY_SET_UP'
  | 'NOT_FOUND'
  | 'INTERNAL'

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; availableAt?: number }
}
