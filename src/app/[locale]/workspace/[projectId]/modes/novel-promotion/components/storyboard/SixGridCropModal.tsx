'use client'
/* eslint-disable @next/next/no-img-element -- full-resolution source is intentionally loaded only while this crop modal is open */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useCloseOnWorkspaceStageInactive } from '../WorkspaceStageActivityContext'
import type { NormalizedCropRect, NovelPromotionStoryboard } from '@/types/project'
import { toDisplayImageUrl } from '@/lib/media/image-url'

export type CropEntry = { cellIndex: number; normalizedCropRect: NormalizedCropRect }
export type CropSourceKind = 'original' | 'upscaled'

const CELL_WIDTH = 1 / 3
const CELL_HEIGHT = 1 / 2
const MIN_WIDTH = CELL_WIDTH * 0.3

function cellBounds(cellIndex: number) {
  return { left: (cellIndex % 3) * CELL_WIDTH, top: Math.floor(cellIndex / 3) * CELL_HEIGHT }
}

type CropGeometry = { sourceAspectRatio: number; cellAspectRatio: '16:9' | '9:16' }

function targetAspectRatio(value: CropGeometry['cellAspectRatio']) {
  return value === '9:16' ? 9 / 16 : 16 / 9
}

function defaultEntry(cellIndex: number, geometry?: CropGeometry): CropEntry {
  const { left, top } = cellBounds(cellIndex)
  if (!geometry) return { cellIndex, normalizedCropRect: { x: left, y: top, width: CELL_WIDTH, height: CELL_HEIGHT } }
  const normalizedRatio = targetAspectRatio(geometry.cellAspectRatio) / geometry.sourceAspectRatio
  const width = Math.min(CELL_WIDTH, CELL_HEIGHT * normalizedRatio)
  const height = width / normalizedRatio
  return { cellIndex, normalizedCropRect: {
    x: left + (CELL_WIDTH - width) / 2, y: top + (CELL_HEIGHT - height) / 2, width, height,
  } }
}

export function resetCropRects(current?: CropEntry[], cellIndex?: number, geometry?: CropGeometry): CropEntry[] {
  const base = current?.length === 6 ? [...current].sort((a, b) => a.cellIndex - b.cellIndex) : Array.from({ length: 6 }, (_, index) => defaultEntry(index))
  if (cellIndex === undefined) return Array.from({ length: 6 }, (_, index) => defaultEntry(index, geometry))
  return base.map((entry) => entry.cellIndex === cellIndex ? defaultEntry(cellIndex, geometry) : entry)
}

export function buildCropSubmission(entries: CropEntry[]): CropEntry[] {
  if (entries.length !== 6 || new Set(entries.map((entry) => entry.cellIndex)).size !== 6) {
    throw new Error('SIX_GRID_EXACTLY_SIX_CROPS_REQUIRED')
  }
  return [...entries].sort((a, b) => a.cellIndex - b.cellIndex)
}

export function getCropSourceOptions(storyboard: NovelPromotionStoryboard): {
  options: Array<{ kind: CropSourceKind; url: string }>; requiredKind: CropSourceKind; canSubmit: boolean
} {
  const options: Array<{ kind: CropSourceKind; url: string }> = []
  if (storyboard.sheetImageUrl) options.push({ kind: 'original', url: storyboard.sheetImageUrl })
  if (storyboard.upscaledSheetImageUrl) options.push({ kind: 'upscaled', url: storyboard.upscaledSheetImageUrl })
  const requiredKind = storyboard.sixGridProcessingOrder === 'sheet_upscale_then_crop' ? 'upscaled' : 'original'
  return { options, requiredKind, canSubmit: options.some((option) => option.kind === requiredKind) }
}

