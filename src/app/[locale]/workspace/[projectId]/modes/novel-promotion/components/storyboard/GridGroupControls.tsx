'use client'
/* eslint-disable @next/next/no-img-element -- the owned storyboard sheet is already served through the media URL contract */

import React from 'react'
import { useTranslations } from 'next-intl'
import { AppIcon } from '@/components/ui/icons'
import type { NovelPromotionStoryboard } from '@/types/project'
import { Link } from '@/i18n/navigation'
import { isGridStoryboardMode, resolveStoryboardGridSpec } from '@/lib/novel-promotion/grid-storyboard/spec'
import { toDisplayImageUrl } from '@/lib/media/image-url'

export type GridUpscaleWorkflow = {
  workflowId: string
  workflowVersionId: string
  label: string
}

export interface GridGroupControlsProps {
  storyboard: NovelPromotionStoryboard
  isTaskRunning: boolean
  upscaleWorkflow: GridUpscaleWorkflow | null
  generationError?: string | null
  onGenerateSheet: () => void
  onPreviewSheet: (url: string) => void
  onUpscaleSheet: (workflow: GridUpscaleWorkflow) => void
  onOpenCrop: () => void
  onViewPrompt: () => void
  onUploadSheet: () => void
  /** Keeps the legacy public SixGridGroupControls translation contract intact. */
  translationNamespace?: 'storyboard.grid' | 'storyboard.sixGrid'
}

function includesUnsupportedRatio(error: string) {
  return error.includes('SIX_GRID_ASPECT_RATIO_UNSUPPORTED')
    || error.includes('IMAGE_MODEL_ASPECT_RATIO_UNSUPPORTED')
}

export default function GridGroupControls({
  storyboard,
  isTaskRunning,
  upscaleWorkflow,
  generationError,
  onGenerateSheet,
  onPreviewSheet,
  onUpscaleSheet,
  onOpenCrop,
  onViewPrompt,
  onUploadSheet,
  translationNamespace = 'storyboard.grid',
}: GridGroupControlsProps) {
  const t = useTranslations(translationNamespace)
  if (!isGridStoryboardMode(storyboard.layoutMode)) return null

  const mode = storyboard.layoutMode
  const isLegacySixGrid = translationNamespace === 'storyboard.sixGrid'
  const cellRatio = storyboard.sixGridCellAspectRatio === '9:16' ? '9:16' : '16:9'
  const spec = resolveStoryboardGridSpec(mode, cellRatio)
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
  const title = isLegacySixGrid ? t('title') : t(`title.${mode}`)
  const generateLabel = isLegacySixGrid
    ? t(hasSheet ? 'regenerateSheet' : 'generateSheet')
    : t(`${hasSheet ? 'regenerateSheet' : 'generateSheet'}.${mode}`)
  const errorMessage = generationError && mode === 'six_grid' && includesUnsupportedRatio(generationError)
    ? t('sixGridRatioUnsupported')
    : generationError

  return (
    <section className="mb-4 min-w-0 rounded-xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] p-3" aria-label={title}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words text-sm font-semibold text-[var(--glass-text-primary)]">{title}</h3>
          <div className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--glass-text-secondary)]">
            <span>{t('sourceLabel')}: {source}</span>
            {!isLegacySixGrid && <span>{spec.columns}×{spec.rows} · {spec.sheetAspectRatio}</span>}
            <span>{t('artifactVersion', { version: storyboard.sheetArtifactVersion || 0 })}</span>
            <span>{t('status', { status: isTaskRunning ? t('running') : t('idle') })}</span>
          </div>
        </div>
        <Link
          href={{ pathname: '/profile', query: { section: 'comfyui' } }}
          className="glass-btn-base glass-btn-secondary shrink-0 rounded-lg px-3 py-1.5 text-xs"
          title={t('comfyuiHint')}
        >
          <AppIcon name="settingsHexAlt" className="h-3.5 w-3.5" />
          {t('manageComfyui')}
        </Link>
      </div>

      <div className="mt-3 grid min-w-0 gap-2 text-xs sm:grid-cols-2">
        <div className={`min-w-0 break-words rounded-lg border p-2 ${order === 'sheet_upscale_then_crop' ? 'border-[var(--glass-stroke-focus)]' : 'border-[var(--glass-stroke-base)]'}`}>
          <strong>{t('orders.sheet_upscale_then_crop')}</strong>
        </div>
        <div className={`min-w-0 break-words rounded-lg border p-2 ${order === 'crop_then_panel_upscale' ? 'border-[var(--glass-stroke-focus)]' : 'border-[var(--glass-stroke-base)]'}`}>
          <strong>{t('orders.crop_then_panel_upscale')}</strong>
        </div>
      </div>

      {storyboard.sheetImageUrl ? (
        <button
          type="button"
          className="mt-3 block w-full overflow-hidden rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)]"
          onClick={() => onPreviewSheet(storyboard.sheetImageUrl!)}
        >
          <img
            src={toDisplayImageUrl(storyboard.sheetImageUrl) || storyboard.sheetImageUrl}
            alt={isLegacySixGrid ? t('previewOriginal') : t('sheetPreviewAlt')}
            className="mx-auto max-h-72 w-full object-contain"
          />
        </button>
      ) : null}

      <div className="mt-3 flex min-w-0 flex-wrap gap-2">
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
          {generateLabel}
        </button>
        <button type="button" className="glass-btn-base glass-btn-secondary rounded-lg px-3 py-1.5 text-xs" disabled={isTaskRunning || Boolean(upscaleDisabledReason)} title={upscaleDisabledReason} onClick={() => upscaleWorkflow && onUpscaleSheet(upscaleWorkflow)}>
          {t('upscaleSheet')}
        </button>
        <button type="button" className="glass-btn-base glass-btn-secondary rounded-lg px-3 py-1.5 text-xs" disabled={isTaskRunning || !canCrop} title={cropDisabledReason} onClick={onOpenCrop}>
          {t('crop')}
        </button>
      </div>
      {errorMessage && (
        <p role="alert" className="mt-3 break-words text-xs text-[var(--glass-tone-danger-fg)]">
          {generationError === errorMessage ? t('generationFailed', { message: errorMessage }) : errorMessage}
        </p>
      )}
    </section>
  )
}
