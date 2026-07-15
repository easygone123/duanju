'use client'

import { useTranslations } from 'next-intl'

export default function ViralBriefEditor({
  value,
  disabled,
  saving,
  onChange,
  onSave,
}: {
  value: string
  disabled: boolean
  saving: boolean
  onChange: (value: string) => void
  onSave: () => void
}) {
  const t = useTranslations('viralReplication')

  return (
    <section className="rounded-2xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] p-6">
      <label htmlFor="viral-replication-brief" className="mb-2 block font-semibold text-[var(--glass-text-primary)]">
        {t('brief.label')}
      </label>
      <p className="mb-3 text-sm text-[var(--glass-text-tertiary)]">{t('brief.help')}</p>
      <textarea
        id="viral-replication-brief"
        value={value}
        disabled={disabled}
        maxLength={2_000}
        rows={5}
        onChange={(event) => onChange(event.target.value)}
        className="w-full resize-y rounded-xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] px-4 py-3 text-sm text-[var(--glass-text-primary)] outline-none focus:border-[var(--glass-stroke-focus)] disabled:cursor-not-allowed disabled:opacity-60"
      />
      <div className="mt-3 flex items-center justify-between gap-4">
        <span className="text-xs text-[var(--glass-text-tertiary)]">{value.length}/2000</span>
        <button
          type="button"
          disabled={disabled || saving || !value.trim()}
          onClick={onSave}
          className="glass-btn-base glass-btn-secondary px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? t('actions.saving') : t('actions.save')}
        </button>
      </div>
    </section>
  )
}
