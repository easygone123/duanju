import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TASK_TYPE, type QueueType, type TaskJobData } from '@/lib/task/types'
import {
  addTaskJob,
  getQueueByType,
  getQueueTypeByTaskType,
  QUEUE_NAME,
  removeTaskJob,
} from '@/lib/task/queues'
import { buildDefaultTaskBillingInfo, isBillableTaskType } from '@/lib/billing/task-policy'
import { getTaskStageLabel, getTaskTypeLabel } from '@/lib/task/progress-message'
import enProgress from '@/../messages/en/progress.json'
import zhProgress from '@/../messages/zh/progress.json'
import { TASK_TYPE_CATALOG } from '@/../tests/contracts/task-type-catalog'
import { TASKTYPE_BEHAVIOR_MATRIX } from '@/../tests/contracts/tasktype-behavior-matrix'

const queueState = vi.hoisted(() => ({
  addCalls: [] as Array<{ queueName: string; name: string; data: TaskJobData; opts: Record<string, unknown> }>,
  removableJobQueueName: null as string | null,
  remove: vi.fn(async () => undefined),
}))

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(public readonly name: string) {}

    async add(name: string, data: TaskJobData, opts: Record<string, unknown>) {
      queueState.addCalls.push({ queueName: this.name, name, data, opts })
      return { id: data.taskId }
    }

    async getJob() {
      if (queueState.removableJobQueueName !== this.name) return null
      return { remove: queueState.remove }
    }
  },
}))

vi.mock('@/lib/redis', () => ({ queueRedis: {} }))

function buildJob(type: TaskJobData['type'], taskId = `task-${type}`): TaskJobData {
  return {
    taskId,
    type,
    locale: 'zh',
    projectId: 'project-1',
    targetType: 'ViralVideoReplication',
    targetId: 'replication-1',
    userId: 'user-1',
    payload: {},
  }
}

describe('viral replication task queue registration', () => {
  beforeEach(() => {
    queueState.addCalls.length = 0
    queueState.removableJobQueueName = null
    queueState.remove.mockClear()
  })

  it('registers the two stable task type constants and the viral queue type', () => {
    expect(TASK_TYPE.VIRAL_VIDEO_ANALYSIS).toBe('viral_video_analysis')
    expect(TASK_TYPE.VIRAL_STORYBOARD_GENERATION).toBe('viral_storyboard_generation')

    const queueType: QueueType = 'viral'
    expect(queueType).toBe('viral')
  })

  it('routes both task types to the dedicated viral replication queue', () => {
    expect(QUEUE_NAME.VIRAL_REPLICATION).toBe('waoowaoo-viral-replication')
    expect(getQueueTypeByTaskType(TASK_TYPE.VIRAL_VIDEO_ANALYSIS)).toBe('viral')
    expect(getQueueTypeByTaskType(TASK_TYPE.VIRAL_STORYBOARD_GENERATION)).toBe('viral')
    expect(getQueueByType('viral').name).toBe(QUEUE_NAME.VIRAL_REPLICATION)
  })

  it.each([
    TASK_TYPE.VIRAL_VIDEO_ANALYSIS,
    TASK_TYPE.VIRAL_STORYBOARD_GENERATION,
  ])('forces %s jobs to one attempt even when callers request retries', async (taskType) => {
    await addTaskJob(buildJob(taskType), { attempts: 9, priority: 7 })

    expect(queueState.addCalls).toHaveLength(1)
    expect(queueState.addCalls[0]).toMatchObject({
      queueName: 'waoowaoo-viral-replication',
      name: taskType,
      opts: {
        attempts: 1,
        priority: 7,
      },
    })
  })

  it('includes the viral replication queue when removing task jobs', async () => {
    queueState.removableJobQueueName = 'waoowaoo-viral-replication'

    await expect(removeTaskJob('viral-task-1')).resolves.toBe(true)
    expect(queueState.remove).toHaveBeenCalledOnce()
  })

  it.each([
    TASK_TYPE.VIRAL_VIDEO_ANALYSIS,
    TASK_TYPE.VIRAL_STORYBOARD_GENERATION,
  ])('bills %s as text and prefers the analysis model snapshot', (taskType) => {
    expect(isBillableTaskType(taskType)).toBe(true)

    const billingInfo = buildDefaultTaskBillingInfo(taskType, {
      analysisModelSnapshot: 'snapshot::analysis-model',
      analysisModel: 'configured::analysis-model',
      model: 'fallback::model',
    })

    expect(billingInfo).toMatchObject({
      billable: true,
      apiType: 'text',
      model: 'snapshot::analysis-model',
      taskType,
    })
  })

  it('registers localized task and stage progress labels', () => {
    expect(getTaskTypeLabel(TASK_TYPE.VIRAL_VIDEO_ANALYSIS)).toBe(
      'progress.taskType.viralVideoAnalysis',
    )
    expect(getTaskTypeLabel(TASK_TYPE.VIRAL_STORYBOARD_GENERATION)).toBe(
      'progress.taskType.viralStoryboardGeneration',
    )
    expect([
      'viral_preprocess',
      'viral_shot_analysis',
      'viral_report_aggregation',
      'viral_storyboard_generation',
      'viral_persistence',
    ].map(getTaskStageLabel)).toEqual([
      'progress.stage.viralPreprocess',
      'progress.stage.viralShotAnalysis',
      'progress.stage.viralReportAggregation',
      'progress.stage.viralStoryboardGeneration',
      'progress.stage.viralPersistence',
    ])

    expect(enProgress.taskType.viralVideoAnalysis).toBe('Viral video analysis')
    expect(enProgress.taskType.viralStoryboardGeneration).toBe('Viral storyboard generation')
    expect(enProgress.stage.viralPreprocess).toBe('Preprocess source video')
    expect(enProgress.stage.viralShotAnalysis).toBe('Analyze video shots')
    expect(enProgress.stage.viralReportAggregation).toBe('Aggregate analysis report')
    expect(enProgress.stage.viralStoryboardGeneration).toBe('Generate replication storyboard')
    expect(enProgress.stage.viralPersistence).toBe('Persist viral replication result')

    expect(zhProgress.taskType.viralVideoAnalysis).toBe('爆款视频分析')
    expect(zhProgress.taskType.viralStoryboardGeneration).toBe('爆款分镜生成')
    expect(zhProgress.stage.viralPreprocess).toBe('预处理源视频')
    expect(zhProgress.stage.viralShotAnalysis).toBe('分析视频镜头')
    expect(zhProgress.stage.viralReportAggregation).toBe('汇总分析报告')
    expect(zhProgress.stage.viralStoryboardGeneration).toBe('生成复刻分镜')
    expect(zhProgress.stage.viralPersistence).toBe('保存爆款复刻结果')
  })

  it.each([
    TASK_TYPE.VIRAL_VIDEO_ANALYSIS,
    TASK_TYPE.VIRAL_STORYBOARD_GENERATION,
  ])('keeps %s in the exhaustive task coverage catalogs', (taskType) => {
    expect(TASK_TYPE_CATALOG).toContainEqual(expect.objectContaining({
      taskType,
      owner: 'tests/unit/worker/viral-replication-worker.test.ts',
    }))
    expect(TASKTYPE_BEHAVIOR_MATRIX).toContainEqual(expect.objectContaining({
      taskType,
      workerTest: 'tests/unit/worker/viral-replication-worker.test.ts',
      chainTest: 'tests/integration/chain/text.chain.test.ts',
      apiContractTest: 'tests/integration/api/contract/llm-observe-routes.test.ts',
    }))
  })
})
