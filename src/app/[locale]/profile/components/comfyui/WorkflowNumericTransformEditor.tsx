'use client'

import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { convertComfyNumericBinding, decimalEquals } from '@/lib/comfyui/numeric-binding'
import type {
  ComfyNumericBindingTransform,
  ComfyNumericOutput,
  ComfyNumericRounding,
} from '@/lib/comfyui/types'

interface Props {
  role: 'duration' | 'fps'
  mappingIdentity?: string
  value: ComfyNumericBindingTransform
  sampleDuration?: number
  sampleFps?: number
  disabled?: boolean
  onChange(value: ComfyNumericBindingTransform): void
}

const inputClass = 'mt-1 w-full min-w-0 rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-2 py-1.5 text-xs'

function allowedValuesText(value: ComfyNumericBindingTransform) {
  return value.allowedTargetValues?.join(', ') ?? ''
}

function numericErrorReason(error: unknown) {
  if (!error || typeof error !== 'object' || !('details' in error)) return null
  const details = error.details
  if (!details || typeof details !== 'object' || !('reason' in details)) return null
  const reason = details.reason
  return reason === 'invalid_source'
    || reason === 'missing_fps'
    || reason === 'invalid_frames'
    || reason === 'unsupported_target'
    ? reason
    : null
}

