import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { NextIntlClientProvider } from 'next-intl'

import SixGridGroupControls from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/SixGridGroupControls'
import SixGridCropModal, {
  adjustCropRect,
  buildCropSubmission,
  getCropSourceOptions,
  pointerDeltaToNormalized,
  resetCropRects,
} from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/SixGridCropModal'
import { DialoguePanelBadge } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/PanelCard'
import { SixGridPanelActions } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/ImageSectionActionButtons'
import {
  buildPanelUpscaleRequest,
  buildPanelUndoRequest,
  buildSheetCropRequest,
  buildSheetTaskRequest,
  createPanelUndoMutationOptions,
  isSixGridPanelBusy,
  isSixGridGroupBusy,
  sixGridStoryboardQueryKeys,
} from '@/lib/query/hooks/useSixGridStoryboard'
import { resolveProfileSection } from '@/app/[locale]/profile/profile-section'
import { buildSixGridTaskTypeContract } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/hooks/useStoryboardTaskAwareStoryboards'
import type { NovelPromotionStoryboard } from '@/types/project'
import { queryKeys } from '@/lib/query/keys'

vi.mock('@/components/ui/icons', () => ({
  AppIcon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}))
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...props }: { href: string | { pathname: string; query?: Record<string, string> }; children: React.ReactNode }) => {
    const resolved = typeof href === 'string'
      ? href
      : `${href.pathname}${href.query ? `?${new URLSearchParams(href.query)}` : ''}`
    return createElement('a', { ...props, href: resolved }, children)
  },
}))
const apiFetchMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api-fetch', () => ({ apiFetch: apiFetchMock }))

const messages = {
  storyboard: { sixGrid: {
    title: 'Six-grid storyboard', generateSheet: 'Generate 3x2 sheet', regenerateSheet: 'Regenerate 3x2 sheet',
    previewOriginal: 'Preview original sheet', upscaleSheet: 'Upscale original sheet', crop: 'Crop six panels',
    orderLabel: 'Processing order', orders: { sheet_upscale_then_crop: 'Upscale sheet then crop', crop_then_panel_upscale: 'Crop then upscale panels' },
    sourceLabel: 'Current source', sourceOriginal: 'Original sheet', sourceUpscaled: 'Upscaled sheet', sourceMissing: 'No sheet',
    artifactVersion: 'Artifact version {version}', status: 'Task status: {status}', idle: 'Idle', running: 'Running',
    manageComfyui: 'Manage ComfyUI pool', comfyuiHint: 'Configure and test your private ComfyUI upscale workflow in Settings Center.',
    workflowRequired: 'A published and tested upscale workflow is required', sheetRequired: 'Generate the original sheet first',
    upscaledSheetRequired: 'Upscale the sheet before cropping',
    cropModal: { title: 'Crop six panels', source: 'Crop source', original: 'Original sheet', upscaled: 'Upscaled sheet', cell: 'Cell {cell}', resetCell: 'Reset cell', resetAll: 'Reset all', cancel: 'Cancel', submit: 'Submit crops', moveHint: 'Arrow keys move; Shift moves faster', shrink: 'Shrink crop', grow: 'Grow crop', resize: 'Resize cell {cell}' },
    panel: { actions: 'Six-grid panel actions', dialogue: 'Contains dialogue', recrop: 'Recrop', upscale: 'Upscale panel', previewCurrent: 'Preview current', previewCrop: 'Preview crop', previewUpscale: 'Preview upscale', previewSource: 'Preview source', undo: 'Undo previous' },
  } },
}

const sixGrid = (overrides: Partial<NovelPromotionStoryboard> = {}): NovelPromotionStoryboard => ({
  id: 'storyboard-1', episodeId: 'episode-1', clipId: 'clip-1', storyboardTextJson: null,
  panelCount: 6, storyboardImageUrl: null, layoutMode: 'six_grid', groupSequence: 0,
  sixGridCellAspectRatio: '16:9', sixGridProcessingOrder: 'crop_then_panel_upscale',
  sheetImageUrl: '/media/sheet-preview.webp', sheetImageMediaId: 'sheet-1', sheetArtifactVersion: 3,
  panels: [], ...overrides,
})

function renderWithIntl(node: React.ReactNode) {
  return renderToStaticMarkup(createElement(NextIntlClientProvider, {
    locale: 'en', messages, timeZone: 'UTC',
  } as unknown as React.ComponentProps<typeof NextIntlClientProvider>, node))
}

