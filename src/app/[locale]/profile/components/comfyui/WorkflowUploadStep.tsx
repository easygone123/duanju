'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { apiFetch } from '@/lib/api-fetch'
import type {
  WorkflowAutoMappingResult,
  WorkflowImportKind,
} from '@/lib/comfyui/workflow-auto-mapping-types'
import {
  parseWorkflowImportText,
  readWorkflowImportFile,
  workflowRequestErrorFromPayload,
} from './workflow-ui'

const ANALYZE_ENDPOINT = '/api/comfyui/workflows/analyze'
const IMPORT_KINDS: WorkflowImportKind[] = [
  'image_generation',
  'image_edit',
  'image_upscale',
  'video_generation',
  'video_to_video',
]

interface Props {
  disabled?: boolean
  onAnalyzed(sourceText: string, analysis: WorkflowAutoMappingResult): void
  onError(error: unknown): void
}

export default function WorkflowUploadStep({ disabled, onAnalyzed, onError }: Props) {
  const t = useTranslations('comfyui.workflows')
  const fileRef = useRef<HTMLInputElement>(null)
  const [kind, setKind] = useState<WorkflowImportKind>('image_generation')
  const [analyzing, setAnalyzing] = useState(false)

  const analyzeFile = async (file: File) => {
    setAnalyzing(true)
    try {
      const sourceText = await readWorkflowImportFile(file)
      const apiFormatJson = parseWorkflowImportText(sourceText)
      const response = await apiFetch(ANALYZE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, apiFormatJson }),
      })
      if (!response.ok) {
        throw workflowRequestErrorFromPayload(await response.json().catch(() => null), response.status)
      }
      const payload = await response.json() as { analysis: WorkflowAutoMappingResult }
      onAnalyzed(sourceText, payload.analysis)
    } catch (error) {
      onError(error)
    } finally {
      setAnalyzing(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return <section className="glass-surface-soft min-w-0 space-y-4 rounded-xl p-4" aria-labelledby="workflow-upload-heading">
    <div><h4 id="workflow-upload-heading" className="font-medium">{t('uploadWorkflow')}</h4><p className="mt-1 text-xs text-[var(--glass-text-secondary)]">{t('uploadWorkflowHint')}</p></div>
    <label className="block text-sm">{t('workflowKind')}<select value={kind} disabled={disabled || analyzing} onChange={(event) => setKind(event.target.value as WorkflowImportKind)} className="mt-1 w-full min-w-0 rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-3 py-2">
      {IMPORT_KINDS.map((item) => <option key={item} value={item}>{t(`importKinds.${item}`)}</option>)}
    </select></label>
    <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" disabled={disabled || analyzing} onChange={(event) => {
      const file = event.target.files?.[0]
      if (file) void analyzeFile(file)
    }} />
    <button type="button" disabled={disabled || analyzing} onClick={() => fileRef.current?.click()} className="glass-btn-base glass-btn-tone-info w-full px-4 py-2 text-sm disabled:opacity-50">
      {analyzing ? t('analyzingWorkflow') : t('selectWorkflowJson')}
    </button>
  </section>
}
