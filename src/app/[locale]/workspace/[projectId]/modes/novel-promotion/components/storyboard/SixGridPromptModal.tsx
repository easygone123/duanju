'use client'

import React, { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

import GlassModalShell from '@/components/ui/primitives/GlassModalShell'
import { AppIcon } from '@/components/ui/icons'

interface SixGridPromptModalProps {
  open: boolean
  onClose: () => void
  prompt: string | null | undefined
  groupSequence: number | null | undefined
  cellRatio: '16:9' | '9:16'
}

export default function SixGridPromptModal({
  open,
  onClose,
  prompt,
  groupSequence,
  cellRatio,
}: SixGridPromptModalProps) {
  const t = useTranslations('storyboard.sixGrid.promptModal')
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const hasPrompt = Boolean(prompt?.trim())

  useEffect(() => {
    setCopyState('idle')
  }, [open, prompt])

  const copyPrompt = async () => {
    if (!hasPrompt || prompt == null) return
    try {
      await navigator.clipboard.writeText(prompt)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  const close = () => {
    setCopyState('idle')
    onClose()
  }

  return (
    <GlassModalShell
      open={open}
      onClose={close}
      title={t('title')}
      description={t('description')}
      size="lg"
      showCloseButton={false}
      footer={(
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" className="glass-btn-base glass-btn-secondary rounded-lg px-4 py-2 text-sm" onClick={close}>
            {t('close')}
          </button>
          {hasPrompt ? (
            <button type="button" className="glass-btn-base glass-btn-primary rounded-lg px-4 py-2 text-sm" onClick={() => void copyPrompt()}>
              <AppIcon name="copy" className="h-4 w-4" />
              {t('copy')}
            </button>
          ) : null}
        </div>
      )}
    >
      <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
        <div className="flex flex-wrap gap-2 text-xs text-[var(--glass-text-secondary)]">
          {groupSequence != null ? (
            <span className="rounded-full border border-[var(--glass-stroke-base)] px-2.5 py-1">
              {t('groupContext', { sequence: groupSequence })}
            </span>
          ) : null}
          <span className="rounded-full border border-[var(--glass-stroke-base)] px-2.5 py-1">
            {t('cellRatioContext', { ratio: cellRatio })}
          </span>
        </div>

        {hasPrompt ? (
          <textarea
            aria-label={t('promptLabel')}
            readOnly
            value={prompt ?? ''}
            rows={16}
            className="glass-input w-full resize-y whitespace-pre-wrap font-mono text-sm leading-6"
          />
        ) : (
          <p role="status" className="rounded-xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] p-4 text-sm text-[var(--glass-text-secondary)]">
            {t('missing')}
          </p>
        )}

        {copyState === 'copied' ? (
          <p role="status" className="text-sm text-[var(--glass-tone-success-fg)]">{t('copied')}</p>
        ) : null}
        {copyState === 'failed' ? (
          <p role="alert" className="text-sm text-[var(--glass-tone-danger-fg)]">{t('copyFailed')}</p>
        ) : null}
      </div>
    </GlassModalShell>
  )
}
