import type { Job } from 'bullmq'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TASK_TYPE, type TaskJobData } from '@/lib/task/types'

const prismaMock = vi.hoisted(() => ({
  videoEditorProject: {
    updateMany: vi.fn(),
  },
}))
const renderMock = vi.hoisted(() => vi.fn())
const progressMock = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/novel-promotion/editor-render', () => ({
  renderVideoEditorProject: renderMock,
}))
vi.mock('@/lib/workers/shared', () => ({
  reportTaskProgress: progressMock,
}))

import { handleEditorRenderTask } from '@/lib/workers/handlers/editor-render'

function createJob(): Job<TaskJobData> {
  return {
    data: {
      taskId: 'task-render-1',
      type: TASK_TYPE.EDITOR_RENDER,
      locale: 'zh',
      projectId: 'project-1',
      episodeId: 'episode-1',
      targetType: 'VideoEditorProject',
      targetId: 'editor-1',
      userId: 'user-1',
    },
  } as Job<TaskJobData>
}

describe('editor render worker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.videoEditorProject.updateMany.mockResolvedValue({ count: 1 })
    renderMock.mockResolvedValue({
      storageKey: 'images/editor-exports/project-1/episode-1-output.mp4',
      fileName: 'waoowaoo-episode-1.mp4',
    })
  })

  it('TASKTYPE:editor_render publishes the rendered output only for the active task', async () => {
    const result = await handleEditorRenderTask(createJob())

    expect(renderMock).toHaveBeenCalledWith(expect.objectContaining({
      editorProjectId: 'editor-1',
      projectId: 'project-1',
      userId: 'user-1',
    }))
    expect(prismaMock.videoEditorProject.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'editor-1',
        renderTaskId: 'task-render-1',
      },
      data: {
        renderStatus: 'completed',
        outputUrl: 'images/editor-exports/project-1/episode-1-output.mp4',
      },
    })
    expect(result).toMatchObject({
      editorProjectId: 'editor-1',
      outputUrl: 'images/editor-exports/project-1/episode-1-output.mp4',
    })
  })

  it('marks the active render as failed when FFmpeg rendering fails', async () => {
    renderMock.mockRejectedValueOnce(new Error('ffmpeg failed'))

    await expect(handleEditorRenderTask(createJob())).rejects.toThrow('ffmpeg failed')
    expect(prismaMock.videoEditorProject.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'editor-1',
        renderTaskId: 'task-render-1',
      },
      data: {
        renderStatus: 'failed',
        outputUrl: null,
      },
    })
  })
})
