import type { Prisma } from '@prisma/client'
import { ApiError } from '@/lib/api-errors'
import { prisma } from '@/lib/prisma'

type EpisodeOwnershipClient = {
  novelPromotionEpisode: Pick<Prisma.TransactionClient['novelPromotionEpisode'], 'findFirst'>
}

export async function requireOwnedNovelPromotionEpisode(input: {
  projectId: string
  episodeId: string
  client?: EpisodeOwnershipClient
}) {
  const client = input.client || prisma
  const episode = await client.novelPromotionEpisode.findFirst({
    where: {
      id: input.episodeId,
      novelPromotionProject: { projectId: input.projectId },
    },
    select: { id: true, novelPromotionProjectId: true },
  })
  if (!episode) throw new ApiError('NOT_FOUND')
  return episode
}
