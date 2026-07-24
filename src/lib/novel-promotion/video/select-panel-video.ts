export interface PanelVideoSelectionInput {
  videoUrl?: string | null
  lipSyncVideoUrl?: string | null
  preferLipSync: boolean
}

export interface PanelVideoSelection {
  videoUrl: string | null
  isLipSync: boolean
}

export function selectPanelVideo(input: PanelVideoSelectionInput): PanelVideoSelection {
  const baseVideoUrl = input.videoUrl || null
  const lipSyncVideoUrl = input.lipSyncVideoUrl || null

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
