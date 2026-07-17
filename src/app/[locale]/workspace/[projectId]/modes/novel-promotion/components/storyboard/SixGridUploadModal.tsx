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
  isSixGridSheetRatioAllowed,
} from '@/lib/novel-promotion/six-grid/upload-contract'

type CellRatio = '16:9' | '9:16'
type UploadError = 'invalidType' | 'invalidImage' | 'tooLarge' | 'dimensionsInvalid' | 'ratioInvalid' | 'uploadFailed'

interface SelectedImage {
  file: File
  objectUrl: string
  width: number | null
  height: number | null
  ratio: number | null
  valid: boolean
}

interface SixGridUploadModalProps {
  open: boolean
  onClose: () => void
  cellRatio: CellRatio
  expectedSheetArtifactVersion: number
  onSubmit: (file: File, version: number) => Promise<unknown>
}

const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

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

function expectedRatioLabel(cellRatio: CellRatio): string {
  return cellRatio === '9:16' ? '27:32' : '8:3'
}

export default function SixGridUploadModal({
  open,
  onClose,
  cellRatio,
  expectedSheetArtifactVersion,
  onSubmit,
}: SixGridUploadModalProps) {
  const t = useTranslations('storyboard.sixGrid.uploadModal')
  const [selected, setSelected] = useState<SelectedImage | null>(null)
  const [error, setError] = useState<UploadError | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const objectUrlRef = useRef<string | null>(null)
  const selectionTokenRef = useRef(0)
  const wasOpenRef = useRef(false)

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
      resetTransientState()
      wasOpenRef.current = open
    }
  }, [open, resetTransientState])

  useEffect(() => () => {
    selectionTokenRef.current += 1
    revokePreview()
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

    const objectUrl = URL.createObjectURL(file)
    objectUrlRef.current = objectUrl
    setSelected({ file, objectUrl, width: null, height: null, ratio: null, valid: false })

    let decoded: ImageBitmap | null = null
    try {
      decoded = await createImageBitmap(file)
      if (selectionTokenRef.current !== token) return
      const { width, height } = decoded
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
        setError('invalidImage')
        return
      }
      const ratio = width / height
      if (width > SIX_GRID_UPLOAD_MAX_DIMENSION
        || height > SIX_GRID_UPLOAD_MAX_DIMENSION
        || width * height > SIX_GRID_UPLOAD_MAX_PIXELS) {
        setSelected({ file, objectUrl, width, height, ratio, valid: false })
        setError('dimensionsInvalid')
        return
      }
      const valid = isSixGridSheetRatioAllowed(ratio, cellRatio)
      setSelected({ file, objectUrl, width, height, ratio, valid })
      if (!valid) setError('ratioInvalid')
    } catch {
      if (selectionTokenRef.current === token) setError('invalidImage')
    } finally {
      decoded?.close()
    }
  }, [cellRatio, revokePreview, submitting])

  const close = useCallback(() => {
    if (submitting) return
    resetTransientState()
    onClose()
  }, [onClose, resetTransientState, submitting])

  const confirm = async () => {
    if (!selected?.valid || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit(selected.file, expectedSheetArtifactVersion)
      resetTransientState()
      onClose()
    } catch {
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
      title={t('title')}
      description={t('description')}
      size="lg"
      footer={footer}
      closeOnBackdrop={!submitting}
      closeOnEsc={!submitting}
      showCloseButton={!submitting}
    >
      <div className="max-h-[62vh] space-y-4 overflow-y-auto pr-1">
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
            id="six-grid-sheet-upload"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            disabled={submitting}
            aria-label={t('chooseFile')}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              void selectFile(file)
            }}
          />
          <label htmlFor="six-grid-sheet-upload" className="glass-btn-base glass-btn-secondary mx-auto w-fit cursor-pointer rounded-lg px-4 py-2 text-sm">
            <AppIcon name="upload" className="h-4 w-4" />
            {t('chooseFile')}
          </label>
          <p className="mt-3 text-sm text-[var(--glass-text-secondary)]">{t('dropFile')}</p>
          <p className="mt-1 text-xs text-[var(--glass-text-tertiary)]">{t('supportedTypes')}</p>
        </div>

        {selected ? (
          <div className="grid gap-4 rounded-xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] p-4 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <img src={selected.objectUrl} alt={t('previewAlt')} className="max-h-64 w-full rounded-lg object-contain" />
            <dl className="grid content-start grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
              <dt className="text-[var(--glass-text-secondary)]">{t('fileLabel')}</dt>
              <dd className="break-all text-[var(--glass-text-primary)]">{selected.file.name}</dd>
              <dt className="text-[var(--glass-text-secondary)]">{t('sizeLabel')}</dt>
              <dd>{formatBytes(selected.file.size)}</dd>
              <dt className="text-[var(--glass-text-secondary)]">{t('dimensionsLabel')}</dt>
              <dd>{selected.width != null && selected.height != null ? `${selected.width} × ${selected.height}` : t('ratioPending')}</dd>
              <dt className="text-[var(--glass-text-secondary)]">{t('expectedRatioLabel')}</dt>
              <dd>{expectedRatioLabel(cellRatio)}</dd>
              <dt className="text-[var(--glass-text-secondary)]">{t('detectedRatioLabel')}</dt>
              <dd>{selected.ratio != null ? selected.ratio.toFixed(4) : t('ratioPending')}</dd>
              <dt className="text-[var(--glass-text-secondary)]">{t('cellRatioLabel')}</dt>
              <dd>{cellRatio}</dd>
            </dl>
          </div>
        ) : null}

        <p className="rounded-xl border border-[var(--glass-stroke-base)] p-3 text-sm text-[var(--glass-text-secondary)]">
          {t('replacementWarning')}
        </p>
        {error ? <p role="alert" className="text-sm text-[var(--glass-tone-danger-fg)]">{t(error)}</p> : null}
      </div>
    </GlassModalShell>
  )
}
