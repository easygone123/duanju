'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { ComfyVariableDefinition, ComfyVariableValue } from '@/lib/comfyui/types'

const MAX_LIVE_TEST_UPLOAD_BYTES = 25 * 1024 * 1024
const ALLOWED_MEDIA_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime',
])

export interface LiveTestUploadPayload { filename: string; contentType: string; base64: string }
export interface WorkflowTestPayload {
  variables: Record<string, ComfyVariableValue>
  uploads: Record<string, LiveTestUploadPayload | LiveTestUploadPayload[]>
}

export function emptyWorkflowTestPayload(): WorkflowTestPayload { return { variables: {}, uploads: {} } }

type RawValues = Record<string, string | boolean>
type UploadValues = Record<string, LiveTestUploadPayload[]>
interface BuildWorkflowTestPayloadOptions {
  positiveNumberVariables?: ReadonlySet<string>
}

export function buildWorkflowTestPayload(
  definitions: ComfyVariableDefinition[], rawValues: RawValues, uploadValues: UploadValues,
  options: BuildWorkflowTestPayloadOptions = {},
): { payload: WorkflowTestPayload | null; missing: string[] } {
  const variables: Record<string, ComfyVariableValue> = {}
  const uploads: WorkflowTestPayload['uploads'] = {}
  const missing: string[] = []
  for (const variable of definitions) {
    if (['image_ref', 'video_ref', 'image_ref_list'].includes(variable.type)) {
      const files = uploadValues[variable.name] ?? []
      if (variable.required && files.length === 0) missing.push(variable.name)
      if (files.length > 0) {
        const refs = files.map((file) => ({ storageKey: file.filename, filename: file.filename, mimeType: file.contentType }))
        variables[variable.name] = variable.type === 'image_ref_list' ? refs : refs[0]
        uploads[variable.name] = variable.type === 'image_ref_list' ? files : files[0]
      }
      continue
    }
    const raw = rawValues[variable.name]
    const absent = raw === undefined || raw === ''
    if (absent) {
      if (variable.required) missing.push(variable.name)
      continue
    }
    const parsed = variable.type === 'number' ? Number(raw) : variable.type === 'boolean' ? raw === true || raw === 'true' : String(raw)
    if (variable.type === 'number' && !Number.isFinite(parsed)) { missing.push(variable.name); continue }
    if (variable.type === 'number'
      && options.positiveNumberVariables?.has(variable.name)
      && Number(parsed) <= 0) { missing.push(variable.name); continue }
    if (variable.options?.length && !variable.options.includes(parsed as never)) { missing.push(variable.name); continue }
    variables[variable.name] = parsed as ComfyVariableValue
  }
  return { payload: missing.length === 0 ? { variables, uploads } : null, missing }
}

export async function fileToLiveTestUpload(file: File): Promise<LiveTestUploadPayload> {
  if (!ALLOWED_MEDIA_TYPES.has(file.type) || file.size <= 0 || file.size > MAX_LIVE_TEST_UPLOAD_BYTES) throw new Error('testUploadInvalid')
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('testUploadInvalid'))
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('testUploadInvalid'))
    reader.readAsDataURL(file)
  })
  const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[^A-Za-z0-9]+/, '') || 'upload.bin'
  return { filename: safeName.slice(0, 255), contentType: file.type, base64: dataUrl.slice(dataUrl.indexOf(',') + 1) }
}

export async function filesToLiveTestUploads(files: File[], variableType: ComfyVariableDefinition['type']) {
  if (files.length === 0 || files.length > (variableType === 'image_ref_list' ? 8 : 1)
    || files.some((file) => variableType === 'video_ref'
      ? !file.type.startsWith('video/') : !file.type.startsWith('image/'))) {
    throw new Error('testUploadInvalid')
  }
  if (files.reduce((sum, file) => sum + file.size, 0) > 32 * 1024 * 1024) throw new Error('testUploadTotalTooLarge')
  const uploads: LiveTestUploadPayload[] = []
  for (const file of files) uploads.push(await fileToLiveTestUpload(file))
  return uploads
}

type UploadConverter = (files: File[], variableType: ComfyVariableDefinition['type']) => Promise<LiveTestUploadPayload[]>

