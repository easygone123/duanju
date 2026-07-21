import { NextRequest, NextResponse } from 'next/server'

import { isErrorResponse, requireProjectAuthLight } from '@/lib/api-auth'
import { ApiError, apiHandler } from '@/lib/api-errors'
import { resolveOwnedComfyMediaRefFromValue } from '@/lib/comfyui/media-ownership'
import { getMediaObjectById } from '@/lib/media/service'
import { prisma } from '@/lib/prisma'

interface PanelHistoryEntry {
  url: string
  timestamp: string
}

function parsePanelHistory(value: string | null): PanelHistoryEntry[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is PanelHistoryEntry => (
      !!entry
      && typeof entry === 'object'
      && typeof (entry as PanelHistoryEntry).url === 'string'
      && typeof (entry as PanelHistoryEntry).timestamp === 'string'
    ))
  } catch {
    return []
  }
}

/**
 * Attach an image that already belongs to the current user/project directly to
 * a storyboard panel. This is the write path used by externally generated
 * storyboards: uploading a finished grid/crop must not require an image model
 * to redraw the user's image before it can become a video first frame.
 */
export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const auth = await requireProjectAuthLight(projectId)
  if (isErrorResponse(auth)) return auth

  const body: unknown = await request.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError('INVALID_PARAMS')
  }
  const panelId = typeof (body as Record<string, unknown>).panelId === 'string'
    ? (body as Record<string, unknown>).panelId as string
    : ''
  const image = (body as Record<string, unknown>).image
  if (!panelId.trim() || typeof image !== 'string' || !image.trim()) {
    throw new ApiError('INVALID_PARAMS')
  }

  const panel = await prisma.novelPromotionPanel.findFirst({
    where: {
      id: panelId,
      storyboard: {
        episode: {
          novelPromotionProject: {
            projectId,
            project: { userId: auth.session.user.id },
          },
        },
      },
    },
    select: {
      id: true,
      imageUrl: true,
      imageMediaId: true,
      imageHistory: true,
    },
  })
  if (!panel) throw new ApiError('NOT_FOUND')

  const owned = await resolveOwnedComfyMediaRefFromValue({
    userId: auth.session.user.id,
    projectId,
    value: image,
    mediaType: 'image',
  })
  if (!owned) {
    throw new ApiError('INVALID_PARAMS', { code: 'PANEL_IMAGE_NOT_OWNED', field: 'image' })
  }

  const mediaRow = await prisma.mediaObject.findUnique({
    where: { storageKey: owned.storageKey },
    select: { id: true },
  })
  const media = mediaRow ? await getMediaObjectById(mediaRow.id) : null
  if (!media || !media.mimeType?.startsWith('image/')) {
    throw new ApiError('INVALID_PARAMS', { code: 'PANEL_IMAGE_INVALID', field: 'image' })
  }

  const history = parsePanelHistory(panel.imageHistory)
  if (panel.imageUrl) {
    history.push({ url: panel.imageUrl, timestamp: new Date().toISOString() })
  }

  await prisma.novelPromotionPanel.update({
    where: { id: panel.id },
    data: {
      previousImageUrl: panel.imageUrl,
      previousImageMediaId: panel.imageMediaId,
      imageUrl: media.url,
      imageMediaId: media.id,
      imageHistory: JSON.stringify(history),
      imageDerivation: 'manual_upload',
      imageLineage: JSON.stringify({ source: 'owned_media', mediaId: media.id }),
      candidateImages: null,
      videoUrl: null,
      videoMediaId: null,
      lipSyncTaskId: null,
      lipSyncVideoUrl: null,
      lipSyncVideoMediaId: null,
    },
  })

  return NextResponse.json({
    success: true,
    panelId: panel.id,
    imageUrl: media.url,
    imageMediaId: media.id,
  })
})
