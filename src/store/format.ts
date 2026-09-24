export function fmtEth(n: number) {
  const v = Math.abs(n) < 0.00005 ? 0 : n
  return `${v.toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) >= 100 ? 2 : 4 })} ETH`
}

export function fmtSignedEth(n: number) {
  return `${n > 0 ? '+' : ''}${fmtEth(n)}`
}

export function fmtPct(n: number) {
  return `${(n * 100).toFixed(n < 0.1 ? 2 : 1)}%`
}

export function fmtCompact(n: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(n)
}

/** Token price in USD */
export function fmtPrice(p: number) {
  if (p >= 1) return `$${p.toFixed(2)}`
  return `$${p.toPrecision(3)}`
}

export const floor4 = (n: number) => Math.floor(n * 10_000 + 1e-9) / 10_000

export const fmtTime = (t: number) =>
  new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
