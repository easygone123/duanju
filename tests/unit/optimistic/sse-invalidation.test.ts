import { beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/lib/query/keys'
import { TASK_EVENT_TYPE, TASK_SSE_EVENT_TYPE } from '@/lib/task/types'

type InvalidateArg = { queryKey?: readonly unknown[]; exact?: boolean }

type EffectCleanup = (() => void) | void | null

const runtime = vi.hoisted(() => ({
  queryClient: {
    invalidateQueries: vi.fn(async (...args: [InvalidateArg?]) => {
      void args
      return undefined
    }),
    setQueriesData: vi.fn(),
  },
  effectCleanup: null as EffectCleanup,
  scheduledTimers: [] as Array<() => void>,
}))

const overlayMock = vi.hoisted(() => ({
  applyTaskLifecycleToOverlay: vi.fn(),
}))

class FakeEventSource {
  static OPEN = 1
  static instances: FakeEventSource[] = []

  readonly url: string
  readyState = FakeEventSource.OPEN
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  private listeners = new Map<string, Set<EventListener>>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, handler: EventListener) {
    const set = this.listeners.get(type) || new Set<EventListener>()
    set.add(handler)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, handler: EventListener) {
    const set = this.listeners.get(type)
    if (!set) return
    set.delete(handler)
  }

  emit(type: string, payload: unknown) {
    const event = { data: JSON.stringify(payload) } as MessageEvent
    if (this.onmessage) this.onmessage(event)
    const set = this.listeners.get(type)
    if (!set) return
    for (const handler of set) {
      handler(event as unknown as Event)
    }
  }

  close() {
    this.readyState = 2
  }
}

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return {
    ...actual,
    useMemo: <T,>(factory: () => T) => factory(),
    useRef: <T,>(value: T) => ({ current: value }),
    useEffect: (effect: () => EffectCleanup) => {
      runtime.effectCleanup = effect()
    },
  }
})

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => runtime.queryClient,
}))

vi.mock('@/lib/query/task-target-overlay', () => overlayMock)

function hasInvalidation(predicate: (arg: InvalidateArg) => boolean) {
  return runtime.queryClient.invalidateQueries.mock.calls.some((call) => {
    const arg = (call[0] || {}) as InvalidateArg
    return predicate(arg)
  })
}

