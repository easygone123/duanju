// @vitest-environment jsdom

import React from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CombinedPreviewPanel } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video-stage/combined-preview'
import type { VideoPanel } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video/types'
import { buildCombinedPreviewTimeline } from '@/lib/novel-promotion/video/combined-preview'

type PlayerListener = (event: { detail?: unknown }) => void

const playerMock = vi.hoisted(() => ({
  currentFrame: 0,
  mounts: 0,
  listeners: new Map<string, Set<PlayerListener>>(),
  seekTo: vi.fn(),
  play: vi.fn(),
  pause: vi.fn(),
  getCurrentFrame: vi.fn(() => 0),
  addEventListener: vi.fn((name: string, listener: PlayerListener) => {
    const listeners = playerMock.listeners.get(name) ?? new Set<PlayerListener>()
    listeners.add(listener)
    playerMock.listeners.set(name, listeners)
  }),
  removeEventListener: vi.fn((name: string, listener: PlayerListener) => {
    playerMock.listeners.get(name)?.delete(listener)
  }),
}))

const prefetchMock = vi.hoisted(() => ({
  prefetch: vi.fn(),
  freeByUrl: new Map<string, ReturnType<typeof vi.fn>>(),
}))

vi.mock('@remotion/player', async () => {
  const ReactModule = await import('react')
  const player = {
    seekTo: playerMock.seekTo,
    play: playerMock.play,
    pause: playerMock.pause,
    getCurrentFrame: playerMock.getCurrentFrame,
    addEventListener: playerMock.addEventListener,
    removeEventListener: playerMock.removeEventListener,
  }

  return {
    Player: ReactModule.forwardRef(function MockPlayer(
      props: Record<string, unknown>,
      ref: React.ForwardedRef<typeof player>,
    ) {
      ReactModule.useImperativeHandle(ref, () => player, [])
      ReactModule.useEffect(() => {
        playerMock.mounts += 1
      }, [])
      return ReactModule.createElement('div', {
        'data-testid': 'combined-preview-player',
        'data-duration-in-frames': props.durationInFrames,
      })
    }),
  }
})

vi.mock('remotion', () => ({
  prefetch: prefetchMock.prefetch,
}))

function panel(overrides: Partial<VideoPanel> = {}): VideoPanel {
  return {
    panelId: 'panel-1',
    storyboardId: 'storyboard-1',
    panelIndex: 0,
    videoUrl: '/clip-0.mp4',
    imageUrl: '/thumb-0.jpg',
    estimatedDuration: 2,
    ...overrides,
  }
}

function videoPanels(count: number): VideoPanel[] {
  return Array.from({ length: count }, (_, index) => panel({
    panelId: `panel-${index}`,
    storyboardId: `storyboard-${index}`,
    panelIndex: index,
    videoUrl: `/clip-${index}.mp4`,
    imageUrl: `/thumb-${index}.jpg`,
    groupSequence: index < 2 ? 1 : 2,
  }))
}

function preview(
  panels: readonly VideoPanel[],
  panelVideoPreference: ReadonlyMap<string, boolean> = new Map(),
  videoRatio = '16:9',
) {
  return React.createElement(CombinedPreviewPanel, { panels, panelVideoPreference, videoRatio })
}

function emit(name: string, detail?: unknown) {
  act(() => {
    for (const listener of playerMock.listeners.get(name) ?? []) listener({ detail })
  })
}

function emitFrame(frame: number) {
  playerMock.currentFrame = frame
  playerMock.getCurrentFrame.mockReturnValue(frame)
  emit('frameupdate', { frame })
}

