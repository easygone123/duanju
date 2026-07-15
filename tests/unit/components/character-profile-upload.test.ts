import * as React from 'react'
import { createElement } from 'react'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import type { AbstractIntlMessages } from 'next-intl'
import { describe, expect, it, vi } from 'vitest'
import CharacterProfileCard from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/assets/CharacterProfileCard'

vi.mock('@/components/task/TaskStatusInline', () => ({ default: () => null }))
vi.mock('@/lib/task/presentation', () => ({ resolveTaskPresentationState: () => null }))
vi.mock('@/components/ui/icons', () => ({
  AppIcon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}))
vi.mock('@/lib/query/mutations', () => ({
  useUploadProjectCharacterImage: () => ({ mutate: vi.fn(), isPending: false }),
}))

describe('CharacterProfileCard manual image upload', () => {
  it('offers image upload before AI appearance generation', () => {
    Reflect.set(globalThis, 'React', React)
    const messages = {
      assets: {
        characterProfile: {
          delete: '删除', editProfile: '编辑档案', useExisting: '使用已有角色',
          confirmAndGenerate: '确认并生成', uploadImage: '上传角色图片',
          importance: { A: '主要角色' },
          summary: {
            gender: '性别', age: '年龄', era: '年代', class: '阶层', occupation: '职业',
            personality: '性格', costume: '服装', identifier: '标志',
          },
        },
      },
    }
    const card = createElement(CharacterProfileCard, {
      characterId: 'character-1',
      projectId: 'project-1',
      name: '林夏',
      profileData: {
        role_level: 'A', archetype: '主角', gender: '女', age_range: '20-25',
        era_period: '现代', social_class: '普通', occupation: '记者',
        personality_tags: ['冷静'], costume_tier: 2, primary_identifier: '红围巾',
        suggested_colors: ['红色'], visual_keywords: ['短发'],
      },
      onEdit: () => undefined,
      onConfirm: () => undefined,
    })
    const providerProps: ComponentProps<typeof NextIntlClientProvider> = {
      locale: 'zh', timeZone: 'Asia/Shanghai',
      messages: messages as unknown as AbstractIntlMessages,
      children: card,
    }

    const html = renderToStaticMarkup(createElement(NextIntlClientProvider, providerProps))

    expect(html).toContain('上传角色图片')
    expect(html).toContain('type="file"')
    expect(html).toContain('accept="image/*"')
    expect(html).toContain('data-icon="upload"')
  })
})
