export type LipSyncPanelIdentity = {
  id: string
  storyboardId: string
  panelIndex: number
}

export function buildLipSyncVoiceLinePanelMatch(panel: LipSyncPanelIdentity) {
  return {
    OR: [
      { matchedPanelId: panel.id },
      {
        lineType: 'dialogue',
        matchedPanelId: null,
        matchedStoryboardId: panel.storyboardId,
        matchedPanelIndex: panel.panelIndex,
      },
    ],
  }
}

export function buildOwnedLipSyncVoiceLineWhere(input: {
  voiceLineId: string
  panel: LipSyncPanelIdentity
  projectId: string
  userId?: string
  episodeId?: string
}) {
  return {
    id: input.voiceLineId,
    enabled: true,
    ...(input.episodeId ? { episodeId: input.episodeId } : {}),
    ...buildLipSyncVoiceLinePanelMatch(input.panel),
    episode: {
      storyboards: { some: { id: input.panel.storyboardId } },
      novelPromotionProject: {
        projectId: input.projectId,
        ...(input.userId ? { project: { userId: input.userId } } : {}),
      },
    },
  }
}
