'use client'
/* eslint-disable @next/next/no-img-element -- object URLs are temporary local previews */

import React, { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { useTranslations } from 'next-intl'

import GlassModalShell from '@/components/ui/primitives/GlassModalShell'
import { AppIcon } from '@/components/ui/icons'
import {
  SIX_GRID_UPLOAD_MAX_BYTES,
  SIX_GRID_UPLOAD_MAX_DIMENSION,
  SIX_GRID_UPLOAD_MAX_PIXELS,
  isGridSheetRatioAllowed,
} from '@/lib/novel-promotion/six-grid/upload-contract'
import { parseSixGridUploadImageMetadata } from '@/lib/novel-promotion/six-grid/upload-image-metadata'
import { resolveStoryboardGridSpec, type GridStoryboardMode } from '@/lib/novel-promotion/grid-storyboard/spec'

type CellRatio = '16:9' | '9:16'
type UploadError = 'invalidType' | 'invalidImage' | 'tooLarge' | 'dimensionsInvalid' | 'ratioInvalid' | 'uploadFailed'

interface SelectedImage {
  file: File
  objectUrl: string | null
  width: number
  height: number
  ratio: number
  valid: boolean
}

interface SixGridUploadModalProps {
  open: boolean
  onClose: () => void
  cellRatio: CellRatio
  expectedSheetArtifactVersion: number
  onSubmit: (file: File, version: number) => Promise<unknown>
  mode?: GridStoryboardMode
}

const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const PREVIEW_MAX_SIDE = 1280
const MIME_BY_FORMAT = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`
}

function expectedRatioLabel(mode: GridStoryboardMode, cellRatio: CellRatio): string {
  return resolveStoryboardGridSpec(mode, cellRatio).sheetAspectRatio
}

function thumbnailDimensions(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('SIX_GRID_UPLOAD_IMAGE_INVALID'))
    }, 'image/webp', 0.86)
  })
}

export default function SixGridUploadModal({
  open,
  onClose,
  cellRatio,
  expectedSheetArtifactVersion,
  onSubmit,
  mode = 'six_grid',
}: SixGridUploadModalProps) {
  const t = useTranslations('storyboard.sixGrid.uploadModal')
  const [selected, setSelected] = useState<SelectedImage | null>(null)
  const [error, setError] = useState<UploadError | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const objectUrlRef = useRef<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const filePickerButtonRef = useRef<HTMLButtonElement>(null)
  const selectionTokenRef = useRef(0)
  const sessionTokenRef = useRef(0)
  const mountedRef = useRef(false)
  const openRef = useRef(open)
  const wasOpenRef = useRef(false)
  openRef.current = open

  const revokePreview = useCallback(() => {
    if (!objectUrlRef.current) return
    URL.revokeObjectURL(objectUrlRef.current)
    objectUrlRef.current = null
  }, [])

  const resetTransientState = useCallback(() => {
    selectionTokenRef.current += 1
    revokePreview()
    setSelected(null)
    setError(null)
    setSubmitting(false)
    setDragActive(false)
  }, [revokePreview])

  useEffect(() => {
    if (open !== wasOpenRef.current) {
      sessionTokenRef.current += 1
      resetTransientState()
      wasOpenRef.current = open
    }
  }, [open, resetTransientState])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      sessionTokenRef.current += 1
      selectionTokenRef.current += 1
      revokePreview()
    }
  }, [revokePreview])

  const selectFile = useCallback(async (file: File | undefined) => {
    if (!file || submitting) return
    const token = selectionTokenRef.current + 1
    selectionTokenRef.current = token
    revokePreview()
    setSelected(null)
    setError(null)

    if (!ACCEPTED_TYPES.has(file.type)) {
      setError('invalidType')
      return
    }
    if (file.size > SIX_GRID_UPLOAD_MAX_BYTES) {
      setError('tooLarge')
      return
    }

    let decoded: ImageBitmap | null = null
    try {
      const metadata = parseSixGridUploadImageMetadata(await file.arrayBuffer())
      if (selectionTokenRef.current !== token) return
      if (MIME_BY_FORMAT[metadata.format] !== file.type) {
        setError('invalidImage')
        return
      }
      const { width, height } = metadata
      const ratio = width / height
      if (width > SIX_GRID_UPLOAD_MAX_DIMENSION
        || height > SIX_GRID_UPLOAD_MAX_DIMENSION
        || width * height > SIX_GRID_UPLOAD_MAX_PIXELS) {
        setError('dimensionsInvalid')
        return
      }
      if (!isGridSheetRatioAllowed(ratio, resolveStoryboardGridSpec(mode, cellRatio))) {
        setError('ratioInvalid')
        return
      }
      setSelected({ file, objectUrl: null, width, height, ratio, valid: false })

      const thumbnail = thumbnailDimensions(width, height)
      decoded = await createImageBitmap(file, {
        imageOrientation: 'from-image',
        resizeWidth: thumbnail.width,
        resizeHeight: thumbnail.height,
        resizeQuality: 'high',
      })
      if (selectionTokenRef.current !== token) return
      const canvas = document.createElement('canvas')
      canvas.width = thumbnail.width
      canvas.height = thumbnail.height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('SIX_GRID_UPLOAD_IMAGE_INVALID')
      context.drawImage(decoded, 0, 0, thumbnail.width, thumbnail.height)
      const previewBlob = await canvasBlob(canvas)
      if (selectionTokenRef.current !== token) return
      const objectUrl = URL.createObjectURL(previewBlob)
      objectUrlRef.current = objectUrl
      setSelected({ file, objectUrl, width, height, ratio, valid: true })
    } catch {
      if (selectionTokenRef.current === token) setError('invalidImage')
    } finally {
      decoded?.close()
    }
  }, [cellRatio, mode, revokePreview, submitting])

  const close = useCallback(() => {
    if (submitting) return
    resetTransientState()
    onClose()
  }, [onClose, resetTransientState, submitting])

  const confirm = async () => {
    if (!selected?.valid || submitting) return
    const sessionToken = sessionTokenRef.current
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit(selected.file, expectedSheetArtifactVersion)
      if (!mountedRef.current || !openRef.current || sessionTokenRef.current !== sessionToken) return
      resetTransientState()
      onClose()
    } catch {
      if (!mountedRef.current || !openRef.current || sessionTokenRef.current !== sessionToken) return
      setSubmitting(false)
      setError('uploadFailed')
    }
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(false)
    void selectFile(event.dataTransfer.files[0])
  }

  const footer = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <button type="button" className="glass-btn-base glass-btn-secondary rounded-lg px-4 py-2 text-sm" disabled={submitting} onClick={close}>
        {t('cancel')}
      </button>
      <button
        type="button"
        className="glass-btn-base glass-btn-primary rounded-lg px-4 py-2 text-sm"
        disabled={!selected?.valid || submitting}
        onClick={() => void confirm()}
      >
        <AppIcon name="upload" className="h-4 w-4" />
        {submitting ? t('uploading') : t('confirm')}
      </button>
    </div>
  )

  return (
    <GlassModalShell
      open={open}
      onClose={close}
      title={t(mode === 'four_grid' ? 'titleFourGrid' : 'title')}
      description={t(mode === 'four_grid' ? 'descriptionFourGrid' : 'description')}
      size="lg"
      footer={footer}
      closeOnBackdrop={!submitting}
      closeOnEsc={!submitting}
      showCloseButton={!submitting}
      initialFocusRef={filePickerButtonRef}
    >
      <div className="space-y-4">
        <div
          className={`rounded-xl border border-dashed p-6 text-center transition-colors ${dragActive ? 'border-[var(--glass-stroke-focus)] bg-[var(--glass-bg-muted)]' : 'border-[var(--glass-stroke-base)]'}`}
          onDragEnter={(event) => { event.preventDefault(); if (!submitting) setDragActive(true) }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false)
          }}
          onDrop={onDrop}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            disabled={submitting}
            aria-label={t('chooseFile')}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              void selectFile(file)
            }}
          />
          <button
            ref={filePickerButtonRef}
            type="button"
            className="glass-btn-base glass-btn-secondary mx-auto w-fit rounded-lg px-4 py-2 text-sm"
            disabled={submitting}
            onClick={() => fileInputRef.current?.click()}
          >
            <AppIcon name="upload" className="h-4 w-4" />
            {t('chooseFile')}
          </button>
          <p className="mt-3 text-sm text-[var(--glass-text-secondary)]">{t('dropFile')}</p>
          <p className="mt-1 text-xs text-[var(--glass-text-tertiary)]">{t('supportedTypes')}</p>
        </div>

        {selected ? (
          <div className="grid gap-4 rounded-xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] p-4 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            {selected.objectUrl ? (
              <img src={selected.objectUrl} alt={t(mode === 'four_grid' ? 'previewAltFourGrid' : 'previewAlt')} className="max-h-64 w-full rounded-lg object-contain" />
            ) : <div aria-hidden="true" />}
            <dl className="grid content-start grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
              <dt className="text-[var(--glass-text-secondary)]">{t('fileLabel')}</dt>
              <dd className="break-all text-[var(--glass-text-primary)]">{selected.file.name}</dd>
              <dt className="text-[var(--glass-text-secondary)]">{t('sizeLabel')}</dt>
              <dd>{formatBytes(selected.file.size)}</dd>
              <dt className="text-[var(--glass-text-secondary)]">{t('dimensionsLabel')}</dt>
              <dd>{`${selected.width} × ${selected.height}`}</dd>
              <dt className="text-[var(--glass-text-secondary)]">{t('expectedRatioLabel')}</dt>
              <dd>{expectedRatioLabel(mode, cellRatio)}</dd>
              <dt className="text-[var(--glass-text-secondary)]">{t('detectedRatioLabel')}</dt>
              <dd>{selected.ratio.toFixed(4)}</dd>
              <dt className="text-[var(--glass-text-secondary)]">{t('cellRatioLabel')}</dt>
              <dd>{cellRatio}</dd>
            </dl>
          </div>
        ) : null}

        <p className="rounded-xl border border-[var(--glass-stroke-base)] p-3 text-sm text-[var(--glass-text-secondary)]">
          {t(mode === 'four_grid' ? 'replacementWarningFourGrid' : 'replacementWarning')}
        </p>
        {error ? <p role="alert" className="text-sm text-[var(--glass-tone-danger-fg)]">
          {t(error === 'ratioInvalid' && mode === 'four_grid' ? 'ratioInvalidFourGrid' : error)}
        </p> : null}
      </div>
    </GlassModalShell>
  )
}
