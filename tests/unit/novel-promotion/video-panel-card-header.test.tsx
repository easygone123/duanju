// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VideoPanelCardHeader from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video/panel-card/VideoPanelCardHeader'
import type { VideoPanelRuntime } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video/panel-card/hooks/useVideoPanelActions'

vi.mock('@/components/task/TaskStatusOverlay', () => ({
  default: () => React.createElement('div', { 'data-testid': 'task-overlay' }),
}))
vi.mock('@/components/media/MediaImageWithLoading', () => ({
  MediaImageWithLoading: (props: { onClick?: () => void }) => React.createElement(
    'button',
    { type: 'button', 'data-testid': 'panel-thumbnail', onClick: props.onClick },
    'thumbnail',
  ),
}))
vi.mock('@/components/ui/icons', () => ({
  AppIcon: ({ name }: { name: string }) => React.createElement('span', null, name),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function createHeaderRuntime(input: {
  hasDialogue: boolean
  narrationVoiceEnabled?: boolean
  isPlaying?: boolean
}) {
  const handlePlayClick = vi.fn(async () => undefined)
  const runtime = {
    t: (key: string) => key,
    panel: {
      storyboardId: 'storyboard-1',
      panelIndex: 0,
      panelId: 'panel-1',
      imageUrl: 'frame.jpg',
      videoUrl: null,
      lipSyncVideoUrl: 'lip-only.mp4',
      hasDialogue: input.hasDialogue,
      narrationVoiceEnabled: input.narrationVoiceEnabled,
    },
    panelIndex: 0,
    panelKey: 'storyboard-1-0',
    layout: {
      videoRatio: '16:9',
      hasNext: false,
      isLinked: false,
      isLastFrame: false,
    },
    media: {
      baseVideoUrl: undefined,
      currentVideoUrl: 'lip-only.mp4',
      showLipSyncVideo: true,
      onToggleLipSyncVideo: vi.fn(),
      onPreviewImage: vi.fn(),
    },
    taskStatus: {
      isVideoTaskRunning: false,
      isLipSyncTaskRunning: false,
      panelErrorDisplay: null,
    },
    videoModel: {
      selectedModel: 'video-model',
      generationOptions: {},
      missingCapabilityFields: [],
      validationError: null,
      hasSettingsChanges: false,
      hasExplicitSelection: false,
      durationOverrideDirty: false,
    },
    player: {
      cssAspectRatio: '16/9',
      isPlaying: input.isPlaying ?? false,
      videoRef: React.createRef<HTMLVideoElement>(),
      setIsPlaying: vi.fn(),
      handlePlayClick,
      handlePreviewImage: vi.fn(),
    },
    actions: {
      onUpdateFrameLink: vi.fn(),
      onGenerateVideo: vi.fn(),
    },
  } as unknown as VideoPanelRuntime

  return { runtime, handlePlayClick }
}

describe('VideoPanelCardHeader playable media selection', () => {
  it.each([
    { label: 'ordinary', hasDialogue: false },
    { label: 'dialogue', hasDialogue: true },
  ])('plays a selected lip-sync URL when a $label panel has no base video', ({ hasDialogue }) => {
    const { runtime, handlePlayClick } = createHeaderRuntime({ hasDialogue })
    render(<VideoPanelCardHeader runtime={runtime} />)

    fireEvent.click(screen.getByTestId('panel-thumbnail'))
    expect(handlePlayClick).toHaveBeenCalledTimes(1)
  })

  it('renders the selected lip-sync URL while playing without a base video', () => {
    const { runtime } = createHeaderRuntime({ hasDialogue: true, isPlaying: true })
    const { container } = render(<VideoPanelCardHeader runtime={runtime} />)

    expect(container.querySelector('video')?.getAttribute('src')).toBe('lip-only.mp4')
  })

  it('does not expose a disabled narration lip-only result as playable', () => {
    const { runtime, handlePlayClick } = createHeaderRuntime({
      hasDialogue: false,
      narrationVoiceEnabled: false,
      isPlaying: true,
    })
    const { container } = render(<VideoPanelCardHeader runtime={runtime} />)

    expect(container.querySelector('video')).toBeNull()
    fireEvent.click(screen.getByTestId('panel-thumbnail'))
    expect(handlePlayClick).not.toHaveBeenCalled()
  })

  it('still plays the base video when narration is disabled and both variants exist', () => {
    const { runtime } = createHeaderRuntime({
      hasDialogue: false,
      narrationVoiceEnabled: false,
      isPlaying: true,
    })
    runtime.panel.videoUrl = 'base.mp4'
    runtime.media.baseVideoUrl = 'base.mp4'
    const { container } = render(<VideoPanelCardHeader runtime={runtime} />)

    expect(container.querySelector('video')?.getAttribute('src')).toBe('base.mp4')
  })
})