export function adjustCropRect(
  rect: NormalizedCropRect,
  cellIndex: number,
  mode: 'move' | 'resize',
  delta: { dx: number; dy: number },
  geometry?: CropGeometry,
): NormalizedCropRect {
  const { left, top } = cellBounds(cellIndex)
  if (mode === 'move') {
    return {
      ...rect,
      x: Math.min(left + CELL_WIDTH - rect.width, Math.max(left, rect.x + delta.dx)),
      y: Math.min(top + CELL_HEIGHT - rect.height, Math.max(top, rect.y + delta.dy)),
    }
  }
  const normalizedRatio = geometry
    ? targetAspectRatio(geometry.cellAspectRatio) / geometry.sourceAspectRatio
    : CELL_WIDTH / CELL_HEIGHT
  const widthDelta = delta.dx || delta.dy * normalizedRatio
  const maxWidth = Math.min(CELL_WIDTH, CELL_HEIGHT * normalizedRatio)
  const width = Math.min(maxWidth, Math.max(Math.min(MIN_WIDTH, maxWidth), rect.width + widthDelta))
  const height = width / normalizedRatio
  const centerX = rect.x + rect.width / 2
  const centerY = rect.y + rect.height / 2
  return {
    x: Math.min(left + CELL_WIDTH - width, Math.max(left, centerX - width / 2)),
    y: Math.min(top + CELL_HEIGHT - height, Math.max(top, centerY - height / 2)),
    width,
    height,
  }
}

export function pointerDeltaToNormalized(
  delta: { dx: number; dy: number },
  bounds: { width: number; height: number },
) {
  if (bounds.width <= 0 || bounds.height <= 0) return { dx: 0, dy: 0 }
  return { dx: delta.dx / bounds.width, dy: delta.dy / bounds.height }
}

export function resizeCropFromBottomRight(
  rect: NormalizedCropRect,
  cellIndex: number,
  delta: { dx: number; dy: number },
  geometry: CropGeometry,
) {
  const { left, top } = cellBounds(cellIndex)
  const normalizedRatio = targetAspectRatio(geometry.cellAspectRatio) / geometry.sourceAspectRatio
  const widthDelta = Math.abs(delta.dx) >= Math.abs(delta.dy * normalizedRatio)
    ? delta.dx
    : delta.dy * normalizedRatio
  const maxWidth = Math.min(left + CELL_WIDTH - rect.x, (top + CELL_HEIGHT - rect.y) * normalizedRatio)
  const width = Math.min(maxWidth, Math.max(Math.min(MIN_WIDTH, maxWidth), rect.width + widthDelta))
  return { ...rect, width, height: width / normalizedRatio }
}

type SourceCropState = {
  rects: CropEntry[]
  aspectRatio: number
  initialized: boolean
  dirty: boolean
}

type CropSourceStates = Record<CropSourceKind, SourceCropState>

interface Props {
  isOpen: boolean
  storyboard: NovelPromotionStoryboard
  initialCellIndex?: number
  onClose: () => void
  onSubmit: (cropRects: CropEntry[]) => Promise<void>
}

