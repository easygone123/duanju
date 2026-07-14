import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildWorkspacePerformanceBaseline,
  buildWorkspacePerformanceComparison,
  evaluateWorkspacePerformanceBudgets,
  parseWorkspacePerformanceArgs,
  runWorkspacePerformanceCli,
} from '../../scripts/measure-workspace-performance'

const CLI_USAGE = 'Usage: npm run perf:workspace -- --baseline|--compare'

function runRealCli(
  args: readonly string[],
  nodeEnv: 'development' | 'production' | 'test' = 'test',
) {
  return spawnSync(
    process.execPath,
    [
      resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
      resolve(process.cwd(), 'scripts/measure-workspace-performance.ts'),
      ...args,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: nodeEnv },
    },
  )
}

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

  it('enforces the final deterministic workspace budgets', () => {
    const report = buildWorkspacePerformanceComparison()

    expect(report.acceptance.cachedStageVisibleMs).toBeLessThanOrEqual(300)
    expect(report.acceptance.wholeProjectRefetchesOnStageSwitch).toBe(0)
    expect(report.acceptance.initialStageRequestNames).toEqual([
      'project-shell',
      'storyboard-stage',
    ])
    expect(report.acceptance.initialMountedCardBodies).toBeLessThanOrEqual(20)
    expect(report.acceptance.taskCompletionUnrelatedRefetches).toBe(0)
    expect(report.acceptance.passed).toBe(true)
  })

  it('rejects the old eager-mount and broad-refetch baseline', () => {
    const baseline = buildWorkspacePerformanceBaseline()

    expect(evaluateWorkspacePerformanceBudgets(baseline.observations, 1)).toMatchObject({
      cachedStageVisibleMs: 460,
      wholeProjectRefetchesOnStageSwitch: 1,
      initialMountedCardBodies: 96,
      taskCompletionUnrelatedRefetches: 1,
      passed: false,
    })
  })

  it('parses baseline and comparison CLI modes', () => {
    expect(parseWorkspacePerformanceArgs(['--baseline'])).toEqual({ mode: 'baseline' })
    expect(parseWorkspacePerformanceArgs(['--compare'])).toEqual({ mode: 'compare' })
  })

  it('rejects a missing CLI mode with concise usage', () => {
    expect(() => parseWorkspacePerformanceArgs([])).toThrowError(CLI_USAGE)
  })

  it('rejects unknown CLI arguments with concise usage', () => {
    expect(() => parseWorkspacePerformanceArgs(['--wat'])).toThrowError(CLI_USAGE)
    expect(() => parseWorkspacePerformanceArgs(['--baseline', '--wat'])).toThrowError(
      CLI_USAGE,
    )
  })

  it('builds the same deterministic baseline in production', () => {
    const expected = buildWorkspacePerformanceBaseline()
    vi.stubEnv('NODE_ENV', 'production')

    expect(buildWorkspacePerformanceBaseline()).toEqual(expected)
  })

  it('runs baseline through injected stdout and exit-code adapters', () => {
    const stdout = vi.fn()
    const stderr = vi.fn()
    const setExitCode = vi.fn()

    runWorkspacePerformanceCli(['--baseline'], { stdout, stderr, setExitCode })

    expect(stdout).toHaveBeenCalledOnce()
    expect(JSON.parse(stdout.mock.calls[0][0])).toEqual(
      buildWorkspacePerformanceBaseline(),
    )
    expect(stderr).not.toHaveBeenCalled()
    expect(setExitCode).toHaveBeenCalledWith(0)
  })

  it('runs comparison through injected stdout and exits successfully when budgets pass', () => {
    const stdout = vi.fn()
    const stderr = vi.fn()
    const setExitCode = vi.fn()

    runWorkspacePerformanceCli(['--compare'], { stdout, stderr, setExitCode })

    expect(JSON.parse(stdout.mock.calls[0][0])).toEqual(
      buildWorkspacePerformanceComparison(),
    )
    expect(stderr).not.toHaveBeenCalled()
    expect(setExitCode).toHaveBeenCalledWith(0)
  })

  it('routes invalid arguments through injected stderr and a non-zero exit code', () => {
    const stdout = vi.fn()
    const stderr = vi.fn()
    const setExitCode = vi.fn()

    runWorkspacePerformanceCli(['--unknown'], { stdout, stderr, setExitCode })

    expect(stdout).not.toHaveBeenCalled()
    expect(stderr).toHaveBeenCalledOnce()
    expect(stderr).toHaveBeenCalledWith(CLI_USAGE)
    expect(setExitCode).toHaveBeenCalledWith(1)
  })

  it('runs the real tsx baseline entry point and emits production-safe JSON', () => {
    const result = runRealCli(['--baseline'], 'production')

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(buildWorkspacePerformanceBaseline())
  })

  it('runs the real tsx comparison entry point and emits the accepted report', () => {
    const result = runRealCli(['--compare'], 'production')

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(buildWorkspacePerformanceComparison())
  })

  it('runs the real tsx entry point with missing mode and exits with usage', () => {
    const result = runRealCli([])

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(CLI_USAGE)
  })
})