describe('six-grid storyboard controls', () => {
  it('renders all group actions and both explicit processing-order labels only for six-grid groups', () => {
    const html = renderWithIntl(createElement(SixGridGroupControls, {
      storyboard: sixGrid(), isTaskRunning: false, upscaleWorkflow: null,
      onGenerateSheet: () => undefined, onPreviewSheet: () => undefined,
      onUpscaleSheet: () => undefined, onOpenCrop: () => undefined,
    }))
    expect(html).toContain('Regenerate 3x2 sheet')
    expect(html).toContain('Preview original sheet')
    expect(html).toContain('Upscale original sheet')
    expect(html).toContain('Crop six panels')
    expect(html).toContain('Upscale sheet then crop')
    expect(html).toContain('Crop then upscale panels')
    expect(html).toContain('Artifact version 3')
    expect(html).toContain('/profile?section=comfyui')

    expect(renderWithIntl(createElement(SixGridGroupControls, {
      storyboard: sixGrid({ layoutMode: 'individual' }), isTaskRunning: false, upscaleWorkflow: null,
      onGenerateSheet: () => undefined, onPreviewSheet: () => undefined,
      onUpscaleSheet: () => undefined, onOpenCrop: () => undefined,
    }))).toBe('')
  })

  it('marks dialogue cards with color plus visible text and an aria label', () => {
    const html = renderWithIntl(createElement(DialoguePanelBadge, { hasDialogue: true }))
    expect(html).toContain('Contains dialogue')
    expect(html).toContain('aria-label="Contains dialogue"')
    expect(html).toContain('data-dialogue-panel="true"')
    expect(renderWithIntl(createElement(DialoguePanelBadge, { hasDialogue: false }))).toBe('')
  })

  it('exposes recrop, upscale, lineage previews, and previous-image undo on each six-grid card', () => {
    const html = renderWithIntl(createElement(SixGridPanelActions, {
      currentUrl: '/current.webp', croppedUrl: '/crop.webp', upscaledUrl: '/upscale.webp', previousUrl: '/previous.webp',
      sourceUrl: '/sheet.webp', isBusy: false, canUpscale: true,
      onRecrop: () => undefined, onUpscale: () => undefined, onPreview: () => undefined, onUndo: () => undefined,
    }))
    expect(html).toContain('Recrop')
    expect(html).toContain('Upscale panel')
    expect(html).toContain('Preview current')
    expect(html).toContain('Preview crop')
    expect(html).toContain('Preview upscale')
    expect(html).toContain('Preview source')
    expect(html).toContain('Undo previous')
  })

  it('keeps six-grid card actions busy while either its local mutation or server image task is running', () => {
    expect(isSixGridPanelBusy('panel-1', 'panel-1', false)).toBe(true)
    expect(isSixGridPanelBusy(null, 'panel-1', true)).toBe(true)
    expect(isSixGridPanelBusy(null, 'panel-1', false, true)).toBe(true)
    expect(isSixGridPanelBusy('panel-2', 'panel-1', false)).toBe(false)
  })

  it('disables recrop, upscale, and undo for a server group task and restores them when it finishes', () => {
    const renderActions = (serverGroupRunning: boolean) => renderWithIntl(createElement(SixGridPanelActions, {
      currentUrl: '/current.webp', croppedUrl: '/crop.webp', previousUrl: '/previous.webp',
      isBusy: isSixGridGroupBusy(false, serverGroupRunning), canUpscale: true,
      onRecrop: () => undefined, onUpscale: () => undefined, onPreview: () => undefined, onUndo: () => undefined,
    }))
    const busyHtml = renderActions(true)
    expect(busyHtml.match(/disabled=""/g)).toHaveLength(3)
    expect(renderActions(false)).not.toContain('disabled=""')
  })
})

