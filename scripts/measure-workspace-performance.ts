import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import {
  createWorkspaceMetrics,
  type WorkspaceRequestMetric,
} from '../src/lib/performance/workspace-metrics'

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
  const metrics = createWorkspaceMetrics({ enabled: true, now: () => fixture.startedAt })

  metrics.stageStart('storyboard')
  for (const request of fixture.requests) {
    metrics.recordRequest(request.name, request.bytes, request.kind)
  }
  for (let index = 0; index < fixture.refetchCount; index += 1) {
    metrics.recordRefetch(['workspace-performance', fixture.scenario, index])
  }
  metrics.setMountedCards('storyboard', fixture.mountedCardBodies)
  metrics.stageVisible('storyboard', fixture.visibleAt)

  const snapshot = metrics.snapshot()
  const stage = snapshot.stages.storyboard

  return {
    scenario: fixture.scenario,
    stageVisibleMs: stage.visibleMs ?? 0,
    requests: snapshot.requests,
    requestCount: snapshot.requestCount,
    requestBytes: snapshot.requestBytes,
    refetchCount: snapshot.refetchCount,
    jsChunks: [...fixture.jsChunks],
    mountedCardBodies: stage.mountedCards ?? 0,
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
  console.log(JSON.stringify(buildWorkspacePerformanceBaseline(), null, 2))
}
