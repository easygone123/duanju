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
  'Usage: npm run perf:workspace -- --baseline'

export function parseWorkspacePerformanceArgs(
  args: readonly string[],
): { mode: 'baseline' } {
  if (args.length === 1 && args[0] === '--baseline') {
    return { mode: 'baseline' }
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

const entryPath = process.argv[1] ? resolve(process.argv[1]) : undefined
const isDirectRun = entryPath === fileURLToPath(import.meta.url)

if (isDirectRun) {
  try {
    parseWorkspacePerformanceArgs(process.argv.slice(2))
    console.log(JSON.stringify(buildWorkspacePerformanceBaseline(), null, 2))
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : WORKSPACE_PERFORMANCE_CLI_USAGE,
    )
    process.exitCode = 1
  }
}
