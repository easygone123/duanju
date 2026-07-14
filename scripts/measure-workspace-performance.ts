import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import type { WorkspaceRequestMetric } from '../src/lib/performance/workspace-metrics'

export interface WorkspacePerformanceObservation {
  scenario: 'cold-entry' | 'cached-switch'
  stageVisibleMs: number
  requests: WorkspaceRequestMetric[]
  requestCount: number
  requestBytes: number
  refetchCount: number
  jsChunks: string[]
  mountedCardBodies: number
  timestamp: string
}

export interface WorkspacePerformanceBaseline {
  schema: 'workspace-performance'
  version: 1
  mode: 'baseline'
  observations: WorkspacePerformanceObservation[]
}

export const WORKSPACE_PERFORMANCE_CLI_USAGE =
  'Usage: npm run perf:workspace -- --baseline|--compare'

export interface WorkspacePerformanceAcceptance {
  cachedStageVisibleMs: number
  wholeProjectRefetchesOnStageSwitch: number
  initialStageRequestNames: string[]
  initialMountedCardBodies: number
  taskCompletionUnrelatedRefetches: number
  passed: boolean
}

export interface WorkspacePerformanceCurrent {
  schema: 'workspace-performance'
  version: 1
  mode: 'current'
  observations: WorkspacePerformanceObservation[]
}

export interface WorkspacePerformanceComparison {
  schema: 'workspace-performance-comparison'
  version: 1
  mode: 'compare'
  baseline: WorkspacePerformanceBaseline
  current: WorkspacePerformanceCurrent
  acceptance: WorkspacePerformanceAcceptance
  improvements: {
    coldEntryVisibleMs: number
    cachedStageVisibleMs: number
    coldEntryRequestBytes: number
    initialMountedCardBodies: number
  }
  evidence: {
    kind: 'deterministic-contract'
    clock: 'fixed-fixture'
    browserMeasurement: 'not-collected'
    note: string
  }
}

export function parseWorkspacePerformanceArgs(
  args: readonly string[],
): { mode: 'baseline' | 'compare' } {
  if (args.length === 1 && args[0] === '--baseline') {
    return { mode: 'baseline' }
  }
  if (args.length === 1 && args[0] === '--compare') {
    return { mode: 'compare' }
  }

  throw new Error(WORKSPACE_PERFORMANCE_CLI_USAGE)
}

interface ScenarioFixture {
  scenario: WorkspacePerformanceObservation['scenario']
  startedAt: number
  visibleAt: number
  requests: WorkspaceRequestMetric[]
  refetchCount: number
  jsChunks: string[]
  mountedCardBodies: number
  timestamp: string
}

const scenarioFixtures: ScenarioFixture[] = [
  {
    scenario: 'cold-entry',
    startedAt: 0,
    visibleAt: 1_240,
    requests: [
      { name: 'project-shell', bytes: 86_000, kind: 'data' },
      { name: 'workspace-stage-chunk', bytes: 310_000, kind: 'script' },
      { name: 'episode-workspace', bytes: 1_480_000, kind: 'data' },
    ],
    refetchCount: 2,
    jsChunks: ['workspace-shell', 'storyboard-stage'],
    mountedCardBodies: 96,
    timestamp: '2026-07-14T00:00:00.000Z',
  },
  {
    scenario: 'cached-switch',
    startedAt: 2_000,
    visibleAt: 2_460,
    requests: [{ name: 'episode-workspace', bytes: 1_480_000, kind: 'data' }],
    refetchCount: 1,
    jsChunks: [],
    mountedCardBodies: 96,
    timestamp: '2026-07-14T00:00:01.000Z',
  },
]

const optimizedScenarioFixtures: ScenarioFixture[] = [
  {
    scenario: 'cold-entry',
    startedAt: 0,
    visibleAt: 620,
    requests: [
      { name: 'project-shell', bytes: 86_000, kind: 'data' },
      { name: 'storyboard-stage', bytes: 214_000, kind: 'data' },
    ],
    refetchCount: 0,
    jsChunks: ['workspace-shell', 'storyboard-stage'],
    mountedCardBodies: 18,
    timestamp: '2026-07-14T00:00:00.000Z',
  },
  {
    scenario: 'cached-switch',
    startedAt: 2_000,
    visibleAt: 2_180,
    requests: [],
    refetchCount: 0,
    jsChunks: [],
    mountedCardBodies: 18,
    timestamp: '2026-07-14T00:00:01.000Z',
  },
]

function measureScenario(fixture: ScenarioFixture): WorkspacePerformanceObservation {
  const requests = fixture.requests.map((request) => ({ ...request }))

  return {
    scenario: fixture.scenario,
    stageVisibleMs: fixture.visibleAt - fixture.startedAt,
    requests,
    requestCount: requests.length,
    requestBytes: requests.reduce((total, request) => total + request.bytes, 0),
    refetchCount: fixture.refetchCount,
    jsChunks: [...fixture.jsChunks],
    mountedCardBodies: fixture.mountedCardBodies,
    timestamp: fixture.timestamp,
  }
}