describe('six-grid crop contract', () => {
  it('keeps a locked ratio inside the selected cell and supports cell/all reset', () => {
    const initial = resetCropRects()
    const moved = adjustCropRect(initial[0].normalizedCropRect, 0, 'move', { dx: 1, dy: 1 })
    expect(moved.x + moved.width).toBeLessThanOrEqual(1 / 3)
    expect(moved.y + moved.height).toBeLessThanOrEqual(1 / 2)
    expect(moved.width / moved.height).toBeCloseTo(2 / 3)
    const squareSource = adjustCropRect(initial[0].normalizedCropRect, 0, 'resize', { dx: -0.05, dy: 0 }, {
      sourceAspectRatio: 1, cellAspectRatio: '16:9',
    })
    expect(squareSource.width / squareSource.height).toBeCloseTo(16 / 9)
    expect(resetCropRects(initial, 4)[4]).toEqual(resetCropRects()[4])
    expect(pointerDeltaToNormalized({ dx: 100, dy: 50 }, { width: 1000, height: 500 })).toEqual({ dx: 0.1, dy: 0.1 })
  })

  it('sorts exactly six crop rectangles and blocks an unavailable required source', () => {
    const reversed = resetCropRects().reverse()
    expect(buildCropSubmission(reversed).map((entry) => entry.cellIndex)).toEqual([0, 1, 2, 3, 4, 5])
    expect(() => buildCropSubmission(reversed.slice(1))).toThrow('SIX_GRID_EXACTLY_SIX_CROPS_REQUIRED')
    expect(getCropSourceOptions(sixGrid({ sixGridProcessingOrder: 'sheet_upscale_then_crop', upscaledSheetImageUrl: null }))).toEqual({
      options: [{ kind: 'original', url: '/media/sheet-preview.webp' }], requiredKind: 'upscaled', canSubmit: false,
    })
  })

  it('only loads the full source image while the accessible modal is open', () => {
    const common = {
      storyboard: sixGrid(), initialCellIndex: 2, onClose: () => undefined,
      onSubmit: async () => undefined,
    }
    expect(renderWithIntl(createElement(SixGridCropModal, { ...common, isOpen: false }))).not.toContain('<img')
    const openHtml = renderWithIntl(createElement(SixGridCropModal, { ...common, isOpen: true }))
    expect(openHtml).toContain('role="dialog"')
    expect(openHtml).toContain('aria-labelledby=')
    expect(openHtml).toContain('/media/sheet-preview.webp')
    expect(openHtml).toContain('Arrow keys move')
    const portraitHtml = renderWithIntl(createElement(SixGridCropModal, {
      ...common, storyboard: sixGrid({ sixGridCellAspectRatio: '9:16' }), isOpen: true,
    }))
    expect(portraitHtml).toContain('aspect-ratio:0.84375')
  })
})

