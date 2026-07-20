// @vitest-environment jsdom

import React, { createElement } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextIntlClientProvider } from 'next-intl'

import { StoryboardModeSelector } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/ConfigStage'
import GridGroupControls from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/GridGroupControls'
import GridCropModal from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/GridCropModal'
import type { NovelPromotionStoryboard } from '@/types/project'
import {
  gridStoryboardQueryKeys,
  useGridStoryboard,
  useSixGridStoryboard,
} from '@/lib/query/hooks/useSixGridStoryboard'
import { buildScriptToStoryboardRunBody } from '@/lib/query/hooks/useScriptToStoryboardRunStream'
import { resolveStoryboardRunErrorMessage } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/hooks/useWorkspaceExecution'
import { TASK_TYPE } from '@/lib/task/types'

vi.mock('@/components/ui/icons', () => ({
  AppIcon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}))
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children }: { children: React.ReactNode }) => createElement('a', null, children),
}))

const messages = {
  novelPromotion: { storyboardRunSettings: {
    modeLabel: 'Storyboard mode',
    mode: {
      individual: 'Individual panels',
      four_grid: '2x2 four-grid',
      six_grid: '3x2 six-grid',
    },
    recommended: 'Recommended',
    fourGridHint: 'Works with common image ratios.',
    sixGridRatioWarning: 'Requires a model that supports uncommon whole-sheet ratios.',
    cellRatioLabel: 'Cell aspect ratio',
    inheritVideoRatio: 'Inherit video ratio ({ratio})',
    sheetRatioLabel: 'Whole-sheet ratio',
  } },
  storyboard: { grid: {
    title: { four_grid: 'Four-grid storyboard', six_grid: 'Six-grid storyboard' },
    generateSheet: { four_grid: 'Generate 2x2 four-grid', six_grid: 'Generate 3x2 six-grid' },
    regenerateSheet: { four_grid: 'Regenerate 2x2 four-grid', six_grid: 'Regenerate 3x2 six-grid' },
    viewPrompt: 'View prompt', uploadSheet: 'Upload grid sheet',
    sheetPreviewAlt: 'Grid sheet preview', upscaleSheet: 'Upscale sheet', crop: 'Crop panels',
    orders: { sheet_upscale_then_crop: 'Upscale sheet then crop', crop_then_panel_upscale: 'Crop then upscale panels' },
    sourceLabel: 'Current source', sourceOriginal: 'Original sheet', sourceUpscaled: 'Upscaled sheet', sourceMissing: 'No sheet',
    artifactVersion: 'Artifact version {version}', status: 'Task status: {status}', idle: 'Idle', running: 'Running',
    sheetGenerationRunning: {
      four_grid: 'Generating one complete 2×2 sheet…',
      six_grid: 'Generating one complete 3×2 sheet…',
    },
    sheetGenerationStatus: {
      four_grid: 'One complete 2×2 four-grid sheet is being generated, not four independent images.',
      six_grid: 'One complete 3×2 six-grid sheet is being generated, not six independent images.',
    },
    taskRunning: 'Grid sheet operation in progress…',
    taskRunningStatus: 'A grid sheet operation is in progress. Generation will be available when it finishes.',
    manageComfyui: 'Manage ComfyUI', comfyuiHint: 'Manage ComfyUI', workflowRequired: 'Workflow required',
    sheetRequired: 'Sheet required', upscaledSheetRequired: 'Upscaled sheet required',
    generationFailed: 'Generation failed: {message}',
    sixGridRatioUnsupported: 'This model does not support the six-grid ratio. Switch to four-grid or change model.',
    cropModal: {
      title: { four_grid: 'Crop four panels', six_grid: 'Crop six panels' },
      source: 'Crop source', original: 'Original', upscaled: 'Upscaled', cell: 'Cell {cell}',
      resetCell: 'Reset cell', resetAll: 'Reset all', cancel: 'Cancel', submit: 'Submit crops',
      moveHint: 'Move hint', shrink: 'Shrink', grow: 'Grow', resize: 'Resize cell {cell}',
    },
    sourceOrderMismatch: 'Wrong source order',
  } },
}

function withIntl(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {node}
    </NextIntlClientProvider>
  )
}

function storyboard(mode: 'four_grid' | 'six_grid', overrides: Partial<NovelPromotionStoryboard> = {}): NovelPromotionStoryboard {
  return {
    id: `${mode}-1`, episodeId: 'episode-1', clipId: 'clip-1', storyboardTextJson: null,
    panelCount: mode === 'four_grid' ? 4 : 6, storyboardImageUrl: null, layoutMode: mode,
    groupSequence: 1, sixGridCellAspectRatio: '16:9', sixGridProcessingOrder: 'crop_then_panel_upscale',
    sheetImageUrl: '/media/owned-sheet.webp', sheetArtifactVersion: 2, panels: [], ...overrides,
  }
}

