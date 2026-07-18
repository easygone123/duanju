'use client'

import React, { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { CanonicalWorkflowInput } from '@/lib/comfyui/workflow-auto-mapping-types'
import { guidedCompatibleRoles } from './guided-workflow-creation'
import {
  addGuidedInput,
  addGuidedOutput,
  guidedInputCandidates,
  guidedMappingDraftIssues,
  guidedOutputNodeCandidates,
  removeGuidedInput,
  removeGuidedOutput,
  setGuidedPrimaryOutput,
  updateGuidedInputRole,
  updateGuidedOutput,
  type GuidedWorkflowMappingDraft,
} from './guided-workflow-mapping-draft'

interface Props {
  value: GuidedWorkflowMappingDraft
  disabled?: boolean
  onChange(value: GuidedWorkflowMappingDraft): void
}

export default function WorkflowGuidedMappingEditor({
  value,
  disabled = false,
  onChange,
}: Props) {
  const t = useTranslations('comfyui.workflows.guided')
  const canonical = useTranslations('comfyui.workflows.canonicalInputs')
  const [addingInput, setAddingInput] = useState(false)
  const [candidateId, setCandidateId] = useState('')
  const [newRole, setNewRole] = useState<CanonicalWorkflowInput | ''>('')
  const inputCandidates = useMemo(
    () => guidedInputCandidates(value.analysis, value.inputs),
    [value.analysis, value.inputs],
  )
  const selectedCandidate = inputCandidates.find((candidate) => candidate.id === candidateId)
  const outputNodes = useMemo(() => guidedOutputNodeCandidates(value.analysis), [value.analysis])
  const issues = guidedMappingDraftIssues(value)

  const chooseCandidate = (nextId: string) => {
    setCandidateId(nextId)
    const candidate = inputCandidates.find((item) => item.id === nextId)
    setNewRole(candidate?.roles[0] || '')
  }

  const confirmInput = () => {
    if (!candidateId || !newRole) return
    onChange(addGuidedInput(value, candidateId, newRole))
    setAddingInput(false)
    setCandidateId('')
    setNewRole('')
  }

  const addOutput = () => {
    const used = new Set(value.outputs.map((output) => output.nodeId))
    const candidate = outputNodes.find((node) => !used.has(node.nodeId)) || outputNodes[0]
    if (candidate) onChange(addGuidedOutput(value, candidate.nodeId))
  }

  return <section className="w-full min-w-0 max-w-4xl space-y-6" aria-labelledby="guided-mapping-editor-title">
    <div>
      <h3 id="guided-mapping-editor-title" className="font-medium">{t('mappingEditorTitle')}</h3>
      <p className="mt-1 text-xs text-[var(--glass-text-secondary)]">{t('mappingEditorHint')}</p>
    </div>

    <section className="space-y-3" aria-labelledby="guided-input-mappings-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id="guided-input-mappings-title" className="text-sm font-medium">{t('inputMappingsTitle')}</h4>
        <button
          type="button"
          disabled={disabled || inputCandidates.length === 0}
          onClick={() => setAddingInput((current) => !current)}
          className="glass-btn-base px-3 py-1.5 text-xs disabled:opacity-50"
        >{t('addInputMapping')}</button>
      </div>

      {value.inputs.length === 0 && <p className="text-sm text-[var(--glass-text-secondary)]">{t('noInputMappings')}</p>}
      <div className="space-y-2">
        {value.inputs.map((proposal) => <div
          key={proposal.id}
          className="grid min-w-0 gap-2 rounded-xl border border-[var(--glass-stroke-base)] p-3 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.8fr)_auto] sm:items-end"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium">{canonical(proposal.canonicalName)}</p>
            <p className="mt-1 break-all text-xs text-[var(--glass-text-tertiary)]">
              {proposal.nodeId}.{proposal.inputPath}
            </p>
          </div>
          <label className="min-w-0 text-xs text-[var(--glass-text-secondary)]">
            {t('mappedRole')}
            <select
              value={proposal.canonicalName}
              disabled={disabled}
              aria-label={t('mappingRoleFor', { field: `${proposal.nodeId}.${proposal.inputPath}` })}
              onChange={(event) => onChange(updateGuidedInputRole(
                value,
                proposal.id,
                event.target.value as CanonicalWorkflowInput,
              ))}
              className="glass-input mt-1 w-full min-w-0 px-2 py-2 text-sm"
            >
              {guidedCompatibleRoles(proposal).map((role) => <option key={role} value={role}>
                {canonical(role)}
              </option>)}
            </select>
          </label>
          <button
            type="button"
            disabled={disabled}
            aria-label={t('removeInputMappingLabel', { input: canonical(proposal.canonicalName) })}
            onClick={() => onChange(removeGuidedInput(value, proposal.id))}
            className="glass-btn-base px-3 py-2 text-xs disabled:opacity-50"
          >{t('removeMapping')}</button>
        </div>)}
      </div>

      {addingInput && <div className="grid min-w-0 gap-3 rounded-xl border border-[var(--glass-stroke-focus)] p-3 sm:grid-cols-2">
        <label className="min-w-0 text-xs text-[var(--glass-text-secondary)]">
          {t('workflowField')}
          <select
            value={candidateId}
            disabled={disabled}
            aria-label={t('workflowField')}
            onChange={(event) => chooseCandidate(event.target.value)}
            className="glass-input mt-1 w-full min-w-0 px-2 py-2 text-sm"
          >
            <option value="">{t('chooseWorkflowField')}</option>
            {inputCandidates.map((candidate) => <option key={candidate.id} value={candidate.id}>
              {candidate.nodeTitle || candidate.nodeId} · {candidate.nodeId}.{candidate.inputPath}
            </option>)}
          </select>
        </label>
        <label className="min-w-0 text-xs text-[var(--glass-text-secondary)]">
          {t('newMappingRole')}
          <select
            value={newRole}
            disabled={disabled || !selectedCandidate}
            aria-label={t('newMappingRole')}
            onChange={(event) => setNewRole(event.target.value as CanonicalWorkflowInput)}
            className="glass-input mt-1 w-full min-w-0 px-2 py-2 text-sm"
          >
            <option value="">{t('chooseMappingRole')}</option>
            {(selectedCandidate?.roles || []).map((role) => <option key={role} value={role}>
              {canonical(role)}
            </option>)}
          </select>
        </label>
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <button
            type="button"
            disabled={disabled || !candidateId || !newRole}
            onClick={confirmInput}
            className="glass-btn-base glass-btn-tone-info px-3 py-2 text-xs disabled:opacity-50"
          >{t('confirmInputMapping')}</button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setAddingInput(false)
              setCandidateId('')
              setNewRole('')
            }}
            className="glass-btn-base px-3 py-2 text-xs disabled:opacity-50"
          >{t('cancelMapping')}</button>
        </div>
      </div>}
    </section>

    <section className="space-y-3" aria-labelledby="guided-output-mappings-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id="guided-output-mappings-title" className="text-sm font-medium">{t('outputMappingsTitle')}</h4>
        <button
          type="button"
          disabled={disabled || outputNodes.length === 0}
          onClick={addOutput}
          className="glass-btn-base px-3 py-1.5 text-xs disabled:opacity-50"
        >{t('addOutputMapping')}</button>
      </div>

      {value.outputs.length === 0 && <p role="alert" className="text-sm text-[var(--glass-tone-danger-fg)]">
        {t('outputRequired')}
      </p>}
      <div className="space-y-2">
        {value.outputs.map((output, index) => <div
          key={`${index}:${output.name}`}
          className="grid min-w-0 gap-2 rounded-xl border border-[var(--glass-stroke-base)] p-3 md:grid-cols-2"
        >
          <label className="min-w-0 text-xs text-[var(--glass-text-secondary)]">
            {t('outputNode')}
            <select
              value={output.nodeId}
              disabled={disabled}
              aria-label={t('outputNode')}
              onChange={(event) => onChange(updateGuidedOutput(value, index, { nodeId: event.target.value }))}
              className="glass-input mt-1 w-full min-w-0 px-2 py-2 text-sm"
            >
              {outputNodes.map((node) => <option key={node.nodeId} value={node.nodeId}>
                {node.nodeTitle || node.classType} · {node.nodeId}
              </option>)}
            </select>
          </label>
          <label className="min-w-0 text-xs text-[var(--glass-text-secondary)]">
            {t('historyField')}
            <input
              type="text"
              value={output.fieldPath}
              disabled={disabled}
              aria-label={t('historyField')}
              onChange={(event) => onChange(updateGuidedOutput(value, index, { fieldPath: event.target.value }))}
              className="glass-input mt-1 w-full min-w-0 px-2 py-2 text-sm"
            />
          </label>
          <label className="min-w-0 text-xs text-[var(--glass-text-secondary)]">
            {t('outputMappingName')}
            <input
              type="text"
              value={output.name}
              disabled={disabled}
              aria-label={t('outputMappingName')}
              onChange={(event) => onChange(updateGuidedOutput(value, index, { name: event.target.value }))}
              className="glass-input mt-1 w-full min-w-0 px-2 py-2 text-sm"
            />
          </label>
          <div className="flex min-w-0 flex-wrap items-end gap-2">
            <label className="flex min-w-0 items-center gap-2 text-xs">
              <input
                type="radio"
                name="guided-primary-output"
                checked={output.primary}
                disabled={disabled}
                aria-label={t('usePrimaryOutput', { name: output.name })}
                onChange={() => onChange(setGuidedPrimaryOutput(value, index))}
              />
              <span>{t('primaryOutput')}</span>
            </label>
            <button
              type="button"
              disabled={disabled}
              aria-label={t('removeOutputLabel', { name: output.name })}
              onClick={() => onChange(removeGuidedOutput(value, index))}
              className="glass-btn-base px-3 py-2 text-xs disabled:opacity-50"
            >{t('removeMapping')}</button>
          </div>
        </div>)}
      </div>
      {issues.length > 0 && value.outputs.length > 0 && <p role="alert" className="text-sm text-[var(--glass-tone-danger-fg)]">
        {issues.map((issue) => t(`mappingDraftIssues.${issue}`)).join(' ')}
      </p>}
    </section>
  </section>
}
