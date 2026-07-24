import { ApiError } from '@/lib/api-errors'
import { prisma } from '@/lib/prisma'

export const viralReplicationDetailSelect = {
  id: true,
  brief: true,
  videoRatio: true,
  artStyle: true,
  storyboardGenerationMode: true,
  transcriptionMode: true,
  status: true,
  reportJson: true,
  reportVersion: true,
  transcriptText: true,
  errorMessage: true,
  durationMs: true,
  confirmedAt: true,
  createdAt: true,
  updatedAt: true,
  project: { select: { id: true, name: true } },
  episode: { select: { id: true, episodeNumber: true, name: true } },
  sourceVideoMedia: {
    select: {
      id: true,
      publicId: true,
      mimeType: true,
      sizeBytes: true,
      width: true,
      height: true,
      durationMs: true,
    },
  },
} as const

export async function readOwnedViralReplication(id: string, userId: string) {
  const replication = await prisma.viralReplication.findFirst({
    where: { id, userId },
    select: viralReplicationDetailSelect,
  })
  if (!replication) throw new ApiError('NOT_FOUND')
  return replication
}
