import { Readable } from 'node:stream'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError, getRequestId } from '@/lib/api-errors'
import { submitTask } from '@/lib/task/submitter'
import { resolveRequiredTaskLocale } from '@/lib/task/resolve-locale'
import { TASK_TYPE } from '@/lib/task/types'
import { getObjectStream } from '@/lib/storage'
import { resolveStorageKeyFromMediaValue } from '@/lib/media/service'

function renderFileName(episodeId: string) {
  return `waoowaoo-${episodeId}.mp4`
}

async function findOwnedEditorProject(input: {
  projectId: string
  userId: string
  episodeId: string
}) {
  return await prisma.videoEditorProject.findFirst({
    where: {
      episodeId: input.episodeId,
      episode: {
        novelPromotionProject: {
          projectId: input.projectId,
          project: { userId: input.userId },
        },
      },
    },
  })
}

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult
  const body = await request.json().catch(() => ({}))
  const episodeId = typeof body?.episodeId === 'string' ? body.episodeId.trim() : ''
  if (!episodeId) throw new ApiError('INVALID_PARAMS')

  const editorProject = await findOwnedEditorProject({
    projectId,
    userId: authResult.session.user.id,
    episodeId,
  })
  if (!editorProject) throw new ApiError('NOT_FOUND')

  await prisma.videoEditorProject.update({
    where: { id: editorProject.id },
    data: {
      renderStatus: 'pending',
      outputUrl: null,
    },
  })

  let task: Awaited<ReturnType<typeof submitTask>>
  try {
    task = await submitTask({
      userId: authResult.session.user.id,
      locale: resolveRequiredTaskLocale(request),
      projectId,
      episodeId,
      type: TASK_TYPE.EDITOR_RENDER,
      targetType: 'VideoEditorProject',
      targetId: editorProject.id,
      payload: {
        episodeId,
        displayMode: 'loading',
      },
      dedupeKey: `editor_render:${editorProject.id}`,
      maxAttempts: 1,
      requestId: getRequestId(request),
    })
  } catch (error) {
    await prisma.videoEditorProject.update({
      where: { id: editorProject.id },
      data: { renderStatus: 'failed' },
    })
    throw error
  }

  await prisma.videoEditorProject.update({
    where: { id: editorProject.id },
    data: {
      renderTaskId: task.taskId,
    },
  })

  return NextResponse.json({
    success: true,
    async: true,
    taskId: task.taskId,
    status: task.status,
  })
})

export const GET = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult
  const episodeId = request.nextUrl.searchParams.get('episodeId')?.trim() || ''
  if (!episodeId) throw new ApiError('INVALID_PARAMS')

  const editorProject = await findOwnedEditorProject({
    projectId,
    userId: authResult.session.user.id,
    episodeId,
  })
  if (!editorProject) throw new ApiError('NOT_FOUND')

  if (request.nextUrl.searchParams.get('download') === '1') {
    if (editorProject.renderStatus !== 'completed' || !editorProject.outputUrl) {
      throw new ApiError('INVALID_PARAMS')
    }
    const storageKey = await resolveStorageKeyFromMediaValue(editorProject.outputUrl)
    if (!storageKey) throw new ApiError('NOT_FOUND')
    const objectStream = await getObjectStream(storageKey)
    const body = Readable.toWeb(objectStream as Readable)
    return new Response(body as ReadableStream, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="${renderFileName(episodeId)}"`,
        'Cache-Control': 'private, no-store',
      },
    })
  }

  return NextResponse.json({
    status: editorProject.renderStatus || 'idle',
    taskId: editorProject.renderTaskId,
    downloadUrl: editorProject.renderStatus === 'completed' && editorProject.outputUrl
      ? `/api/novel-promotion/${projectId}/editor/render?episodeId=${encodeURIComponent(episodeId)}&download=1`
      : null,
  })
})