const controlProps = {
  isTaskRunning: false, upscaleWorkflow: null, onGenerateSheet: vi.fn(), onPreviewSheet: vi.fn(),
  onUpscaleSheet: vi.fn(), onOpenCrop: vi.fn(), onViewPrompt: vi.fn(), onUploadSheet: vi.fn(),
}

afterEach(cleanup)

describe('grid storyboard configuration', () => {
  it('renders exactly individual, recommended four-grid, and warned six-grid while preserving the selected value', () => {
    const onChange = vi.fn()
    const view = render(withIntl(<StoryboardModeSelector
      mode="six_grid" cellRatio="9:16" videoRatio="16:9" settingsLocked={false} onChange={onChange}
    />))
    const selector = view.getByRole('combobox', { name: 'Storyboard mode' }) as HTMLSelectElement
    expect([...selector.options].map((option) => option.value)).toEqual(['individual', 'four_grid', 'six_grid'])
    expect(selector.value).toBe('six_grid')
    expect(view.getByText(/2x2 four-grid.*Recommended/)).toBeTruthy()
    expect(view.getByText('Requires a model that supports uncommon whole-sheet ratios.')).toBeTruthy()
    expect(view.getByText(/Whole-sheet ratio.*27:32/)).toBeTruthy()

    fireEvent.change(selector, { target: { value: 'four_grid' } })
    expect(onChange).toHaveBeenCalledWith('storyboardGenerationMode', 'four_grid')
  })

  it('keeps all mode controls disabled when settings are locked', () => {
    const view = render(withIntl(<StoryboardModeSelector
      mode="four_grid" cellRatio="16:9" videoRatio="16:9" settingsLocked onChange={vi.fn()}
    />))
    expect(view.getAllByRole('combobox').every((node) => (node as HTMLSelectElement).disabled)).toBe(true)
    expect(view.getByText(/Whole-sheet ratio.*16:9/)).toBeTruthy()
  })

  it('keeps individual mode selected without exposing grid-only controls', () => {
    const view = render(withIntl(<StoryboardModeSelector
      mode="individual" cellRatio={null} videoRatio="16:9" settingsLocked={false} onChange={vi.fn()}
    />))
    expect((view.getByRole('combobox', { name: 'Storyboard mode' }) as HTMLSelectElement).value).toBe('individual')
    expect(view.queryByRole('combobox', { name: 'Cell aspect ratio' })).toBeNull()
    expect(view.queryByText(/Whole-sheet ratio/)).toBeNull()
  })
})

