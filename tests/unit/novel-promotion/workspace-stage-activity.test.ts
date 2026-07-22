// @vitest-environment jsdom

import React, { useState } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceStageCache, type WorkspaceStageComponentMap } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/WorkspaceStageCache'
import ScriptViewAssetsPanel from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/script-view/ScriptViewAssetsPanel'
import { SpotlightCharCard } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/script-view/SpotlightCards'
import AIDataModal from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/AIDataModal'
import SpeakerVoiceBindingDialog from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/voice/SpeakerVoiceBindingDialog'
import { usePanelVoiceManager } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video/panel-card/runtime/hooks/usePanelVoiceManager'
import type { MatchedVoiceLine } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video/types'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}))

vi.mock('@/components/ui/icons', () => ({
  AppIcon: ({ name }: { name: string }) => React.createElement('span', { 'data-icon': name }),
}))

vi.mock('@/components/media/MediaImageWithLoading', () => ({
  MediaImageWithLoading: ({ src, alt, onClick }: {
    src: string
    alt: string
    onClick?: React.MouseEventHandler<HTMLImageElement>
  }) => React.createElement('img', { src, alt, onClick }),
}))

vi.mock('@/components/ui/ImagePreviewModal', () => ({
  default: () => React.createElement('div', null, 'spotlight image preview'),
}))

vi.mock('@/app/[locale]/workspace/asset-hub/components/VoicePickerDialog', () => ({
  default: () => React.createElement('div', null, 'voice picker'),
}))

vi.mock('@/app/[locale]/workspace/asset-hub/components/VoiceCreationModal', () => ({
  default: () => React.createElement('div', null, 'voice creation'),
}))

const queryMocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  setQueryData: vi.fn(),
}))

vi.mock('@/lib/query/hooks', () => ({
  useGenerateProjectVoice: () => ({ mutateAsync: queryMocks.mutateAsync }),
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ setQueryData: queryMocks.setQueryData }),
}))

class TestAudio {
  static instances: TestAudio[] = []

  currentTime = 0
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  pause = vi.fn()
  play = vi.fn().mockResolvedValue(undefined)

  constructor(public readonly src: string) {
    TestAudio.instances.push(this)
  }
}

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
    editor: EmptyStage,
  }
}

function ScriptPortalStage() {
  return React.createElement(ScriptViewAssetsPanel, {
    clips: [],
    assetViewMode: 'all',
    setAssetViewMode: vi.fn(),
    setSelectedClipId: vi.fn(),
    characters: [],
    locations: [],
    props: [],
    activeCharIds: [],
    activeLocationIds: [],
    activePropIds: [],
    selectedAppearanceKeys: new Set<string>(),
    onUpdateClipAssets: vi.fn().mockResolvedValue(undefined),
    assetsLoading: false,
    assetsLoadingState: null,
    allAssetsHaveImages: true,
    globalCharIds: [],
    globalLocationIds: [],
    globalPropIds: [],
    missingAssetsCount: 0,
    isSubmittingStoryboardBuild: false,
    getSelectedAppearances: () => [],
    tScript: (key: string) => key,
    tAssets: (key: string) => key,
    tNP: (key: string) => key,
    tCommon: (key: string) => key,
  })
}

function AIDataPortalStage() {
  const [isOpen, setIsOpen] = useState(true)
  return React.createElement(AIDataModal, {
    isOpen,
    onClose: () => {
      activityCloseMocks.aiData()
      setIsOpen(false)
    },
    syncKey: 'panel-1',
    panelNumber: 1,
    shotType: null,
    cameraMove: null,
    description: null,
    location: null,
    characters: [],
    videoPrompt: null,
    photographyRules: null,
    actingNotes: null,
    videoRatio: '16:9',
    onSave: vi.fn(),
  })
}

function SpeakerPortalStage() {
  const [isOpen, setIsOpen] = useState(true)
  return React.createElement(SpeakerVoiceBindingDialog, {
    isOpen,
    speaker: 'Narrator',
    projectId: 'project-1',
    episodeId: 'episode-1',
    onClose: () => {
      activityCloseMocks.speaker()
      setIsOpen(false)
    },
    onBound: vi.fn(),
  })
}

const voiceLine: MatchedVoiceLine = {
  id: 'line-1',
  lineIndex: 1,
  speaker: 'Narrator',
  content: 'hello',
  audioUrl: '/voice.mp3',
}

const activityCloseMocks = {
  aiData: vi.fn(),
  speaker: vi.fn(),
}

function PanelVoiceStage() {
  const voice = usePanelVoiceManager({
    projectId: 'project-1',
    episodeId: 'episode-1',
    matchedVoiceLines: [voiceLine],
    audioFailedMessage: 'audio failed',
  })
  return React.createElement('button', {
    onClick: () => voice.handlePlayVoiceLine(voiceLine),
  }, 'play panel voice')
}

