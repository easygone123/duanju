'use client'
/* eslint-disable @next/next/no-img-element -- full-resolution source is intentionally loaded only while this crop modal is open */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useCloseOnWorkspaceStageInactive } from '../WorkspaceStageActivityContext'
import type { NormalizedCropRect, NovelPromotionStoryboard } from '@/types/project'
import { toDisplayImageUrl } from '@/lib/media/image-url'
import { isGridStoryboardMode, resolveStoryboardGridSpec, type StoryboardGridSpec } from '@/lib/novel-promotion/grid-storyboard/spec'

export type CropEntry = { cellIndex: number; normalizedCropRect: NormalizedCropRect }
export type CropSourceKind = 'original' | 'upscaled'

const SIX_GRID_SPEC = resolveStoryboardGridSpec('six_grid', '16:9')

function cellBounds(cellIndex: number, spec: Pick<StoryboardGridSpec, 'columns' | 'rows'> = SIX_GRID_SPEC) {
  const cellWidth = 1 / spec.columns
  const cellHeight = 1 / spec.rows
  return {
    left: (cellIndex % spec.columns) * cellWidth,
    top: Math.floor(cellIndex / spec.columns) * cellHeight,
    cellWidth,
    cellHeight,
  }
}

type CropGeometry = {
  sourceAspectRatio: number
  cellAspectRatio: '16:9' | '9:16'
  spec?: StoryboardGridSpec
}

function targetAspectRatio(value: CropGeometry['cellAspectRatio']) {
  return value === '9:16' ? 9 / 16 : 16 / 9
}

function defaultEntry(cellIndex: number, geometry?: CropGeometry): CropEntry {
  const spec = geometry?.spec ?? SIX_GRID_SPEC
  const { left, top, cellWidth, cellHeight } = cellBounds(cellIndex, spec)
  if (!geometry) return { cellIndex, normalizedCropRect: { x: left, y: top, width: cellWidth, height: cellHeight } }
  const normalizedRatio = targetAspectRatio(geometry.cellAspectRatio) / geometry.sourceAspectRatio
  const width = Math.min(cellWidth, cellHeight * normalizedRatio)
  const height = width / normalizedRatio
  return { cellIndex, normalizedCropRect: {
    x: left + (cellWidth - width) / 2, y: top + (cellHeight - height) / 2, width, height,
  } }
}

export function resetCropRects(current?: CropEntry[], cellIndex?: number, geometry?: CropGeometry): CropEntry[] {
  const panelCount = geometry?.spec?.panelCount ?? SIX_GRID_SPEC.panelCount
  const base = current?.length === panelCount
    ? [...current].sort((a, b) => a.cellIndex - b.cellIndex)
    : Array.from({ length: panelCount }, (_, index) => defaultEntry(index, geometry))
  if (cellIndex === undefined) return Array.from({ length: panelCount }, (_, index) => defaultEntry(index, geometry))
  return base.map((entry) => entry.cellIndex === cellIndex ? defaultEntry(cellIndex, geometry) : entry)
}

