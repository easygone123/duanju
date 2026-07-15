import { describe, expect, it } from 'vitest'
import { resolveTaskMaxAttempts } from '@/lib/task/retry-policy'
import { TASK_TYPE } from '@/lib/task/types'

describe('task retry policy', () => {
  it.each([
    TASK_TYPE.VIRAL_VIDEO_ANALYSIS,
    TASK_TYPE.VIRAL_STORYBOARD_GENERATION,
  ])('forces %s to one attempt for omitted and explicit requests', (taskType) => {
    expect(resolveTaskMaxAttempts(taskType)).toBe(1)
    expect(resolveTaskMaxAttempts(taskType, 9)).toBe(1)
  })

  it('preserves requested and default semantics for ordinary tasks', () => {
    expect(resolveTaskMaxAttempts(TASK_TYPE.ANALYZE_NOVEL)).toBeUndefined()
    expect(resolveTaskMaxAttempts(TASK_TYPE.ANALYZE_NOVEL, 9)).toBe(9)
  })

  it.each([
    TASK_TYPE.STORY_TO_SCRIPT_RUN,
    TASK_TYPE.SCRIPT_TO_STORYBOARD_RUN,
  ])('preserves the existing single-attempt behavior for %s', (taskType) => {
    expect(resolveTaskMaxAttempts(taskType)).toBe(1)
    expect(resolveTaskMaxAttempts(taskType, 9)).toBe(1)
  })
})
