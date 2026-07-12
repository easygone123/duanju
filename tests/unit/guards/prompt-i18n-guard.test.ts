import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const fixtures: string[] = []
const guardPath = path.join(process.cwd(), 'scripts/guards/prompt-i18n-guard.mjs')

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true, force: true })
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-i18n-guard-'))
  fixtures.push(root)
  write(root, 'src/lib/prompt-i18n/catalog.ts', "pathStem: 'fixture/basic'")
  write(root, 'lib/prompts/fixture/basic.zh.txt', '中文模板')
  write(root, 'lib/prompts/fixture/basic.en.txt', 'English template')
  return root
}

function write(root: string, relativePath: string, content: string) {
  const filePath = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function run(root: string) {
  return spawnSync(process.execPath, [guardPath], { cwd: root, encoding: 'utf8' })
}

describe('prompt i18n guard exact allowlist', () => {
  it('permits only the two established system templates and reader', () => {
    const root = fixture()
    write(root, 'lib/prompts/skills/api-config-template.system.txt', 'system template')
    write(root, 'lib/prompts/skills/tutorial.system.txt', 'system template')
    write(root, 'src/lib/assistant-platform/system-prompts.ts', [
      "import fs from 'node:fs'",
      "fs.readFileSync('lib/prompts/skills/tutorial.system.txt', 'utf8')",
    ].join('\n'))

    const result = run(root)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('[prompt-i18n-guard] OK')
  })

  it('still rejects a similarly named unlocalized system template', () => {
    const root = fixture()
    write(root, 'lib/prompts/skills/rogue.system.txt', 'not allowlisted')

    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('lib/prompts/skills/rogue.system.txt')
  })

  it('still rejects a similarly named direct prompt reader', () => {
    const root = fixture()
    write(root, 'src/lib/assistant-platform/system-prompt.ts', [
      "import fs from 'node:fs'",
      "fs.readFileSync('lib/prompts/skills/tutorial.system.txt', 'utf8')",
    ].join('\n'))

    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('src/lib/assistant-platform/system-prompt.ts')
  })
})
