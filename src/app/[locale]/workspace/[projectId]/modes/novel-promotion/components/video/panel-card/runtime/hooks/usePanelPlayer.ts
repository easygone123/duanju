import { logError as _ulogError } from '@/lib/logging/core'
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import { useWorkspaceStageActivity } from '../../../../WorkspaceStageActivityContext'
import { selectPanelVideo } from '@/lib/novel-promotion/video/select-panel-video'

interface UsePanelPlayerParams {
  videoRatio: string
  imageUrl?: string
  videoUrl?: string
  lipSyncVideoUrl?: string
  showLipSyncVideo: boolean
  onPreviewImage?: (imageUrl: string) => void
}

export function usePanelPlayer({
  videoRatio,
  imageUrl,
  videoUrl,
  lipSyncVideoUrl,
  showLipSyncVideo,
  onPreviewImage,
}: UsePanelPlayerParams) {
  const isStageActive = useWorkspaceStageActivity()
  const [isPlaying, setIsPlaying] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const playTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isStageActiveRef = useRef(isStageActive)
  isStageActiveRef.current = isStageActive
  const cssAspectRatio = videoRatio.replace(':', '/')
  const currentVideoUrl = selectPanelVideo({
    videoUrl,
    lipSyncVideoUrl,
    preferLipSync: showLipSyncVideo,
  }).videoUrl || undefined

  const handlePreviewImage = useCallback((event?: MouseEvent) => {
    if (event) event.stopPropagation()
    if (!imageUrl || !onPreviewImage) return
    onPreviewImage(imageUrl)
  }, [imageUrl, onPreviewImage])

  const handlePlayClick = useCallback(async () => {
    if (!isStageActive) return
    setIsPlaying(true)
    if (playTimeoutRef.current) clearTimeout(playTimeoutRef.current)
    playTimeoutRef.current = setTimeout(async () => {
      playTimeoutRef.current = null
      if (!isStageActiveRef.current || !videoRef.current) return
      try {
        await videoRef.current.play()
      } catch (error: unknown) {
        if ((error as { name?: string }).name !== 'AbortError') {
          _ulogError('Video play error:', error)
        }
      }
    }, 100)
  }, [isStageActive])

  useEffect(() => {
    if (isStageActive) return
    if (playTimeoutRef.current) {
      clearTimeout(playTimeoutRef.current)
      playTimeoutRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.pause()
      videoRef.current.currentTime = 0
    }
    setIsPlaying(false)
  }, [isStageActive])

  useEffect(() => () => {
    if (playTimeoutRef.current) clearTimeout(playTimeoutRef.current)
    if (videoRef.current) {
      videoRef.current.pause()
      videoRef.current.currentTime = 0
    }
  }, [])

  return {
    cssAspectRatio,
    currentVideoUrl,
    isPlaying,
    setIsPlaying,
    videoRef,
    handlePreviewImage,
    handlePlayClick,
  }
}
