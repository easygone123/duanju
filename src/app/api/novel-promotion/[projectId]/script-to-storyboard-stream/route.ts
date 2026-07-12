import { NextRequest } from 'next/server'
import { requireProjectAuth, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { TASK_TYPE } from '@/lib/task/types'
import { maybeSubmitLLMTask } from '@/lib/llm-observe/route-task'
import { getProjectModelConfig } from '@/lib/config-service'
import {
  SIX_GRID_ASPECT_RATIO_UNSUPPORTED,
  STORYBOARD_RUN_SETTINGS_INVALID,
  parseStoryboardRunSettingsTask,
  resolveStoryboardRunSettings,
} from '@/lib/novel-promotion/six-grid/run-settings'

export const runtime = 'nodejs'

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const body = await request.json().catch(() => ({}))
  const episodeId = typeof body?.episodeId === 'string' ? body.episodeId.trim() : ''

  if (!episodeId) {
    throw new ApiError('INVALID_PARAMS')
  }

  const authResult = await requireProjectAuth(projectId, {
    include: { characters: true, locations: true },
  })
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult
  const projectConfig = await getProjectModelConfig(projectId, session.user.id)
  let runSettings
  try {
    const taskSettings = parseStoryboardRunSettingsTask(body)
    runSettings = resolveStoryboardRunSettings({
      task: taskSettings,
      project: projectConfig,
    })
  } catch (error) {
    if (error instanceof Error && error.message === STORYBOARD_RUN_SETTINGS_INVALID) {
      throw new ApiError('INVALID_PARAMS', {
        code: STORYBOARD_RUN_SETTINGS_INVALID,
      })
    }
    if (error instanceof Error && error.message === SIX_GRID_ASPECT_RATIO_UNSUPPORTED) {
      throw new ApiError('INVALID_PARAMS', {
        code: SIX_GRID_ASPECT_RATIO_UNSUPPORTED,
        field: 'sixGridCellAspectRatio',
      })
    }
    throw error
  }

  const asyncTaskResponse = await maybeSubmitLLMTask({
    request,
    userId: session.user.id,
    projectId,
    episodeId,
    type: TASK_TYPE.SCRIPT_TO_STORYBOARD_RUN,
    targetType: 'NovelPromotionEpisode',
    targetId: episodeId,
    routePath: `/api/novel-promotion/${projectId}/script-to-storyboard-stream`,
    body: {
      ...body,
      ...runSettings,
      displayMode: 'detail',
    },
    dedupeKey: `script_to_storyboard_run:${episodeId}`,
    priority: 2,
  })
  if (asyncTaskResponse) return asyncTaskResponse

  throw new ApiError('INVALID_PARAMS')
})
