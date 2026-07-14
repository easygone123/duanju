// @vitest-environment jsdom

import React, { useState } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  WorkspaceStageCache,
  type WorkspaceStageComponentMap,
} from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/WorkspaceStageCache'
import InsertPanelModal from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/InsertPanelModal'
import PanelVariantModal from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/PanelVariantModal'
import SixGridCropModal from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/SixGridCropModal'
import { usePanelPlayer } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video/panel-card/runtime/hooks/usePanelPlayer'
import { useVoicePlayback } from '@/lib/novel-promotion/stages/voice-stage-runtime/useVoicePlayback'
import type { NovelPromotionStoryboard } from '@/types/project'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const sideEffectMocks = vi.hoisted(() => ({
  analyze: vi.fn(),
  insertClose: vi.fn(),
  variantClose: vi.fn(),
  cropClose: vi.fn(),
}))

vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}))

vi.mock('@/components/ui/icons', () => ({
  AppIcon: ({ name }: { name: string }) => React.createElement('span', { 'data-icon': name }),
}))

vi.mock('@/components/media/MediaImageWithLoading', () => ({
  MediaImageWithLoading: ({ alt }: { alt: string }) => React.createElement('img', { alt }),
}))

vi.mock('@/lib/query/hooks', () => ({
  useAnalyzeProjectShotVariants: () => ({ mutateAsync: sideEffectMocks.analyze }),
}))

function EmptyStage() {
  return React.createElement('div', null, 'empty stage')
}

function stageComponents(config: React.ComponentType): WorkspaceStageComponentMap {
  return {
    config,
    script: EmptyStage,
    storyboard: EmptyStage,
    videos: EmptyStage,
    voice: EmptyStage,
  }
}

function VariantModalStage() {
  const [isOpen, setIsOpen] = useState(true)
  return React.createElement(PanelVariantModal, {
    isOpen,
    onClose: () => {
      sideEffectMocks.variantClose()
      setIsOpen(false)
    },
    panel: {
      id: 'panel-1',
      panelNumber: 1,
      description: 'panel description',
      imageUrl: '/panel.png',
      storyboardId: 'storyboard-1',
    },
    projectId: 'project-1',
    onVariant: vi.fn().mockResolvedValue(undefined),
    isSubmittingVariantTask: false,
  })
}

function InsertModalStage() {
  const [isOpen, setIsOpen] = useState(true)
  return React.createElement(InsertPanelModal, {
    isOpen,
    onClose: () => {
      sideEffectMocks.insertClose()
      setIsOpen(false)
    },
    prevPanel: {
      id: 'panel-1',
      panelNumber: 1,
      description: 'before',
      imageUrl: '/before.png',
    },
    nextPanel: null,
    onInsert: vi.fn().mockResolvedValue(undefined),
    isInserting: true,
  })
}

class TestAudio {
  static instances: TestAudio[] = []

  currentTime = 12
  paused = false
  ended = false
  onended: (() => void) | null = null
  onpause: (() => void) | null = null
  pause = vi.fn(() => {
    this.paused = true
    this.onpause?.()
  })
  play = vi.fn().mockResolvedValue(undefined)

  constructor(public readonly src: string) {
    TestAudio.instances.push(this)
  }
}

function PanelPlayerStage() {
  const player = usePanelPlayer({
    videoRatio: '16:9',
    videoUrl: '/panel.mp4',
    showLipSyncVideo: false,
  })
  return React.createElement(React.Fragment, null,
    React.createElement('button', { onClick: () => void player.handlePlayClick() }, 'play panel video'),
    React.createElement('video', { ref: player.videoRef, 'data-testid': 'panel-video' }),
    React.createElement('span', null, player.isPlaying ? 'panel playing' : 'panel stopped'),
  )
}

function VoicePlaybackStage() {
  const playback = useVoicePlayback()
  return React.createElement(React.Fragment, null,
    React.createElement('button', {
      onClick: () => playback.handleTogglePlayAudio('line-1', '/voice.mp3'),
    }, 'play voice line'),
    React.createElement('span', null, playback.playingLineId ? 'voice playing' : 'voice stopped'),
  )
}

const sixGridStoryboard: NovelPromotionStoryboard = {
  id: 'storyboard-1',
  episodeId: 'episode-1',
  clipId: 'clip-1',
  storyboardTextJson: null,
  panelCount: 6,
  storyboardImageUrl: null,
  layoutMode: 'six_grid',
  groupSequence: 0,
  sixGridCellAspectRatio: '16:9',
  sixGridProcessingOrder: 'crop_then_panel_upscale',
  sheetImageUrl: '/sheet.webp',
  upscaledSheetImageUrl: '/sheet-upscaled.webp',
  panels: [],
}

function CropModalStage() {
  const [isOpen, setIsOpen] = useState(true)
  return React.createElement(SixGridCropModal, {
    isOpen,
    storyboard: sixGridStoryboard,
    onClose: () => {
      sideEffectMocks.cropClose()
      setIsOpen(false)
    },
    onSubmit: vi.fn().mockResolvedValue(undefined),
  })
}

