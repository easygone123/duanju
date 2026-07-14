'use client'

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Player, type PlayerRef } from '@remotion/player'
import type { VideoPanel } from '../../video/types'
import {
  buildCombinedPreviewTimeline,
  findCombinedPreviewItemIndexAtFrame,
  type CombinedPreviewStatus,
} from '@/lib/novel-promotion/video/combined-preview'
import { CombinedPreviewComposition } from './CombinedPreviewComposition'
import { useCombinedPreviewPreload } from './useCombinedPreviewPreload'

const PREVIEW_FPS = 30

const STATUS_LABELS: Record<CombinedPreviewStatus, string> = {
  video: '视频',
  image: '静态图',
  generating: '生成中',
  failed: '失败',
  missing: '缺少媒体',
}

export interface CombinedPreviewPanelProps {
  panels: readonly VideoPanel[]
  panelVideoPreference: ReadonlyMap<string, boolean>
  videoRatio: string
}

function formatDuration(durationInFrames: number) {
  const durationInSeconds = durationInFrames / PREVIEW_FPS
  if (durationInSeconds < 60) return `${durationInSeconds.toFixed(1)}s`

  const minutes = Math.floor(durationInSeconds / 60)
  const seconds = Math.floor(durationInSeconds % 60)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function resolveCompositionSize(videoRatio: string) {
  const [rawWidth, rawHeight] = videoRatio.split(':').map(Number)
  if (!(rawWidth > 0) || !(rawHeight > 0)) {
    return { width: 1280, height: 720, aspectRatio: '16 / 9' }
  }

  const height = 720
  return {
    width: Math.max(1, Math.round(height * rawWidth / rawHeight)),
    height,
    aspectRatio: `${rawWidth} / ${rawHeight}`,
  }
}

export function CombinedPreviewPanel({
  panels,
  panelVideoPreference,
  videoRatio,
}: CombinedPreviewPanelProps) {
  const timeline = useMemo(
    () => buildCombinedPreviewTimeline(panels, panelVideoPreference, PREVIEW_FPS),
    [panelVideoPreference, panels],
  )
  const inputProps = useMemo(() => ({ timeline }), [timeline])
  const compositionSize = useMemo(() => resolveCompositionSize(videoRatio), [videoRatio])
  const [activeIndex, setActiveIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [playerInstance, setPlayerInstance] = useState<PlayerRef | null>(null)
  const playerRef = useRef<PlayerRef | null>(null)
  const activeIndexRef = useRef(0)
  const isPlayingRef = useRef(false)
  const itemsRef = useRef(timeline.items)
  const nodeRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  itemsRef.current = timeline.items

  const updateActiveIndex = useCallback((nextIndex: number) => {
    if (nextIndex < 0 || nextIndex === activeIndexRef.current) return
    activeIndexRef.current = nextIndex
    setActiveIndex(nextIndex)
  }, [])

  const updatePlaying = useCallback((playing: boolean) => {
    if (playing === isPlayingRef.current) return
    isPlayingRef.current = playing
    setIsPlaying(playing)
  }, [])

  const attachPlayer = useCallback((instance: PlayerRef | null) => {
    playerRef.current = instance
    setPlayerInstance((current) => current === instance ? current : instance)
  }, [])

  useEffect(() => {
    if (!playerInstance) return

    const handleFrameUpdate = () => {
      const nextIndex = findCombinedPreviewItemIndexAtFrame(
        itemsRef.current,
        playerInstance.getCurrentFrame(),
      )
      updateActiveIndex(nextIndex)
    }
    const handlePlay = () => updatePlaying(true)
    const handlePause = () => updatePlaying(false)
    const handleEnded = () => updatePlaying(false)

    playerInstance.addEventListener('frameupdate', handleFrameUpdate)
    playerInstance.addEventListener('play', handlePlay)
    playerInstance.addEventListener('pause', handlePause)
    playerInstance.addEventListener('ended', handleEnded)

    return () => {
      playerInstance.removeEventListener('frameupdate', handleFrameUpdate)
      playerInstance.removeEventListener('play', handlePlay)
      playerInstance.removeEventListener('pause', handlePause)
      playerInstance.removeEventListener('ended', handleEnded)
    }
  }, [playerInstance, updateActiveIndex, updatePlaying])

  useEffect(() => {
    if (timeline.items.length === 0) {
      updateActiveIndex(0)
      return
    }

    if (activeIndexRef.current >= timeline.items.length) {
      updateActiveIndex(timeline.items.length - 1)
    }
  }, [timeline.items, updateActiveIndex])

  const activeKey = timeline.items[activeIndex]?.panelKey
  useEffect(() => {
    if (!activeKey) return
    nodeRefs.current.get(activeKey)?.scrollIntoView?.({ block: 'nearest', inline: 'center' })
  }, [activeKey])

  useCombinedPreviewPreload(timeline.items, timeline.items.length === 0 ? -1 : activeIndex)

  const seekToIndex = useCallback((nextIndex: number) => {
    const item = itemsRef.current[nextIndex]
    const player = playerRef.current
    if (!item || !player) return

    const shouldContinuePlaying = isPlayingRef.current
    player.seekTo(item.startFrame)
    updateActiveIndex(nextIndex)
    if (shouldContinuePlaying) player.play()
    else player.pause()
  }, [updateActiveIndex])

  const togglePlayback = useCallback(() => {
    const player = playerRef.current
    if (!player) return

    if (isPlayingRef.current) {
      player.pause()
      updatePlaying(false)
    } else {
      player.play()
      updatePlaying(true)
    }
  }, [updatePlaying])

  if (timeline.items.length === 0) {
    return (
      <section className="rounded-xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] p-6 text-center text-sm text-[var(--glass-text-tertiary)]">
        暂无可预览分镜
      </section>
    )
  }

  return (
    <section className="space-y-3 rounded-xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] p-3">
      <div
        className="mx-auto w-full max-w-5xl overflow-hidden rounded-lg bg-slate-800"
        style={{ aspectRatio: compositionSize.aspectRatio }}
      >
        <Player
          ref={attachPlayer}
          component={CombinedPreviewComposition}
          inputProps={inputProps}
          durationInFrames={Math.max(1, timeline.totalDurationInFrames)}
          fps={PREVIEW_FPS}
          compositionWidth={compositionSize.width}
          compositionHeight={compositionSize.height}
          controls={false}
          loop={false}
          clickToPlay={false}
          style={{ width: '100%', height: '100%' }}
        />
      </div>

      <div className="flex items-center justify-center gap-2">
        <button
          type="button"
          aria-label="上一个镜头"
          disabled={activeIndex === 0}
          onClick={() => seekToIndex(Math.max(0, activeIndexRef.current - 1))}
          className="rounded-md border border-[var(--glass-stroke-base)] px-3 py-1.5 text-sm disabled:opacity-40"
        >
          上一个
        </button>
        <button
          type="button"
          aria-label={isPlaying ? '暂停' : '播放'}
          onClick={togglePlayback}
          className="rounded-md bg-[var(--glass-bg-emphasis)] px-4 py-1.5 text-sm"
        >
          {isPlaying ? '暂停' : '播放'}
        </button>
        <button
          type="button"
          aria-label="下一个镜头"
          disabled={activeIndex === timeline.items.length - 1}
          onClick={() => seekToIndex(Math.min(timeline.items.length - 1, activeIndexRef.current + 1))}
          className="rounded-md border border-[var(--glass-stroke-base)] px-3 py-1.5 text-sm disabled:opacity-40"
        >
          下一个
        </button>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1" aria-label="分镜导航">
        {timeline.items.map((item, index) => {
          const isActive = index === activeIndex
          const previousGroupSequence = timeline.items[index - 1]?.groupSequence
          const isGroupStart = index === 0 || item.groupSequence !== previousGroupSequence

          return (
            <button
              key={item.panelKey}
              ref={(element) => {
                if (element) nodeRefs.current.set(item.panelKey, element)
                else nodeRefs.current.delete(item.panelKey)
              }}
              type="button"
              aria-label={`镜头 ${index + 1}`}
              aria-current={isActive ? 'true' : undefined}
              data-group-start={isGroupStart ? 'true' : undefined}
              onClick={() => seekToIndex(index)}
              className={`w-32 shrink-0 rounded-lg border p-2 text-left transition-colors ${isActive
                ? 'border-[var(--glass-stroke-focus)] bg-[var(--glass-bg-emphasis)]'
                : 'border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)]'
              }`}
            >
              <span className="mb-1 block aspect-video overflow-hidden rounded bg-slate-700">
                {item.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- remote media thumbnails are runtime URLs.
                  <img
                    src={item.imageUrl}
                    alt={`镜头 ${index + 1} 缩略图`}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span
                    data-testid={`combined-preview-thumbnail-placeholder-${item.panelKey}`}
                    className="block h-full w-full"
                    style={{
                      backgroundColor: '#1f2937',
                      backgroundImage: 'linear-gradient(135deg, #475569 0%, #1f2937 100%)',
                    }}
                  />
                )}
              </span>
              <span className="flex items-center justify-between gap-1 text-xs">
                <span>镜头 {index + 1}</span>
                <span>{formatDuration(item.durationInFrames)}</span>
              </span>
              <span className="mt-1 inline-flex rounded-full bg-slate-700 px-2 py-0.5 text-[11px] text-slate-100">
                {STATUS_LABELS[item.status]}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
