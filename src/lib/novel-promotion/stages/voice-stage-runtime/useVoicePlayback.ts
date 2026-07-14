'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useWorkspaceStageActivity } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/WorkspaceStageActivityContext'

export function useVoicePlayback() {
  const isStageActive = useWorkspaceStageActivity()
  const [playingLineId, setPlayingLineId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const handleTogglePlayAudio = useCallback((lineId: string, audioUrl: string) => {
    if (!isStageActive) return
    const currentAudio = audioRef.current

    if (currentAudio && playingLineId === lineId) {
      if (currentAudio.paused) {
        currentAudio.play().then(() => setPlayingLineId(lineId)).catch(() => setPlayingLineId(null))
      } else {
        currentAudio.pause()
        setPlayingLineId(null)
      }
      return
    }

    if (currentAudio) {
      currentAudio.pause()
      currentAudio.currentTime = 0
    }

    const audio = new Audio(audioUrl)
    audioRef.current = audio
    setPlayingLineId(lineId)

    audio.onended = () => {
      setPlayingLineId(null)
      if (audioRef.current === audio) audioRef.current = null
    }
    audio.onpause = () => {
      if (!audio.ended) setPlayingLineId(null)
    }

    audio.play().catch(() => setPlayingLineId(null))
  }, [isStageActive, playingLineId])

  const clearAudio = useCallback(() => {
    const audio = audioRef.current
    if (audio) {
      audio.onended = null
      audio.onpause = null
      audio.pause()
      audio.currentTime = 0
      audioRef.current = null
    }
  }, [])

  const stopPlayback = useCallback(() => {
    clearAudio()
    setPlayingLineId(null)
  }, [clearAudio])

  useEffect(() => {
    if (!isStageActive) stopPlayback()
  }, [isStageActive, stopPlayback])

  useEffect(() => {
    return clearAudio
  }, [clearAudio])

  return {
    playingLineId,
    handleTogglePlayAudio,
  }
}
