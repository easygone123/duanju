'use client'

import React from 'react'
import { useTranslations } from 'next-intl'
import {
  isGridCellAspectRatio,
  isGridStoryboardMode,
  resolveStoryboardGridSpec,
} from '@/lib/novel-promotion/grid-storyboard/spec'
import type {
  SixGridCellAspectRatio,
  StoryboardGenerationMode,
} from '@/lib/novel-promotion/six-grid/contracts'

interface Props {
  mode: StoryboardGenerationMode
  cellRatio: SixGridCellAspectRatio | null
  videoRatio: string | null | undefined
  persistedModes?: StoryboardGenerationMode[]
  onOpenSettings(): void
}

export default function StoryboardModeSummary({
  mode,
  cellRatio,
  videoRatio,
  persistedModes = [],
  onOpenSettings,
}: Props) {
  const t = useTranslations('novelPromotion.storyboardRunSettings')
  const selectedRatio = cellRatio
    || (isGridCellAspectRatio(videoRatio) ? videoRatio : '16:9')
  const spec = isGridStoryboardMode(mode)
    ? resolveStoryboardGridSpec(mode, selectedRatio)
    : null
  const activePersistedModes = [...new Set(persistedModes)]
  const modeChangePending = activePersistedModes.length > 0
    && (activePersistedModes.length !== 1 || activePersistedModes[0] !== mode)

  return <section
    className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--glass-stroke)] bg-[var(--glass-bg)] p-4"
    aria-labelledby="storyboard-mode-summary-title"
  >
    <div className="min-w-0">
      <h2 id="storyboard-mode-summary-title" className="text-sm font-semibold">
        {t('currentModeTitle')}
      </h2>
      <p className="mt-1 text-sm text-[var(--glass-text-secondary)]">{t(`mode.${mode}`)}</p>
      {spec && <dl className="mt-2 flex min-w-0 flex-wrap gap-x-5 gap-y-1 text-xs text-[var(--glass-text-tertiary)]">
        <div className="flex items-center gap-1.5">
          <dt>{t('layoutLabel')}</dt>
          <dd className="font-medium text-[var(--glass-text-secondary)]">{spec.columns}×{spec.rows}</dd>
        </div>
        <div className="flex items-center gap-1.5">
          <dt>{t('sheetRatioLabel')}</dt>
          <dd className="font-medium text-[var(--glass-text-secondary)]">{spec.sheetAspectRatio}</dd>
        </div>
      </dl>}
      {modeChangePending && <p
        role="status"
        className="mt-2 text-xs text-[var(--glass-tone-warning-fg)]"
      >
        {t('pendingRebuild', {
          current: activePersistedModes.map((persistedMode) => t(`mode.${persistedMode}`)).join(', '),
        })}
      </p>}
    </div>
    <button
      type="button"
      onClick={onOpenSettings}
      className="glass-btn-base px-3 py-2 text-sm"
    >{t('changeInStorySettings')}</button>
  </section>
}
