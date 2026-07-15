import fs from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

describe('viral analysis execution lease schema', () => {
  it('stores an independent execution token and lease expiry with a migration', async () => {
    const schema = await fs.readFile(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8')
    const migration = await fs.readFile(
      path.join(process.cwd(), 'prisma/migrations/20260715110000_add_viral_analysis_execution_lease/migration.sql'),
      'utf8',
    )

    expect(schema).toContain('analysisExecutionToken')
    expect(schema).toContain('analysisExecutionExpiresAt')
    expect(migration).toContain('analysisExecutionToken')
    expect(migration).toContain('analysisExecutionExpiresAt')
  })

  it('stores the owning task id in a dedicated indexed migration', async () => {
    const schema = await fs.readFile(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8')
    const migration = await fs.readFile(
      path.join(process.cwd(), 'prisma/migrations/20260715130000_add_viral_analysis_task_owner/migration.sql'),
      'utf8',
    )

    expect(schema).toContain('analysisExecutionTaskId String?')
    expect(schema).toContain('@@index([analysisExecutionTaskId])')
    expect(migration).toContain('analysisExecutionTaskId')
    expect(migration).toContain('viral_replications_analysisExecutionTaskId_idx')
  })
})