describe('sse invalidation behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtime.effectCleanup = null
    runtime.scheduledTimers = []
    FakeEventSource.instances = []

    ;(globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource
    ;(globalThis as unknown as { window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } }).window = {
      setTimeout: ((cb: () => void) => {
        runtime.scheduledTimers.push(cb)
        return runtime.scheduledTimers.length as unknown as ReturnType<typeof setTimeout>
      }) as unknown as typeof setTimeout,
      clearTimeout: (() => undefined) as unknown as typeof clearTimeout,
    }
  })

  it('PROCESSING(progress 数值) 不触发 target-state invalidation；COMPLETED 触发', async () => {
    const { useSSE } = await import('@/lib/query/hooks/useSSE')

    useSSE({
      projectId: 'project-1',
      episodeId: 'episode-1',
      enabled: true,
    })

    const source = FakeEventSource.instances[0]
    expect(source).toBeTruthy()

    source.emit(TASK_SSE_EVENT_TYPE.LIFECYCLE, {
      type: TASK_SSE_EVENT_TYPE.LIFECYCLE,
      taskId: 'task-1',
      taskType: 'IMAGE_CHARACTER',
      targetType: 'CharacterAppearance',
      targetId: 'appearance-1',
      episodeId: 'episode-1',
      payload: {
        lifecycleType: TASK_EVENT_TYPE.PROCESSING,
        progress: 32,
      },
    })

    expect(hasInvalidation((arg) => {
      const key = arg.queryKey || []
      return Array.isArray(key) && key[0] === 'task-target-states'
    })).toBe(false)

    source.emit(TASK_SSE_EVENT_TYPE.LIFECYCLE, {
      type: TASK_SSE_EVENT_TYPE.LIFECYCLE,
      taskId: 'task-1',
      taskType: 'IMAGE_CHARACTER',
      targetType: 'CharacterAppearance',
      targetId: 'appearance-1',
      episodeId: 'episode-1',
      payload: {
        lifecycleType: TASK_EVENT_TYPE.COMPLETED,
      },
    })

    for (const cb of runtime.scheduledTimers) cb()

    expect(hasInvalidation((arg) => {
      const key = arg.queryKey || []
      return Array.isArray(key)
        && key[0] === queryKeys.tasks.targetStatesAll('project-1')[0]
        && key[1] === 'project-1'
        && arg.exact === false
    })).toBe(true)

    expect(overlayMock.applyTaskLifecycleToOverlay).toHaveBeenCalledWith(
      runtime.queryClient,
      expect.objectContaining({
        projectId: 'project-1',
        lifecycleType: TASK_EVENT_TYPE.COMPLETED,
        targetType: 'CharacterAppearance',
        targetId: 'appearance-1',
      }),
    )
  })

  it('patches a completed panel output without broadly invalidating workspace data', async () => {
    const { useSSE } = await import('@/lib/query/hooks/useSSE')

    useSSE({ projectId: 'project-1', episodeId: 'episode-1', enabled: true })
    FakeEventSource.instances[0].emit(TASK_SSE_EVENT_TYPE.LIFECYCLE, {
      type: TASK_SSE_EVENT_TYPE.LIFECYCLE,
      taskId: 'task-image-1',
      taskType: 'image_panel',
      targetType: 'NovelPromotionPanel',
      targetId: 'panel-1',
      episodeId: 'episode-1',
      payload: {
        lifecycleType: TASK_EVENT_TYPE.COMPLETED,
        imageUrl: 'panels/panel-1.jpg',
      },
    })

    const patchedKeys = runtime.queryClient.setQueriesData.mock.calls.map((call) => call[0]?.queryKey)
    expect(patchedKeys).toContainEqual(queryKeys.episodeStage('project-1', 'episode-1', 'storyboard'))
    expect(patchedKeys).toContainEqual(queryKeys.episodeStage('project-1', 'episode-1', 'videos'))
    expect(patchedKeys).toContainEqual(queryKeys.episodeData('project-1', 'episode-1'))
    expect(hasInvalidation((arg) => {
      const root = arg.queryKey?.[0]
      return root === 'episode-stages' || root === 'storyboards' || root === 'voice-lines' || root === 'project-data'
    })).toBe(false)
  })

  it('debounces an unknown completion into one exact stage recovery', async () => {
    const { useSSE } = await import('@/lib/query/hooks/useSSE')

    useSSE({ projectId: 'project-1', episodeId: 'episode-1', enabled: true })
    const source = FakeEventSource.instances[0]
    const unknown = {
      type: TASK_SSE_EVENT_TYPE.LIFECYCLE,
      taskId: 'task-unknown-1',
      taskType: 'custom_task',
      targetType: 'NovelPromotionMystery',
      targetId: 'mystery-1',
      episodeId: 'episode-1',
      payload: {
        lifecycleType: TASK_EVENT_TYPE.COMPLETED,
        workspaceStage: 'storyboard',
      },
    }
    source.emit(TASK_SSE_EVENT_TYPE.LIFECYCLE, unknown)
    source.emit(TASK_SSE_EVENT_TYPE.LIFECYCLE, { ...unknown, taskId: 'task-unknown-2' })

    expect(hasInvalidation((arg) => arg.queryKey?.[0] === 'episode-stages')).toBe(false)
    for (const cb of runtime.scheduledTimers) cb()

    const stageRecoveries = runtime.queryClient.invalidateQueries.mock.calls.filter((call) =>
      call[0]?.queryKey?.[0] === 'episode-stages')
    expect(stageRecoveries).toHaveLength(1)
    expect(stageRecoveries[0]?.[0]).toEqual({
      queryKey: queryKeys.episodeStage('project-1', 'episode-1', 'storyboard'),
    })
    expect(hasInvalidation((arg) => arg.queryKey?.[0] === 'project-data')).toBe(false)
  })

  it('refreshes only the exact viral replication detail and debounces progress', async () => {
    const { useSSE } = await import('@/lib/query/hooks/useSSE')

    useSSE({ projectId: 'project-1', episodeId: 'episode-1', enabled: true })
    const source = FakeEventSource.instances[0]
    const progress = {
      type: TASK_SSE_EVENT_TYPE.LIFECYCLE,
      taskId: 'task-viral-1',
      taskType: 'viral_video_analysis',
      targetType: 'ViralReplication',
      targetId: 'rep-1',
      episodeId: 'episode-1',
      payload: { lifecycleType: TASK_EVENT_TYPE.PROCESSING, progress: 40 },
    }
    source.onmessage?.({ data: JSON.stringify(progress) } as MessageEvent)
    source.onmessage?.({ data: JSON.stringify({
      ...progress,
      payload: { lifecycleType: TASK_EVENT_TYPE.PROGRESS, progress: 41 },
    }) } as MessageEvent)

    expect(hasInvalidation((arg) => arg.queryKey?.[0] === 'viral-replication')).toBe(false)
    for (const cb of runtime.scheduledTimers.splice(0)) cb()
    const progressInvalidations = runtime.queryClient.invalidateQueries.mock.calls.filter((call) =>
      call[0]?.queryKey?.[0] === 'viral-replication')
    expect(progressInvalidations).toHaveLength(1)
    expect(progressInvalidations[0]?.[0]).toEqual({
      queryKey: queryKeys.viralReplication.detail('rep-1'),
      exact: true,
    })

    vi.clearAllMocks()
    source.onmessage?.({ data: JSON.stringify({
      ...progress,
      payload: { lifecycleType: TASK_EVENT_TYPE.COMPLETED },
    }) } as MessageEvent)

    expect(hasInvalidation((arg) =>
      arg.exact === true
      && JSON.stringify(arg.queryKey) === JSON.stringify(queryKeys.viralReplication.detail('rep-1')),
    )).toBe(true)
    expect(hasInvalidation((arg) => {
      const root = arg.queryKey?.[0]
      return root === 'project-data'
        || root === 'episode-data'
        || root === 'episode-stages'
        || root === 'global-assets'
        || root === 'project-assets'
    })).toBe(false)
  })
})
