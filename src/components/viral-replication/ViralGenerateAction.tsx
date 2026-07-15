'use client'

import { useTranslations } from 'next-intl'

export default function ViralGenerateAction({
  disabled,
  pending,
  onGenerate,
}: {
  disabled: boolean
  pending: boolean
  onGenerate: () => void
}) {
  const t = useTranslations('viralReplication')

  return (
    <div className="flex justify-end">
      <button
        type="button"
        disabled={disabled || pending}
        onClick={onGenerate}
        className="glass-btn-base glass-btn-primary px-6 py-3 font-semibold disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? t('actions.starting') : t('actions.generate')}
      </button>
    </div>
  )
}