describe('six-grid task requests and cache scope', () => {
  it('keeps optimistic overlays compatible with SSE storyboard and panel task types', () => {
    expect(buildSixGridTaskTypeContract()).toEqual({
      storyboard: ['storyboard_sheet_generate', 'storyboard_sheet_upscale', 'storyboard_sheet_crop'],
      panel: ['storyboard_panel_upscale'],
    })
  })

  it('builds the three Task 8 endpoint payloads without project-wide invalidation keys', () => {
    expect(buildSheetTaskRequest('project-1', { operation: 'generate', episodeId: 'episode-1', storyboardId: 'storyboard-1' })).toMatchObject({
      endpoint: '/api/novel-promotion/project-1/storyboard-sheet', body: { operation: 'generate' },
    })
    expect(buildSheetCropRequest('project-1', { episodeId: 'episode-1', storyboardId: 'storyboard-1', cropRects: resetCropRects() }).endpoint)
      .toBe('/api/novel-promotion/project-1/storyboard-sheet/crop')
    expect(buildPanelUpscaleRequest('project-1', { episodeId: 'episode-1', storyboardId: 'storyboard-1', panelId: 'panel-1', workflowId: 'wf-1', workflowVersionId: 'wv-1' }).endpoint)
      .toBe('/api/novel-promotion/project-1/storyboard-panel/upscale')
    expect(buildPanelUndoRequest('project-1', { panelId: 'panel-1', expectedCurrentMediaId: 'current-1', expectedPreviousMediaId: 'previous-1' })).toEqual({
      endpoint: '/api/novel-promotion/project-1/panel', method: 'PATCH', body: {
        panelId: 'panel-1', restorePreviousImage: true,
        expectedCurrentMediaId: 'current-1', expectedPreviousMediaId: 'previous-1',
      },
    })
    expect(sixGridStoryboardQueryKeys.group('project-1', 'episode-1', 'storyboard-1')).toEqual([
      'six-grid-storyboard', 'project-1', 'episode-1', 'storyboard-1',
    ])
    expect(sixGridStoryboardQueryKeys.panel('project-1', 'episode-1', 'storyboard-1', 'panel-1')).toEqual([
      'six-grid-storyboard', 'project-1', 'episode-1', 'storyboard-1', 'panel-1',
    ])
  })

  it('rolls back only the conflicted panel and preserves a concurrent successful panel update', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const episodeKey = queryKeys.episodeStage('project-1', 'episode-1', 'storyboard')
    const initialStoryboards = [{ panels: [
      {
        id: 'panel-1', imageUrl: '/current.webp', imageMediaId: 'current-1',
        previousImageUrl: '/previous.webp', previousImageMediaId: 'previous-1',
      },
      {
        id: 'panel-2', imageUrl: '/other.webp', imageMediaId: 'other-1',
        previousImageUrl: '/other-previous.webp', previousImageMediaId: 'other-previous-1',
      },
    ] }]
    const initial = { stage: 'storyboard' as const, episode: { storyboards: initialStoryboards } }
    queryClient.setQueryData(episodeKey, initial)
    apiFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'CONFLICT' }), {
      status: 409, headers: { 'Content-Type': 'application/json' },
    }))
    const options = createPanelUndoMutationOptions(queryClient, 'project-1', 'episode-1')
    const input = {
      panelId: 'panel-1', storyboardId: 'storyboard-1',
      expectedCurrentMediaId: 'current-1', expectedPreviousMediaId: 'previous-1',
    }
    const context = await options.onMutate(input)
    expect(queryClient.getQueryData<typeof initial>(episodeKey)?.episode.storyboards[0].panels[0].imageMediaId).toBe('previous-1')
    const request = options.mutationFn(input)
    await expect(request).rejects.toThrow()
    queryClient.setQueryData(episodeKey, (value: typeof initial | undefined) => ({
      ...value!, episode: { ...value!.episode, storyboards: [{ panels: value!.episode.storyboards[0].panels.map((panel) => panel.id === 'panel-2'
        ? { ...panel, imageUrl: '/other-success.webp', imageMediaId: 'other-success-1' }
        : panel) }] },
    }))
    options.onError(new Error('conflict'), input, context)
    const rolledBack = queryClient.getQueryData<typeof initial>(episodeKey)!
    expect(rolledBack.episode.storyboards[0].panels[0]).toEqual(initial.episode.storyboards[0].panels[0])
    expect(rolledBack.episode.storyboards[0].panels[1]).toMatchObject({
      imageUrl: '/other-success.webp', imageMediaId: 'other-success-1',
    })
    expect(apiFetchMock).toHaveBeenCalledWith('/api/novel-promotion/project-1/panel', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        panelId: 'panel-1', restorePreviousImage: true,
        expectedCurrentMediaId: 'current-1', expectedPreviousMediaId: 'previous-1',
      }),
    })
  })

  it('does not roll back over a newer update to the same panel', async () => {
    const queryClient = new QueryClient()
    const key = queryKeys.episodeStage('project-1', 'episode-1', 'storyboard')
    queryClient.setQueryData(key, { stage: 'storyboard', episode: { storyboards: [{ panels: [{
      id: 'panel-1', imageUrl: '/current.webp', imageMediaId: 'current-1',
      previousImageUrl: '/previous.webp', previousImageMediaId: 'previous-1',
    }] }] } })
    const options = createPanelUndoMutationOptions(queryClient, 'project-1', 'episode-1')
    const input = { panelId: 'panel-1', storyboardId: 'storyboard-1', expectedCurrentMediaId: 'current-1', expectedPreviousMediaId: 'previous-1' }
    const context = await options.onMutate(input)
    queryClient.setQueryData(key, { stage: 'storyboard', episode: { storyboards: [{ panels: [{
      id: 'panel-1', imageUrl: '/newer.webp', imageMediaId: 'newer-1',
      previousImageUrl: '/previous.webp', previousImageMediaId: 'previous-1',
    }] }] } })
    options.onError(new Error('conflict'), input, context)
    expect((queryClient.getQueryData<{ episode: { storyboards: Array<{ panels: Array<{ imageMediaId: string }> }> } }>(key))?.episode.storyboards[0].panels[0].imageMediaId).toBe('newer-1')
  })
})

describe('profile ComfyUI deep link', () => {
  it('activates only valid sections and defaults invalid queries to API config', () => {
    expect(resolveProfileSection('comfyui')).toBe('comfyui')
    expect(resolveProfileSection('billing')).toBe('billing')
    expect(resolveProfileSection('unknown')).toBe('apiConfig')
    expect(resolveProfileSection(null)).toBe('apiConfig')
  })
})
