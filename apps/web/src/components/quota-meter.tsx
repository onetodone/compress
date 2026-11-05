import type { Quota } from '@onetodone/image-compressor-shared'

/** @param exhausted no jobs are left for another reason, e.g. the network limit */
export function QuotaMeter({ quota, exhausted = false }: { quota: Quota; exhausted?: boolean }) {
  const left = exhausted ? 0 : Math.max(quota.limit - quota.used, 0)
  const usedShare = exhausted ? 1 : Math.min(quota.used / quota.limit, 1)
  return (
    <div className="flex min-w-40 flex-col gap-1.5 text-right" aria-live="polite">
      <span className="text-sm">
        <span className="font-medium tabular-nums">{left}</span> of {quota.limit} images left today
      </span>
      <div
        role="meter"
        aria-label="Images used today"
        aria-valuemin={0}
        aria-valuemax={quota.limit}
        aria-valuenow={quota.limit - left}
        className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
      >
        <div
          className={`h-full rounded-full ${left === 0 ? 'bg-red-500' : 'bg-emerald-500'}`}
          style={{ width: `${usedShare * 100}%` }}
        />
      </div>
    </div>
  )
}
