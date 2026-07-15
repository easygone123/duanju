#!/usr/bin/env tsx

import fs from 'node:fs'
import path from 'node:path'
import { TASK_TYPE_CATALOG } from '../../tests/contracts/task-type-catalog'
import { TASKTYPE_BEHAVIOR_MATRIX } from '../../tests/contracts/tasktype-behavior-matrix'
import { inspectTaskTypeBehaviorCoverage } from './tasktype-behavior-coverage'

const root = process.cwd()
const issues = inspectTaskTypeBehaviorCoverage({
  catalog: TASK_TYPE_CATALOG,
  matrix: TASKTYPE_BEHAVIOR_MATRIX,
  fileExists: (file) => fs.existsSync(path.join(root, file)),
})

if (issues.length > 0) {
  console.error('\n[test-behavior-tasktype-coverage-guard] Invalid task type behavior coverage')
  for (const issue of issues) console.error(`  - ${issue}`)
  process.exit(1)
}

const testFiles = new Set(
  TASKTYPE_BEHAVIOR_MATRIX.flatMap((entry) => [
    entry.workerTest,
    entry.chainTest,
    entry.apiContractTest,
  ].filter((file): file is string => Boolean(file))),
)

console.log(
  `[test-behavior-tasktype-coverage-guard] OK taskTypes=${TASK_TYPE_CATALOG.length} tests=${testFiles.size}`,
)
