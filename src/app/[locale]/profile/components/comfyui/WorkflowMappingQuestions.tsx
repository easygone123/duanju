'use client'

import React, { useId } from 'react'
import { useTranslations } from 'next-intl'
import type {
  CanonicalWorkflowInput,
  WorkflowAutoMappingResult,
  WorkflowMappingProposal,
} from '@/lib/comfyui/workflow-auto-mapping-types'
import {
  guidedCompatibleRoles,
  type GuidedWorkflowReview,
} from './guided-workflow-creation'

interface Props {
  analysis: WorkflowAutoMappingResult
  review: GuidedWorkflowReview
  roles: Record<string, CanonicalWorkflowInput | 'preserve_original'>
  primaryOutputNodeId: string
  onRoleChange(id: string, value: CanonicalWorkflowInput): void
  onPrimaryOutputChange(nodeId: string): void
}

function userFacingOutputName(name: string, nodeId: string) {
  const normalizedName = name.trim()
  const normalizedNodeId = nodeId.trim()
  if (!normalizedName || /^output(?:_.*)?$/i.test(normalizedName)) return null
  if (normalizedNodeId && normalizedName.toLocaleLowerCase().includes(normalizedNodeId.toLocaleLowerCase())) {
    return null
  }
  return normalizedName
}

export default function WorkflowMappingQuestions({
  analysis,
  review,
  roles,
  primaryOutputNodeId,
  onRoleChange,
  onPrimaryOutputChange,
}: Props) {
  const t = useTranslations('comfyui.workflows.guided')
  const workflows = useTranslations('comfyui.workflows')
  const canonical = useTranslations('comfyui.workflows.canonicalInputs')
  const groupPrefix = useId()

  const questionText = (proposal: WorkflowMappingProposal) => {
    if (proposal.valueType === 'image_ref' || proposal.valueType === 'image_ref_list' || proposal.valueType === 'video_ref') {
      return t('sourceRoleQuestion', { media: proposal.valueType === 'video_ref' ? 'video' : 'image' })
    }
    if (proposal.canonicalName === 'prompt' || proposal.canonicalName === 'negativePrompt') {
      return t('promptRoleQuestion')
    }
    return t('inputRoleQuestion', { input: canonical(proposal.canonicalName) })
  }

  if (review.questions.length === 0 && !review.needsPrimaryOutput) return null

  return <section className="w-full min-w-0 max-w-4xl space-y-4" aria-labelledby={`${groupPrefix}-title`}>
    <h3 id={`${groupPrefix}-title`} className="font-medium">{t('questionsTitle')}</h3>
    {review.questions.map((proposal, questionIndex) => <fieldset
      key={proposal.id}
      className="glass-surface-soft min-w-0 space-y-3 rounded-xl p-4"
    >
      <legend className="max-w-full break-words px-1 text-sm font-medium">{questionText(proposal)}</legend>
      <div className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-2">
        {guidedCompatibleRoles(proposal).map((role) => <label
          key={role}
          className="flex min-w-0 items-center gap-2 rounded-lg border border-[var(--glass-stroke-base)] p-3 text-sm"
        >
          <input
            type="radio"
            name={`${groupPrefix}-role-${questionIndex}`}
            checked={roles[proposal.id] === role}
            onChange={() => onRoleChange(proposal.id, role)}
          />
          <span className="min-w-0 break-words">{canonical(role)}</span>
        </label>)}
      </div>
      <details className="min-w-0 text-xs text-[var(--glass-text-secondary)]">
        <summary className="cursor-pointer break-words">{t('technicalDetails')}</summary>
        <dl className="mt-2 grid min-w-0 grid-cols-1 gap-1 rounded-lg border border-[var(--glass-stroke-base)] p-3 md:grid-cols-2">
          <div className="min-w-0"><dt className="font-medium">{t('nodeTitle')}</dt><dd className="break-all">{proposal.nodeTitle || proposal.nodeId}</dd></div>
          <div className="min-w-0"><dt className="font-medium">{t('nodeId')}</dt><dd className="break-all">{proposal.nodeId}</dd></div>
          <div className="min-w-0"><dt className="font-medium">{t('inputPath')}</dt><dd className="break-all">{proposal.inputPath}</dd></div>
          <div className="min-w-0"><dt className="font-medium">{t('confidence')}</dt><dd className="break-all">{proposal.confidence} · {workflows(`mappingConfidence.${proposal.confidence}`)}</dd></div>
          <div className="min-w-0 md:col-span-2"><dt className="font-medium">{t('reason')}</dt><dd className="break-all">{proposal.reasonCode} · {workflows(`mappingReasons.${proposal.reasonCode}`)}</dd></div>
        </dl>
      </details>
    </fieldset>)}
    {review.needsPrimaryOutput && <fieldset className="glass-surface-soft min-w-0 space-y-3 rounded-xl p-4">
      <legend className="max-w-full break-words px-1 text-sm font-medium">{t('outputQuestion')}</legend>
      <div className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-2">
        {analysis.outputs.map((output, outputIndex) => <div key={output.nodeId} className="min-w-0 rounded-lg border border-[var(--glass-stroke-base)] p-3">
          <label className="flex min-w-0 items-center gap-2 text-sm">
            <input
              type="radio"
              name={`${groupPrefix}-output`}
              checked={primaryOutputNodeId === output.nodeId}
              onChange={() => onPrimaryOutputChange(output.nodeId)}
            />
            <span className="min-w-0 break-words">
              {userFacingOutputName(output.name, output.nodeId) || t('outputCandidate', { index: outputIndex + 1 })}
            </span>
          </label>
          <details className="mt-2 min-w-0 text-xs text-[var(--glass-text-secondary)]">
            <summary className="cursor-pointer break-words">{t('technicalDetails')}</summary>
            <dl className="mt-2 min-w-0 space-y-1 rounded-lg border border-[var(--glass-stroke-base)] p-3">
              <div className="min-w-0"><dt className="font-medium">{t('outputName')}</dt><dd className="break-all">{output.name}</dd></div>
              <div className="min-w-0"><dt className="font-medium">{t('nodeId')}</dt><dd className="break-all">{output.nodeId}</dd></div>
              <div className="min-w-0"><dt className="font-medium">{t('outputFieldPath')}</dt><dd className="break-all">{output.fieldPath}</dd></div>
            </dl>
          </details>
        </div>)}
      </div>
    </fieldset>}
  </section>
}
