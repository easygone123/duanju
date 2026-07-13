// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CombinedPreviewComposition,
  resolveCombinedPreviewLayerOpacity,
} from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video-stage/combined-preview/CombinedPreviewComposition'
import type {
  CombinedPreviewItem,
  CombinedPreviewTimeline,
} from '@/lib/novel-promotion/video/combined-preview'

const remotionState = vi.hoisted(() => ({ currentFrame: 20 }))

vi.mock('remotion', async () => {
  const ReactModule = await import('react')
  const SequenceFrameContext = ReactModule.createContext<number | null>(null)

  return {
    AbsoluteFill: ({ children, ...props }: React.ComponentProps<'div'>) => (
      ReactModule.createElement('div', props, children)
    ),
    Sequence: ({
      children,
      from,
      durationInFrames,
    }: React.PropsWithChildren<{ from: number; durationInFrames: number }>) => ReactModule.createElement(
      SequenceFrameContext.Provider,
      { value: remotionState.currentFrame - from },
      ReactModule.createElement('div', {
        'data-remotion-sequence': true,
        'data-from': from,
        'data-duration': durationInFrames,
      }, children),
    ),
    Img: ({ maxRetries, ...props }: React.ComponentProps<'img'> & { maxRetries?: number }) => (
      ReactModule.createElement('img', {
        ...props,
        'data-max-retries': maxRetries,
        'data-remotion-img': true,
      })
    ),
    Video: ({
      pauseWhenBuffering,
      volume,
      ...props
    }: React.ComponentProps<'video'> & { pauseWhenBuffering?: boolean; volume?: number }) => (
      ReactModule.createElement('video', {
        ...props,
        'data-pause-when-buffering': pauseWhenBuffering,
        'data-volume': volume,
      })
    ),
    useCurrentFrame: () => ReactModule.useContext(SequenceFrameContext) ?? remotionState.currentFrame,
  }
})

afterEach(() => {
  cleanup()
  remotionState.currentFrame = 20
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

  it('keeps source-over visual alpha opaque while only the incoming layer fades', () => {
    const outgoing = item({
      panelKey: 'outgoing',
      durationInFrames: 20,
      startFrame: 0,
      endFrame: 20,
      transitionOutFrames: 4,
    })
    const incoming = item({
      panelKey: 'incoming',
      durationInFrames: 20,
      startFrame: 16,
      endFrame: 36,
      transitionInFrames: 4,
    })

    for (let globalFrame = incoming.startFrame; globalFrame < outgoing.endFrame; globalFrame += 1) {
      const outgoingOpacity = resolveCombinedPreviewLayerOpacity(outgoing, globalFrame - outgoing.startFrame)
      const incomingOpacity = resolveCombinedPreviewLayerOpacity(incoming, globalFrame - incoming.startFrame)
      const sourceOverAlpha = incomingOpacity + outgoingOpacity * (1 - incomingOpacity)

      expect(outgoingOpacity).toBe(1)
      expect(incomingOpacity).toBe((globalFrame - incoming.startFrame) / incoming.transitionInFrames)
      expect(sourceOverAlpha).toBe(1)
    }
    expect(resolveCombinedPreviewLayerOpacity(incoming, incoming.transitionInFrames)).toBe(1)
  })

  it('uses complementary numeric video volumes across overlap and full volume outside it', () => {
    const outgoing = item({
      panelKey: 'outgoing',
      videoUrl: '/outgoing.mp4',
      status: 'video',
      durationInFrames: 20,
      startFrame: 0,
      endFrame: 20,
      transitionOutFrames: 4,
    })
    const incoming = item({
      panelKey: 'incoming',
      videoUrl: '/incoming.mp4',
      status: 'video',
      durationInFrames: 20,
      startFrame: 16,
      endFrame: 36,
      transitionInFrames: 4,
    })

    for (let globalFrame = incoming.startFrame; globalFrame < outgoing.endFrame; globalFrame += 1) {
      remotionState.currentFrame = globalFrame
      const overlapView = render(React.createElement(CombinedPreviewComposition, {
        timeline: timeline([outgoing, incoming]),
      }))
      const overlapVolumes = Array.from(overlapView.container.querySelectorAll('[data-preview-video]'))
        .map((element) => Number(element.getAttribute('data-volume')))
      const incomingVolume = (globalFrame - incoming.startFrame) / incoming.transitionInFrames

      expect(overlapVolumes).toEqual([1 - incomingVolume, incomingVolume])
      expect(overlapVolumes.reduce((sum, volume) => sum + volume, 0)).toBe(1)
      overlapView.unmount()
    }

    remotionState.currentFrame = 5
    const soloView = render(React.createElement(CombinedPreviewComposition, {
      timeline: timeline([outgoing]),
    }))
    expect(soloView.getByTestId('combined-preview-video-outgoing').getAttribute('data-volume')).toBe('1')
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

  it('renders static bases instead of retained video URLs for generating and failed items', () => {
    const generating = item({
      panelKey: 'generating',
      videoUrl: '/retained-generating.mp4',
      imageUrl: '/generating.jpg',
      status: 'generating',
    })
    const failed = item({
      panelKey: 'failed',
      videoUrl: '/retained-failed.mp4',
      imageUrl: '/failed.jpg',
      status: 'failed',
    })
    const view = render(React.createElement(CombinedPreviewComposition, {
      timeline: timeline([generating, failed]),
    }))

    expect(view.getByTestId('combined-preview-base-generating')).toBeTruthy()
    expect(view.getByTestId('combined-preview-base-failed')).toBeTruthy()
    expect(view.queryByTestId('combined-preview-video-generating')).toBeNull()
    expect(view.queryByTestId('combined-preview-video-failed')).toBeNull()
  })

  it('removes a failed image without losing its base and resets for a replacement URL', () => {
    const view = render(React.createElement(CombinedPreviewComposition, { timeline: previewTimeline }))
    const base = view.getByTestId('combined-preview-base-image')
    const originalImage = base.querySelector('[data-remotion-img]') as HTMLImageElement

    expect(originalImage.getAttribute('data-max-retries')).toBe('0')
    fireEvent.error(originalImage)
    expect(view.getByTestId('combined-preview-base-image')).toBe(base)
    expect(base.querySelector('[data-remotion-img]')).toBeNull()

    const replacementImage = { ...image, imageUrl: '/replacement.jpg' }
    view.rerender(React.createElement(CombinedPreviewComposition, {
      timeline: timeline([replacementImage, video, missing]),
    }))
    expect(base.querySelector('[data-remotion-img]')?.getAttribute('src')).toBe('/replacement.jpg')
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
