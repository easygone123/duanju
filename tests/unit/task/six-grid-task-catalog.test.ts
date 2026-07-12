import { describe, expect, it, vi } from 'vitest'

vi.mock('bullmq', () => ({ Queue: class {} }))
vi.mock('@/lib/redis', () => ({ queueRedis: {} }))

import { TASK_TYPE } from '@/lib/task/types'
import { getQueueTypeByTaskType } from '@/lib/task/queues'
import { resolveTaskIntent } from '@/lib/task/intent'
import { getTaskTypeLabel } from '@/lib/task/progress-message'

describe('six-grid task catalog', () => {
  it.each([
    [TASK_TYPE.STORYBOARD_SHEET_GENERATE, 'generate'],
    [TASK_TYPE.STORYBOARD_SHEET_UPSCALE, 'process'],
    [TASK_TYPE.STORYBOARD_SHEET_CROP, 'process'],
    [TASK_TYPE.STORYBOARD_PANEL_UPSCALE, 'process'],
  ] as const)('routes %s through the image queue with its stable presentation', (taskType, intent) => {
    expect(getQueueTypeByTaskType(taskType)).toBe('image')
    expect(resolveTaskIntent(taskType)).toBe(intent)
    expect(getTaskTypeLabel(taskType)).not.toBe('progress.taskType.generic')
  })
})
