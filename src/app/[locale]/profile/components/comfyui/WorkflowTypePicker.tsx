'use client'

import React from 'react'
import { useTranslations } from 'next-intl'

import type { WorkflowImportKind } from '@/lib/comfyui/workflow-auto-mapping-types'

const KINDS: WorkflowImportKind[] = [
  'image_generation',
  'image_edit',
  'image_upscale',
  'video_generation',
  'video_to_video',
]

interface WorkflowTypePickerProps {
  value: WorkflowImportKind | null
  onSelect: (kind: WorkflowImportKind) => void
}

export default function WorkflowTypePicker({ value, onSelect }: WorkflowTypePickerProps) {
  const t = useTranslations('comfyui.workflows.guided')

  return <section className="w-full max-w-4xl min-w-0 space-y-4" aria-label={t('typeTitle')}>
    <div>
      <h3 className="font-semibold text-[var(--glass-text-primary)]">{t('typeTitle')}</h3>
      <p className="mt-1 text-sm text-[var(--glass-text-secondary)]">{t('typeHint')}</p>
    </div>
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {KINDS.map((kind) => <button
        key={kind}
        type="button"
        value={kind}
        aria-pressed={value === kind}
        onClick={() => onSelect(kind)}
        className={`glass-surface-soft min-w-0 rounded-xl border p-4 text-left transition-colors ${value === kind
          ? 'border-[var(--glass-stroke-focus)]'
          : 'border-[var(--glass-stroke-base)]'}`}
      >
        <span className="block font-medium text-[var(--glass-text-primary)]">{t(`types.${kind}.title`)}</span>
        <span className="mt-1 block text-sm text-[var(--glass-text-secondary)]">{t(`types.${kind}.hint`)}</span>
      </button>)}
    </div>
  </section>
}