describe('generic grid group controls', () => {
  it('uses mode-aware titles and generation labels and keeps upload available before generation', () => {
    const four = render(withIntl(<GridGroupControls
      storyboard={storyboard('four_grid', { sheetImageUrl: null })} {...controlProps}
    />))
    expect(four.getByRole('button', { name: 'Generate 2x2 four-grid' })).toBeTruthy()
    expect(four.getByRole('button', { name: 'Upload grid sheet' }).hasAttribute('disabled')).toBe(false)
    four.unmount()

    const six = render(withIntl(<GridGroupControls storyboard={storyboard('six_grid')} {...controlProps} />))
    expect(six.getByRole('button', { name: 'Regenerate 3x2 six-grid' })).toBeTruthy()
    expect(six.getByRole('img', { name: 'Grid sheet preview' }).getAttribute('src')).toContain('/media/owned-sheet.webp')
    expect(six.queryByRole('button', { name: /preview original/i })).toBeNull()
  })

  it('recommends four-grid for a six-grid model-ratio failure', () => {
    const view = render(withIntl(<GridGroupControls
      storyboard={storyboard('six_grid')} {...controlProps}
      generationError="SIX_GRID_ASPECT_RATIO_UNSUPPORTED"
    />))
    expect(view.getByRole('alert').textContent).toContain('Switch to four-grid or change model')
  })

  it.each([
    ['four_grid', 'Generating one complete 2×2 sheet…', 'One complete 2×2 four-grid sheet is being generated, not four independent images.'],
    ['six_grid', 'Generating one complete 3×2 sheet…', 'One complete 3×2 six-grid sheet is being generated, not six independent images.'],
  ] as const)('announces one complete %s sheet while submission is running', (mode, label, status) => {
    const view = render(withIntl(<GridGroupControls
      storyboard={storyboard(mode)} {...controlProps} isTaskRunning
      activeTaskType={TASK_TYPE.STORYBOARD_SHEET_GENERATE}
    />))
    const generate = view.getByRole('button', { name: label })

    expect(generate.hasAttribute('disabled')).toBe(true)
    expect(generate.getAttribute('aria-busy')).toBe('true')
    expect(generate.getAttribute('title')).toBe(status)
    expect(view.getByRole('status').textContent).toBe(status)
    expect(view.getByRole('button', { name: 'View prompt' }).hasAttribute('disabled')).toBe(false)
    expect(view.getByRole('button', { name: 'Upload grid sheet' })).toBeTruthy()
  })

  it.each([
    TASK_TYPE.STORYBOARD_SHEET_UPSCALE,
    TASK_TYPE.STORYBOARD_SHEET_CROP,
    'storyboard_sheet_upload',
    null,
  ])('uses generic accessible busy copy for non-generation task type %s', (activeTaskType) => {
    const view = render(withIntl(<GridGroupControls
      storyboard={storyboard('four_grid')} {...controlProps} isTaskRunning
      activeTaskType={activeTaskType}
    />))
    const action = view.getByRole('button', { name: 'Grid sheet operation in progress…' })

    expect(action.getAttribute('aria-busy')).toBe('true')
    expect(action.getAttribute('title')).toBe(
      'A grid sheet operation is in progress. Generation will be available when it finishes.',
    )
    expect(view.getByRole('status').textContent).toBe(
      'A grid sheet operation is in progress. Generation will be available when it finishes.',
    )
    expect(view.queryByText(/complete 2×2.*not four independent/i)).toBeNull()
  })

  it('keeps a failed submission actionable once the task is no longer running', () => {
    const onGenerateSheet = vi.fn()
    const view = render(withIntl(<GridGroupControls
      storyboard={storyboard('four_grid')} {...controlProps}
      generationError="provider rejected sheet"
      onGenerateSheet={onGenerateSheet}
    />))

    expect(view.getByRole('alert').textContent).toContain('provider rejected sheet')
    const retry = view.getByRole('button', { name: 'Regenerate 2x2 four-grid' })
    expect(retry.hasAttribute('disabled')).toBe(false)
    fireEvent.click(retry)
    expect(onGenerateSheet).toHaveBeenCalledTimes(1)
  })
})

describe('generic crop overlay', () => {
  it.each([
    ['four_grid', 2, 4],
    ['six_grid', 3, 6],
  ] as const)('renders %s with %i columns and %i cells', (mode, columns, panelCount) => {
    const view = render(withIntl(<GridCropModal
      isOpen storyboard={storyboard(mode)} onClose={vi.fn()} onSubmit={vi.fn().mockResolvedValue(undefined)}
    />))
    const overlay = view.getByTestId('grid-crop-overlay')
    expect(overlay.getAttribute('data-grid-columns')).toBe(String(columns))
    expect(view.getAllByTestId('grid-crop-cell-tab')).toHaveLength(panelCount)
    expect(view.getByRole('img', { name: 'Crop source' }).getAttribute('src')).toContain('/media/owned-sheet.webp')
  })
})

describe('grid runtime compatibility', () => {
  it('uses one mutation family and keeps compatible scoped cache keys', () => {
    expect(useGridStoryboard).toBe(useSixGridStoryboard)
    expect(gridStoryboardQueryKeys.group('p', 'e', 's')).toEqual([
      'six-grid-storyboard', 'p', 'e', 's',
    ])
  })

  it('propagates four-grid through the existing script-to-storyboard run body', () => {
    const body = buildScriptToStoryboardRunBody({
      episodeId: 'episode-1', storyboardGenerationMode: 'four_grid', sixGridCellAspectRatio: '16:9',
      sixGridProcessingOrder: 'crop_then_panel_upscale', storyboardUpscaleModel: null, dialogueVideoModel: null,
    })
    expect(body).toMatchObject({
      storyboardGenerationMode: 'four_grid', sixGridCellAspectRatio: '16:9', async: true,
    })
  })

  it('localizes unsupported six-grid guidance without changing generic four-grid errors', () => {
    const translate = (key: string) => key === 'execution.sixGridRatioUnsupported'
      ? 'Switch to four-grid or change the image model.'
      : key
    expect(resolveStoryboardRunErrorMessage(
      'SIX_GRID_ASPECT_RATIO_UNSUPPORTED', 'six_grid', translate,
    )).toContain('Switch to four-grid')
    expect(resolveStoryboardRunErrorMessage('provider failed', 'four_grid', translate)).toBe('provider failed')
  })
})
