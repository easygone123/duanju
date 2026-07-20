import type { Prisma } from '@prisma/client'
import { narrationSourceKey } from './sync'

export interface NarrationOrphaningTransactionClient {
  novelPromotionPanel: Pick<Prisma.TransactionClient['novelPromotionPanel'], 'findMany'>
  novelPromotionVoiceLine: Pick<Prisma.TransactionClient['novelPromotionVoiceLine'], 'updateMany'>
}

export async function detachVoiceLinesBeforePanelRemoval(input: {
  tx: NarrationOrphaningTransactionClient
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

  const relationMatch = {
    OR: [
      ...(panelIds.length > 0 ? [{ matchedPanelId: { in: panelIds } }] : []),
      ...(storyboardIds.length > 0 ? [{ matchedStoryboardId: { in: storyboardIds } }] : []),
    ],
  }
  const episodeScope = input.episodeId ? { episodeId: input.episodeId } : {}

  // Keep narration media and voice settings available for a deterministic
  // panel/sourceKey rebuild, but make the orphan impossible to consume.
  await input.tx.novelPromotionVoiceLine.updateMany({
    where: {
      ...episodeScope,
      lineType: 'narration',
      OR: [
        ...relationMatch.OR,
        ...(panelIds.length > 0
          ? [{ sourceKey: { in: panelIds.map(narrationSourceKey) } }]
          : []),
      ],
    },
    data: {
      enabled: false,
      matchedPanelId: null,
      matchedStoryboardId: null,
      matchedPanelIndex: null,
    },
  })

  // Dialogue keeps its existing enabled state. Only remove stale panel links.
  await input.tx.novelPromotionVoiceLine.updateMany({
    where: {
      ...episodeScope,
      lineType: { not: 'narration' },
      ...relationMatch,
    },
    data: {
      matchedPanelId: null,
      matchedStoryboardId: null,
      matchedPanelIndex: null,
    },
  })
}
