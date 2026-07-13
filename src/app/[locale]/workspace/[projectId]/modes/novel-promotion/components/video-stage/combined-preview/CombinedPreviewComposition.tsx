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
        <Img
          src={item.imageUrl}
          style={{ ...fillStyle, objectFit: 'cover' }}
        />
      ) : null}
    </div>
  )
}

function PreviewVideo({ item }: { item: CombinedPreviewItem }) {
  const [ready, setReady] = useState(false)

  return (
    <Video
      data-preview-video={item.panelKey}
      data-testid={`combined-preview-video-${item.panelKey}`}
      src={item.videoUrl ?? undefined}
      pauseWhenBuffering
      muted={false}
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

  return (
    <div
      data-preview-item={item.panelKey}
      data-testid={`combined-preview-item-${item.panelKey}`}
      style={{
        ...fillStyle,
        opacity: resolveCombinedPreviewOpacity(item, localFrame),
      }}
    >
      <PreviewBase item={item} />
      {item.videoUrl ? <PreviewVideo key={item.videoUrl} item={item} /> : null}
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
