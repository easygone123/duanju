import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import {
  resolveFrameLinkChoices,
  serializeFrameSourceMeta,
  type FrameLinkChoices,
  type FrameLinkStoryboard,
  type FrameSourceMeta,
} from '@/lib/novel-promotion/video/frame-link-resolver'

type FrameName = 'first' | 'last'
type LinkAction = 'replace' | 'clear' | 'unlink' | 'restore-auto'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function resolveAction(body: Record<string, unknown>): LinkAction | null {
  if (body.action === 'replace' || body.action === 'clear'
    || body.action === 'unlink' || body.action === 'restore-auto') {
    return body.action
  }
  if (body.linked === true) return 'restore-auto'
  if (body.linked === false) return 'unlink'
  return null
}

function ownedPanelWhere(projectId: string, userId: string) {
  return {
    storyboard: {
      episode: {
        novelPromotionProject: {
          projectId,
          project: { userId },
        },
      },
    },
  }
}

function replaceChoice(
  choices: FrameLinkChoices,
  frame: FrameName,
  source: FrameSourceMeta | null,
): FrameLinkChoices {
  return frame === 'first'
    ? { ...choices, firstFrame: source }
    : { ...choices, lastFrame: source }
}

// POST - 更新 panel 的首尾帧链接状态
export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> }
) => {
  const { projectId } = await context.params

  // 🔐 统一权限验证
  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult

  const body: unknown = await request.json()
  if (!isRecord(body)) throw new ApiError('INVALID_PARAMS')
  const storyboardId = typeof body.storyboardId === 'string' ? body.storyboardId.trim() : ''
  const panelIndex = body.panelIndex
  const action = resolveAction(body)

  if (!storyboardId || typeof panelIndex !== 'number' || !Number.isInteger(panelIndex) || panelIndex < 0 || !action) {
    throw new ApiError('INVALID_PARAMS')
  }

  const userId = authResult.session.user.id
  const ownership = ownedPanelWhere(projectId, userId)
  const target = await prisma.novelPromotionPanel.findFirst({
    where: {
      storyboardId,
      panelIndex,
      ...ownership,
    },
    select: {
      id: true,
      storyboard: { select: { episodeId: true } },
    },
  })
  if (!target) throw new ApiError('NOT_FOUND')

  const storyboards = await prisma.novelPromotionStoryboard.findMany({
    where: {
      episodeId: target.storyboard.episodeId,
      episode: {
        novelPromotionProject: {
          projectId,
          project: { userId },
        },
      },
    },
    select: {
      id: true,
      layoutMode: true,
      groupSequence: true,
      continuityAnchor: true,
      panels: {
        select: {
          id: true,
          storyboardId: true,
          panelIndex: true,
          gridCellIndex: true,
          firstFrameSourceMeta: true,
          lastFrameSourceMeta: true,
          linkedToNextPanel: true,
        },
      },
    },
  }) as FrameLinkStoryboard[]

  let choices = resolveFrameLinkChoices({ panelId: target.id, storyboards })
  if (action === 'restore-auto') {
    const withoutOverrides = storyboards.map((storyboard) => ({
      ...storyboard,
      panels: storyboard.panels.map((panel) => panel.id === target.id
        ? { ...panel, firstFrameSourceMeta: null, lastFrameSourceMeta: null }
        : panel),
    }))
    choices = resolveFrameLinkChoices({
      panelId: target.id,
      storyboards: withoutOverrides,
      restoreLegacyAuto: true,
    })
  } else if (action === 'unlink') {
    choices = { firstFrame: null, lastFrame: null }
  } else {
    const frame: FrameName | null = body.frame === 'first' || body.frame === 'last' ? body.frame : null
    if (!frame) throw new ApiError('INVALID_PARAMS')
    if (action === 'clear') {
      choices = replaceChoice(choices, frame, null)
    } else {
      const sourcePanelId = typeof body.sourcePanelId === 'string' ? body.sourcePanelId.trim() : ''
      if (!sourcePanelId) throw new ApiError('INVALID_PARAMS')
      const source = await prisma.novelPromotionPanel.findFirst({
        where: { id: sourcePanelId, ...ownership },
        select: { id: true },
      })
      if (!source) throw new ApiError('NOT_FOUND')
      choices = replaceChoice(choices, frame, { mode: 'manual', sourcePanelId: source.id })
    }
  }

  const updateResult = await prisma.novelPromotionPanel.updateMany({
    where: { id: target.id, ...ownership },
    data: {
      firstFrameSourceMeta: serializeFrameSourceMeta(choices.firstFrame),
      lastFrameSourceMeta: serializeFrameSourceMeta(choices.lastFrame),
      linkedToNextPanel: !!choices.firstFrame && !!choices.lastFrame,
    },
  })
  if (updateResult.count !== 1) throw new ApiError('NOT_FOUND')

  return NextResponse.json({ success: true, ...choices })
})
