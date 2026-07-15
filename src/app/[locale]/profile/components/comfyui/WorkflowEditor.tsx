'use client'

import { useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { ComfyVariableDefinition, ComfyVariableType } from '@/lib/comfyui/types'
import type {
  CanonicalWorkflowInput,
  WorkflowAutoMappingResult,
} from '@/lib/comfyui/workflow-auto-mapping-types'
import WorkflowMappingTable from './WorkflowMappingTable'
import WorkflowAutoMappingTable from './WorkflowAutoMappingTable'
import WorkflowUploadStep from './WorkflowUploadStep'
import {
  MAX_WORKFLOW_JSON_BYTES,
  discoverPlaceholderNames,
  parseWorkflowImportText,
  readWorkflowImportFile,
  confirmWorkflowAnalysis,
  safeWorkflowErrorKey,
  type WorkflowAuthorDraft,
} from './workflow-ui'

interface Props { value: WorkflowAuthorDraft; disabled?: boolean; identityLocked?: boolean; onChange(value: WorkflowAuthorDraft): void; onImportError(key: string): void }
const VARIABLE_TYPES: ComfyVariableType[] = ['string', 'number', 'boolean', 'image_ref', 'image_ref_list', 'video_ref']
const inputClass = 'w-full min-w-0 rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-3 py-2 text-sm'
type WorkflowEditorStage = 'upload' | 'mapping' | 'validate'

function parseDefault(type: ComfyVariableType, raw: string) {
  if (!raw) return undefined
  if (type === 'number') return Number(raw)
  if (type === 'boolean') return raw === 'true'
  return raw
}

export default function WorkflowEditor({ value, disabled, identityLocked, onChange, onImportError }: Props) {
  const t = useTranslations('comfyui.workflows')
  const fileRef = useRef<HTMLInputElement>(null)
  const [stage, setStage] = useState<WorkflowEditorStage>(identityLocked ? 'validate' : 'upload')
  const [analysis, setAnalysis] = useState<WorkflowAutoMappingResult | null>(null)
  const [roles, setRoles] = useState<Record<string, CanonicalWorkflowInput | 'preserve_original'>>({})
  const [primaryOutputNodeId, setPrimaryOutputNodeId] = useState('')
  const placeholders = useMemo(() => discoverPlaceholderNames(value.apiFormatJson), [value.apiFormatJson])
  const updateVariable = (index: number, patch: Partial<ComfyVariableDefinition>) => onChange({ ...value,
    variableDefinitions: value.variableDefinitions.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
  })
  const importText = (text: string) => {
    try { parseWorkflowImportText(text); onChange({ ...value, apiFormatJson: text }) } catch (error) { onImportError(error instanceof Error ? error.message : 'workflowInvalidJson') }
  }

  if (!identityLocked) {
    const hasUnconfirmedAmbiguous = analysis?.proposals.some((proposal) => (
      proposal.confidence === 'ambiguous' && !roles[proposal.id]
    )) ?? false
    const canConfirm = Boolean(analysis && analysis.outputs.length > 0 && primaryOutputNodeId && !hasUnconfirmedAmbiguous)
    const confirmAnalysis = () => {
      if (!analysis) return
      try {
        const overlay = confirmWorkflowAnalysis(analysis, { roles, primaryOutputNodeId })
        onChange({
          ...value,
          mediaType: analysis.mediaType,
          purpose: analysis.purpose,
          apiFormatJson: JSON.stringify(analysis.graph, null, 2),
          ...overlay,
        })
        setStage('validate')
      } catch {
        onImportError('workflowRequestInvalid')
      }
    }

    return <fieldset disabled={disabled} className="min-w-0 space-y-5">
      <legend className="sr-only">{t('editor')}</legend>
      <label className="block text-sm">{t('name')}<input className={inputClass} value={value.name} maxLength={160} onChange={(event) => onChange({ ...value, name: event.target.value })} /></label>
      {stage === 'upload' && <WorkflowUploadStep disabled={disabled} onError={(error) => onImportError(safeWorkflowErrorKey(error))} onAnalyzed={(_sourceText, nextAnalysis) => {
        setAnalysis(nextAnalysis)
        setRoles({})
        setPrimaryOutputNodeId(nextAnalysis.outputs.find((output) => output.primary)?.nodeId || (nextAnalysis.outputs.length === 1 ? nextAnalysis.outputs[0]?.nodeId || '' : ''))
        setStage('mapping')
      }} />}
      {stage === 'mapping' && analysis && <>
        <WorkflowAutoMappingTable analysis={analysis} roles={roles} primaryOutputNodeId={primaryOutputNodeId} onRoleChange={(id, role) => setRoles((current) => ({ ...current, [id]: role }))} onPrimaryOutputChange={setPrimaryOutputNodeId} />
        <div className="flex flex-wrap gap-2"><button type="button" className="glass-btn-base px-4 py-2 text-sm" onClick={() => { setAnalysis(null); setStage('upload') }}>{t('chooseAnotherFile')}</button><button type="button" disabled={!canConfirm} className="glass-btn-base glass-btn-tone-info px-4 py-2 text-sm disabled:opacity-50" onClick={confirmAnalysis}>{t('confirmMappings')}</button></div>
      </>}
      {stage === 'validate' && analysis && <section className="glass-surface-soft space-y-3 rounded-xl p-4"><div><h4 className="font-medium">{t('mappingConfirmed')}</h4><p className="text-xs text-[var(--glass-text-secondary)]">{t('mappingConfirmedHint', { inputs: value.bindings.length, outputs: value.outputs.length })}</p></div><button type="button" className="glass-btn-base px-3 py-1.5 text-xs" onClick={() => setStage('mapping')}>{t('reviewMappings')}</button></section>}
    </fieldset>
  }

  return <fieldset disabled={disabled} className="min-w-0 space-y-5">
    <legend className="sr-only">{t('editor')}</legend>
    <div className="grid gap-3 sm:grid-cols-3"><label className="text-sm">{t('name')}<input className={inputClass} value={value.name} maxLength={160} onChange={(event) => onChange({ ...value, name: event.target.value })} /></label>
      <label className="text-sm">{t('mediaType')}<select disabled={identityLocked || value.purpose === 'upscale'} className={inputClass} value={value.mediaType} onChange={(event) => onChange({ ...value, mediaType: event.target.value as 'image' | 'video', outputs: value.outputs.map((output) => ({ ...output, mediaType: event.target.value as 'image' | 'video' })) })}><option value="image">{t('image')}</option><option value="video">{t('video')}</option></select>{identityLocked && <span className="mt-1 block text-xs text-[var(--glass-text-tertiary)]">{t('mediaTypeImmutable')}</span>}</label>
      <label className="text-sm">{t('purpose')}<select disabled={identityLocked} className={inputClass} value={value.purpose} onChange={(event) => onChange({ ...value, purpose: event.target.value as 'generation' | 'upscale', mediaType: event.target.value === 'upscale' ? 'image' : value.mediaType, outputs: value.outputs.map((output) => ({ ...output, mediaType: event.target.value === 'upscale' ? 'image' : output.mediaType })) })}><option value="generation">{t('purposes.generation')}</option><option value="upscale">{t('purposes.upscale')}</option></select>{identityLocked && <span className="mt-1 block text-xs text-[var(--glass-text-tertiary)]">{t('purposeImmutable')}</span>}</label></div>
    {value.purpose === 'upscale' && <p className="text-xs text-[var(--glass-text-secondary)]">{t('upscaleContractHint')}</p>}
    <section className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-2"><label htmlFor="api-format-json" className="font-medium">{t('apiFormat')}</label>
      <button type="button" className="glass-btn-base px-3 py-1.5 text-xs" onClick={() => fileRef.current?.click()}>{t('importFile')}</button></div>
      <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" onChange={async (event) => {
        const file = event.target.files?.[0]; if (!file) return
        try { importText(await readWorkflowImportFile(file)) } catch (error) { onImportError(error instanceof Error ? error.message : 'workflowInvalidJson') }
        event.target.value = ''
      }} />
      <textarea id="api-format-json" aria-label={t('importPaste')} value={value.apiFormatJson} rows={10} className={`${inputClass} resize-y font-mono text-xs`} onChange={(event) => onChange({ ...value, apiFormatJson: event.target.value })} onBlur={(event) => { if (event.target.value) importText(event.target.value) }} />
      <p className="text-xs text-[var(--glass-text-tertiary)]">{t('clientValidationHint', { megabytes: MAX_WORKFLOW_JSON_BYTES / 1024 / 1024 })}</p>
    </section>
    <section aria-labelledby="workflow-variables" className="space-y-2"><div className="flex items-center justify-between"><h4 id="workflow-variables" className="font-medium">{t('variables')}</h4>
      <button type="button" className="glass-btn-base px-3 py-1.5 text-xs" onClick={() => onChange({ ...value, variableDefinitions: [...value.variableDefinitions, { name: '', type: 'string', required: false, missingValuePolicy: 'preserve_original' }] })}>{t('addVariable')}</button></div>
      {placeholders.length > 0 && <div className="flex flex-wrap gap-2" aria-label={t('placeholders')}>{placeholders.map((name) => <button key={name} type="button" className="glass-badge rounded-full px-2 py-1 text-xs" onClick={() => {
        if (value.variableDefinitions.some((item) => item.name === name)) return
        onChange({ ...value, variableDefinitions: [...value.variableDefinitions, { name, type: 'string', required: true }] })
      }}>{name}</button>)}</div>}
      <div className="space-y-2">{value.variableDefinitions.map((variable, index) => <div key={index} className="grid min-w-0 gap-2 rounded-xl border border-[var(--glass-stroke-base)] p-3 sm:grid-cols-2">
        <label className="text-xs">{t('variable')}<input className={inputClass} value={variable.name} onChange={(event) => updateVariable(index, { name: event.target.value })} /></label>
        <label className="text-xs">{t('type')}<select className={inputClass} value={variable.type} onChange={(event) => updateVariable(index, { type: event.target.value as ComfyVariableType, defaultValue: undefined })}>{VARIABLE_TYPES.map((type) => <option key={type}>{type}</option>)}</select></label>
        <label className="text-xs">{t('defaultValue')}<input className={inputClass} disabled={!['string', 'number', 'boolean'].includes(variable.type)} value={typeof variable.defaultValue === 'string' || typeof variable.defaultValue === 'number' || typeof variable.defaultValue === 'boolean' ? String(variable.defaultValue) : ''} onChange={(event) => updateVariable(index, { defaultValue: parseDefault(variable.type, event.target.value) })} /></label>
        <label className="text-xs">{t('options')}<input className={inputClass} disabled={!['string', 'number', 'boolean'].includes(variable.type)} value={variable.options?.join(', ') ?? ''} onChange={(event) => updateVariable(index, { options: event.target.value ? event.target.value.split(',').map((item) => item.trim()).filter(Boolean).map((item) => variable.type === 'number' ? Number(item) : variable.type === 'boolean' ? item === 'true' : item) : undefined })} /></label>
        <label className="flex items-center gap-2 self-end text-xs"><input type="checkbox" checked={variable.required} onChange={(event) => updateVariable(index, { required: event.target.checked, missingValuePolicy: event.target.checked ? undefined : 'preserve_original' })} />{t('required')}</label>
        <button type="button" className="self-end text-xs text-[var(--glass-danger)]" onClick={() => onChange({ ...value, variableDefinitions: value.variableDefinitions.filter((_, itemIndex) => itemIndex !== index) })}>{t('remove')}</button>
      </div>)}</div>
    </section>
    <WorkflowMappingTable variables={value.variableDefinitions} bindings={value.bindings} outputs={value.outputs} mediaType={value.mediaType}
      onBindingsChange={(bindings) => onChange({ ...value, bindings })} onOutputsChange={(outputs) => onChange({ ...value, outputs })} />
  </fieldset>
}