export function buildCropSubmission(entries: CropEntry[], panelCount: 4 | 6 = 6): CropEntry[] {
  if (entries.length !== panelCount || new Set(entries.map((entry) => entry.cellIndex)).size !== panelCount) {
    throw new Error(panelCount === 6 ? 'SIX_GRID_EXACTLY_SIX_CROPS_REQUIRED' : 'GRID_EXACT_CROPS_REQUIRED')
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
  const spec = geometry?.spec ?? SIX_GRID_SPEC
  const { left, top, cellWidth, cellHeight } = cellBounds(cellIndex, spec)
  if (mode === 'move') {
    return {
      ...rect,
      x: Math.min(left + cellWidth - rect.width, Math.max(left, rect.x + delta.dx)),
      y: Math.min(top + cellHeight - rect.height, Math.max(top, rect.y + delta.dy)),
    }
  }
  const normalizedRatio = geometry
    ? targetAspectRatio(geometry.cellAspectRatio) / geometry.sourceAspectRatio
    : cellWidth / cellHeight
  const widthDelta = delta.dx || delta.dy * normalizedRatio
  const maxWidth = Math.min(cellWidth, cellHeight * normalizedRatio)
  const minWidth = cellWidth * 0.3
  const width = Math.min(maxWidth, Math.max(Math.min(minWidth, maxWidth), rect.width + widthDelta))
  const height = width / normalizedRatio
  const centerX = rect.x + rect.width / 2
  const centerY = rect.y + rect.height / 2
  return {
    x: Math.min(left + cellWidth - width, Math.max(left, centerX - width / 2)),
    y: Math.min(top + cellHeight - height, Math.max(top, centerY - height / 2)),
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
  const spec = geometry.spec ?? SIX_GRID_SPEC
  const { left, top, cellWidth, cellHeight } = cellBounds(cellIndex, spec)
  const normalizedRatio = targetAspectRatio(geometry.cellAspectRatio) / geometry.sourceAspectRatio
  const widthDelta = Math.abs(delta.dx) >= Math.abs(delta.dy * normalizedRatio)
    ? delta.dx
    : delta.dy * normalizedRatio
  const maxWidth = Math.min(left + cellWidth - rect.x, (top + cellHeight - rect.y) * normalizedRatio)
  const minWidth = cellWidth * 0.3
  const width = Math.min(maxWidth, Math.max(Math.min(minWidth, maxWidth), rect.width + widthDelta))
  return { ...rect, width, height: width / normalizedRatio }
}

type SourceCropState = {
  rects: CropEntry[]
  aspectRatio: number
  initialized: boolean
  dirty: boolean
}

type CropSourceStates = Record<CropSourceKind, SourceCropState>

export interface GridCropModalProps {
  isOpen: boolean
  storyboard: NovelPromotionStoryboard
  initialCellIndex?: number
  onClose: () => void
  onSubmit: (cropRects: CropEntry[]) => Promise<void>
  translationNamespace?: 'storyboard.grid' | 'storyboard.sixGrid'
}

export default function GridCropModal({
  isOpen,
  storyboard,
  initialCellIndex = 0,
  onClose,
  onSubmit,
  translationNamespace = 'storyboard.grid',
}: GridCropModalProps) {
  const t = useTranslations(translationNamespace)
  const mode = isGridStoryboardMode(storyboard.layoutMode) ? storyboard.layoutMode : 'six_grid'
  const cellAspectRatio: '16:9' | '9:16' = storyboard.sixGridCellAspectRatio === '9:16' ? '9:16' : '16:9'
  const spec = useMemo(() => resolveStoryboardGridSpec(mode, cellAspectRatio), [cellAspectRatio, mode])
  const isLegacySixGrid = translationNamespace === 'storyboard.sixGrid'
  const [sheetRatioWidth, sheetRatioHeight] = spec.sheetAspectRatio.split(':').map(Number)
  const canonicalSheetAspect = sheetRatioWidth! / sheetRatioHeight!
  const isStageActive = useCloseOnWorkspaceStageInactive(isOpen, onClose)
  const effectiveOpen = isStageActive && isOpen
  const sources = useMemo(() => getCropSourceOptions(storyboard), [storyboard])
  const initialRects = useMemo(() => {
    const panels = [...(storyboard.panels || [])].sort((a, b) => (a.gridCellIndex ?? 0) - (b.gridCellIndex ?? 0))
    if (panels.length !== spec.panelCount || panels.some((panel) => panel.gridCellIndex == null || !panel.normalizedCropRect)) {
      return resetCropRects(undefined, undefined, { sourceAspectRatio: canonicalSheetAspect, cellAspectRatio, spec })
    }
    return panels.map((panel) => ({ cellIndex: panel.gridCellIndex!, normalizedCropRect: panel.normalizedCropRect! }))
  }, [canonicalSheetAspect, cellAspectRatio, spec, storyboard.panels])
  const hasStoredCropRects = useMemo(() => {
    const panels = storyboard.panels || []
    return panels.length === spec.panelCount && panels.every((panel) => panel.gridCellIndex != null && panel.normalizedCropRect)
  }, [spec.panelCount, storyboard.panels])
  const [cellIndex, setCellIndex] = useState(initialCellIndex)
  const [sourceKind, setSourceKind] = useState<CropSourceKind>(sources.requiredKind)
  const [isSubmitting, setIsSubmitting] = useState(false)
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
      const buildSourceState = (kind: CropSourceKind): SourceCropState => {
        const media = kind === 'upscaled' ? storyboard.upscaledSheetImageMedia : storyboard.sheetImageMedia
        const metadataAspect = media?.width && media?.height ? media.width / media.height : null
        const aspectRatio = metadataAspect ?? canonicalSheetAspect
        return {
          rects: hasStoredCropRects ? initialRects : resetCropRects(undefined, undefined, { sourceAspectRatio: aspectRatio, cellAspectRatio, spec }),
          aspectRatio,
          initialized: hasStoredCropRects || metadataAspect !== null,
          dirty: false,
        }
      }
      setSourceStates({ original: buildSourceState('original'), upscaled: buildSourceState('upscaled') })
      setCellIndex(Math.min(spec.panelCount - 1, Math.max(0, initialCellIndex)))
      setSourceKind(sources.requiredKind)
      dialogRef.current?.focus()
    } else if (!effectiveOpen && wasOpen) {
      if (isStageActive) restoreFocusRef.current?.focus()
      restoreFocusRef.current = null
    }
  }, [canonicalSheetAspect, cellAspectRatio, effectiveOpen, hasStoredCropRects, initialCellIndex, initialRects, isStageActive, sources.requiredKind, spec, storyboard.sheetImageMedia, storyboard.upscaledSheetImageMedia])

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
        cellAspectRatio,
        spec,
      }
      return { ...current, [sourceKind]: {
        ...source, dirty: true,
        rects: source.rects.map((entry) => entry.cellIndex === cellIndex
          ? { ...entry, normalizedCropRect: adjustCropRect(entry.normalizedCropRect, cellIndex, mode, delta, geometry) }
          : entry),
      } }
    })
  }, [cellAspectRatio, cellIndex, sourceKind, spec])

  const resizeCurrentFromBottomRight = useCallback((delta: { dx: number; dy: number }) => {
    setSourceStates((current) => {
      const source = current[sourceKind]
      const geometry = {
        sourceAspectRatio: source.aspectRatio,
        cellAspectRatio,
        spec,
      }
      return { ...current, [sourceKind]: {
        ...source, dirty: true,
        rects: source.rects.map((entry) => entry.cellIndex === cellIndex
          ? { ...entry, normalizedCropRect: resizeCropFromBottomRight(entry.normalizedCropRect, cellIndex, delta, geometry) }
          : entry),
      } }
    })
  }, [cellAspectRatio, cellIndex, sourceKind, spec])

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
    cellAspectRatio,
    spec,
  }
  const canSubmit = sources.canSubmit && sourceKind === sources.requiredKind && !isSubmitting
  const currentRect = rects.find((entry) => entry.cellIndex === cellIndex)?.normalizedCropRect
    || defaultEntry(cellIndex, cropGeometry).normalizedCropRect
  const blockedReason = !sources.canSubmit ? t('upscaledSheetRequired') : sourceKind !== sources.requiredKind ? t('sourceOrderMismatch') : undefined

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-[var(--glass-overlay)] p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="grid-crop-title" tabIndex={-1} className="glass-surface-elevated max-h-[94vh] w-full max-w-5xl overflow-y-auto p-5 outline-none">
        <div className="flex items-center justify-between gap-3">
          <h2 id="grid-crop-title" className="min-w-0 break-words text-base font-semibold">
            {isLegacySixGrid ? t('cropModal.title') : t(`cropModal.title.${mode}`)}
          </h2>
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
                      cellAspectRatio,
                      spec,
                    }),
                    aspectRatio: naturalAspect,
                    initialized: true,
                    dirty: false,
                  } }
                })
              }
            }}
          />}
          <div
            className="absolute inset-0 grid"
            style={{ gridTemplateColumns: `repeat(${spec.columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${spec.rows}, minmax(0, 1fr))` }}
            data-testid="grid-crop-overlay"
            data-grid-columns={spec.columns}
            aria-hidden="true"
          >
            {Array.from({ length: spec.panelCount }, (_, index) => <div key={index} className="border border-white/70" />)}
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
          {Array.from({ length: spec.panelCount }, (_, index) => <button key={index} data-testid="grid-crop-cell-tab" type="button" className={`glass-btn-base rounded-lg px-2 py-1 text-xs ${cellIndex === index ? 'glass-btn-primary' : 'glass-btn-secondary'}`} onClick={() => setCellIndex(index)}>{t('cropModal.cell', { cell: index + 1 })}</button>)}
          <button type="button" className="glass-btn-base glass-btn-secondary rounded-lg px-2 py-1 text-xs" onClick={() => updateCurrent('resize', { dx: -0.02, dy: 0 })}>{t('cropModal.shrink')}</button>
          <button type="button" className="glass-btn-base glass-btn-secondary rounded-lg px-2 py-1 text-xs" onClick={() => updateCurrent('resize', { dx: 0.02, dy: 0 })}>{t('cropModal.grow')}</button>
          <button type="button" className="glass-btn-base glass-btn-secondary rounded-lg px-2 py-1 text-xs" onClick={() => setSourceStates((current) => ({ ...current, [sourceKind]: { ...current[sourceKind], dirty: true, rects: resetCropRects(current[sourceKind].rects, cellIndex, cropGeometry) } }))}>{t('cropModal.resetCell')}</button>
          <button type="button" className="glass-btn-base glass-btn-secondary rounded-lg px-2 py-1 text-xs" onClick={() => setSourceStates((current) => ({ ...current, [sourceKind]: { ...current[sourceKind], dirty: true, rects: resetCropRects(undefined, undefined, cropGeometry) } }))}>{t('cropModal.resetAll')}</button>
        </div>
        {blockedReason && <p role="alert" className="mt-3 text-sm text-[var(--glass-tone-danger-fg)]">{blockedReason}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="glass-btn-base glass-btn-secondary rounded-lg px-4 py-2 text-sm" onClick={onClose}>{t('cropModal.cancel')}</button>
          <button type="button" className="glass-btn-base glass-btn-primary rounded-lg px-4 py-2 text-sm" disabled={!canSubmit} title={blockedReason} onClick={async () => { setIsSubmitting(true); try { await onSubmit(buildCropSubmission(rects, spec.panelCount)); onClose() } finally { setIsSubmitting(false) } }}>{t('cropModal.submit')}</button>
        </div>
      </div>
    </div>
  )
}
