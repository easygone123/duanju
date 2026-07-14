import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { REQUIREMENTS_MATRIX } from './requirements-matrix'

const SYSTEM_TEST = 'tests/system/six-grid-storyboard.system.test.ts'
const EXPECTED_IDS = Array.from(
  { length: 6 },
  (_, index) => `REQ-NP-SIX-GRID-${String(index + 1).padStart(2, '0')}`,
)

describe('six-grid requirements matrix', () => {
  it('maps every six-grid requirement to one executable system-test title', () => {
    const entries = REQUIREMENTS_MATRIX.filter((entry) => entry.id.startsWith('REQ-NP-SIX-GRID-'))
    expect(entries.map((entry) => entry.id)).toEqual(EXPECTED_IDS)
    const source = fs.readFileSync(path.resolve(process.cwd(), SYSTEM_TEST), 'utf8')
    for (const entry of entries) {
      expect(entry.priority).toBe('P0')
      expect(entry.tests).toContain(SYSTEM_TEST)
      const title = new RegExp(`(?:it|test)\\(\\s*'${entry.id}[^']*'\\s*,`, 'g')
      expect([...source.matchAll(title)], entry.id).toHaveLength(1)
    }
  })

  it('documents six-grid operation, migration, and safety limits for local and Compose installs', () => {
    for (const filename of ['README.md', 'README_en.md']) {
      const source = fs.readFileSync(path.resolve(process.cwd(), filename), 'utf8')
      for (const requiredText of [
        'six_grid',
        'sheet_upscale_then_crop',
        'crop_then_panel_upscale',
        'SIX_GRID_CROP_MAX_SOURCE_BYTES',
        'SIX_GRID_CROP_MAX_SOURCE_PIXELS',
        'npx prisma migrate deploy',
      ]) expect(source, `${filename} -> ${requiredText}`).toContain(requiredText)
    }

    for (const filename of ['.env.example', 'docker-compose.yml']) {
      const source = fs.readFileSync(path.resolve(process.cwd(), filename), 'utf8')
      expect(source).toContain('SIX_GRID_CROP_MAX_SOURCE_BYTES')
      expect(source).toContain('SIX_GRID_CROP_MAX_SOURCE_PIXELS')
    }
  })
})
