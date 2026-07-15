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
})