export default function WorkflowNumericTransformEditor({
  role,
  mappingIdentity = '',
  value,
  sampleDuration = 5,
  sampleFps = 16,
  disabled = false,
  onChange,
}: Props) {
  const t = useTranslations('comfyui.workflows')
  const allowedValuesErrorId = `${useId()}-allowed-values-error`
  const editorIdentity = JSON.stringify([mappingIdentity, role])
  const canonicalAllowedText = allowedValuesText(value)
  const lastEditorIdentity = useRef(editorIdentity)
  const lastCanonicalAllowedText = useRef(canonicalAllowedText)
  const [allowedText, setAllowedText] = useState(canonicalAllowedText)
  const [allowedTextInvalid, setAllowedTextInvalid] = useState(false)
  const [sampleDurationText, setSampleDurationText] = useState(String(sampleDuration))
  const [runtimeFpsText, setRuntimeFpsText] = useState(String(sampleFps))
  const previewDuration = Number(sampleDurationText)
  const runtimeFps = Number(runtimeFpsText)

  useEffect(() => {
    if (lastEditorIdentity.current !== editorIdentity) {
      lastEditorIdentity.current = editorIdentity
      lastCanonicalAllowedText.current = canonicalAllowedText
      setAllowedText(canonicalAllowedText)
      setAllowedTextInvalid(false)
      return
    }
    if (lastCanonicalAllowedText.current === canonicalAllowedText || allowedTextInvalid) return
    lastCanonicalAllowedText.current = canonicalAllowedText
    setAllowedText(canonicalAllowedText)
  }, [allowedTextInvalid, canonicalAllowedText, editorIdentity])

  const preview = useMemo(() => {
    try {
      const sourceValue = role === 'fps' ? runtimeFps : previewDuration
      const diagnostic = convertComfyNumericBinding({
        variable: role,
        value: sourceValue,
        variables: { fps: runtimeFps },
        transform: value,
      })
      const encoded = diagnostic.encodedAs === 'numeric_string'
        ? JSON.stringify(diagnostic.encodedValue)
        : String(diagnostic.encodedValue)
      if (diagnostic.targetUnit === 'frames') {
        const rounding = diagnostic.rounding ?? value.rounding ?? 'round'
        return {
          text: `${rounding}(${diagnostic.sourceValue} × ${diagnostic.effectiveFps}) + ${diagnostic.frameOffset ?? 0} = ${encoded}`,
        }
      }
      return { text: `${diagnostic.sourceValue} → ${encoded}` }
    } catch (error) {
      return { reason: numericErrorReason(error) ?? 'invalid_source' as const }
    }
  }, [previewDuration, role, runtimeFps, value])

  const setTargetUnit = (targetUnit: 'seconds' | 'frames') => {
    if (targetUnit === 'seconds') {
      const next = { ...value }
      delete next.fps
      delete next.rounding
      delete next.frameOffset
      onChange({ ...next, sourceUnit: 'seconds', targetUnit: 'seconds' })
      return
    }
    onChange({
      ...value,
      sourceUnit: 'seconds',
      targetUnit: 'frames',
      fps: {
        source: 'runtime_then_fallback',
        variable: 'fps',
        fallback: value.fps?.fallback ?? runtimeFps,
      },
      rounding: value.rounding ?? 'round',
      frameOffset: value.frameOffset ?? 0,
    })
  }

  const setAllowedValues = (text: string) => {
    setAllowedText(text)
    const trimmed = text.trim()
    if (!trimmed) {
      setAllowedTextInvalid(false)
      const next = { ...value }
      delete next.allowedTargetValues
      onChange(next)
      return
    }
    const parts = text.split(',').map((item) => item.trim())
    const parsed = parts.map(Number)
    const duplicates = parsed.some((item, index) => parsed.slice(0, index).some((previous) => (
      value.targetUnit === 'frames' ? previous === item : decimalEquals(previous, item)
    )))
    const invalid = parts.some((item) => item.length === 0)
      || parsed.some((item) => !Number.isFinite(item) || item <= 0)
      || (value.targetUnit === 'frames' && parsed.some((item) => !Number.isSafeInteger(item)))
      || duplicates
    setAllowedTextInvalid(invalid)
    onChange({ ...value, allowedTargetValues: invalid ? [] : parsed })
  }

  return <div className="min-w-0 space-y-3 rounded-lg bg-[var(--glass-bg-surface)] p-3 sm:col-span-full">
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      {role === 'duration' && <label className="min-w-0 text-xs">
        {t('numeric.sampleDuration')}
        <input
          aria-label={t('numeric.sampleDuration')}
          className={inputClass}
          disabled={disabled}
          type="number"
          min="0.001"
          step="any"
          value={sampleDurationText}
          onChange={(event) => setSampleDurationText(event.target.value)}
        />
      </label>}
      <label className="min-w-0 text-xs">
        {t('numeric.runtimeFps')}
        <input
          aria-label={t('numeric.runtimeFps')}
          className={inputClass}
          disabled={disabled}
          type="number"
          min="0.001"
          step="any"
          value={runtimeFpsText}
          onChange={(event) => setRuntimeFpsText(event.target.value)}
        />
      </label>
      {role === 'duration' && <label className="min-w-0 text-xs">
        {t('numeric.targetUnit')}
        <select
          aria-label={t('numeric.targetUnit')}
          className={inputClass}
          disabled={disabled}
          value={value.targetUnit}
          onChange={(event) => setTargetUnit(event.target.value as 'seconds' | 'frames')}
        >
          <option value="seconds">{t('numeric.seconds')}</option>
          <option value="frames">{t('numeric.frames')}</option>
        </select>
      </label>}
      <label className="min-w-0 text-xs">
        {t('numeric.outputFormat')}
        <select
          aria-label={t('numeric.outputFormat')}
          className={inputClass}
          disabled={disabled}
          value={value.output}
          onChange={(event) => onChange({ ...value, output: event.target.value as ComfyNumericOutput })}
        >
          <option value="number">{t('numeric.number')}</option>
          <option value="numeric_string">{t('numeric.numericString')}</option>
        </select>
      </label>
      {role === 'duration' && value.targetUnit === 'frames' && <>
        <label className="min-w-0 text-xs">
          {t('numeric.fallbackFps')}
          <input
            aria-label={t('numeric.fallbackFps')}
            className={inputClass}
            disabled={disabled}
            type="number"
            min="0.001"
            step="any"
            value={Number.isFinite(value.fps?.fallback) ? value.fps?.fallback : ''}
            onChange={(event) => onChange({
              ...value,
              fps: {
                source: 'runtime_then_fallback',
                variable: 'fps',
                fallback: event.target.value === '' ? Number.NaN : Number(event.target.value),
              },
            })}
          />
        </label>
        <label className="min-w-0 text-xs">
          {t('numeric.rounding')}
          <select
            aria-label={t('numeric.rounding')}
            className={inputClass}
            disabled={disabled}
            value={value.rounding ?? 'round'}
            onChange={(event) => onChange({
              ...value,
              rounding: event.target.value as ComfyNumericRounding,
            })}
          >
            <option value="round">round</option>
            <option value="floor">floor</option>
            <option value="ceil">ceil</option>
          </select>
        </label>
        <label className="min-w-0 text-xs">
          {t('numeric.frameOffset')}
          <select
            aria-label={t('numeric.frameOffset')}
            className={inputClass}
            disabled={disabled}
            value={value.frameOffset ?? 0}
            onChange={(event) => onChange({
              ...value,
              frameOffset: Number(event.target.value) as 0 | 1,
            })}
          >
            <option value="0">0</option>
            <option value="1">1</option>
          </select>
        </label>
      </>}
      <label className="min-w-0 text-xs sm:col-span-2">
        {t('numeric.allowedValues')}
        <input
          aria-label={t('numeric.allowedValues')}
          aria-invalid={allowedTextInvalid || undefined}
          aria-describedby={allowedTextInvalid ? allowedValuesErrorId : undefined}
          className={inputClass}
          disabled={disabled}
          inputMode="decimal"
          value={allowedText}
          onChange={(event) => setAllowedValues(event.target.value)}
        />
      </label>
    </div>
    {allowedTextInvalid && <p
      id={allowedValuesErrorId}
      role="alert"
      className="text-xs text-[var(--glass-danger)]"
    >
      {t('numeric.invalidAllowedValues')}
    </p>}
    <p className="text-xs text-[var(--glass-text-secondary)]">
      {t('numeric.preview')}: {'text' in preview ? preview.text : t(`numeric.errors.${preview.reason}`)}
    </p>
  </div>
}
