import type { CSSProperties } from 'react'

interface SegmentedProps<T extends string> {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  label: string
  /** Colors the thumb, e.g. green for long and red for short */
  tone?: (v: T) => 'long' | 'short' | undefined
}

/** iOS-style segmented control with a sliding thumb. */
export function Segmented<T extends string>({ value, options, onChange, label, tone }: SegmentedProps<T>) {
  const index = Math.max(0, options.findIndex((o) => o.value === value))
  return (
    <div
      className="seg"
      role="group"
      aria-label={label}
      style={{ '--n': options.length, '--i': index } as CSSProperties}
    >
      <span className="seg-thumb" data-tone={tone?.(value)} aria-hidden="true" />
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

interface SliderProps {
  id: string
  min: number
  max: number
  step: number
  value: number
  onChange: (v: number) => void
  valueText: string
}

/** iOS-style slider: thin filled track, round white thumb. */
export function Slider({ id, min, max, step, value, onChange, valueText }: SliderProps) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0
  return (
    <input
      id={id}
      className="slider"
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      aria-valuetext={valueText}
      style={{ '--p': `${pct}%` } as CSSProperties}
    />
  )
}

/** A label/value row inside a `.group` list. */
export function Row({ label, value, tone, strong }: { label: string; value: string; tone?: 'gain' | 'loss'; strong?: boolean }) {
  return (
    <div className={strong ? 'strong' : undefined}>
      <dt>{label}</dt>
      <dd className={tone ? `num ${tone}` : 'num'}>{value}</dd>
    </div>
  )
}