beforeEach(() => {
  playerMock.currentFrame = 0
  playerMock.mounts = 0
  playerMock.listeners.clear()
  playerMock.seekTo.mockReset()
  playerMock.play.mockReset()
  playerMock.pause.mockReset()
  playerMock.getCurrentFrame.mockReset().mockImplementation(() => playerMock.currentFrame)
  playerMock.addEventListener.mockClear()
  playerMock.removeEventListener.mockClear()
  prefetchMock.freeByUrl.clear()
  prefetchMock.prefetch.mockReset().mockImplementation((url: string) => {
    const free = vi.fn()
    prefetchMock.freeByUrl.set(url, free)
    return { free, waitUntilDone: vi.fn(async () => url) }
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

describe('finished-film combined preview', () => {
  it('keeps one Player mounted while nodes seek, preserve playback, and follow frame updates', () => {
    const panels = videoPanels(3)
    const timeline = buildCombinedPreviewTimeline(panels, new Map())
    const view = render(preview(panels))
    const nodes = panels.map((_, index) => view.getByRole('button', { name: `镜头 ${index + 1}` }))

    expect(nodes).toHaveLength(3)
    expect(view.getAllByTestId('combined-preview-player')).toHaveLength(1)
    expect(playerMock.mounts).toBe(1)
    expect(nodes[0].getAttribute('aria-current')).toBe('true')
    expect(nodes[0].getAttribute('data-group-start')).toBe('true')
    expect(nodes[1].getAttribute('data-group-start')).toBeNull()
    expect(nodes[2].getAttribute('data-group-start')).toBe('true')
    const scrollIntoView = vi.mocked(HTMLElement.prototype.scrollIntoView)
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'center' })
    scrollIntoView.mockClear()

    emit('play')
    fireEvent.click(nodes[1])
    expect(playerMock.seekTo).toHaveBeenLastCalledWith(timeline.items[1].startFrame)
    expect(playerMock.play).toHaveBeenLastCalledWith()
    expect(playerMock.pause).not.toHaveBeenCalled()

    emit('pause')
    fireEvent.click(nodes[0])
    expect(playerMock.pause).toHaveBeenLastCalledWith()

    emitFrame(timeline.items[2].startFrame)
    expect(nodes[2].getAttribute('aria-current')).toBe('true')
    expect(nodes[0].getAttribute('aria-current')).toBeNull()
    expect(playerMock.mounts).toBe(1)
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'center' })

    for (const eventName of ['frameupdate', 'play', 'pause', 'ended']) {
      expect(playerMock.addEventListener).toHaveBeenCalledWith(eventName, expect.any(Function))
      expect(playerMock.addEventListener.mock.calls.filter(([name]) => name === eventName)).toHaveLength(1)
    }

    view.unmount()
    for (const eventName of ['frameupdate', 'play', 'pause', 'ended']) {
      expect(playerMock.removeEventListener).toHaveBeenCalledWith(eventName, expect.any(Function))
      expect(playerMock.removeEventListener.mock.calls.filter(([name]) => name === eventName)).toHaveLength(1)
    }
  })

  it('marks every groupSequence change, including transitions to null and undefined', () => {
    const panels = [
      panel({ panelId: 'group-1', panelIndex: 0, groupSequence: 1 }),
      panel({ panelId: 'ungrouped-null', panelIndex: 1, groupSequence: null }),
      panel({ panelId: 'group-2', panelIndex: 2, groupSequence: 2 }),
      panel({ panelId: 'ungrouped-undefined', panelIndex: 3, groupSequence: undefined }),
    ]
    const view = render(preview(panels))

    for (let index = 0; index < panels.length; index += 1) {
      expect(view.getByRole('button', { name: `镜头 ${index + 1}` }).getAttribute('data-group-start')).toBe('true')
    }
  })

  it('makes the last synchronous node click authoritative without remounting Player', () => {
    const panels = videoPanels(3)
    const timeline = buildCombinedPreviewTimeline(panels, new Map())
    const view = render(preview(panels))
    const nodes = panels.map((_, index) => view.getByRole('button', { name: `镜头 ${index + 1}` }))

    fireEvent.click(nodes[0])
    fireEvent.click(nodes[1])
    fireEvent.click(nodes[2])

    expect(playerMock.seekTo).toHaveBeenLastCalledWith(timeline.items[2].startFrame)
    expect(nodes[2].getAttribute('aria-current')).toBe('true')
    expect(playerMock.mounts).toBe(1)
  })

  it('preloads only the unique previous, current, and next video URLs and frees the bounded window', () => {
    const panels = videoPanels(4)
    const view = render(preview(panels))

    expect(prefetchMock.prefetch.mock.calls.map(([url]) => url)).toEqual(['/clip-0.mp4', '/clip-1.mp4'])
    fireEvent.click(view.getByRole('button', { name: '镜头 3' }))
    expect(prefetchMock.prefetch.mock.calls.map(([url]) => url)).toEqual([
      '/clip-0.mp4', '/clip-1.mp4', '/clip-2.mp4', '/clip-3.mp4',
    ])
    expect(prefetchMock.freeByUrl.get('/clip-0.mp4')).toHaveBeenCalledTimes(1)
    expect(prefetchMock.freeByUrl.get('/clip-1.mp4')).not.toHaveBeenCalled()

    view.unmount()
    for (const url of ['/clip-1.mp4', '/clip-2.mp4', '/clip-3.mp4']) {
      expect(prefetchMock.freeByUrl.get(url)).toHaveBeenCalledTimes(1)
    }
  })

  it('prefetches duplicate URLs once and frees their single handle on unmount', () => {
    const panels = videoPanels(3).map((item, index) => ({
      ...item,
      videoUrl: index < 2 ? '/shared.mp4' : '/unique.mp4',
    }))
    const view = render(preview(panels))

    expect(prefetchMock.prefetch).toHaveBeenCalledTimes(1)
    expect(prefetchMock.prefetch).toHaveBeenCalledWith('/shared.mp4', expect.any(Object))
    fireEvent.click(view.getByRole('button', { name: '镜头 3' }))
    expect(prefetchMock.prefetch).toHaveBeenCalledTimes(2)
    expect(prefetchMock.prefetch).toHaveBeenLastCalledWith('/unique.mp4', expect.any(Object))

    view.unmount()
    expect(prefetchMock.freeByUrl.get('/shared.mp4')).toHaveBeenCalledTimes(1)
    expect(prefetchMock.freeByUrl.get('/unique.mp4')).toHaveBeenCalledTimes(1)
  })

  it('keeps every non-video status clickable with lazy thumbnails and a non-black missing placeholder', () => {
    const panels = [
      panel({ panelId: 'image', panelIndex: 0, videoUrl: undefined, imageUrl: '/image.jpg' }),
      panel({ panelId: 'missing', panelIndex: 1, videoUrl: undefined, imageUrl: undefined }),
      panel({ panelId: 'generating', panelIndex: 2, videoTaskRunning: true, imageUrl: '/generating.jpg' }),
      panel({ panelId: 'failed', panelIndex: 3, videoErrorMessage: 'failed', imageUrl: '/failed.jpg' }),
    ]
    const timeline = buildCombinedPreviewTimeline(panels, new Map())
    const view = render(preview(panels, new Map(), '9:16'))

    expect(view.getAllByRole('button', { name: /^镜头 \d+$/ })).toHaveLength(4)
    expect(view.getByText('静态图')).toBeTruthy()
    expect(view.getByText('缺少媒体')).toBeTruthy()
    expect(view.getByText('生成中')).toBeTruthy()
    expect(view.getByText('失败')).toBeTruthy()
    expect(view.getAllByText('2.0s')).toHaveLength(4)
    expect(view.getAllByRole('img').every((image) => image.getAttribute('loading') === 'lazy')).toBe(true)
    const placeholder = view.getByTestId('combined-preview-thumbnail-placeholder-missing')
    expect(placeholder.style.backgroundImage).toContain('linear-gradient')

    fireEvent.click(view.getByRole('button', { name: '镜头 4' }))
    expect(playerMock.seekTo).toHaveBeenLastCalledWith(timeline.items[3].startFrame)
  })

  it('does not mount Player for an empty panel list', () => {
    const view = render(preview([]))

    expect(view.queryByTestId('combined-preview-player')).toBeNull()
    expect(view.getByText('暂无可预览分镜')).toBeTruthy()
    expect(prefetchMock.prefetch).not.toHaveBeenCalled()
  })

  it('resets the active node when an emptied timeline receives panels again', () => {
    const panelVideoPreference = new Map<string, boolean>()
    const view = render(preview(videoPanels(4), panelVideoPreference))
    fireEvent.click(view.getByRole('button', { name: '镜头 4' }))
    expect(view.getByRole('button', { name: '镜头 4' }).getAttribute('aria-current')).toBe('true')

    view.rerender(preview([], panelVideoPreference))
    view.rerender(preview(videoPanels(1), panelVideoPreference))

    expect(view.getByRole('button', { name: '镜头 1' }).getAttribute('aria-current')).toBe('true')
  })
})
