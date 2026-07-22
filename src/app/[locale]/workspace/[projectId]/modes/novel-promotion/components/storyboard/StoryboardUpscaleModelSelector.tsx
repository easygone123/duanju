'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'

import { useToast } from '@/contexts/ToastContext'
import { Link } from '@/i18n/navigation'
import { useWorkspaceStageRuntime } from '../../WorkspaceStageRuntimeContext'

export default function StoryboardUpscaleModelSelector() {
  const t = useTranslations('novelPromotion.storyboardRunSettings')
  const { showToast } = useToast()
  const runtime = useWorkspaceStageRuntime()
  const [selectedValue, setSelectedValue] = useState(runtime.storyboardUpscaleModel || '')
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setSelectedValue(runtime.storyboardUpscaleModel || '')
  }, [runtime.storyboardUpscaleModel])

  const hasPersistedSelection = useMemo(() => runtime.userUpscaleModels.some(
    (model) => model.value === runtime.storyboardUpscaleModel,
  ), [runtime.storyboardUpscaleModel, runtime.userUpscaleModels])

  const handleChange = useCallback(async (value: string) => {
    const previous = runtime.storyboardUpscaleModel || ''
    setSelectedValue(value)
    setIsSaving(true)
    try {
      const saved = await runtime.onStoryboardConfigChange(
        'storyboardUpscaleModel',
        value || null,
      )
      if (!saved) {
        setSelectedValue(previous)
        showToast(t('saveFailed'), 'error')
      }
    } catch {
      setSelectedValue(previous)
      showToast(t('saveFailed'), 'error')
    } finally {
      setIsSaving(false)
    }
  }, [runtime, showToast, t])

  return (
    <section className="mb-4 flex min-w-0 flex-col gap-2 rounded-xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] p-3 sm:flex-row sm:items-end sm:justify-between">
      <label className="min-w-0 flex-1 text-xs text-[var(--glass-text-secondary)]">
        <span className="mb-1 block font-medium">{t('upscaleModelLabel')}</span>
        <select
          value={selectedValue}
          disabled={isSaving}
          aria-label={t('upscaleModelLabel')}
          onChange={(event) => void handleChange(event.target.value)}
          className="glass-input-base w-full min-w-0 px-3 py-2 sm:max-w-xl"
        >
          <option value="">{t('noUpscaleModel')}</option>
          {!hasPersistedSelection && runtime.storyboardUpscaleModel && (
            <option value={runtime.storyboardUpscaleModel}>{runtime.storyboardUpscaleModel}</option>
          )}
          {runtime.userUpscaleModels.map((model) => (
            <option key={model.value} value={model.value}>{model.label}</option>
          ))}
        </select>
        <span className="mt-1 block break-words text-[11px] text-[var(--glass-text-tertiary)]">
          {runtime.userUpscaleModels.length === 0 ? t('comfyuiEmptyHint') : t('comfyuiManageHint')}
        </span>
      </label>
      <Link
        className="glass-btn-base glass-btn-secondary shrink-0 rounded-lg px-3 py-2 text-xs"
        href={{ pathname: '/profile', query: { section: 'comfyui' } }}
      >
        {t('manageComfyui')}
      </Link>
    </section>
  )
}
