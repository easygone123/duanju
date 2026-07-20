import { describe, expect, it } from 'vitest'
import { parseCharacterVisualAppearances } from '@/lib/workers/handlers/character-profile-helpers'

describe('character profile visual response', () => {
  it('rejects a pronoun-only initial appearance description', () => {
    expect(() => parseCharacterVisualAppearances(JSON.stringify({
      characters: [{ appearances: [{ change_reason: '初始形象', descriptions: ['我'] }] }],
    }))).toThrow('AI返回格式错误: 形象描述无效')
  })

  it('returns trimmed appearance descriptions when they contain usable visual detail', () => {
    expect(parseCharacterVisualAppearances(JSON.stringify({
      characters: [{
        appearances: [{
          change_reason: '初始形象',
          descriptions: ['  二十五岁男性，剑眉星目，黑色短发，身穿深蓝色长袍与黑色长靴。  '],
        }],
      }],
    }))).toEqual([{
      changeReason: '初始形象',
      descriptions: ['二十五岁男性，剑眉星目，黑色短发，身穿深蓝色长袍与黑色长靴。'],
    }])
  })
})
