import type { ApiErrorCode } from '../../lib/account-types'

/** An error from the account API (or the network) with a machine-readable code. */
export class ApiError extends Error {
  code: ApiErrorCode | 'NETWORK'
  /** For COOLDOWN: epoch ms when the change unlocks. */
  availableAt?: number

  constructor(code: ApiErrorCode | 'NETWORK', message: string, availableAt?: number) {
    super(message)
    this.code = code
    this.availableAt = availableAt
  }
}