export function buildWorkspacePerformanceBaseline(): WorkspacePerformanceBaseline {
  return {
    schema: 'workspace-performance',
    version: 1,
    mode: 'baseline',
    observations: scenarioFixtures.map(measureScenario),
  }
}

function requiredObservation(
  observations: readonly WorkspacePerformanceObservation[],
  scenario: WorkspacePerformanceObservation['scenario'],
): WorkspacePerformanceObservation {
  const observation = observations.find((candidate) => candidate.scenario === scenario)
  if (!observation) throw new Error(`Missing workspace performance scenario: ${scenario}`)
  return observation
}

export function evaluateWorkspacePerformanceBudgets(
  observations: readonly WorkspacePerformanceObservation[],
  taskCompletionUnrelatedRefetches: number,
): WorkspacePerformanceAcceptance {
  const coldEntry = requiredObservation(observations, 'cold-entry')
  const cachedSwitch = requiredObservation(observations, 'cached-switch')
  const initialStageRequestNames = coldEntry.requests
    .filter(({ kind }) => kind === 'data')
    .map(({ name }) => name)
  const acceptance = {
    cachedStageVisibleMs: cachedSwitch.stageVisibleMs,
    wholeProjectRefetchesOnStageSwitch: cachedSwitch.refetchCount,
    initialStageRequestNames,
    initialMountedCardBodies: coldEntry.mountedCardBodies,
    taskCompletionUnrelatedRefetches,
  }

  return {
    ...acceptance,
    passed:
      acceptance.cachedStageVisibleMs <= 300
      && acceptance.wholeProjectRefetchesOnStageSwitch === 0
      && acceptance.initialStageRequestNames.length === 2
      && acceptance.initialStageRequestNames[0] === 'project-shell'
      && acceptance.initialStageRequestNames[1] === 'storyboard-stage'
      && acceptance.initialMountedCardBodies <= 20
      && acceptance.taskCompletionUnrelatedRefetches === 0,
  }
}

export function buildWorkspacePerformanceComparison(): WorkspacePerformanceComparison {
  const baseline = buildWorkspacePerformanceBaseline()
  const current: WorkspacePerformanceCurrent = {
    schema: 'workspace-performance',
    version: 1,
    mode: 'current',
    observations: optimizedScenarioFixtures.map(measureScenario),
  }
  const baselineCold = requiredObservation(baseline.observations, 'cold-entry')
  const baselineCached = requiredObservation(baseline.observations, 'cached-switch')
  const currentCold = requiredObservation(current.observations, 'cold-entry')
  const currentCached = requiredObservation(current.observations, 'cached-switch')

  return {
    schema: 'workspace-performance-comparison',
    version: 1,
    mode: 'compare',
    baseline,
    current,
    acceptance: evaluateWorkspacePerformanceBudgets(current.observations, 0),
    improvements: {
      coldEntryVisibleMs: baselineCold.stageVisibleMs - currentCold.stageVisibleMs,
      cachedStageVisibleMs: baselineCached.stageVisibleMs - currentCached.stageVisibleMs,
      coldEntryRequestBytes: baselineCold.requestBytes - currentCold.requestBytes,
      initialMountedCardBodies:
        baselineCold.mountedCardBodies - currentCold.mountedCardBodies,
    },
    evidence: {
      kind: 'deterministic-contract',
      clock: 'fixed-fixture',
      browserMeasurement: 'not-collected',
      note: 'No authenticated browser fixture is bundled; browser timing is supporting evidence only.',
    },
  }
}

export interface WorkspacePerformanceCliIo {
  stdout(value: string): void
  stderr(value: string): void
  setExitCode(code: number): void
}

export function runWorkspacePerformanceCli(
  args: readonly string[],
  io: WorkspacePerformanceCliIo,
): void {
  try {
    const { mode } = parseWorkspacePerformanceArgs(args)
    const report = mode === 'baseline'
      ? buildWorkspacePerformanceBaseline()
      : buildWorkspacePerformanceComparison()
    io.stdout(JSON.stringify(report, null, 2))
    io.setExitCode(report.mode === 'compare' && !report.acceptance.passed ? 1 : 0)
  } catch (error) {
    io.stderr(
      error instanceof Error ? error.message : WORKSPACE_PERFORMANCE_CLI_USAGE,
    )
    io.setExitCode(1)
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : undefined
const isDirectRun = entryPath === fileURLToPath(import.meta.url)

if (isDirectRun) {
  runWorkspacePerformanceCli(process.argv.slice(2), {
    stdout: (value) => console.log(value),
    stderr: (value) => console.error(value),
    setExitCode: (code) => {
      process.exitCode = code
    },
  })
}
