'use client'

import React, { useRef, type DragEvent } from 'react'
import { useTranslations } from 'next-intl'

import { deriveWorkflowName } from './guided-workflow-creation'

interface WorkflowJsonDropzoneProps {
  name: string
  busy: boolean
  onFile: (file: File, derivedName: string) => void
  onNameChange: (name: string) => void
}

export default function WorkflowJsonDropzone({
  name,
  busy,
  onFile,
  onNameChange,
}: WorkflowJsonDropzoneProps) {
  const t = useTranslations('comfyui.workflows.guided')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const select = (file?: File) => {
    if (file) onFile(file, deriveWorkflowName(file.name))
  }
  const preventDragDefault = (event: DragEvent<HTMLElement>) => event.preventDefault()
  const fileButton = <button
    type="button"
    disabled={busy}
    onClick={() => fileInputRef.current?.click()}
    className="glass-btn-base glass-btn-tone-info mt-4 px-4 py-2 text-sm disabled:opacity-50"
  >
    {busy ? t('analyzing') : t('chooseFile')}
  </button>

  const processingRegion = <section
    aria-label={t('dropTitle')}
    aria-busy={busy}
    className="w-full max-w-3xl min-w-0 space-y-4"
    onDragEnter={preventDragDefault}
    onDragOver={preventDragDefault}
    onDrop={(event) => {
      event.preventDefault()
      if (!busy) select(event.dataTransfer.files[0])
    }}
  >
    <div className="glass-surface-soft min-w-0 rounded-2xl border border-dashed border-[var(--glass-stroke-base)] p-6 text-center">
      <h3 className="font-semibold text-[var(--glass-text-primary)]">{t('dropTitle')}</h3>
      <p className="mt-1 text-sm text-[var(--glass-text-secondary)]">{t('dropHint')}</p>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className="sr-only"
        aria-label={t('jsonInput')}
        disabled={busy}
        onChange={(event) => {
          select(event.currentTarget.files?.[0])
          event.currentTarget.value = ''
        }}
      />
      {fileButton}
    </div>
    <label className="block min-w-0 text-sm text-[var(--glass-text-secondary)]">
      <span>{t('name')}</span>
      <input
        type="text"
        value={name}
        maxLength={160}
        onChange={(event) => onNameChange(event.target.value)}
        className="glass-input mt-1 w-full min-w-0 px-3 py-2"
      />
    </label>
  </section>

  return <>
    {processingRegion}
    <div role="status" aria-live="polite" className="sr-only">
      {busy ? t('analyzing') : ''}
    </div>
  </>
}
