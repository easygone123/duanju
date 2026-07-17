'use client'

import React from 'react'
import { useTranslations } from 'next-intl'
import { AppIcon } from '@/components/ui/icons'
import type { NovelPromotionStoryboard } from '@/types/project'
import { Link } from '@/i18n/navigation'

export type SixGridUpscaleWorkflow = {
  workflowId: string
  workflowVersionId: string
  label: string
}

interface Props {
  storyboard: NovelPromotionStoryboard
  isTaskRunning: boolean
  upscaleWorkflow: SixGridUpscaleWorkflow | null
  generationError?: string | null
  onGenerateSheet: () => void
  onPreviewSheet: (url: string) => void
  onUpscaleSheet: (workflow: SixGridUpscaleWorkflow) => void
  onOpenCrop: () => void
  onViewPrompt: () => void
  onUploadSheet: () => void
}

export default function SixGridGroupControls({
  storyboard, isTaskRunning, upscaleWorkflow, generationError, onGenerateSheet, onPreviewSheet, onUpscaleSheet, onOpenCrop,
  onViewPrompt, onUploadSheet,
}: Props) {
  const t = useTranslations('storyboard.sixGrid')
  if (storyboard.layoutMode !== 'six_grid') return null

  const hasSheet = Boolean(storyboard.sheetImageUrl)
  const hasUpscaledSheet = Boolean(storyboard.upscaledSheetImageUrl)
  const order = storyboard.sixGridProcessingOrder || 'crop_then_panel_upscale'
  const cropRequiresUpscaled = order === 'sheet_upscale_then_crop'
  const canCrop = hasSheet && (!cropRequiresUpscaled || hasUpscaledSheet)
  const cropDisabledReason = !hasSheet ? t('sheetRequired') : cropRequiresUpscaled && !hasUpscaledSheet
    ? t('upscaledSheetRequired') : undefined
  const upscaleDisabledReason = !hasSheet ? t('sheetRequired') : !upscaleWorkflow
    ? t('workflowRequired') : undefined
  const source = cropRequiresUpscaled
    ? (hasUpscaledSheet ? t('sourceUpscaled') : t('sourceMissing'))
    : (hasSheet ? t('sourceOriginal') : t('sourceMissing'))

  return (
    <section className="mb-4 rounded-xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] p-3" aria-label={t('title')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--glass-text-primary)]">{t('title')}</h3>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--glass-text-secondary)]">
            <span>{t('sourceLabel')}: {source}</span>
            <span>{t('artifactVersion', { version: storyboard.sheetArtifactVersion || 0 })}</span>
            <span>{t('status', { status: isTaskRunning ? t('running') : t('idle') })}</span>
          </div>
        </div>
        <Link
          href={{ pathname: '/profile', query: { section: 'comfyui' } }}
          className="glass-btn-base glass-btn-secondary rounded-lg px-3 py-1.5 text-xs"
          title={t('comfyuiHint')}
        >
          <AppIcon name="settingsHexAlt" className="h-3.5 w-3.5" />
          {t('manageComfyui')}
        </Link>
      </div>

      <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <div className={`rounded-lg border p-2 ${order === 'sheet_upscale_then_crop' ? 'border-[var(--glass-stroke-focus)]' : 'border-[var(--glass-stroke-base)]'}`}>
          <strong>{t('orders.sheet_upscale_then_crop')}</strong>
        </div>
        <div className={`rounded-lg border p-2 ${order === 'crop_then_panel_upscale' ? 'border-[var(--glass-stroke-focus)]' : 'border-[var(--glass-stroke-base)]'}`}>
          <strong>{t('orders.crop_then_panel_upscale')}</strong>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="glass-btn-base glass-btn-secondary rounded-lg px-3 py-1.5 text-xs" onClick={onViewPrompt}>
          <AppIcon name="eye" className="h-3.5 w-3.5" />
          {t('viewPrompt')}
        </button>
        <button type="button" className="glass-btn-base glass-btn-secondary rounded-lg px-3 py-1.5 text-xs" disabled={isTaskRunning} onClick={onUploadSheet}>
          <AppIcon name="upload" className="h-3.5 w-3.5" />
          {t('uploadSheet')}
        </button>
        <button type="button" className="glass-btn-base glass-btn-primary rounded-lg px-3 py-1.5 text-xs" disabled={isTaskRunning} onClick={onGenerateSheet}>
          <AppIcon name="imagePreview" className="h-3.5 w-3.5" />
          {hasSheet ? t('regenerateSheet') : t('generateSheet')}
        </button>
        <button type="button" className="glass-btn-base glass-btn-secondary rounded-lg px-3 py-1.5 text-xs" disabled={!hasSheet} title={!hasSheet ? t('sheetRequired') : undefined} onClick={() => storyboard.sheetImageUrl && onPreviewSheet(storyboard.sheetImageUrl)}>
          {t('previewOriginal')}
        </button>
        <button type="button" className="glass-btn-base glass-btn-secondary rounded-lg px-3 py-1.5 text-xs" disabled={isTaskRunning || Boolean(upscaleDisabledReason)} title={upscaleDisabledReason} onClick={() => upscaleWorkflow && onUpscaleSheet(upscaleWorkflow)}>
          {t('upscaleSheet')}
        </button>
        <button type="button" className="glass-btn-base glass-btn-secondary rounded-lg px-3 py-1.5 text-xs" disabled={isTaskRunning || !canCrop} title={cropDisabledReason} onClick={onOpenCrop}>
          {t('crop')}
        </button>
      </div>
      {generationError && (
        <p role="alert" className="mt-3 text-xs text-[var(--glass-tone-danger-fg)]">
          {t('generationFailed', { message: generationError })}
        </p>
      )}
    </section>
  )
}
