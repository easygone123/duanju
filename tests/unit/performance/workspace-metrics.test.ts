import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWorkspaceMetrics } from '@/lib/performance/workspace-metrics'

describe('workspace performance metrics', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('records stage latency, request bytes, refetch count, and mounted cards', () => {
    const metrics = createWorkspaceMetrics({ enabled: true })

    metrics.stageStart('storyboard', 100)
    metrics.recordRequest('/storyboards', 42_000)
    metrics.recordRequest('/workspace-stage.js', 310_000, 'script')
    metrics.recordRefetch(['storyboards', 'episode-1'])
    metrics.setMountedCards('storyboard', 18)
    metrics.stageVisible('storyboard', 260)

    expect(metrics.snapshot()).toMatchObject({
      stages: { storyboard: { visibleMs: 160, mountedCards: 18 } },
      requests: [
        { name: '/storyboards', bytes: 42_000, kind: 'data' },
        { name: '/workspace-stage.js', bytes: 310_000, kind: 'script' },
      ],
      requestCount: 2,
      requestBytes: 352_000,
      refetchCount: 1,
    })
  })

  it('uses an injected deterministic clock when timestamps are omitted', () => {
    let currentTime = 100
    const metrics = createWorkspaceMetrics({
      enabled: true,
      now: () => currentTime,
    })

    metrics.stageStart('script')
    currentTime = 275
    metrics.stageVisible('script')

    expect(metrics.snapshot().stages.script.visibleMs).toBe(175)
  })

  it('is a no-op unless collection is explicitly enabled', () => {
    const metrics = createWorkspaceMetrics()

    metrics.stageStart('storyboard', 100)
    metrics.recordRequest('/storyboards', 42_000)
    metrics.recordRefetch(['storyboards'])
    metrics.setMountedCards('storyboard', 18)
    metrics.stageVisible('storyboard', 260)

    expect(metrics.snapshot()).toEqual({
      stages: {},
      requests: [],
      requestCount: 0,
      requestBytes: 0,
      refetchCount: 0,
    })
  })

  it('does not read the clock when collection is disabled', () => {
    const metrics = createWorkspaceMetrics({
      now: () => {
        throw new Error('clock must not be read')
      },
    })

    expect(() => {
      metrics.stageStart('storyboard')
      metrics.stageVisible('storyboard')
    }).not.toThrow()
  })

  it('stays a no-op in production even when explicitly enabled', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const metrics = createWorkspaceMetrics({ enabled: true })

    metrics.recordRequest('/storyboards', 42_000)
    metrics.recordRefetch(['storyboards'])

    expect(metrics.snapshot()).toMatchObject({
      requestCount: 0,
      requestBytes: 0,
      refetchCount: 0,
    })
  })

  it('does not read the clock in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const metrics = createWorkspaceMetrics({
      enabled: true,
      now: () => {
        throw new Error('clock must not be read')
      },
    })

    expect(() => {
      metrics.stageStart('storyboard')
      metrics.stageVisible('storyboard')
    }).not.toThrow()
  })
})
