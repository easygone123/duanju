import { describe, expect, it } from 'vitest'

import { buildWorkspacePerformanceComparison } from '../../scripts/measure-workspace-performance'

describe('workspace stage performance system contract', () => {
  it('measures the optimized deterministic flow against the original baseline', () => {
    const report = buildWorkspacePerformanceComparison()
    const coldEntry = report.current.observations.find(
      (observation) => observation.scenario === 'cold-entry',
    )
    const cachedSwitch = report.current.observations.find(
      (observation) => observation.scenario === 'cached-switch',
    )

    expect(coldEntry?.requests.map(({ name }) => name)).toEqual([
      'project-shell',
      'storyboard-stage',
    ])
    expect(coldEntry?.mountedCardBodies).toBeLessThanOrEqual(20)
    expect(cachedSwitch?.stageVisibleMs).toBeLessThanOrEqual(300)
    expect(cachedSwitch?.requests).toEqual([])
    expect(cachedSwitch?.refetchCount).toBe(0)
    expect(report.acceptance.taskCompletionUnrelatedRefetches).toBe(0)
  })

  it('uses fixed clocks and fixtures so acceptance does not depend on machine speed', () => {
    const first = buildWorkspacePerformanceComparison()
    const second = buildWorkspacePerformanceComparison()

    expect(second).toEqual(first)
    expect(first.evidence.kind).toBe('deterministic-contract')
    expect(first.evidence.browserMeasurement).toBe('not-collected')
  })
})
