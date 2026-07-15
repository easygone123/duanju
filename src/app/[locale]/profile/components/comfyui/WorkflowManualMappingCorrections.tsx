'use client'

import React, { useId } from 'react'
import { useTranslations } from 'next-intl'
import type {
  CanonicalWorkflowInput,
  WorkflowAutoMappingResult,
} from '@/lib/comfyui/workflow-auto-mapping-types'
import {
  manualWorkflowMappingCandidates,
  type ManualWorkflowMappings,
} from './manual-workflow-mapping'

interface Props {
  analysis: WorkflowAutoMappingResult
  missingRequiredInputs: CanonicalWorkflowInput[]
  value: ManualWorkflowMappings
  disabled?: boolean
  onChange(value: ManualWorkflowMappings): void
}

export default function WorkflowManualMappingCorrections({
  analysis,
  missingRequiredInputs,
  value,
  disabled = false,
  onChange,
}: Props) {
  const t = useTranslations('comfyui.workflows.guided')
  const canonical = useTranslations('comfyui.workflows.canonicalInputs')
  const idPrefix = useId()
  const activeCanonicalNames = Object.entries(value)
    .filter((entry) => entry[1] !== undefined)
    .map(([canonicalName]) => canonicalName as CanonicalWorkflowInput)
  const canonicalNames = [...new Set([...missingRequiredInputs, ...activeCanonicalNames])]

  if (canonicalNames.length === 0) return null

  return <section className="w-full min-w-0 max-w-4xl space-y-4" aria-labelledby={`${idPrefix}-title`}>
    <h3 id={`${idPrefix}-title`} className="font-medium">{t('manualCorrectionsTitle')}</h3>
    {canonicalNames.map((canonicalName) => {
      const candidates = manualWorkflowMappingCandidates(analysis, canonicalName, value)
      const selected = value[canonicalName]
      const fieldId = `${idPrefix}-${canonicalName}`
      const descriptionId = `${fieldId}-description`

      return <div key={canonicalName} className="glass-surface-soft min-w-0 rounded-xl p-4">
        <label htmlFor={fieldId} className="block min-w-0 text-sm font-medium">
          {t('manualCorrectionLabel', { input: canonical(canonicalName) })}
        </label>
        <select
          id={fieldId}
          value={selected?.id || ''}
          disabled={disabled || candidates.length === 0}
          aria-describedby={descriptionId}
          onChange={(event) => {
            const next = { ...value }
            if (!event.target.value) {
              delete next[canonicalName]
              onChange(next)
              return
            }
            const candidate = candidates.find((item) => item.id === event.target.value)
            if (!candidate) return
            next[canonicalName] = candidate
            onChange(next)
          }}
          className="glass-input mt-2 w-full min-w-0 px-3 py-2 text-sm disabled:opacity-50"
        >
          <option value="">
            {selected ? t('manualCorrectionClear') : t('manualCorrectionPlaceholder')}
          </option>
          {candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>
            {candidate.nodeTitle || candidate.nodeId} · {candidate.inputPath}
          </option>)}
        </select>
        <p id={descriptionId} role="status" className="mt-2 break-all text-xs text-[var(--glass-text-secondary)]">
          {selected
            ? t('manualCorrectionSelectedField', { field: `${selected.nodeId}.${selected.inputPath}` })
            : candidates.length === 0 ? t('manualCorrectionNoCandidates') : ''}
        </p>
      </div>
    })}
  </section>
}