export default function SixGridCropModal({ isOpen, storyboard, initialCellIndex = 0, onClose, onSubmit }: Props) {
  const t = useTranslations('storyboard.sixGrid')
  const isStageActive = useCloseOnWorkspaceStageInactive(isOpen, onClose)
  const effectiveOpen = isStageActive && isOpen
  const sources = useMemo(() => getCropSourceOptions(storyboard), [storyboard])
  const initialRects = useMemo(() => {
    const panels = [...(storyboard.panels || [])].sort((a, b) => (a.gridCellIndex ?? 0) - (b.gridCellIndex ?? 0))
    if (panels.length !== 6 || panels.some((panel) => panel.gridCellIndex == null || !panel.normalizedCropRect)) return resetCropRects()
    return panels.map((panel) => ({ cellIndex: panel.gridCellIndex!, normalizedCropRect: panel.normalizedCropRect! }))
  }, [storyboard.panels])
  const hasStoredCropRects = useMemo(() => {
    const panels = storyboard.panels || []
    return panels.length === 6 && panels.every((panel) => panel.gridCellIndex != null && panel.normalizedCropRect)
  }, [storyboard.panels])
  const [cellIndex, setCellIndex] = useState(initialCellIndex)
  const [sourceKind, setSourceKind] = useState<CropSourceKind>(sources.requiredKind)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const canonicalSheetAspect = storyboard.sixGridCellAspectRatio === '9:16' ? 27 / 32 : 8 / 3
  const initialSourceState = (): SourceCropState => ({
    rects: initialRects,
    aspectRatio: canonicalSheetAspect,
    initialized: hasStoredCropRects,
    dirty: false,
  })
  const [sourceStates, setSourceStates] = useState<CropSourceStates>(() => ({
    original: initialSourceState(), upscaled: initialSourceState(),
  }))
  const dialogRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef<{ x: number; y: number; mode: 'move' | 'resize' } | null>(null)
  const previousOpenRef = useRef(false)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const isStageActiveRef = useRef(isStageActive)
  isStageActiveRef.current = isStageActive

  useEffect(() => {
    const wasOpen = previousOpenRef.current
    previousOpenRef.current = effectiveOpen
    if (effectiveOpen && !wasOpen) {
      restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const cellAspectRatio = storyboard.sixGridCellAspectRatio === '9:16' ? '9:16' : '16:9'
      const buildSourceState = (kind: CropSourceKind): SourceCropState => {
        const media = kind === 'upscaled' ? storyboard.upscaledSheetImageMedia : storyboard.sheetImageMedia
        const metadataAspect = media?.width && media?.height ? media.width / media.height : null
        const aspectRatio = metadataAspect ?? canonicalSheetAspect
        return {
          rects: hasStoredCropRects ? initialRects : resetCropRects(undefined, undefined, { sourceAspectRatio: aspectRatio, cellAspectRatio }),
          aspectRatio,
          initialized: hasStoredCropRects || metadataAspect !== null,
          dirty: false,
        }
      }
      setSourceStates({ original: buildSourceState('original'), upscaled: buildSourceState('upscaled') })
      setCellIndex(Math.min(5, Math.max(0, initialCellIndex)))
      setSourceKind(sources.requiredKind)
      dialogRef.current?.focus()
    } else if (!effectiveOpen && wasOpen) {
      if (isStageActive) restoreFocusRef.current?.focus()
      restoreFocusRef.current = null
    }
  }, [canonicalSheetAspect, effectiveOpen, hasStoredCropRects, initialCellIndex, initialRects, isStageActive, sources.requiredKind, storyboard.sheetImageMedia, storyboard.sixGridCellAspectRatio, storyboard.upscaledSheetImageMedia])

  useEffect(() => () => {
    if (isStageActiveRef.current) restoreFocusRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!effectiveOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const activeElement = document.activeElement as HTMLElement | null
      if (!activeElement || !focusable.includes(activeElement)) {
        event.preventDefault()
        if (event.shiftKey) last.focus()
        else first.focus()
      } else if (event.shiftKey && activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [effectiveOpen, onClose])

  const updateCurrent = useCallback((mode: 'move' | 'resize', delta: { dx: number; dy: number }) => {
    setSourceStates((current) => {
      const source = current[sourceKind]
      const geometry = {
        sourceAspectRatio: source.aspectRatio,
        cellAspectRatio: storyboard.sixGridCellAspectRatio === '9:16' ? '9:16' as const : '16:9' as const,
      }
      return { ...current, [sourceKind]: {
        ...source, dirty: true,
        rects: source.rects.map((entry) => entry.cellIndex === cellIndex
          ? { ...entry, normalizedCropRect: adjustCropRect(entry.normalizedCropRect, cellIndex, mode, delta, geometry) }
          : entry),
      } }
    })
  }, [cellIndex, sourceKind, storyboard.sixGridCellAspectRatio])

  const resizeCurrentFromBottomRight = useCallback((delta: { dx: number; dy: number }) => {
    setSourceStates((current) => {
      const source = current[sourceKind]
      const geometry = {
        sourceAspectRatio: source.aspectRatio,
        cellAspectRatio: storyboard.sixGridCellAspectRatio === '9:16' ? '9:16' as const : '16:9' as const,
      }
      return { ...current, [sourceKind]: {
        ...source, dirty: true,
        rects: source.rects.map((entry) => entry.cellIndex === cellIndex
          ? { ...entry, normalizedCropRect: resizeCropFromBottomRight(entry.normalizedCropRect, cellIndex, delta, geometry) }
          : entry),
      } }
    })
  }, [cellIndex, sourceKind, storyboard.sixGridCellAspectRatio])

  useEffect(() => {
    if (!effectiveOpen) return
    const move = (event: PointerEvent) => {
      const previous = draggingRef.current
      if (!previous) return
      const bounds = previewRef.current?.getBoundingClientRect()
      const delta = pointerDeltaToNormalized(
        { dx: event.clientX - previous.x, dy: event.clientY - previous.y },
        { width: bounds?.width || 0, height: bounds?.height || 0 },
      )
      if (previous.mode === 'resize') resizeCurrentFromBottomRight(delta)
      else updateCurrent('move', delta)
      draggingRef.current = { x: event.clientX, y: event.clientY, mode: previous.mode }
    }
    const stop = () => { draggingRef.current = null }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop) }
  }, [effectiveOpen, resizeCurrentFromBottomRight, updateCurrent])

  if (!effectiveOpen) return null
  const selectedSource = sources.options.find((source) => source.kind === sourceKind)
  const activeSourceState = sourceStates[sourceKind]
  const rects = activeSourceState.rects
  const sourceAspectRatio = activeSourceState.aspectRatio
  const cropGeometry: CropGeometry = {
    sourceAspectRatio,
    cellAspectRatio: storyboard.sixGridCellAspectRatio === '9:16' ? '9:16' : '16:9',
  }
  const canSubmit = sources.canSubmit && sourceKind === sources.requiredKind && !isSubmitting
  const currentRect = rects.find((entry) => entry.cellIndex === cellIndex)?.normalizedCropRect || defaultEntry(cellIndex).normalizedCropRect
  const blockedReason = !sources.canSubmit ? t('upscaledSheetRequired') : sourceKind !== sources.requiredKind ? t('sourceOrderMismatch') : undefined

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-[var(--glass-overlay)] p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="six-grid-crop-title" tabIndex={-1} className="glass-surface-elevated max-h-[94vh] w-full max-w-5xl overflow-y-auto p-5 outline-none">
        <div className="flex items-center justify-between gap-3">
          <h2 id="six-grid-crop-title" className="text-base font-semibold">{t('cropModal.title')}</h2>
          <button type="button" className="glass-btn-base glass-btn-secondary rounded-lg px-3 py-1 text-sm" onClick={onClose}>{t('cropModal.cancel')}</button>
        </div>
        <label className="mt-4 block text-sm">
          <span className="mr-2">{t('cropModal.source')}</span>
          <select className="glass-input-base px-2 py-1" value={sourceKind} onChange={(event) => setSourceKind(event.target.value as CropSourceKind)}>
            {sources.options.map((source) => <option key={source.kind} value={source.kind}>{t(`cropModal.${source.kind}`)}</option>)}
          </select>
        </label>

        <div
          ref={previewRef}
          className="relative mx-auto mt-4 w-full max-w-4xl overflow-hidden rounded-lg bg-[var(--glass-bg-muted)]"
          style={{ aspectRatio: sourceAspectRatio }}
        >
          {selectedSource && <img
            src={toDisplayImageUrl(selectedSource.url) || selectedSource.url}
            alt={t('cropModal.source')}
            className="h-full w-full object-fill"
            onLoad={(event) => {
              const image = event.currentTarget
              if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                const naturalAspect = image.naturalWidth / image.naturalHeight
                setSourceStates((current) => {
                  const source = current[sourceKind]
                  if (source.initialized || source.dirty) return current
                  return { ...current, [sourceKind]: {
                    rects: resetCropRects(undefined, undefined, {
                      sourceAspectRatio: naturalAspect,
                      cellAspectRatio: storyboard.sixGridCellAspectRatio === '9:16' ? '9:16' : '16:9',
                    }),
                    aspectRatio: naturalAspect,
                    initialized: true,
                    dirty: false,
                  } }
                })
              }
            }}
          />}
          <div className="absolute inset-0 grid grid-cols-3 grid-rows-2" aria-hidden="true">
            {Array.from({ length: 6 }, (_, index) => <div key={index} className="border border-white/70" />)}
          </div>
          <button
            type="button"
            className="absolute border-2 border-cyan-300 bg-cyan-300/10 focus:outline-none focus:ring-2 focus:ring-white"
            aria-label={t('cropModal.cell', { cell: cellIndex + 1 })}
            style={{ left: `${currentRect.x * 100}%`, top: `${currentRect.y * 100}%`, width: `${currentRect.width * 100}%`, height: `${currentRect.height * 100}%` }}
            onPointerDown={(event) => { draggingRef.current = { x: event.clientX, y: event.clientY, mode: 'move' }; event.currentTarget.setPointerCapture?.(event.pointerId) }}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 0.01 : 0.002
              const directions: Record<string, { dx: number; dy: number }> = { ArrowLeft: { dx: -step, dy: 0 }, ArrowRight: { dx: step, dy: 0 }, ArrowUp: { dx: 0, dy: -step }, ArrowDown: { dx: 0, dy: step } }
              if (directions[event.key]) { event.preventDefault(); updateCurrent('move', directions[event.key]) }
            }}
          />
          <button
            type="button"
            aria-label={t('cropModal.resize', { cell: cellIndex + 1 })}
            className="absolute z-10 h-5 w-5 -translate-x-1/2 -translate-y-1/2 cursor-se-resize rounded-full border-2 border-white bg-cyan-500"
            style={{ left: `${(currentRect.x + currentRect.width) * 100}%`, top: `${(currentRect.y + currentRect.height) * 100}%` }}
            onPointerDown={(event) => {
              event.stopPropagation()
              draggingRef.current = { x: event.clientX, y: event.clientY, mode: 'resize' }
              event.currentTarget.setPointerCapture?.(event.pointerId)
            }}
          />
        </div>

        <p className="mt-2 text-xs text-[var(--glass-text-secondary)]">{t('cropModal.moveHint')}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {Array.from({ length: 6 }, (_, index) => <button key={index} type="button" className={`glass-btn-base rounded-lg px-2 py-1 text-xs ${cellIndex === index ? 'glass-btn-primary' : 'glass-btn-secondary'}`} onClick={() => setCellIndex(index)}>{t('cropModal.cell', { cell: index + 1 })}</button>)}
          <button type="button" className="glass-btn-base glass-btn-secondary rounded-lg px-2 py-1 text-xs" onClick={() => updateCurrent('resize', { dx: -0.02, dy: 0 })}>{t('cropModal.shrink')}</button>
          <button type="button" className="glass-btn-base glass-btn-secondary rounded-lg px-2 py-1 text-xs" onClick={() => updateCurrent('resize', { dx: 0.02, dy: 0 })}>{t('cropModal.grow')}</button>
          <button type="button" className="glass-btn-base glass-btn-secondary rounded-lg px-2 py-1 text-xs" onClick={() => setSourceStates((current) => ({ ...current, [sourceKind]: { ...current[sourceKind], dirty: true, rects: resetCropRects(current[sourceKind].rects, cellIndex, cropGeometry) } }))}>{t('cropModal.resetCell')}</button>
          <button type="button" className="glass-btn-base glass-btn-secondary rounded-lg px-2 py-1 text-xs" onClick={() => setSourceStates((current) => ({ ...current, [sourceKind]: { ...current[sourceKind], dirty: true, rects: resetCropRects(undefined, undefined, cropGeometry) } }))}>{t('cropModal.resetAll')}</button>
        </div>
        {blockedReason && <p role="alert" className="mt-3 text-sm text-[var(--glass-tone-danger-fg)]">{blockedReason}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="glass-btn-base glass-btn-secondary rounded-lg px-4 py-2 text-sm" onClick={onClose}>{t('cropModal.cancel')}</button>
          <button type="button" className="glass-btn-base glass-btn-primary rounded-lg px-4 py-2 text-sm" disabled={!canSubmit} title={blockedReason} onClick={async () => { setIsSubmitting(true); try { await onSubmit(buildCropSubmission(rects)); onClose() } finally { setIsSubmitting(false) } }}>{t('cropModal.submit')}</button>
        </div>
      </div>
    </div>
  )
}
