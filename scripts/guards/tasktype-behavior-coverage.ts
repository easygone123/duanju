export type TaskTypeCoverageInput = {
  taskType: string
  owner: string
  layers: ReadonlyArray<string>
}

export type TaskTypeBehaviorInput = {
  taskType: string
  caseId: string
  workerTest: string | null
  chainTest: string | null
  apiContractTest: string | null
}

type CoveragePathField = 'workerTest' | 'chainTest' | 'apiContractTest'

const LAYER_PATH_FIELDS: ReadonlyArray<{
  layer: string
  field: CoveragePathField
}> = [
  { layer: 'worker-unit', field: 'workerTest' },
  { layer: 'api-contract', field: 'apiContractTest' },
  { layer: 'chain', field: 'chainTest' },
]

export function inspectTaskTypeBehaviorCoverage(input: {
  catalog: ReadonlyArray<TaskTypeCoverageInput>
  matrix: ReadonlyArray<TaskTypeBehaviorInput>
  fileExists(path: string): boolean
}): string[] {
  const issues: string[] = []
  const matrixByTaskType = new Map(input.matrix.map((entry) => [entry.taskType, entry]))

  for (const catalogEntry of input.catalog) {
    const matrixEntry = matrixByTaskType.get(catalogEntry.taskType)
    if (!matrixEntry) {
      issues.push(`${catalogEntry.taskType}: missing behavior matrix entry`)
      continue
    }
    if (matrixEntry.caseId !== `TASKTYPE:${catalogEntry.taskType}`) {
      issues.push(`${catalogEntry.taskType}: invalid caseId ${matrixEntry.caseId}`)
    }

    for (const { layer, field } of LAYER_PATH_FIELDS) {
      const declared = catalogEntry.layers.includes(layer)
      const testPath = matrixEntry[field]
      if (declared && !testPath) {
        issues.push(`${catalogEntry.taskType}: declared ${layer} layer is missing ${field}`)
        continue
      }
      if (!declared && testPath) {
        issues.push(`${catalogEntry.taskType}: undeclared ${layer} layer must not set ${field}`)
        continue
      }
      if (testPath && !input.fileExists(testPath)) {
        issues.push(`${catalogEntry.taskType}: ${field} references missing file ${testPath}`)
      }
    }
  }

  const catalogTaskTypes = new Set(input.catalog.map((entry) => entry.taskType))
  for (const matrixEntry of input.matrix) {
    if (!catalogTaskTypes.has(matrixEntry.taskType)) {
      issues.push(`${matrixEntry.taskType}: behavior matrix entry has no catalog task type`)
    }
  }

  return issues
}
