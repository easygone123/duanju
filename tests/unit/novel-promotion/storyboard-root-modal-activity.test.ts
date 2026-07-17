// @vitest-environment jsdom

import React from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import StoryboardStage from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard'
import { WorkspaceStageActivityProvider } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/WorkspaceStageActivityContext'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const TestActivityProvider = WorkspaceStageActivityProvider as React.ComponentType<{
  isActive: boolean
  children?: React.ReactNode
}>

const rootMocks = vi.hoisted(() => ({
  canvasProps: null as Record<string, (...args: never[]) => unknown> | null,
}))

vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}))

vi.mock('@/components/ui/icons', () => ({
  AppIcon: ({ name }: { name: string }) => React.createElement('span', { 'data-icon': name }),
}))

vi.mock('@/components/media/MediaImageWithLoading', () => ({
  MediaImageWithLoading: ({ src, alt }: { src: string; alt: string }) => React.createElement('img', { src, alt }),
}))

vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/WorkspaceDataProvider', () => ({
  useWorkspaceData: () => ({
    projectAssets: {
      characters: [{
        id: 'character-1',
        name: 'Ava',
        appearances: [{ id: 'appearance-1', appearanceIndex: 0, changeReason: 'Default' }],
      }],
      locations: [{ id: 'location-1', name: 'Studio' }],
    },
  }),
}))

vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardStageShell', () => ({
  default: ({ children }: { children: React.ReactNode }) => React.createElement('section', null, children),
}))

vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardToolbar', () => ({
  default: () => null,
}))

vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardCanvas', () => ({
  default: (props: Record<string, (...args: never[]) => unknown>) => {
    rootMocks.canvasProps = props
    return React.createElement(React.Fragment, null,
      React.createElement('button', {
        onClick: () => props.onOpenCharacterPicker('panel-1' as never),
      }, 'open character picker'),
      React.createElement('button', {
        onClick: () => props.onPreviewImage('/preview.png' as never),
      }, 'open image preview'),
      React.createElement('button', {
        onClick: () => props.onOpenEditModal('storyboard-1' as never, 0 as never),
      }, 'open image editor'),
    )
  },
}))

vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/ImageEditModal', () => ({
  default: () => React.createElement('div', { 'data-testid': 'image-edit-modal' }, 'image editor'),
}))

vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/AIDataModal', () => ({
  default: () => React.createElement('div', { 'data-testid': 'ai-data-modal' }, 'AI data'),
}))

vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/hooks/useStoryboardStageController', async () => {
  const ReactModule = await import('react')
  const storyboard = {
    id: 'storyboard-1',
    clipId: 'clip-1',
    panels: [{ id: 'panel-1', panelNumber: 1, characters: [], location: null }],
  }
  const noop = () => undefined
  const noopAsync = async () => undefined
  const panelData = {
    id: 'panel-1', panelIndex: 0, panelNumber: 1, shotType: null, cameraMove: null,
    description: null, location: null, characters: [], srtStart: null, srtEnd: null,
    duration: null, videoPrompt: null,
  }

  return {
    useStoryboardStageController: () => {
      const [localStoryboards, setLocalStoryboards] = ReactModule.useState([storyboard])
      const [editingPanel, setEditingPanel] = ReactModule.useState<{ storyboardId: string; panelIndex: number } | null>(null)
      const [previewImage, setPreviewImage] = ReactModule.useState<string | null>(null)
      const [assetPickerPanel, setAssetPickerPanel] = ReactModule.useState<{ panelId: string; type: 'character' | 'location' } | null>(null)
      const [aiDataPanel, setAIDataPanel] = ReactModule.useState<{ storyboardId: string; panelIndex: number } | null>(null)

      return {
        localStoryboards,
        setLocalStoryboards,
        sortedStoryboards: localStoryboards,
        expandedClips: new Set<string>(),
        toggleExpandedClip: noop,
        getClipInfo: () => null,
        getTextPanels: (candidate: typeof storyboard) => candidate.panels,
        getPanelEditData: () => panelData,
        updatePanelEdit: noop,
        formatClipTitle: () => 'clip',
        totalPanels: 1,
        storyboardStartIndex: new Map<string, number>(),
        savingPanels: new Set<string>(), deletingPanelIds: new Set<string>(), saveStateByPanel: new Map(),
        hasUnsavedByPanel: new Map(), submittingStoryboardTextIds: new Set<string>(), addingStoryboardGroup: false,
        movingClipId: null, insertingAfterPanelId: null, savePanelWithData: noopAsync, addPanel: noopAsync,
        deletePanel: noopAsync, deleteStoryboard: noopAsync, regenerateStoryboardText: noopAsync,
        addStoryboardGroup: noopAsync, moveStoryboardGroup: noopAsync, insertPanel: noopAsync,
        submittingVariantPanelId: null, generatePanelVariant: noopAsync,
        submittingStoryboardIds: new Set<string>(), submittingPanelImageIds: new Set<string>(), selectingCandidateIds: new Set<string>(),
        editingPanel, setEditingPanel, modifyingPanels: new Set<string>(), isDownloadingImages: false,
        previewImage, setPreviewImage, regeneratePanelImage: noopAsync, regenerateAllPanelsIndividually: noopAsync,
        selectPanelCandidate: noopAsync, selectPanelCandidateIndex: noop, cancelPanelCandidate: noop,
        getPanelCandidates: () => [], downloadAllImages: noopAsync, clearStoryboardError: noopAsync,
        assetPickerPanel, setAssetPickerPanel, aiDataPanel, setAIDataPanel, isEpisodeBatchSubmitting: false,
        getDefaultAssetsForClip: () => [], handleEditSubmit: noopAsync, handlePanelUpdate: noop,
        handleAddCharacter: noop, handleSetLocation: noop, handleRemoveCharacter: noop, handleRemoveLocation: noop,
        retrySave: noop, updatePhotographyPlanMutation: { mutateAsync: noopAsync },
        updatePanelActingNotesMutation: { mutateAsync: noopAsync }, addingStoryboardGroupState: null,
        transitioningState: null, runningCount: 0, pendingPanelCount: 0, handleGenerateAllPanels: noopAsync,
        sixGridUpscaleWorkflow: null, sixGridTaskStoryboardId: null, sixGridTaskPanelId: null,
        generateSixGridSheet: noopAsync, upscaleSixGridSheet: noopAsync, cropSixGridSheet: noopAsync,
        upscaleSixGridPanel: noopAsync, undoSixGridPanel: noopAsync,
      }
    },
  }
})

