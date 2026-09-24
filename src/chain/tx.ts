import { BaseError, decodeErrorResult, type Abi, type Address, type Hash, type Hex, type WalletClient } from 'viem'
import { marginPoolAbi, marginTradingAbi, priceOracleAbi, riskManagerAbi } from './abis'
import { TARGET_CHAIN } from './config'
import { publicClient } from './read'

export interface WriteRequest {
  address: Address
  abi: Abi
  functionName: string
  args?: readonly unknown[]
  value?: bigint
}

/** Plain-language reasons for the contract's custom errors. Anything else falls back to viem's own message. */
const REASONS: Record<string, string> = {
  StalePrice: 'The oracle price is out of date. Ask the testnet oracle operator to push a new price.',
  NoPrice: 'This market has no oracle price yet.',
  MarketDisabled: 'This market is not enabled.',
  LeverageTooHigh: 'That leverage is above the market maximum.',
  LeverageTooLow: 'Leverage must be at least 1x.',
  MarketBorrowCapExceeded: 'This market has reached its borrow cap. Lower your amount or leverage.',
  PoolUtilizationCapExceeded: 'The pool would go over 90% utilization. Lower your amount or leverage.',
  ExceedsUtilizationCap: 'The pool has to stay under 90% utilization.',
  BelowMinimumCollateral: 'The minimum collateral is 0.01 ETH.',
  BelowMinimumDeposit: 'The minimum deposit is 0.01 ETH.',
  InsufficientLiquidity: 'Not enough un-lent ETH in the pool for that withdrawal.',
  InsufficientShares: 'You do not have that much deposited.',
  NothingToClaim: 'There are no rewards to claim yet.',
  NotLiquidatable: 'This position is not past its liquidation price.',
  PositionNotOpen: 'This position is already closed.',
  NotPositionOwner: 'Only the position owner can close it.',
  EnforcedPause: 'The contracts are paused.',
  OwnableUnauthorizedAccount: 'Only the testnet oracle operator can do that.',
}

/**
 * Errors raised by contracts MarginTrading calls (RiskManager, the pool) are not in MarginTrading's own ABI, so decode
 * revert data against every contract's errors.
 */
const ERROR_ABI = [marginPoolAbi, marginTradingAbi, riskManagerAbi, priceOracleAbi].flatMap((a) => a.filter((x) => x.type === 'error')) as Abi

export function describeError(e: unknown): string {
  if (e instanceof BaseError) {
    if (e.walk((x) => (x as { name?: string }).name === 'UserRejectedRequestError')) {
      return 'You cancelled the transaction in your wallet.'
    }
    const raw = e.walk((x) => typeof (x as { data?: unknown }).data === 'string' && (x as { data: string }).data.startsWith('0x'))
    if (raw) {
      try {
        const { errorName } = decodeErrorResult({ abi: ERROR_ABI, data: (raw as unknown as { data: Hex }).data })
        return REASONS[errorName] ?? `The contract rejected this: ${errorName}.`
      } catch {
        // not a known contract error: fall through to viem's message
      }
    }
    return e.shortMessage
  }
  if (typeof e === 'object' && e !== null && (e as { code?: number }).code === 4001) {
    return 'You cancelled the transaction in your wallet.'
  }
  return e instanceof Error ? e.message : 'Something went wrong.'
}

/**
 * Simulate first (so a failing call shows the contract's own reason instead of a gas error), then send.
 * Returns the transaction hash; the caller waits for the receipt.
 */
export async function submit(wc: WalletClient, req: WriteRequest): Promise<Hash> {
  const account = wc.account
  if (!account) throw new Error('No wallet account.')
  await publicClient.simulateContract({ ...req, account } as never)
  return wc.writeContract({ ...req, account, chain: TARGET_CHAIN } as never)
}
