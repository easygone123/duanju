'use client'

import { useTranslations } from 'next-intl'

const ANALYSIS_STAGES = ['upload', 'probe', 'frames', 'shots', 'report'] as const

export default function ViralReplicationProgress({
  status,
  progress = 0,
}: {
  status: 'analyzing' | 'generating'
  progress?: number
}) {
  const t = useTranslations('viralReplication')
  const normalizedProgress = Math.max(0, Math.min(100, progress))

  if (status === 'generating') {
    return (
      <section
        data-testid="viral-generation-progress"
        className="rounded-2xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] p-6"
      >
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="font-semibold text-[var(--glass-text-primary)]">{t('progress.generating')}</h2>
          <span className="text-sm text-[var(--glass-text-secondary)]">{Math.round(normalizedProgress)}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-[var(--glass-bg-muted)]">
          <div
            className="h-full rounded-full bg-[var(--glass-accent-from)] transition-[width] duration-300"
            style={{ width: `${normalizedProgress}%` }}
          />
        </div>
      </section>
    )
  }

  return (
    <section className="rounded-2xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] p-6">
      <h2 className="mb-5 font-semibold text-[var(--glass-text-primary)]">{t('progress.analyzing')}</h2>
      <ol className="grid gap-3 md:grid-cols-5">
        {ANALYSIS_STAGES.map((stage, index) => {
          const threshold = (index / ANALYSIS_STAGES.length) * 100
          const active = normalizedProgress >= threshold
          return (
            <li
              key={stage}
              data-testid="viral-progress-stage"
              className={`rounded-xl border px-3 py-4 text-sm ${active
                ? 'border-[var(--glass-stroke-focus)] bg-[var(--glass-bg-surface-strong)] text-[var(--glass-text-primary)]'
                : 'border-[var(--glass-stroke-base)] text-[var(--glass-text-tertiary)]'
              }`}
            >
              <span className="mb-2 block text-xs tabular-nums">{index + 1}/5</span>
              {t(`progress.stages.${stage}`)}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
