import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildWorkspacePerformanceBaseline,
  parseWorkspacePerformanceArgs,
} from '../../scripts/measure-workspace-performance'

const CLI_USAGE = 'Usage: npm run perf:workspace -- --baseline'

describe('workspace performance baseline contract', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('records deterministic cold-entry and cached-switch observations', () => {
    const report = buildWorkspacePerformanceBaseline()

    expect(report).toEqual({
      schema: 'workspace-performance',
      version: 1,
      mode: 'baseline',
      observations: [
        {
          scenario: 'cold-entry',
          stageVisibleMs: 1_240,
          requests: [
            { name: 'project-shell', bytes: 86_000, kind: 'data' },
            { name: 'workspace-stage-chunk', bytes: 310_000, kind: 'script' },
            { name: 'episode-workspace', bytes: 1_480_000, kind: 'data' },
          ],
          requestCount: 3,
          requestBytes: 1_876_000,
          refetchCount: 2,
          jsChunks: ['workspace-shell', 'storyboard-stage'],
          mountedCardBodies: 96,
          timestamp: '2026-07-14T00:00:00.000Z',
        },
        {
          scenario: 'cached-switch',
          stageVisibleMs: 460,
          requests: [
            { name: 'episode-workspace', bytes: 1_480_000, kind: 'data' },
          ],
          requestCount: 1,
          requestBytes: 1_480_000,
          refetchCount: 1,
          jsChunks: [],
          mountedCardBodies: 96,
          timestamp: '2026-07-14T00:00:01.000Z',
        },
      ],
    })
  })

  it('records observations without enforcing the final budgets yet', () => {
    const report = buildWorkspacePerformanceBaseline()
    const cachedSwitch = report.observations.find(
      (observation) => observation.scenario === 'cached-switch',
    )

    expect(cachedSwitch?.stageVisibleMs).toBe(460)
    expect(cachedSwitch?.refetchCount).toBe(1)
    expect(cachedSwitch?.mountedCardBodies).toBe(96)
  })

  it('parses baseline as the only supported CLI mode', () => {
    expect(parseWorkspacePerformanceArgs(['--baseline'])).toEqual({ mode: 'baseline' })
  })

  it('rejects a missing CLI mode with concise usage', () => {
    expect(() => parseWorkspacePerformanceArgs([])).toThrowError(CLI_USAGE)
  })

  it('rejects unknown CLI arguments with concise usage', () => {
    expect(() => parseWorkspacePerformanceArgs(['--compare'])).toThrowError(CLI_USAGE)
    expect(() => parseWorkspacePerformanceArgs(['--baseline', '--wat'])).toThrowError(
      CLI_USAGE,
    )
  })

  it('builds the same deterministic baseline in production', () => {
    const expected = buildWorkspacePerformanceBaseline()
    vi.stubEnv('NODE_ENV', 'production')

    expect(buildWorkspacePerformanceBaseline()).toEqual(expected)
  })
})
