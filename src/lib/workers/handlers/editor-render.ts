import type { Job } from 'bullmq'
import { prisma } from '@/lib/prisma'
import { renderVideoEditorProject } from '@/lib/novel-promotion/editor-render'
import type { TaskJobData } from '@/lib/task/types'
import { reportTaskProgress } from '@/lib/workers/shared'

export async function handleEditorRenderTask(job: Job<TaskJobData>) {
  const editorProjectId = job.data.targetId
  await prisma.videoEditorProject.updateMany({
    where: {
      id: editorProjectId,
      episode: {
        novelPromotionProject: {
          projectId: job.data.projectId,
          project: { userId: job.data.userId },
        },
      },
    },
    data: {
      renderStatus: 'rendering',
      renderTaskId: job.data.taskId,
      outputUrl: null,
    },
  })
  await reportTaskProgress(job, 8, {
    stage: 'editor_render_prepare',
    stageLabel: '正在准备分镜视频',
  })

  try {
    const result = await renderVideoEditorProject({
      editorProjectId,
      projectId: job.data.projectId,
      userId: job.data.userId,
      job,
    })
    const updated = await prisma.videoEditorProject.updateMany({
      where: {
        id: editorProjectId,
        renderTaskId: job.data.taskId,
      },
      data: {
        renderStatus: 'completed',
        outputUrl: result.storageKey,
      },
    })
    if (updated.count === 0) throw new Error('EDITOR_RENDER_RESULT_STALE')
    await reportTaskProgress(job, 100, {
      stage: 'editor_render_done',
      stageLabel: '合并视频已生成',
    })
    return {
      editorProjectId,
      outputUrl: result.storageKey,
      fileName: result.fileName,
    }
  } catch (error) {
    await prisma.videoEditorProject.updateMany({
      where: {
        id: editorProjectId,
        renderTaskId: job.data.taskId,
      },
      data: {
        renderStatus: 'failed',
        outputUrl: null,
      },
    })
    throw error
  }
}
