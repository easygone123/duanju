import type { Prisma } from '@prisma/client'

export interface VoiceLineOrphaningTransactionClient {
  novelPromotionPanel: Pick<Prisma.TransactionClient['novelPromotionPanel'], 'findMany'>
  novelPromotionVoiceLine: Pick<Prisma.TransactionClient['novelPromotionVoiceLine'], 'updateMany'>
}

export async function detachVoiceLinesBeforePanelRemoval(input: {
  tx: VoiceLineOrphaningTransactionClient
  episodeId?: string
  panelIds?: string[]
  storyboardIds?: string[]
}) {
  const storyboardIds = [...new Set((input.storyboardIds || []).filter(Boolean))]
  const explicitPanelIds = [...new Set((input.panelIds || []).filter(Boolean))]
  const storyboardPanels = storyboardIds.length > 0
    ? await input.tx.novelPromotionPanel.findMany({
        where: { storyboardId: { in: storyboardIds } },
        select: { id: true },
      })
    : []
  const panelIds = [...new Set([
    ...explicitPanelIds,
    ...storyboardPanels.map((panel) => panel.id),
  ])]
  if (panelIds.length === 0 && storyboardIds.length === 0) return

  await input.tx.novelPromotionVoiceLine.updateMany({
    where: {
      ...(input.episodeId ? { episodeId: input.episodeId } : {}),
      OR: [
        ...(panelIds.length > 0 ? [{ matchedPanelId: { in: panelIds } }] : []),
        ...(storyboardIds.length > 0 ? [{ matchedStoryboardId: { in: storyboardIds } }] : []),
      ],
    },
    data: {
      matchedPanelId: null,
      matchedStoryboardId: null,
      matchedPanelIndex: null,
    },
  })
}
