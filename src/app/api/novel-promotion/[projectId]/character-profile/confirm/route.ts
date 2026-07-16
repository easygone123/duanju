import { NextRequest, NextResponse } from 'next/server'
import { requireProjectAuth, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { TASK_TYPE } from '@/lib/task/types'
import { maybeSubmitLLMTask } from '@/lib/llm-observe/route-task'
import { prisma } from '@/lib/prisma'
import { z } from 'zod'

const boundedText = z.string().trim().min(1).max(200)
const boundedList = z.array(z.string().trim().min(1).max(100)).max(50)
const profileUpdateSchema = z.object({
  role_level: z.enum(['S', 'A', 'B', 'C', 'D']),
  archetype: boundedText,
  personality_tags: boundedList,
  era_period: boundedText,
  social_class: boundedText,
  occupation: z.string().trim().max(200).optional(),
  costume_tier: z.number().int().min(1).max(5),
  suggested_colors: boundedList,
  primary_identifier: z.string().trim().max(500).optional(),
  visual_keywords: boundedList,
  gender: boundedText,
  age_range: boundedText,
}).strict()

/**
 * 确认角色档案并生成视觉描述
 * POST /api/novel-promotion/[projectId]/character-profile/confirm
 */
export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const body = await request.json().catch(() => ({}))
  const characterId = typeof body?.characterId === 'string' ? body.characterId.trim() : ''

  if (!characterId) {
    throw new ApiError('INVALID_PARAMS')
  }

  const authResult = await requireProjectAuth(projectId)
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult

  const asyncTaskResponse = await maybeSubmitLLMTask({
    request,
    userId: session.user.id,
    projectId,
    type: TASK_TYPE.CHARACTER_PROFILE_CONFIRM,
    targetType: 'NovelPromotionCharacter',
    targetId: characterId,
    routePath: `/api/novel-promotion/${projectId}/character-profile/confirm`,
    body,
    dedupeKey: `character_profile_confirm:${characterId}`})
  if (asyncTaskResponse) return asyncTaskResponse

  throw new ApiError('INVALID_PARAMS')
})

/** 修改已确认角色的档案，不重新生成或删除现有形象。 */
export const PATCH = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const body = await request.json().catch(() => ({}))
  const characterId = typeof body?.characterId === 'string' ? body.characterId.trim() : ''
  const parsedProfile = profileUpdateSchema.safeParse(body?.profileData)
  if (!characterId || !parsedProfile.success) {
    throw new ApiError('INVALID_PARAMS')
  }

  const authResult = await requireProjectAuth(projectId)
  if (isErrorResponse(authResult)) return authResult

  const result = await prisma.novelPromotionCharacter.updateMany({
    where: {
      id: characterId,
      novelPromotionProjectId: authResult.novelData.id,
      profileConfirmed: true,
    },
    data: { profileData: JSON.stringify(parsedProfile.data) },
  })
  if (result.count !== 1) throw new ApiError('NOT_FOUND')

  return NextResponse.json({ success: true })
})
