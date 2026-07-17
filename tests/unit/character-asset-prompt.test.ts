import { describe, expect, it } from 'vitest'
import { CHARACTER_PROMPT_SUFFIX } from '@/lib/constants'
import { buildCharacterAssetPrompt } from '@/lib/character-asset-prompt'

function countOccurrences(input: string, target: string): number {
  return input.split(target).length - 1
}

describe('buildCharacterAssetPrompt', () => {
  it('places art style before the fixed character-sheet suffix', () => {
    const result = buildCharacterAssetPrompt('黑发角色', '电影写实风格')

    expect(result).toBe(`黑发角色，电影写实风格，${CHARACTER_PROMPT_SUFFIX}`)
  })

  it('normalizes an existing suffix to exactly one final occurrence', () => {
    const result = buildCharacterAssetPrompt(
      `黑发角色，${CHARACTER_PROMPT_SUFFIX}`,
      '电影写实风格',
    )

    expect(countOccurrences(result, CHARACTER_PROMPT_SUFFIX)).toBe(1)
    expect(result.endsWith(CHARACTER_PROMPT_SUFFIX)).toBe(true)
    expect(result.indexOf('电影写实风格')).toBeLessThan(result.indexOf(CHARACTER_PROMPT_SUFFIX))
  })
})
