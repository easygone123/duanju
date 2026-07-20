'use client'

import { useTranslations } from 'next-intl'

import type { PanelNarrationMode } from '@/lib/novel-promotion/narration/state'
import { usePanelNarrationControl } from './hooks/usePanelNarrationControl'
import type { StoryboardPanel } from './hooks/useStoryboardState'

interface PanelNarrationControlProps {
  projectId: string
  episodeId: string
  panel: StoryboardPanel
}

const modes: PanelNarrationMode[] = ['auto', 'on', 'off']

export default function PanelNarrationControl({
  projectId,
  episodeId,
  panel,
}: PanelNarrationControlProps) {
  const t = useTranslations('storyboard.sixGrid.panel.narration')
  const control = usePanelNarrationControl({ projectId, episodeId, panel })

  if (panel.hasDialogue || !control.available || !control.canonical) return null

  return (
    <section
      data-testid="panel-narration-control"
      className="glass-surface-soft mb-3 rounded-lg border border-[var(--glass-stroke-base)] p-2.5"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-[var(--glass-text-primary)]">{t('title')}</span>
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${control.canonical.narrationRecommended
            ? 'border-[var(--glass-tone-success-fg)]/40 text-[var(--glass-tone-success-fg)]'
            : 'border-[var(--glass-stroke-base)] text-[var(--glass-text-tertiary)]'}`}
        >
          {control.canonical.narrationRecommended ? t('aiRecommended') : t('aiNotRecommended')}
        </span>
      </div>

      <fieldset
        className="mb-2 flex rounded-lg border border-[var(--glass-stroke-base)] p-0.5"
        disabled={control.saving}
      >
        <legend className="sr-only">{t('title')}</legend>
        {modes.map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={control.draftMode === mode}
            onClick={() => control.selectMode(mode)}
            className={`min-w-0 flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${control.draftMode === mode
              ? 'bg-[var(--glass-accent-from)] text-white'
              : 'text-[var(--glass-text-secondary)] hover:bg-[var(--glass-bg-surface)]'}`}
          >
            {t(mode)}
          </button>
        ))}
      </fieldset>

      <p className="mb-2 text-[10px] text-[var(--glass-text-tertiary)]">
        {control.draftMode === 'auto' ? t('aiHint') : t('manualHint')}
      </p>

      {control.showFields && (
        <div className="space-y-2">
          <label className="block text-[11px] font-medium text-[var(--glass-text-secondary)]">
            <span className="mb-1 block">{t('text')}</span>
            <textarea
              aria-label={t('text')}
              value={control.displayedText ?? ''}
              disabled={control.saving}
              rows={2}
              onChange={(event) => control.editText(event.target.value)}
              className="glass-textarea-base w-full resize-y px-2 py-1.5 text-xs leading-5 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>
          <label className="block text-[11px] font-medium text-[var(--glass-text-secondary)]">
            <span className="mb-1 block">{t('emotion')}</span>
            <input
              aria-label={t('emotion')}
              value={control.displayedEmotion ?? ''}
              disabled={control.saving}
              onChange={(event) => control.editEmotion(event.target.value)}
              className="glass-input-base h-8 w-full px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>
        </div>
      )}

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="min-h-4 flex-1" aria-live="polite">
          {control.errorMessage && (
            <p role="alert" className="text-[11px] text-[var(--glass-tone-danger-fg)]">
              {control.errorMessage}
            </p>
          )}
        </div>
        <button
          type="button"
          disabled={control.saving}
          onClick={() => void control.save()}
          className="glass-btn-base glass-btn-primary rounded-md px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
        >
          {control.saving ? t('saving') : t('save')}
        </button>
      </div>
    </section>
  )
}
