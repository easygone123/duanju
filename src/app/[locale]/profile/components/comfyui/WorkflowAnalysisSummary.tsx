'use client'

import React from 'react'
import { useTranslations } from 'next-intl'
import type { GuidedWorkflowReview } from './guided-workflow-creation'

interface Props { review: GuidedWorkflowReview }

type GuidedIssueKey =
  | 'COMFY_WORKFLOW_API_FORMAT_REQUIRED'
  | 'COMFY_WORKFLOW_API_FORMAT_INVALID'
  | 'COMFY_WORKFLOW_OUTPUT_REQUIRED'
  | 'COMFY_WORKFLOW_OUTPUT_AMBIGUOUS'

function guidedIssueKey(code: string): GuidedIssueKey | 'unknown' {
  switch (code) {
    case 'COMFY_WORKFLOW_API_FORMAT_REQUIRED':
    case 'COMFY_WORKFLOW_API_FORMAT_INVALID':
    case 'COMFY_WORKFLOW_OUTPUT_REQUIRED':
    case 'COMFY_WORKFLOW_OUTPUT_AMBIGUOUS':
      return code
    default:
      return 'unknown'
  }
}

export default function WorkflowAnalysisSummary({ review }: Props) {
  const t = useTranslations('comfyui.workflows.guided')
  const canonical = useTranslations('comfyui.workflows.canonicalInputs')

  return <section className="w-full min-w-0 max-w-4xl space-y-3" aria-labelledby="workflow-analysis-summary">
    <h3 id="workflow-analysis-summary" className="font-medium">{t('summaryTitle')}</h3>
    <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2">
      {review.resolvedInputs.length > 0 && <article className="glass-surface-soft min-w-0 rounded-xl p-4">
        <h4 className="text-sm font-medium">{t('recognizedInputs')}</h4>
        <ul className="mt-2 space-y-1 text-sm text-[var(--glass-text-secondary)]">
          {review.resolvedInputs.map((input) => <li key={input} className="break-words">
            {t('recognizedInput', { input: canonical(input) })}
          </li>)}
        </ul>
      </article>}
      {review.preservedCount > 0 && <article className="glass-surface-soft min-w-0 rounded-xl p-4 text-sm">
        {t('preservedDefaults', { count: review.preservedCount })}
      </article>}
      <article className="glass-surface-soft min-w-0 rounded-xl p-4">
        <h4 className="text-sm font-medium">{t('recognizedOutput')}</h4>
        <p className="mt-1 break-words text-sm text-[var(--glass-text-secondary)]">
          {review.primaryOutputNodeId
            ? t('outputReady')
            : t('outputNeedsChoice')}
        </p>
      </article>
      {review.missingRequiredInputs.length > 0 && <article role="alert" className="glass-surface-soft min-w-0 rounded-xl p-4 text-sm text-[var(--glass-tone-danger-fg)]">
        {t('missingRequiredInputs', {
          inputs: review.missingRequiredInputs.map((input) => canonical(input)).join('、'),
        })}
      </article>}
      {review.blockingIssueCodes.map((code, index) => <article
        key={`${code}-${index}`}
        role="alert"
        className="glass-surface-soft min-w-0 rounded-xl p-4 text-sm text-[var(--glass-tone-danger-fg)]"
      >
        {t(`issues.${guidedIssueKey(code)}`)}
      </article>)}
    </div>
  </section>
}
