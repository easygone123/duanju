import { describe, expect, it } from 'vitest'
import { inspectTaskTypeBehaviorCoverage } from '@/../scripts/guards/tasktype-behavior-coverage'

describe('task type behavior coverage guard', () => {
  it('rejects a declared API layer with no API contract test', () => {
    const issues = inspectTaskTypeBehaviorCoverage({
      catalog: [{
        taskType: 'example_task',
        owner: 'tests/unit/example.test.ts',
        layers: ['worker-unit', 'api-contract'],
      }],
      matrix: [{
        taskType: 'example_task',
        caseId: 'TASKTYPE:example_task',
        workerTest: 'tests/unit/example.test.ts',
        chainTest: null,
        apiContractTest: null,
      }],
      fileExists: () => true,
    })

    expect(issues).toContain('example_task: declared api-contract layer is missing apiContractTest')
  })

  it('rejects an undeclared layer that masquerades as covered', () => {
    const issues = inspectTaskTypeBehaviorCoverage({
      catalog: [{
        taskType: 'example_task',
        owner: 'tests/unit/example.test.ts',
        layers: ['worker-unit'],
      }],
      matrix: [{
        taskType: 'example_task',
        caseId: 'TASKTYPE:example_task',
        workerTest: 'tests/unit/example.test.ts',
        chainTest: null,
        apiContractTest: 'tests/integration/api/unrelated.test.ts',
      }],
      fileExists: () => true,
    })

    expect(issues).toContain('example_task: undeclared api-contract layer must not set apiContractTest')
  })
})
