'use client'

import React, { useState } from 'react'
import { AbsoluteFill, Img, Sequence, Video, useCurrentFrame } from 'remotion'
import {
  resolveCombinedPreviewOpacity,
  type CombinedPreviewItem,
  type CombinedPreviewTimeline,
} from '@/lib/novel-promotion/video/combined-preview'

const fillStyle = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
} as const

function PreviewImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false)

  if (failed) return null

  return (
    <Img
      src={src}
      maxRetries={0}
      onError={() => setFailed(true)}
      style={{ ...fillStyle, objectFit: 'cover' }}
    />
  )
}

function PreviewBase({ item }: { item: CombinedPreviewItem }) {
  return (
    <div
      data-preview-base={item.panelKey}
      data-testid={`combined-preview-base-${item.panelKey}`}
      style={{
        ...fillStyle,
        overflow: 'hidden',
        backgroundColor: '#1f2937',
        backgroundImage: 'linear-gradient(135deg, #374151 0%, #1f2937 55%, #111827 100%)',
      }}
    >
      {item.imageUrl ? (
        <PreviewImage key={item.imageUrl} src={item.imageUrl} />
      ) : null}
    </div>
  )
}

export function resolveCombinedPreviewLayerOpacity(item: CombinedPreviewItem, localFrame: number): number {
  if (localFrame >= 0 && localFrame < item.transitionInFrames) {
    return localFrame / item.transitionInFrames
  }

  return 1
}

function PreviewVideo({ item, volume }: { item: CombinedPreviewItem; volume: number }) {
  const [ready, setReady] = useState(false)

  return (
    <Video
      data-preview-video={item.panelKey}
      data-testid={`combined-preview-video-${item.panelKey}`}
      src={item.videoUrl ?? undefined}
      pauseWhenBuffering
      muted={false}
      volume={volume}
      onCanPlay={() => setReady(true)}
      onError={() => setReady(false)}
      style={{
        ...fillStyle,
        objectFit: 'cover',
        opacity: ready ? 1 : 0,
      }}
    />
  )
}

function PreviewItem({ item }: { item: CombinedPreviewItem }) {
  const localFrame = useCurrentFrame()
  const audioVolume = resolveCombinedPreviewOpacity(item, localFrame)

  return (
    <div
      data-preview-item={item.panelKey}
      data-testid={`combined-preview-item-${item.panelKey}`}
      style={{
        ...fillStyle,
        opacity: resolveCombinedPreviewLayerOpacity(item, localFrame),
      }}
    >
      <PreviewBase item={item} />
      {item.status === 'video' && item.videoUrl ? (
        <PreviewVideo key={item.videoUrl} item={item} volume={audioVolume} />
      ) : null}
    </div>
  )
}

export function CombinedPreviewComposition({ timeline }: { timeline: CombinedPreviewTimeline }) {
  return (
    <AbsoluteFill
      data-preview-root
      data-testid="combined-preview-composition"
      style={{ backgroundColor: '#111827' }}
    >
      {timeline.items.map((item) => (
        <Sequence
          key={item.panelKey}
          from={item.startFrame}
          durationInFrames={item.durationInFrames}
        >
          <PreviewItem item={item} />
        </Sequence>
      ))}
    </AbsoluteFill>
  )
}
