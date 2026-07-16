// @vitest-environment jsdom

import * as React from 'react'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextIntlClientProvider } from 'next-intl'
import type { AbstractIntlMessages } from 'next-intl'

Reflect.set(globalThis, 'React', React)

const uploadCharacterMutationMock = vi.hoisted(() => ({
  isPending: false,
  mutate: vi.fn(),
}))
const uploadLocationMutationMock = vi.hoisted(() => ({
  isPending: false,
  mutate: vi.fn(),
}))

vi.mock('@/lib/query/mutations', () => ({
  useUploadProjectCharacterImage: () => uploadCharacterMutationMock,
  useUploadProjectLocationImage: () => uploadLocationMutationMock,
}))

vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/assets/character-card/CharacterCardGallery', () => ({
  default: () => createElement('div'),
}))

vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/assets/location-card/LocationImageList', () => ({
  default: () => createElement('div'),
}))

vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/assets/VoiceSettings', () => ({
  default: () => createElement('div'),
}))

vi.mock('@/components/task/TaskStatusInline', () => ({
  default: () => createElement('span'),
}))

vi.mock('@/components/image-generation/ImageGenerationInlineCountButton', () => ({
  default: () => createElement('button'),
}))

vi.mock('@/lib/image-generation/use-image-generation-count', () => ({
  useImageGenerationCount: () => ({
    count: 3,
    setCount: vi.fn(),
  }),
}))

vi.mock('@/lib/task/presentation', () => ({
  resolveTaskPresentationState: () => null,
}))

const messages = {
  assets: {
    character: {
      primary: '主形象',
      secondary: '子形象',
      edit: '编辑角色',
      delete: '删除角色',
    },
    location: {
      edit: '编辑场景',
      delete: '删除场景',
    },
    image: {
      regenCountPrefix: '重新生成',
      undo: '撤回',
      optionSelected: '已选择方案 {number}',
      selectFirst: '请先选择方案',
      selectTip: '选择并确认后可继续编辑',
      confirmOption: '确认方案 {number}',
      deleteOthersHint: '删除其他方案',
      edit: '编辑图片',
    },
  },
} as const

const TestIntlProvider = NextIntlClientProvider as React.ComponentType<{
  locale: string
  messages: AbstractIntlMessages
  timeZone: string
  children?: React.ReactNode
}>

function renderWithIntl(node: React.ReactNode) {
  return render(
    createElement(
      TestIntlProvider,
      {
        locale: 'zh',
        messages: messages as unknown as AbstractIntlMessages,
        timeZone: 'Asia/Shanghai',
      },
      node,
    ),
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('confirmed project asset editing', () => {
  it('keeps character data and selected image editing available in selection mode', async () => {
    const { default: CharacterCard } = await import('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/assets/CharacterCard')
    const onEdit = vi.fn()
    const onImageEdit = vi.fn()

    renderWithIntl(
      createElement(CharacterCard, {
        character: {
          id: 'character-1',
          name: '沈烬',
          appearances: [],
        },
        appearance: {
          id: 'appearance-1',
          appearanceIndex: 0,
          changeReason: '默认形象',
          description: '黑色长风衣',
          descriptions: ['黑色长风衣', '深灰西装'],
          imageUrl: 'https://example.com/selected.png',
          imageUrls: [
            'https://example.com/selected.png',
            'https://example.com/alternative.png',
          ],
          previousImageUrl: null,
          previousImageUrls: [],
          previousDescription: null,
          previousDescriptions: null,
          selectedIndex: 0,
        },
        onEdit,
        onDelete: vi.fn(),
        onRegenerate: vi.fn(),
        onGenerate: vi.fn(),
        onImageClick: vi.fn(),
        showDeleteButton: true,
        onImageEdit,
        projectId: 'project-1',
        onConfirmSelection: vi.fn(),
      }),
    )

    fireEvent.click(screen.getByTitle('编辑角色'))
    fireEvent.click(screen.getByTitle('编辑图片'))

    expect(onEdit).toHaveBeenCalledOnce()
    expect(onImageEdit).toHaveBeenCalledWith('character-1', 'appearance-1', 0)
  })

  it('keeps location data and selected image editing available in selection mode', async () => {
    const { default: LocationCard } = await import('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/assets/LocationCard')
    const onEdit = vi.fn()
    const onImageEdit = vi.fn()

    renderWithIntl(
      createElement(LocationCard, {
        location: {
          id: 'location-1',
          name: '旧港仓库',
          summary: '潮湿昏暗的废弃仓库',
          selectedImageId: 'location-image-1',
          images: [
            {
              id: 'location-image-1',
              imageIndex: 0,
              description: '仓库主视图',
              imageUrl: 'https://example.com/selected.png',
              previousImageUrl: null,
              previousDescription: null,
              isSelected: true,
            },
            {
              id: 'location-image-2',
              imageIndex: 1,
              description: '仓库备选视图',
              imageUrl: 'https://example.com/alternative.png',
              previousImageUrl: null,
              previousDescription: null,
              isSelected: false,
            },
          ],
        },
        onEdit,
        onDelete: vi.fn(),
        onRegenerate: vi.fn(),
        onGenerate: vi.fn(),
        onImageClick: vi.fn(),
        onImageEdit,
        projectId: 'project-1',
        onConfirmSelection: vi.fn(),
      }),
    )

    fireEvent.click(screen.getByTitle('编辑场景'))
    fireEvent.click(screen.getByTitle('编辑图片'))

    expect(onEdit).toHaveBeenCalledOnce()
    expect(onImageEdit).toHaveBeenCalledWith('location-1', 0)
  })
})
