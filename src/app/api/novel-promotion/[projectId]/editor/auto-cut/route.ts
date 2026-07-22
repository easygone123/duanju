import { NextRequest } from 'next/server'
import { requireProjectAuth, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { maybeSubmitLLMTask } from '@/lib/llm-observe/route-task'
import { TASK_TYPE } from '@/lib/task/types'
import { normalizeEditorAutoCutSourceClips } from '@/lib/novel-promotion/editor-auto-cut'

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const authResult = await requireProjectAuth(projectId)
  if (isErrorResponse(authResult)) return authResult

  const body = await request.json().catch(() => ({}))
  const episodeId = typeof body?.episodeId === 'string' ? body.episodeId.trim() : ''
  const clips = normalizeEditorAutoCutSourceClips(body?.clips)
  if (!episodeId || clips.length === 0) throw new ApiError('INVALID_PARAMS')

  const asyncTaskResponse = await maybeSubmitLLMTask({
    request,
    userId: authResult.session.user.id,
    projectId,
    episodeId,
    type: TASK_TYPE.EDITOR_AUTO_CUT,
    targetType: 'NovelPromotionEpisode',
    targetId: episodeId,
    routePath: `/api/novel-promotion/${projectId}/editor/auto-cut`,
    body: {
      ...body,
      episodeId,
      clips,
      displayMode: 'loading',
      maxInputTokens: Math.min(32_000, 4_000 + clips.length * 450),
      maxOutputTokens: Math.min(16_000, 1_000 + clips.length * 220),
    },
    dedupeKey: `editor_auto_cut:${episodeId}`,
  })
  if (asyncTaskResponse) return asyncTaskResponse

  throw new ApiError('INVALID_PARAMS')
})