export function createWorkflowUploadSelectionController(convert: UploadConverter = filesToLiveTestUploads) {
  const generations = new Map<string, number>()
  let mounted = true
  return {
    async select(
      variableName: string,
      files: File[],
      variableType: ComfyVariableDefinition['type'],
      commit: (value: LiveTestUploadPayload[]) => void,
      onError: (key: string) => void,
    ) {
      const generation = (generations.get(variableName) ?? 0) + 1
      generations.set(variableName, generation)
      commit([])
      if (files.length === 0) return
      try {
        const uploads = await convert(files, variableType)
        if (mounted && generations.get(variableName) === generation) commit(uploads)
      } catch (error) {
        if (mounted && generations.get(variableName) === generation) {
          onError(error instanceof Error && error.message === 'testUploadTotalTooLarge' ? error.message : 'testUploadInvalid')
        }
      }
    },
    dispose() { mounted = false },
  }
}

interface Props {
  definitions: ComfyVariableDefinition[]
  positiveNumberVariables?: ReadonlySet<string>
  labelOverrides?: Readonly<Record<string, string>>
  hintOverrides?: Readonly<Record<string, string>>
  onChange(payload: WorkflowTestPayload | null): void
  onError(key: string): void
}
const inputClass = 'mt-1 w-full rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-2 py-2 text-xs'

export default function WorkflowTestForm({
  definitions,
  positiveNumberVariables,
  labelOverrides = {},
  hintOverrides = {},
  onChange,
  onError,
}: Props) {
  const t = useTranslations('comfyui.workflows')
  const [rawValues, setRawValues] = useState<RawValues>(() => Object.fromEntries(definitions.flatMap((item) =>
    item.defaultValue !== undefined && ['string', 'number', 'boolean'].includes(item.type) ? [[item.name, String(item.defaultValue)]] : [])))
  const [uploadValues, setUploadValues] = useState<UploadValues>({})
  const uploadController = useRef<ReturnType<typeof createWorkflowUploadSelectionController> | null>(null)
  if (!uploadController.current) uploadController.current = createWorkflowUploadSelectionController()
  useEffect(() => () => uploadController.current?.dispose(), [])
  const result = useMemo(() => buildWorkflowTestPayload(
    definitions, rawValues, uploadValues, { positiveNumberVariables },
  ), [definitions, positiveNumberVariables, rawValues, uploadValues])
  useEffect(() => onChange(result.payload), [onChange, result.payload])
  if (definitions.length === 0) return null
  return <fieldset className="space-y-2 rounded-xl border border-[var(--glass-stroke-base)] p-3"><legend className="px-1 text-sm font-medium">{t('testInputs')}</legend>
    {definitions.map((variable) => <label key={variable.name} className="block text-xs">{labelOverrides[variable.name] ?? variable.name}{variable.required ? ' *' : ''}
      {['image_ref', 'video_ref', 'image_ref_list'].includes(variable.type) ? <input className={inputClass} type="file" multiple={variable.type === 'image_ref_list'} accept={variable.type === 'video_ref' ? 'video/mp4,video/webm,video/quicktime' : 'image/png,image/jpeg,image/webp'} onChange={(event) => {
        void uploadController.current?.select(variable.name, Array.from(event.target.files ?? []), variable.type, (files) => {
          setUploadValues((current) => {
            const next = { ...current }
            if (files.length === 0) delete next[variable.name]
            else next[variable.name] = files
            return next
          })
        }, onError)
      }} /> : variable.options?.length ? <select className={inputClass} required={variable.required} value={String(rawValues[variable.name] ?? '')} onChange={(event) => setRawValues((current) => ({ ...current, [variable.name]: event.target.value }))}>
        <option value="">{t('selectValue')}</option>{variable.options.map((option) => <option key={String(option)} value={String(option)}>{String(option)}</option>)}</select> : variable.type === 'boolean' ? <select className={inputClass} required={variable.required} value={String(rawValues[variable.name] ?? '')} onChange={(event) => setRawValues((current) => ({ ...current, [variable.name]: event.target.value }))}>
        <option value="">{t('selectValue')}</option><option value="true">true</option><option value="false">false</option></select> : <input className={inputClass} required={variable.required} type={variable.type === 'number' ? 'number' : 'text'} value={String(rawValues[variable.name] ?? '')} onChange={(event) => setRawValues((current) => ({ ...current, [variable.name]: event.target.value }))} />}
      {hintOverrides[variable.name] && <span className="mt-1 block text-[var(--glass-text-tertiary)]">{hintOverrides[variable.name]}</span>}
    </label>)}
    {result.missing.length > 0 && <p role="alert" className="text-xs text-[var(--glass-danger)]">{
      result.missing.some((name) => positiveNumberVariables?.has(name))
        ? t('videoTestDurationInvalid')
        : t('testInputsMissing', { fields: result.missing.join(', ') })
    }</p>}
  </fieldset>
}
