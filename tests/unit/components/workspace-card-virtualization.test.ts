// @vitest-environment jsdom

import React from 'react'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import VideoRenderPanel from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video-stage/VideoRenderPanel'
import VoiceLineList from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/voice-stage/VoiceLineList'
import StoryboardPanelList from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardPanelList'
import StoryboardCanvas from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardCanvas'
import type { VideoPanel } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video/types'
import type { VoiceLine } from '@/lib/novel-promotion/stages/voice-stage-runtime/types'
import type { StoryboardPanel } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/hooks/useStoryboardState'
import { useVideoPanelViewport } from '@/lib/novel-promotion/stages/video-stage-runtime/useVideoPanelViewport'

vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video', () => ({
  VideoPanelCard: ({ panel }: { panel: VideoPanel }) => React.createElement(
    'article',
    { 'data-testid': 'video-panel-card' },
    panel.panelId,
  ),
}))

vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/voice/VoiceLineCard', () => ({
  default: ({ line }: { line: VoiceLine }) => React.createElement(
    'article',
    { 'data-testid': 'voice-line-card' },
    line.id,
  ),
}))

vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/PanelCard', () => ({
  default: ({ panel }: { panel: StoryboardPanel }) => React.createElement(
    'article',
    { 'data-testid': 'storyboard-panel-card' },
    panel.id,
  ),
}))

vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardGroup', () => ({
  default: ({ storyboard }: { storyboard: { id: string } }) => React.createElement(
    'section',
    { 'data-testid': 'storyboard-group' },
    storyboard.id,
  ),
}))

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

beforeEach(() => {
  Reflect.set(globalThis, 'React', React)
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    },
  })
  Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: vi.fn() })
})

afterEach(() => cleanup())

function videoPanels(count: number): VideoPanel[] {
  return Array.from({ length: count }, (_, index) => ({
    panelId: `video-${index}`,
    storyboardId: `storyboard-${index}`,
    panelIndex: index,
    videoTaskRunning: index === 89,
  }))
}

function videoProps(allPanels: VideoPanel[], panelRefs: React.MutableRefObject<Map<string, HTMLDivElement>>) {
  const noop = () => undefined
  const asyncNoop = async () => undefined
  return {
    allPanels,
    linkedPanels: new Map(),
    highlightedPanelKey: 'storyboard-90-90',
    panelRefs,
    videoRatio: '16:9',
    defaultVideoModel: '',
    capabilityOverrides: {},
    projectId: 'project-1',
    episodeId: 'episode-1',
    runningVoiceLineIds: new Set<string>(),
    panelVoiceLines: new Map(),
    panelVideoPreference: new Map(),
    savingPrompts: new Set<string>(),
    flModel: '',
    flModelOptions: [],
    flGenerationOptions: {},
    flCapabilityFields: [],
    flMissingCapabilityFields: [],
    flModelSupportsFirstLastFrame: false,
    flCustomPrompts: new Map(),
    onGenerateVideo: asyncNoop,
    onUpdatePanelVideoModel: asyncNoop,
    onLipSync: asyncNoop,
    onToggleLink: asyncNoop,
    onUpdateFrameLink: asyncNoop,
    onFlModelChange: noop,
    onFlCapabilityChange: noop,
    onFlCustomPromptChange: noop,
    onResetFlPrompt: noop,
    onGenerateFirstLastFrame: asyncNoop,
    onPreviewImage: noop,
    onToggleLipSyncVideo: noop,
    getNextPanel: () => null,
    getPreviousPanel: () => null,
    getFrameLinkChoices: () => ({}),
    isLinkedAsLastFrame: () => false,
    getDefaultFlPrompt: () => '',
    getLocalPrompt: () => '',
    updateLocalPrompt: noop,
    savePrompt: asyncNoop,
  } as unknown as React.ComponentProps<typeof VideoRenderPanel>
}

function voiceLines(count: number): VoiceLine[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `voice-${index}`,
    lineIndex: index,
    speaker: 'speaker',
    content: `line ${index}`,
    emotionPrompt: null,
    emotionStrength: null,
    audioUrl: null,
    updatedAt: null,
    lineTaskRunning: index === 89,
  }))
}

