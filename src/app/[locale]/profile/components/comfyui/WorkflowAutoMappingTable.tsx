'use client'

import React from 'react'
import { useTranslations } from 'next-intl'
import type {
  CanonicalWorkflowInput,
  WorkflowAutoMappingResult,
} from '@/lib/comfyui/workflow-auto-mapping-types'
import { guidedCompatibleRoles, guidedMappingReasonKey } from './guided-workflow-creation'

export interface WorkflowAutoMappingTableProps {
  analysis: WorkflowAutoMappingResult
  roles: Record<string, CanonicalWorkflowInput | 'preserve_original'>
  primaryOutputNodeId: string
  onRoleChange(id: string, value: CanonicalWorkflowInput | 'preserve_original'): void
  onPrimaryOutputChange(nodeId: string): void
}

export default function WorkflowAutoMappingTable({ analysis, roles, primaryOutputNodeId, onRoleChange, onPrimaryOutputChange }: WorkflowAutoMappingTableProps) {
  const t = useTranslations('comfyui.workflows')
  return <div className="min-w-0 space-y-5">
    <section className="space-y-2" aria-labelledby="automatic-input-mappings">
      <div><h4 id="automatic-input-mappings" className="font-medium">{t('automaticMappings')}</h4><p className="text-xs text-[var(--glass-text-secondary)]">{t('automaticMappingsHint')}</p></div>
      {analysis.proposals.length === 0 && <p className="rounded-lg border border-[var(--glass-stroke-base)] p-3 text-sm">{t('noMappingsFound')}</p>}
      <div className="space-y-2">{analysis.proposals.map((proposal) => {
        const confidence = proposal.confidence
        const selected = roles[proposal.id] || (confidence === 'ambiguous' ? '' : proposal.canonicalName)
        return <div key={proposal.id} className="grid min-w-0 gap-2 rounded-xl border border-[var(--glass-stroke-base)] p-3 sm:grid-cols-2">
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-medium">{t(`canonicalInputs.${selected && selected !== 'preserve_original' ? selected : proposal.canonicalName}`)}</span><span data-confidence={confidence} className={`rounded-full px-2 py-0.5 text-[11px] ${confidence === 'high' ? 'bg-[var(--glass-tone-success-bg)] text-[var(--glass-tone-success-fg)]' : confidence === 'ambiguous' ? 'bg-[var(--glass-tone-warning-bg)] text-[var(--glass-tone-warning-fg)]' : confidence === 'blocking' ? 'bg-[var(--glass-tone-danger-bg)] text-[var(--glass-tone-danger-fg)]' : 'bg-[var(--glass-bg-muted)] text-[var(--glass-text-secondary)]'}`}>{t(`mappingConfidence.${confidence}`)}</span>{proposal.required && <span className="text-[11px] text-[var(--glass-tone-danger-fg)]">{t('required')}</span>}</div>
            <p className="mt-1 break-all text-xs text-[var(--glass-text-tertiary)]">{proposal.nodeTitle || proposal.nodeId} · {proposal.nodeId}.{proposal.inputPath}</p><p className="mt-1 text-xs text-[var(--glass-text-secondary)]">{t(`mappingReasons.${guidedMappingReasonKey(proposal.reasonCode)}`)}</p></div>
          <label className="text-xs">{t('mappedRole')}<select disabled={confidence !== 'ambiguous'} value={selected} onChange={(event) => onRoleChange(proposal.id, event.target.value as CanonicalWorkflowInput | 'preserve_original')} className="mt-1 w-full min-w-0 rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-2 py-2">
            {confidence === 'ambiguous' && <option value="">{t('selectMappingRole')}</option>}
            {guidedCompatibleRoles(proposal).map((role) => <option key={role} value={role}>{t(`canonicalInputs.${role}`)}</option>)}
            {!proposal.required && <option value="preserve_original">{t('preserveOriginal')}</option>}
          </select></label>
        </div>
      })}</div>
    </section>
    <section className="space-y-2" aria-labelledby="automatic-output-mappings"><h4 id="automatic-output-mappings" className="font-medium">{t('outputMappings')}</h4>
      {analysis.outputs.length === 0 ? <p role="alert" className="rounded-lg border border-[var(--glass-stroke-danger)] p-3 text-sm text-[var(--glass-tone-danger-fg)]">{t('primaryOutputMissing')}</p> : analysis.outputs.map((output) => <label key={output.nodeId} className="flex min-w-0 items-center gap-2 rounded-lg border border-[var(--glass-stroke-base)] p-3 text-sm"><input type="radio" name="automatic-primary-output" checked={primaryOutputNodeId === output.nodeId} onChange={() => onPrimaryOutputChange(output.nodeId)} /><span className="min-w-0 break-all">{output.name} · {output.nodeId}.{output.fieldPath}</span></label>)}
    </section>
  </div>
}
