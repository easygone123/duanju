import { describe, expect, it } from 'vitest'
import { TASK_TYPE } from '@/lib/task/types'
import { resolveTaskIntent } from '@/lib/task/intent'

describe('resolveTaskIntent', () => {
  it('maps generate task types', () => {
    expect(resolveTaskIntent(TASK_TYPE.IMAGE_CHARACTER)).toBe('generate')
    expect(resolveTaskIntent(TASK_TYPE.IMAGE_LOCATION)).toBe('generate')
    expect(resolveTaskIntent(TASK_TYPE.VIDEO_PANEL)).toBe('generate')
    expect(resolveTaskIntent(TASK_TYPE.AI_STORY_EXPAND)).toBe('generate')
    expect(resolveTaskIntent(TASK_TYPE.VIRAL_STORYBOARD_GENERATION)).toBe('generate')
  })

  it('maps viral video analysis as analysis', () => {
    expect(resolveTaskIntent(TASK_TYPE.VIRAL_VIDEO_ANALYSIS)).toBe('analyze')
  })

  it('maps regenerate and modify task types', () => {
    expect(resolveTaskIntent(TASK_TYPE.REGENERATE_GROUP)).toBe('regenerate')
    expect(resolveTaskIntent(TASK_TYPE.PANEL_VARIANT)).toBe('regenerate')
    expect(resolveTaskIntent(TASK_TYPE.MODIFY_ASSET_IMAGE)).toBe('modify')
  })

  it('falls back to process for unknown types', () => {
    expect(resolveTaskIntent('unknown_type')).toBe('process')
    expect(resolveTaskIntent(null)).toBe('process')
    expect(resolveTaskIntent(undefined)).toBe('process')
  })
})
