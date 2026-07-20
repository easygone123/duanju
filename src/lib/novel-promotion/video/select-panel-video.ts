export interface PanelVideoSelectionInput {
  videoUrl?: string | null
  lipSyncVideoUrl?: string | null
  preferLipSync: boolean
  hasDialogue?: boolean | null
  narrationVoiceEnabled?: boolean
}

export interface PanelVideoSelection {
  videoUrl: string | null
  isLipSync: boolean
}

export interface NarrationVoiceLineState {
  lineType?: string | null
  enabled?: boolean | null
}

export function resolveNarrationVoiceEnabled(
  voiceLines: readonly NarrationVoiceLineState[] | null | undefined,
): boolean | undefined {
  const narrationLines = (voiceLines || []).filter((line) => line.lineType === 'narration')
  if (narrationLines.length === 0) return undefined
  return narrationLines.some((line) => line.enabled !== false)
}

export function shouldIgnoreDisabledNarrationLipSync(input: Pick<
  PanelVideoSelectionInput,
  'hasDialogue' | 'narrationVoiceEnabled'
>): boolean {
  return input.hasDialogue !== true && input.narrationVoiceEnabled === false
}

export function selectPanelVideo(input: PanelVideoSelectionInput): PanelVideoSelection {
  const baseVideoUrl = input.videoUrl || null
  const lipSyncVideoUrl = input.lipSyncVideoUrl || null

  if (shouldIgnoreDisabledNarrationLipSync(input)) {
    return { videoUrl: baseVideoUrl, isLipSync: false }
  }

  if (input.preferLipSync) {
    return lipSyncVideoUrl
      ? { videoUrl: lipSyncVideoUrl, isLipSync: true }
      : { videoUrl: baseVideoUrl, isLipSync: false }
  }

  if (baseVideoUrl) return { videoUrl: baseVideoUrl, isLipSync: false }
  if (lipSyncVideoUrl) {
    return { videoUrl: lipSyncVideoUrl, isLipSync: true }
  }
  return { videoUrl: null, isLipSync: false }
}
