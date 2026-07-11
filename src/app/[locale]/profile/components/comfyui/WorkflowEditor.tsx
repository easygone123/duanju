'use client'

import { useMemo, useRef } from 'react'
import { useTranslations } from 'next-intl'
import type { ComfyVariableDefinition, ComfyVariableType } from '@/lib/comfyui/types'
import WorkflowMappingTable from './WorkflowMappingTable'
import {
  MAX_WORKFLOW_JSON_BYTES,
  discoverPlaceholderNames,
  parseWorkflowImportText,
  readWorkflowImportFile,
  type WorkflowAuthorDraft,
} from './workflow-ui'

interface Props { value: WorkflowAuthorDraft; disabled?: boolean; onChange(value: WorkflowAuthorDraft): void; onImportError(key: string): void }
const VARIABLE_TYPES: ComfyVariableType[] = ['string', 'number', 'boolean', 'image_ref', 'image_ref_list', 'video_ref']
const inputClass = 'w-full min-w-0 rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-3 py-2 text-sm'

function parseDefault(type: ComfyVariableType, raw: string) {
  if (!raw) return undefined
  if (type === 'number') return Number(raw)
  if (type === 'boolean') return raw === 'true'
  return raw
}

export default function WorkflowEditor({ value, disabled, onChange, onImportError }: Props) {
  const t = useTranslations('comfyui.workflows')
  const fileRef = useRef<HTMLInputElement>(null)
  const placeholders = useMemo(() => discoverPlaceholderNames(value.apiFormatJson), [value.apiFormatJson])
  const updateVariable = (index: number, patch: Partial<ComfyVariableDefinition>) => onChange({ ...value,
    variableDefinitions: value.variableDefinitions.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
  })
  const importText = (text: string) => {
    try { parseWorkflowImportText(text); onChange({ ...value, apiFormatJson: text }) } catch (error) { onImportError(error instanceof Error ? error.message : 'workflowInvalidJson') }
  }

  return <fieldset disabled={disabled} className="space-y-5">
    <legend className="sr-only">{t('editor')}</legend>
    <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">{t('name')}<input className={inputClass} value={value.name} maxLength={160} onChange={(event) => onChange({ ...value, name: event.target.value })} /></label>
      <label className="text-sm">{t('mediaType')}<select className={inputClass} value={value.mediaType} onChange={(event) => onChange({ ...value, mediaType: event.target.value as 'image' | 'video' })}><option value="image">{t('image')}</option><option value="video">{t('video')}</option></select></label></div>
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
      <div className="space-y-2">{value.variableDefinitions.map((variable, index) => <div key={index} className="grid gap-2 rounded-xl border border-[var(--glass-stroke-base)] p-3 sm:grid-cols-2 xl:grid-cols-5">
        <label className="text-xs">{t('variable')}<input className={inputClass} value={variable.name} onChange={(event) => updateVariable(index, { name: event.target.value })} /></label>
        <label className="text-xs">{t('type')}<select className={inputClass} value={variable.type} onChange={(event) => updateVariable(index, { type: event.target.value as ComfyVariableType, defaultValue: undefined })}>{VARIABLE_TYPES.map((type) => <option key={type}>{type}</option>)}</select></label>
        <label className="text-xs">{t('defaultValue')}<input className={inputClass} value={typeof variable.defaultValue === 'string' || typeof variable.defaultValue === 'number' || typeof variable.defaultValue === 'boolean' ? String(variable.defaultValue) : ''} onChange={(event) => updateVariable(index, { defaultValue: parseDefault(variable.type, event.target.value) })} /></label>
        <label className="flex items-center gap-2 self-end text-xs"><input type="checkbox" checked={variable.required} onChange={(event) => updateVariable(index, { required: event.target.checked, missingValuePolicy: event.target.checked ? undefined : 'preserve_original' })} />{t('required')}</label>
        <button type="button" className="self-end text-xs text-[var(--glass-danger)]" onClick={() => onChange({ ...value, variableDefinitions: value.variableDefinitions.filter((_, itemIndex) => itemIndex !== index) })}>{t('remove')}</button>
      </div>)}</div>
    </section>
    <WorkflowMappingTable variables={value.variableDefinitions} bindings={value.bindings} outputs={value.outputs} mediaType={value.mediaType}
      onBindingsChange={(bindings) => onChange({ ...value, bindings })} onOutputsChange={(outputs) => onChange({ ...value, outputs })} />
  </fieldset>
}
