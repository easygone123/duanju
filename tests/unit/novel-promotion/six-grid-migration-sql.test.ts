import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const migrationPath = path.join(
  process.cwd(),
  'prisma/migrations/20260713070000_add_six_grid_crop_claims/migration.sql',
)

describe('six-grid crop claim migration SQL', () => {
  it('contains executable SQL without patch markers at line starts', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8')
    expect(sql).toMatch(/^CREATE TABLE `six_grid_crop_claims`/)
    expect(sql).not.toMatch(/^[+-](?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|\s)/m)
    expect(sql).toContain('UNIQUE INDEX `six_grid_crop_claims_claimKey_key`')
    expect(sql).toContain('INDEX `six_grid_crop_claims_leaseUntil_idx`')
  })
})
