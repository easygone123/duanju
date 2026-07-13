// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CombinedPreviewComposition } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video-stage/combined-preview/CombinedPreviewComposition'
import type {
  CombinedPreviewItem,
  CombinedPreviewTimeline,
} from '@/lib/novel-promotion/video/combined-preview'

const remotionState = vi.hoisted(() => ({ currentFrame: 2 }))

vi.mock('remotion', async () => {
  const ReactModule = await import('react')

  return {
    AbsoluteFill: ({ children, ...props }: React.ComponentProps<'div'>) => (
      ReactModule.createElement('div', props, children)
    ),
    Sequence: ({
      children,
      from,
      durationInFrames,
    }: React.PropsWithChildren<{ from: number; durationInFrames: number }>) => (
      ReactModule.createElement('div', {
        'data-remotion-sequence': true,
        'data-from': from,
        'data-duration': durationInFrames,
      }, children)
    ),
    Img: (props: React.ComponentProps<'img'>) => ReactModule.createElement('img', {
      ...props,
      'data-remotion-img': true,
    }),
    Video: ({ pauseWhenBuffering, ...props }: React.ComponentProps<'video'> & { pauseWhenBuffering?: boolean }) => (
      ReactModule.createElement('video', {
        ...props,
        'data-pause-when-buffering': pauseWhenBuffering,
      })
    ),
    useCurrentFrame: () => remotionState.currentFrame,
  }
})

afterEach(() => {
  cleanup()
  remotionState.currentFrame = 2
})

function item(overrides: Partial<CombinedPreviewItem>): CombinedPreviewItem {
  return {
    panelKey: 'panel',
    storyboardId: 'storyboard',
    panelIndex: 0,
    videoUrl: null,
    imageUrl: null,
    durationInFrames: 20,
    startFrame: 0,
    endFrame: 20,
    transitionInFrames: 0,
    transitionOutFrames: 0,
    status: 'missing',
    ...overrides,
  }
}

function timeline(items: readonly CombinedPreviewItem[]): CombinedPreviewTimeline {
  return {
    items,
    totalDurationInFrames: items.at(-1)?.endFrame ?? 0,
    itemByPanelKey: new Map(items.map((entry) => [entry.panelKey, entry])),
  }
}

describe('CombinedPreviewComposition', () => {
  const image = item({
    panelKey: 'image',
    imageUrl: '/image.jpg',
    startFrame: 4,
    endFrame: 24,
    status: 'image',
  })
  const video = item({
    panelKey: 'video',
    imageUrl: '/fallback.jpg',
    videoUrl: '/video.mp4',
    startFrame: 18,
    endFrame: 38,
    transitionInFrames: 4,
    status: 'video',
  })
  const missing = item({
    panelKey: 'missing',
    startFrame: 38,
    endFrame: 48,
    durationInFrames: 10,
  })
  const previewTimeline = timeline([image, video, missing])

  it('renders one non-black root and exact overlapping sequence layers', () => {
    const view = render(React.createElement(CombinedPreviewComposition, { timeline: previewTimeline }))
    const root = view.getByTestId('combined-preview-composition')
    const sequences = view.container.querySelectorAll('[data-remotion-sequence]')

    expect(root.style.backgroundColor).not.toBe('black')
    expect(root.style.backgroundColor).not.toBe('rgb(0, 0, 0)')
    expect(root.hasAttribute('data-preview-root')).toBe(true)
    expect(sequences).toHaveLength(3)
    expect(Array.from(sequences).map((sequence) => ({
      from: sequence.getAttribute('data-from'),
      duration: sequence.getAttribute('data-duration'),
    }))).toEqual([
      { from: '4', duration: '20' },
      { from: '18', duration: '20' },
      { from: '38', duration: '10' },
    ])
    expect(view.getByTestId('combined-preview-item-video').style.opacity).toBe('0.5')
    expect(view.getByTestId('combined-preview-item-video').getAttribute('data-preview-item')).toBe('video')
  })

  it('always renders a covering base and only uses Img for available images', () => {
    const view = render(React.createElement(CombinedPreviewComposition, { timeline: previewTimeline }))

    expect(view.getByTestId('combined-preview-base-image').querySelector('[data-remotion-img]')?.getAttribute('src'))
      .toBe('/image.jpg')
    expect(view.getByTestId('combined-preview-base-video').querySelector('[data-remotion-img]')?.getAttribute('src'))
      .toBe('/fallback.jpg')
    expect(view.getByTestId('combined-preview-base-missing')).toBeTruthy()
    expect(view.getByTestId('combined-preview-base-missing').getAttribute('data-preview-base')).toBe('missing')
    expect(view.getByTestId('combined-preview-base-missing').style.backgroundImage).not.toBe('none')
    expect(view.queryByTestId('combined-preview-video-image')).toBeNull()
    expect(view.queryByTestId('combined-preview-video-missing')).toBeNull()
  })

  it('keeps the base mounted while video readiness reveals and errors hide the video', () => {
    const view = render(React.createElement(CombinedPreviewComposition, { timeline: previewTimeline }))
    const base = view.getByTestId('combined-preview-base-video')
    const media = view.getByTestId('combined-preview-video-video')

    expect(media.style.opacity).toBe('0')
    expect((media as HTMLVideoElement).muted).toBe(false)
    expect(media.getAttribute('data-preview-video')).toBe('video')
    expect(media.getAttribute('data-pause-when-buffering')).toBe('true')
    fireEvent.canPlay(media)
    expect(media.style.opacity).toBe('1')
    expect(view.getByTestId('combined-preview-base-video')).toBe(base)
    fireEvent.error(media)
    expect(media.style.opacity).toBe('0')
    expect(view.getByTestId('combined-preview-base-video')).toBe(base)
  })

  it('resets readiness when a panel receives a different video URL', () => {
    const view = render(React.createElement(CombinedPreviewComposition, { timeline: previewTimeline }))
    const originalVideo = view.getByTestId('combined-preview-video-video')
    fireEvent.canPlay(originalVideo)
    expect(originalVideo.style.opacity).toBe('1')

    const updatedVideo = { ...video, videoUrl: '/replacement.mp4' }
    view.rerender(React.createElement(CombinedPreviewComposition, {
      timeline: timeline([image, updatedVideo, missing]),
    }))

    const replacementVideo = view.getByTestId('combined-preview-video-video')
    expect(replacementVideo.getAttribute('src')).toBe('/replacement.mp4')
    expect(replacementVideo.style.opacity).toBe('0')
    expect(view.getByTestId('combined-preview-base-video')).toBeTruthy()
  })
})