beforeEach(() => {
  TestAudio.instances = []
  vi.stubGlobal('Audio', TestAudio)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('cached workspace stage activity', () => {
  it('closes the real ScriptViewAssetsPanel body portal when its shell becomes inactive', async () => {
    const stages = stageComponents(ScriptPortalStage)
    const view = render(React.createElement(WorkspaceStageCache, {
      currentStage: 'config',
      episodeId: 'episode-1',
      stageComponents: stages,
    }))

    const editButtons = [...view.container.querySelectorAll('[data-icon="edit"]')]
    fireEvent.click(editButtons[0].closest('button') as HTMLButtonElement)
    await waitFor(() => expect(document.body.textContent).toContain('edit · asset.activeCharacters'))

    view.rerender(React.createElement(WorkspaceStageCache, {
      currentStage: 'script',
      episodeId: 'episode-1',
      stageComponents: stages,
    }))

    await waitFor(() => expect(document.body.textContent).not.toContain('edit · asset.activeCharacters'))
  })

  it('closes the real AIDataModal body portal when its shell becomes inactive', async () => {
    const stages = stageComponents(AIDataPortalStage)
    const view = render(React.createElement(WorkspaceStageCache, {
      currentStage: 'config',
      episodeId: 'episode-1',
      stageComponents: stages,
    }))
    expect(document.body.textContent).toContain('storyboard.aiData.title')

    view.rerender(React.createElement(WorkspaceStageCache, {
      currentStage: 'script',
      episodeId: 'episode-1',
      stageComponents: stages,
    }))

    await waitFor(() => expect(document.body.textContent).not.toContain('storyboard.aiData.title'))
    expect(activityCloseMocks.aiData).toHaveBeenCalledOnce()
  })

  it('closes the real speaker binding body portal when its shell becomes inactive', async () => {
    const stages = stageComponents(SpeakerPortalStage)
    const view = render(React.createElement(WorkspaceStageCache, {
      currentStage: 'config',
      episodeId: 'episode-1',
      stageComponents: stages,
    }))
    expect(document.body.textContent).toContain('voice.inlineBinding.title')

    view.rerender(React.createElement(WorkspaceStageCache, {
      currentStage: 'script',
      episodeId: 'episode-1',
      stageComponents: stages,
    }))

    await waitFor(() => expect(document.body.textContent).not.toContain('voice.inlineBinding.title'))
    expect(activityCloseMocks.speaker).toHaveBeenCalledOnce()
  })

  it('closes a SpotlightCards image portal when its cached shell becomes inactive', async () => {
    function SpotlightStage() {
      return React.createElement(SpotlightCharCard, {
        char: {
          id: 'character-1',
          name: 'Narrator',
          appearances: [],
        },
        appearance: {
          id: 'appearance-1',
          appearanceIndex: 0,
          changeReason: 'primary',
          description: null,
          descriptions: null,
          imageUrl: '/portrait.png',
          imageUrls: ['/portrait.png'],
          previousImageUrl: null,
          previousImageUrls: [],
          previousDescription: null,
          previousDescriptions: null,
          selectedIndex: 0,
        },
        isActive: true,
        onClick: vi.fn(),
      })
    }

    const stages = stageComponents(SpotlightStage)
    const view = render(React.createElement(WorkspaceStageCache, {
      currentStage: 'config',
      episodeId: 'episode-1',
      stageComponents: stages,
    }))
    fireEvent.click(view.getByRole('img', { name: 'Narrator' }))
    expect(document.body.textContent).toContain('spotlight image preview')

    view.rerender(React.createElement(WorkspaceStageCache, {
      currentStage: 'script',
      episodeId: 'episode-1',
      stageComponents: stages,
    }))

    await waitFor(() => expect(document.body.textContent).not.toContain('spotlight image preview'))
  })

  it('pauses SpotlightCards audio when its cached shell becomes inactive', async () => {
    function SpotlightStage() {
      return React.createElement(SpotlightCharCard, {
        char: {
          id: 'character-1',
          name: 'Narrator',
          appearances: [],
          customVoiceUrl: '/spotlight.mp3',
        },
        isActive: true,
        onClick: vi.fn(),
      })
    }

    const stages = stageComponents(SpotlightStage)
    const view = render(React.createElement(WorkspaceStageCache, {
      currentStage: 'config',
      episodeId: 'episode-1',
      stageComponents: stages,
    }))
    fireEvent.click(view.getByRole('button', { name: 'scriptView.asset.listen' }))
    const audio = TestAudio.instances[0]

    view.rerender(React.createElement(WorkspaceStageCache, {
      currentStage: 'script',
      episodeId: 'episode-1',
      stageComponents: stages,
    }))

    await waitFor(() => expect(audio.pause).toHaveBeenCalledOnce())
    expect(audio.currentTime).toBe(0)
  })

  it('pauses panel voice audio when its cached shell becomes inactive', async () => {
    const stages = stageComponents(PanelVoiceStage)
    const view = render(React.createElement(WorkspaceStageCache, {
      currentStage: 'config',
      episodeId: 'episode-1',
      stageComponents: stages,
    }))
    fireEvent.click(view.getByRole('button', { name: 'play panel voice' }))
    const audio = TestAudio.instances[0]

    view.rerender(React.createElement(WorkspaceStageCache, {
      currentStage: 'script',
      episodeId: 'episode-1',
      stageComponents: stages,
    }))

    await waitFor(() => expect(audio.pause).toHaveBeenCalledOnce())
  })
})