function renderRoot(isActive: boolean) {
  return React.createElement(
    TestActivityProvider,
    { isActive },
    React.createElement(StoryboardStage, {
      projectId: 'project-1', episodeId: 'episode-1', storyboards: [], clips: [], videoRatio: '16:9',
      onBack: vi.fn(), onNext: vi.fn(),
    }),
  )
}

afterEach(() => {
  cleanup()
  document.body.style.overflow = ''
  rootMocks.canvasProps = null
  vi.restoreAllMocks()
})

describe('storyboard root inactive modal cleanup', () => {
  it('removes a real GlassModalShell picker portal and editor when the root becomes inactive', async () => {
    const removeWindowListener = vi.spyOn(window, 'removeEventListener')
    const view = render(renderRoot(true))
    fireEvent.click(view.getByRole('button', { name: 'open character picker' }))
    act(() => {
      rootMocks.canvasProps?.onOpenEditModal('storyboard-1' as never, 0 as never)
    })
    expect(document.body.textContent).toContain('storyboard.panel.selectCharacter')
    expect(view.getByTestId('image-edit-modal')).toBeTruthy()

    view.rerender(renderRoot(false))

    await waitFor(() => expect(document.body.textContent).not.toContain('storyboard.panel.selectCharacter'))
    expect(view.queryByTestId('image-edit-modal')).toBeNull()
    expect(removeWindowListener).toHaveBeenCalledWith('keydown', expect.any(Function))

    view.rerender(renderRoot(true))
    expect(document.body.textContent).not.toContain('storyboard.panel.selectCharacter')
    expect(view.queryByTestId('image-edit-modal')).toBeNull()
  })

  it('removes ImagePreviewModal and restores body overflow when the root becomes inactive', async () => {
    const removeDocumentListener = vi.spyOn(document, 'removeEventListener')
    const view = render(renderRoot(true))
    fireEvent.click(view.getByRole('button', { name: 'open image preview' }))
    await waitFor(() => expect(document.body.style.overflow).toBe('hidden'))
    expect(view.getByAltText('common.preview')).toBeTruthy()

    view.rerender(renderRoot(false))

    await waitFor(() => expect(view.queryByAltText('common.preview')).toBeNull())
    expect(document.body.style.overflow).toBe('unset')
    expect(removeDocumentListener).toHaveBeenCalledWith('keydown', expect.any(Function))
  })

  it('immediately clears a modal opened externally while inactive', async () => {
    const view = render(renderRoot(true))
    view.rerender(renderRoot(false))

    act(() => {
      rootMocks.canvasProps?.onPreviewImage('/late-preview.png' as never)
    })

    expect(document.body.textContent).not.toContain('common.viewOriginal')
    expect(document.body.style.overflow).not.toBe('hidden')

    view.rerender(renderRoot(true))
    await waitFor(() => expect(document.body.textContent).not.toContain('common.viewOriginal'))
  })
})
