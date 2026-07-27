import { TASK_TYPE, type TaskType } from './types'

const SINGLE_ATTEMPT_TASK_TYPES = new Set<TaskType>([
  TASK_TYPE.STORY_TO_SCRIPT_RUN,
  TASK_TYPE.SCRIPT_TO_STORYBOARD_RUN,
  TASK_TYPE.VIRAL_VIDEO_ANALYSIS,
  TASK_TYPE.VIRAL_STORYBOARD_GENERATION,
  TASK_TYPE.EDITOR_RENDER,
])

export function resolveTaskMaxAttempts(type: TaskType, requested?: number): number | undefined {
  if (SINGLE_ATTEMPT_TASK_TYPES.has(type)) return 1
  return requested
}
