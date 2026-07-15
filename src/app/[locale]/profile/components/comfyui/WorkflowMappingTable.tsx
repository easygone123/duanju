'use client'

import { useTranslations } from 'next-intl'
import type { ComfyInputBinding, ComfyOutputBinding, ComfyVariableDefinition } from '@/lib/comfyui/types'
import { removeWorkflowOutput, setPrimaryOutput } from './workflow-ui'

const TRANSFORMS = ['filename', 'image_ref', 'filename_list'] as const

interface Props {
  variables: ComfyVariableDefinition[]
  bindings: ComfyInputBinding[]
  outputs: ComfyOutputBinding[]
  mediaType: 'image' | 'video'
  onBindingsChange(value: ComfyInputBinding[]): void
  onOutputsChange(value: ComfyOutputBinding[]): void
}

const inputClass = 'w-full min-w-0 rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-2 py-1.5 text-xs'

export default function WorkflowMappingTable({ variables, bindings, outputs, mediaType, onBindingsChange, onOutputsChange }: Props) {
  const t = useTranslations('comfyui.workflows')
  const updateBinding = (index: number, patch: Partial<ComfyInputBinding>) => onBindingsChange(
    bindings.map((binding, itemIndex) => itemIndex === index ? { ...binding, ...patch } : binding),
  )
  const updateOutput = (index: number, patch: Partial<ComfyOutputBinding>) => onOutputsChange(
    outputs.map((output, itemIndex) => itemIndex === index ? { ...output, ...patch } : output),
  )

  return <div className="min-w-0 space-y-5">
    <section aria-labelledby="workflow-input-mappings">
      <div className="flex items-center justify-between gap-3"><h4 id="workflow-input-mappings" className="font-medium">{t('inputMappings')}</h4>
        <button type="button" className="glass-btn-base px-3 py-1.5 text-xs" onClick={() => onBindingsChange([...bindings, {
          nodeId: '', inputPath: '', variable: variables[0]?.name ?? '', valueType: variables[0]?.type ?? 'string',
        }])}>{t('addMapping')}</button></div>
      <div className="mt-2 space-y-2">
        {bindings.map((binding, index) => <div key={index} className="grid min-w-0 gap-2 rounded-xl border border-[var(--glass-stroke-base)] p-3 sm:grid-cols-2">
          <label className="text-xs">{t('nodeId')}<input className={inputClass} value={binding.nodeId} onChange={(event) => updateBinding(index, { nodeId: event.target.value })} /></label>
          <label className="text-xs">{t('inputPath')}<input className={inputClass} value={binding.inputPath} onChange={(event) => updateBinding(index, { inputPath: event.target.value })} /></label>
          <label className="text-xs">{t('variable')}<select className={inputClass} value={binding.variable} onChange={(event) => {
            const variable = variables.find((item) => item.name === event.target.value)
            updateBinding(index, { variable: event.target.value, valueType: variable?.type ?? 'string' })
          }}>{variables.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
          <label className="text-xs">{t('transform')}<select className={inputClass} value={binding.transform ?? ''} onChange={(event) => updateBinding(index, { transform: event.target.value ? event.target.value as typeof TRANSFORMS[number] : undefined })}>
            <option value="">{t('none')}</option>{TRANSFORMS.map((transform) => <option key={transform} value={transform}>{transform}</option>)}</select></label>
          <button type="button" className="self-end text-xs text-[var(--glass-danger)]" onClick={() => onBindingsChange(bindings.filter((_, itemIndex) => itemIndex !== index))}>{t('remove')}</button>
        </div>)}
      </div>
    </section>
    <section aria-labelledby="workflow-output-mappings">
      <div className="flex items-center justify-between gap-3"><h4 id="workflow-output-mappings" className="font-medium">{t('outputMappings')}</h4>
        <button type="button" className="glass-btn-base px-3 py-1.5 text-xs" onClick={() => onOutputsChange([...outputs, {
          name: `output_${outputs.length + 1}`, nodeId: '', fieldPath: mediaType === 'image' ? 'images' : 'videos', mediaType, primary: outputs.length === 0,
        }])}>{t('addOutput')}</button></div>
      <div className="mt-2 space-y-2">{outputs.map((output, index) => <div key={index} className="grid min-w-0 gap-2 rounded-xl border border-[var(--glass-stroke-base)] p-3 sm:grid-cols-2">
        <label className="text-xs">{t('outputName')}<input className={inputClass} value={output.name} onChange={(event) => updateOutput(index, { name: event.target.value })} /></label>
        <label className="text-xs">{t('nodeId')}<input className={inputClass} value={output.nodeId} onChange={(event) => updateOutput(index, { nodeId: event.target.value })} /></label>
        <label className="text-xs">{t('fieldPath')}<input className={inputClass} value={output.fieldPath} onChange={(event) => updateOutput(index, { fieldPath: event.target.value })} /></label>
        <label className="flex items-center gap-2 self-end text-xs"><input type="radio" name="primary-output" checked={output.primary} onChange={() => onOutputsChange(setPrimaryOutput(outputs, index))} />{t('primaryOutput')}</label>
        <button type="button" disabled={outputs.length <= 1} className="self-end text-xs text-[var(--glass-danger)] disabled:cursor-not-allowed disabled:opacity-40" onClick={() => onOutputsChange(removeWorkflowOutput(outputs, index))}>{t('remove')}</button>
      </div>)}</div>
    </section>
  </div>
}