describe('workspace card virtualization', () => {
  it('bounds video card bodies, pins highlighted/running panels, and keeps offscreen scroll targets', () => {
    const panelRefs = { current: new Map<string, HTMLDivElement>() }
    const view = render(React.createElement(VideoRenderPanel, videoProps(videoPanels(100), panelRefs)))

    expect(view.getAllByTestId('video-panel-card').length).toBeLessThanOrEqual(10)
    expect(view.getByText('video-89')).toBeTruthy()
    expect(view.getByText('video-90')).toBeTruthy()
    expect(view.queryByText('video-50')).toBeNull()
    expect(panelRefs.current.has('storyboard-50-50')).toBe(true)
  })

  it('scrolls to the retained wrapper for an unmounted video card body', () => {
    const scrollTo = vi.fn()
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 100 })
    Object.defineProperty(window, 'scrollTo', { configurable: true, value: scrollTo })
    const wrapper = document.createElement('div')
    wrapper.getBoundingClientRect = () => ({ top: 2500 } as DOMRect)
    const hook = renderHook(() => useVideoPanelViewport())
    hook.result.current.panelRefs.current.set('storyboard-50-50', wrapper)

    act(() => hook.result.current.locateVoiceLinePanel('storyboard-50', 50))

    expect(scrollTo).toHaveBeenCalledWith({ top: 2460, behavior: 'smooth' })
    expect(hook.result.current.highlightedPanelKey).toBe('storyboard-50-50')
  })

  it('bounds voice cards while pinning the playing, editing, and running lines', () => {
    const lines = voiceLines(100)
    const noop = () => undefined
    const asyncNoop = async () => undefined
    const view = render(React.createElement(VoiceLineList, {
      voiceLines: lines,
      runningLineIds: new Set(['voice-89']),
      voiceStatusStateByLineId: new Map(),
      playingLineId: 'voice-88',
      editingLineId: 'voice-90',
      analyzing: false,
      getSpeakerVoiceUrl: () => null,
      onTogglePlayAudio: noop,
      onDownloadSingle: noop,
      onGenerateLine: asyncNoop,
      onStartEdit: noop,
      onLocatePanel: noop,
      onDeleteLine: asyncNoop,
      onDeleteAudio: asyncNoop,
      onSaveEmotionSettings: asyncNoop,
      onAnalyze: asyncNoop,
    } as React.ComponentProps<typeof VoiceLineList>))

    expect(view.getAllByTestId('voice-line-card').length).toBeLessThanOrEqual(10)
    expect(view.getByText('voice-88')).toBeTruthy()
    expect(view.getByText('voice-89')).toBeTruthy()
    expect(view.getByText('voice-90')).toBeTruthy()
    expect(view.queryByText('voice-50')).toBeNull()
  })

  it('bounds storyboard card bodies while pinning dirty and running panels', () => {
    const panels = Array.from({ length: 100 }, (_, index) => ({
      id: `panel-${index}`,
      storyboardId: 'storyboard-1',
      panelIndex: index,
      imageUrl: null,
    })) as unknown as StoryboardPanel[]
    const noop = () => undefined
    const asyncNoop = async () => undefined
    const view = render(React.createElement(StoryboardPanelList, {
      storyboard: { id: 'storyboard-1', layoutMode: 'single' },
      textPanels: panels,
      storyboardStartIndex: 0,
      videoRatio: '16:9',
      isSubmittingStoryboardTextTask: false,
      savingPanels: new Set<string>(),
      deletingPanelIds: new Set<string>(),
      saveStateByPanel: {},
      hasUnsavedByPanel: new Set(['panel-90']),
      modifyingPanels: new Set<string>(),
      panelTaskErrorMap: new Map(),
      isPanelTaskRunning: (panel: StoryboardPanel) => panel.id === 'panel-89',
      getPanelEditData: () => ({}),
      getPanelCandidates: () => null,
      onPanelUpdate: noop,
      onPanelDelete: noop,
      onOpenCharacterPicker: noop,
      onOpenLocationPicker: noop,
      onRemoveCharacter: noop,
      onRemoveLocation: noop,
      onRetryPanelSave: noop,
      onRegeneratePanelImage: noop,
      onOpenEditModal: noop,
      onOpenAIDataModal: noop,
      onSelectPanelCandidateIndex: noop,
      onConfirmPanelCandidate: asyncNoop,
      onCancelPanelCandidate: noop,
      onClearPanelTaskError: noop,
      onPreviewImage: noop,
      onInsertAfter: noop,
      onVariant: noop,
      isInsertDisabled: () => false,
      sixGridUpscaleWorkflow: null,
      sixGridTaskPanelId: null,
      isSixGridTaskRunning: false,
      onOpenSixGridCrop: noop,
      onUpscaleSixGridPanel: asyncNoop,
      onUndoSixGridPanel: asyncNoop,
    } as unknown as React.ComponentProps<typeof StoryboardPanelList>))

    expect(view.getAllByTestId('storyboard-panel-card').length).toBeLessThanOrEqual(10)
    expect(view.getByText('panel-89')).toBeTruthy()
    expect(view.getByText('panel-90')).toBeTruthy()
    expect(view.queryByText('panel-50')).toBeNull()
  })

  it('bounds storyboard groups while pinning local and persisted active groups', () => {
    const storyboards = Array.from({ length: 100 }, (_, index) => ({
      id: `storyboard-${index}`,
      clipId: `clip-${index}`,
      panels: [],
    }))
    const noop = () => undefined
    const asyncNoop = async () => undefined
    const view = render(React.createElement(StoryboardCanvas, {
      sortedStoryboards: storyboards,
      videoRatio: '16:9',
      expandedClips: new Set(['storyboard-89']),
      submittingStoryboardIds: new Set(['storyboard-90']),
      selectingCandidateIds: new Set<string>(),
      submittingStoryboardTextIds: new Set<string>(),
      savingPanels: new Set<string>(),
      deletingPanelIds: new Set<string>(),
      saveStateByPanel: {},
      hasUnsavedByPanel: new Set<string>(),
      modifyingPanels: new Set<string>(),
      submittingPanelImageIds: new Set<string>(),
      movingClipId: null,
      insertingAfterPanelId: null,
      submittingVariantPanelId: null,
      projectId: 'project-1',
      episodeId: 'episode-1',
      storyboardStartIndex: {},
      getClipInfo: () => undefined,
      getTextPanels: (storyboard: { id: string }) => storyboard.id === 'storyboard-91'
        ? [{ id: 'panel-running', imageTaskRunning: true }]
        : [],
      getPanelEditData: () => ({}),
      formatClipTitle: () => '',
      onToggleExpandedClip: noop,
      onMoveStoryboardGroup: asyncNoop,
      onRegenerateStoryboardText: asyncNoop,
      onAddPanel: asyncNoop,
      onDeleteStoryboard: asyncNoop,
      onGenerateAllIndividually: asyncNoop,
      onPreviewImage: noop,
      onCloseStoryboardError: noop,
      onPanelUpdate: noop,
      onPanelDelete: asyncNoop,
      onOpenCharacterPicker: noop,
      onOpenLocationPicker: noop,
      onRemoveCharacter: noop,
      onRemoveLocation: noop,
      onRetryPanelSave: noop,
      onRegeneratePanelImage: noop,
      onOpenEditModal: noop,
      onOpenAIDataModal: noop,
      getPanelCandidates: () => null,
      onSelectPanelCandidateIndex: noop,
      onConfirmPanelCandidate: asyncNoop,
      onCancelPanelCandidate: noop,
      onInsertPanel: asyncNoop,
      onPanelVariant: asyncNoop,
      addStoryboardGroup: asyncNoop,
      addingStoryboardGroup: false,
      setLocalStoryboards: noop,
      sixGridUpscaleWorkflow: null,
      sixGridTaskStoryboardId: null,
      sixGridTaskPanelId: null,
      onGenerateSixGridSheet: asyncNoop,
      onUpscaleSixGridSheet: asyncNoop,
      onCropSixGridSheet: asyncNoop,
      onUpscaleSixGridPanel: asyncNoop,
      onUndoSixGridPanel: asyncNoop,
    } as unknown as React.ComponentProps<typeof StoryboardCanvas>))

    expect(view.getAllByTestId('storyboard-group').length).toBeLessThanOrEqual(10)
    expect(view.queryByText('storyboard-89')).toBeNull()
    expect(view.getByText('storyboard-90')).toBeTruthy()
    expect(view.getByText('storyboard-91')).toBeTruthy()
    expect(view.queryByText('storyboard-50')).toBeNull()
  })
})
