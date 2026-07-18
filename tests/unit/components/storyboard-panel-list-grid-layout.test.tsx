// @vitest-environment jsdom

import React, { createElement } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/virtualization/VirtualCardRange', () => ({
  VirtualCardRange: ({
    items,
    className,
    renderCard,
  }: {
    items: Array<{ id: string }>
    className?: string
    renderCard: (item: { id: string }, index: number) => React.ReactNode
  }) => createElement(
    'div',
    { 'data-testid': 'panel-grid', className },
    items.map((item, index) => createElement(React.Fragment, { key: item.id }, renderCard(item, index))),
  ),
}))

vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/PanelCard', () => ({
  default: (props: Record<string, unknown>) => createElement('div', {
    'data-testid': 'panel-card',
    'data-panel-id': (props.panel as { id: string }).id,
    'data-can-delete': String(typeof props.onDelete === 'function'),
    'data-can-insert': String(typeof props.onInsertAfter === 'function'),
    'data-can-variant': String(typeof props.onVariant === 'function'),
    'data-can-generate-individually': String(props.allowIndividualImageGeneration !== false),
  }),
}))

import StoryboardPanelList from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardPanelList'
import type { NovelPromotionStoryboard } from '@/types/project'

afterEach(cleanup)

function storyboard(layoutMode: 'individual' | 'four_grid' | 'six_grid'): NovelPromotionStoryboard {
  return {
    id: `${layoutMode}-storyboard`,
    episodeId: 'episode-1',
    clipId: 'clip-1',
    layoutMode,
    panelCount: layoutMode === 'four_grid' ? 4 : layoutMode === 'six_grid' ? 6 : 1,
    storyboardImageUrl: null,
    storyboardTextJson: null,
    sixGridCellAspectRatio: '16:9',
    panels: [],
  }
}

function panel(index: number) {
  return {
    id: `panel-${index}`,
    storyboardId: 'storyboard-1',
    panelIndex: index,
    panelNumber: index + 1,
    imageUrl: null,
  }
}

function renderPanelList(
  layoutMode: 'individual' | 'four_grid' | 'six_grid',
  panelCount: number,
  videoRatio = '16:9',
) {
  const props = {
    storyboard: storyboard(layoutMode),
    textPanels: Array.from({ length: panelCount }, (_, index) => panel(index)),
    storyboardStartIndex: 0,
    videoRatio,
    isSubmittingStoryboardTextTask: false,
    savingPanels: new Set<string>(),
    deletingPanelIds: new Set<string>(),
    saveStateByPanel: {},
    hasUnsavedByPanel: new Set<string>(),
    modifyingPanels: new Set<string>(),
    panelTaskErrorMap: new Map(),
    isPanelTaskRunning: () => false,
    getPanelEditData: () => ({}),
    getPanelCandidates: () => null,
    onPanelUpdate: vi.fn(),
    onPanelDelete: vi.fn(),
    onOpenCharacterPicker: vi.fn(),
    onOpenLocationPicker: vi.fn(),
    onRemoveCharacter: vi.fn(),
    onRemoveLocation: vi.fn(),
    onRetryPanelSave: vi.fn(),
    onRegeneratePanelImage: vi.fn(async () => true),
    onOpenEditModal: vi.fn(),
    onOpenAIDataModal: vi.fn(),
    onSelectPanelCandidateIndex: vi.fn(),
    onConfirmPanelCandidate: vi.fn(async () => undefined),
    onCancelPanelCandidate: vi.fn(),
    onClearPanelTaskError: vi.fn(),
    onPreviewImage: vi.fn(),
    onInsertAfter: vi.fn(),
    onVariant: vi.fn(),
    isInsertDisabled: () => false,
    sixGridUpscaleWorkflow: null,
    sixGridTaskPanelId: null,
    isSixGridTaskRunning: false,
    onOpenSixGridCrop: vi.fn(),
    onUpscaleSixGridPanel: vi.fn(async () => undefined),
    onUndoSixGridPanel: vi.fn(async () => undefined),
  } as unknown as React.ComponentProps<typeof StoryboardPanelList>

  return render(<StoryboardPanelList {...props} />)
}

describe('storyboard panel list grid invariants', () => {
  it('renders four-grid as exactly four cards in two columns', () => {
    const view = renderPanelList('four_grid', 6)

    expect(view.getByTestId('panel-grid').className).toContain('grid-cols-2')
    expect(view.getAllByTestId('panel-card')).toHaveLength(4)
    expect(view.getAllByTestId('panel-card').map((card) => card.getAttribute('data-panel-id')))
      .toEqual(['panel-0', 'panel-1', 'panel-2', 'panel-3'])
    expect(view.getAllByTestId('panel-card').every((card) => (
      card.getAttribute('data-can-delete') === 'false'
      && card.getAttribute('data-can-insert') === 'false'
      && card.getAttribute('data-can-variant') === 'false'
      && card.getAttribute('data-can-generate-individually') === 'false'
    ))).toBe(true)
  })

  it('renders six-grid as exactly six cards in three columns', () => {
    const view = renderPanelList('six_grid', 7)

    expect(view.getByTestId('panel-grid').className).toContain('grid-cols-3')
    expect(view.getAllByTestId('panel-card')).toHaveLength(6)
  })

  it('keeps orientation-aware layout and cardinality actions for individual panels', () => {
    const view = renderPanelList('individual', 2, '9:16')

    expect(view.getByTestId('panel-grid').className).toContain('grid-cols-5')
    expect(view.getAllByTestId('panel-card')).toHaveLength(2)
    expect(view.getAllByTestId('panel-card').every((card) => (
      card.getAttribute('data-can-delete') === 'true'
      && card.getAttribute('data-can-insert') === 'true'
      && card.getAttribute('data-can-variant') === 'true'
      && card.getAttribute('data-can-generate-individually') === 'true'
    ))).toBe(true)
  })
})