beforeEach(() => {
  sideEffectMocks.analyze.mockImplementation(() => new Promise(() => undefined))
  TestAudio.instances = []
  vi.stubGlobal('Audio', TestAudio)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('inactive workspace media playback', () => {
  it('pauses and resets usePanelPlayer video playback when its stage becomes inactive', async () => {
    vi.useFakeTimers()
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    const stages = stageComponents(PanelPlayerStage)
    const view = render(React.createElement(WorkspaceStageCache, {
      currentStage: 'config',
      projectId: 'project-1',
      episodeId: 'episode-1',
      stageComponents: stages,
    }))
    const video = view.getByTestId('panel-video') as HTMLVideoElement
    video.currentTime = 8

    fireEvent.click(view.getByRole('button', { name: 'play panel video' }))
    await act(async () => vi.advanceTimersByTime(100))
    expect(play).toHaveBeenCalledOnce()
    expect(view.getByText('panel playing')).toBeTruthy()

    view.rerender(React.createElement(WorkspaceStageCache, {
      currentStage: 'script',
      projectId: 'project-1',
      episodeId: 'episode-1',
      stageComponents: stages,
    }))

    expect(pause).toHaveBeenCalledOnce()
    expect(video.currentTime).toBe(0)
    expect(view.getByText('panel stopped')).toBeTruthy()

    view.rerender(React.createElement(WorkspaceStageCache, {
      currentStage: 'config',
      projectId: 'project-1',
      episodeId: 'episode-1',
      stageComponents: stages,
    }))
    fireEvent.click(view.getByRole('button', { name: 'play panel video' }))
    await act(async () => vi.advanceTimersByTime(100))
    expect(play).toHaveBeenCalledTimes(2)
    expect(view.getByText('panel playing')).toBeTruthy()
  })

  it('pauses and resets useVoicePlayback audio when its stage becomes inactive', async () => {
    const stages = stageComponents(VoicePlaybackStage)
    const view = render(React.createElement(WorkspaceStageCache, {
      currentStage: 'config',
      projectId: 'project-1',
      episodeId: 'episode-1',
      stageComponents: stages,
    }))

    fireEvent.click(view.getByRole('button', { name: 'play voice line' }))
    const audio = TestAudio.instances[0]
    expect(view.getByText('voice playing')).toBeTruthy()

    view.rerender(React.createElement(WorkspaceStageCache, {
      currentStage: 'script',
      projectId: 'project-1',
      episodeId: 'episode-1',
      stageComponents: stages,
    }))

    await waitFor(() => expect(audio.pause).toHaveBeenCalledOnce())
    expect(audio.currentTime).toBe(0)
    expect(audio.onended).toBeNull()
    expect(audio.onpause).toBeNull()
    expect(view.getByText('voice stopped')).toBeTruthy()

    view.rerender(React.createElement(WorkspaceStageCache, {
      currentStage: 'config',
      projectId: 'project-1',
      episodeId: 'episode-1',
      stageComponents: stages,
    }))
    fireEvent.click(view.getByRole('button', { name: 'play voice line' }))
    expect(TestAudio.instances).toHaveLength(2)
    expect(TestAudio.instances[1].play).toHaveBeenCalledOnce()
    expect(view.getByText('voice playing')).toBeTruthy()
  })
})

describe('inactive workspace storyboard modals', () => {
  it('force-closes PanelVariantModal once and removes its portal while analysis is running', async () => {
    const stages = stageComponents(VariantModalStage)
    const view = render(React.createElement(WorkspaceStageCache, {
      currentStage: 'config',
      projectId: 'project-1',
      episodeId: 'episode-1',
      stageComponents: stages,
    }))

    await waitFor(() => expect(document.body.textContent).toContain('storyboard.variant.shotTitle'))
    await waitFor(() => expect(sideEffectMocks.analyze).toHaveBeenCalledOnce())

    view.rerender(React.createElement(WorkspaceStageCache, {
      currentStage: 'script',
      projectId: 'project-1',
      episodeId: 'episode-1',
      stageComponents: stages,
    }))

    await waitFor(() => expect(document.body.textContent).not.toContain('storyboard.variant.shotTitle'))
    expect(sideEffectMocks.variantClose).toHaveBeenCalledOnce()
    expect(sideEffectMocks.analyze).toHaveBeenCalledOnce()
  })

  it('force-closes InsertPanelModal once and removes its portal while insertion is running', async () => {
    const stages = stageComponents(InsertModalStage)
    const view = render(React.createElement(WorkspaceStageCache, {
      currentStage: 'config',
      projectId: 'project-1',
      episodeId: 'episode-1',
      stageComponents: stages,
    }))

    await waitFor(() => expect(document.body.textContent).toContain('storyboard.insertModal.insertBetween'))

    view.rerender(React.createElement(WorkspaceStageCache, {
      currentStage: 'script',
      projectId: 'project-1',
      episodeId: 'episode-1',
      stageComponents: stages,
    }))

    await waitFor(() => expect(document.body.textContent).not.toContain('storyboard.insertModal.insertBetween'))
    expect(sideEffectMocks.insertClose).toHaveBeenCalledOnce()
  })

  it('closes SixGridCropModal once and detaches its global interactions when inactive', async () => {
    const stages = stageComponents(CropModalStage)
    const view = render(React.createElement(WorkspaceStageCache, {
      currentStage: 'config',
      projectId: 'project-1',
      episodeId: 'episode-1',
      stageComponents: stages,
    }))
    const dialog = view.getByRole('dialog')
    expect(document.activeElement).toBe(dialog)

    view.rerender(React.createElement(WorkspaceStageCache, {
      currentStage: 'script',
      projectId: 'project-1',
      episodeId: 'episode-1',
      stageComponents: stages,
    }))

    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull())
    expect(sideEffectMocks.cropClose).toHaveBeenCalledOnce()
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.pointerMove(window, { clientX: 40, clientY: 40 })
    fireEvent.pointerUp(window)
    expect(sideEffectMocks.cropClose).toHaveBeenCalledOnce()
    expect(document.activeElement).not.toBe(dialog)
  })
})
