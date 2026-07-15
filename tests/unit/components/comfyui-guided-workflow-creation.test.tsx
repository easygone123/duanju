// @vitest-environment jsdom

import React, { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, createEvent, fireEvent, render } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'

import WorkflowJsonDropzone from '@/app/[locale]/profile/components/comfyui/WorkflowJsonDropzone'
import WorkflowTypePicker from '@/app/[locale]/profile/components/comfyui/WorkflowTypePicker'
import type { WorkflowImportKind } from '@/lib/comfyui/workflow-auto-mapping-types'
import enComfyui from '../../../messages/en/comfyui.json'
import zhComfyui from '../../../messages/zh/comfyui.json'

afterEach(cleanup)

function withZh(node: React.ReactNode) {
  return <NextIntlClientProvider
    locale="zh"
    messages={{ comfyui: zhComfyui }}
    timeZone="Asia/Shanghai"
  >
    {node}
  </NextIntlClientProvider>
}

function typePicker(value: WorkflowImportKind | null, onSelect = vi.fn()) {
  return render(withZh(createElement(WorkflowTypePicker, { value, onSelect })))
}

function dropzone(overrides: Partial<React.ComponentProps<typeof WorkflowJsonDropzone>> = {}) {
  return render(withZh(createElement(WorkflowJsonDropzone, {
    name: '初始名称',
    busy: false,
    onFile: vi.fn(),
    onNameChange: vi.fn(),
    ...overrides,
  })))
}

describe('guided ComfyUI workflow type selection', () => {
  it('renders the five supported user-facing workflow kinds', () => {
    const view = typePicker(null)
    const buttons = view.getAllByRole('button')

    expect(buttons).toHaveLength(5)
    expect(buttons.map((button) => button.getAttribute('value'))).toEqual([
      'image_generation',
      'image_edit',
      'image_upscale',
      'video_generation',
      'video_to_video',
    ])
    expect(view.getByText('图片生成')).toBeTruthy()
    expect(view.getByText('图片编辑')).toBeTruthy()
    expect(view.getByText('图片放大')).toBeTruthy()
    expect(view.getByText('视频生成')).toBeTruthy()
    expect(view.getByText('视频转视频')).toBeTruthy()
  })

  it('reports the selected kind and exposes the selected card as pressed', () => {
    const onSelect = vi.fn()
    const view = typePicker('image_edit', onSelect)
    const editButton = view.getByText('图片编辑').closest('button')

    expect(editButton?.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(view.getByText('图片编辑'))
    expect(onSelect).toHaveBeenCalledWith('image_edit')
  })

  it('uses a responsive width-safe card grid', () => {
    const view = typePicker(null)
    const grid = view.getAllByRole('button')[0]?.parentElement
    const section = grid?.parentElement

    expect(section?.className).toContain('min-w-0')
    expect(section?.className).toContain('max-w-4xl')
    expect(grid?.className).toContain('grid-cols-1')
    expect(grid?.className).toContain('sm:grid-cols-2')
    expect(grid?.className).toContain('lg:grid-cols-3')
    expect(`${section?.className} ${grid?.className}`).not.toMatch(/(?:min-)?w-\[\d+px\]/)
  })
})

describe('guided ComfyUI workflow JSON upload', () => {
  it('uses one accessible JSON file input and derives the name through either selection path', () => {
    const onFile = vi.fn()
    const view = dropzone({ onFile })
    const input = view.getByLabelText('工作流 JSON 文件') as HTMLInputElement
    const pickerFile = new File(['{}'], 'portrait.v2.json', { type: 'application/json' })

    expect(view.container.querySelectorAll('input[type="file"]')).toHaveLength(1)
    expect(input.className).toContain('sr-only')
    expect(input.accept).toContain('.json')
    expect(input.accept).toContain('application/json')
    fireEvent.change(input, { target: { files: [pickerFile] } })
    expect(onFile).toHaveBeenLastCalledWith(pickerFile, 'portrait.v2')
    expect(input.value).toBe('')

    const droppedFile = new File(['{}'], 'cinematic.json', { type: 'application/json' })
    const region = view.getByRole('region', { name: '上传工作流 JSON' })
    const dropEvent = createEvent.drop(region, { dataTransfer: { files: [droppedFile] } })
    fireEvent(region, dropEvent)
    expect(dropEvent.defaultPrevented).toBe(true)
    expect(onFile).toHaveBeenLastCalledWith(droppedFile, 'cinematic')
  })

  it('edits the bounded workflow name', () => {
    const onNameChange = vi.fn()
    const view = dropzone({ onNameChange })
    const input = view.getByRole('textbox', { name: '工作流名称' }) as HTMLInputElement

    expect(input.maxLength).toBe(160)
    fireEvent.change(input, { target: { value: '人像精修' } })
    expect(onNameChange).toHaveBeenCalledWith('人像精修')
  })

  it('disables file selection and shows analyzing state while busy', () => {
    const view = dropzone({ busy: true })

    expect((view.getByLabelText('工作流 JSON 文件') as HTMLInputElement).disabled).toBe(true)
    expect((view.getByRole('button', { name: '正在分析…' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('prevents default drag behavior and uses a bounded width-safe layout', () => {
    const view = dropzone()
    const region = view.getByRole('region', { name: '上传工作流 JSON' })
    const dragOverEvent = createEvent.dragOver(region)

    fireEvent(region, dragOverEvent)
    expect(dragOverEvent.defaultPrevented).toBe(true)
    expect(region.className).toContain('w-full')
    expect(region.className).toContain('min-w-0')
    expect(region.className).toContain('max-w-3xl')
    expect(region.className).not.toMatch(/(?:min-)?w-\[\d+px\]/)
  })
})

describe('guided workflow translations', () => {
  const requiredKeys = [
    'typeTitle', 'typeHint', 'jsonInput', 'dropTitle', 'dropHint',
    'chooseFile', 'analyzing', 'name',
  ]
  const kinds: WorkflowImportKind[] = [
    'image_generation', 'image_edit', 'image_upscale', 'video_generation', 'video_to_video',
  ]

  it('keeps the English and Chinese guided message objects structurally identical', () => {
    const zh = zhComfyui.workflows.guided
    const en = enComfyui.workflows.guided

    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    expect(Object.keys(zh).sort()).toEqual([...requiredKeys, 'types'].sort())
    expect(Object.keys(zh.types)).toEqual(kinds)
    expect(Object.keys(en.types)).toEqual(kinds)
    for (const kind of kinds) {
      expect(Object.keys(zh.types[kind]).sort()).toEqual(['hint', 'title'])
      expect(Object.keys(en.types[kind]).sort()).toEqual(['hint', 'title'])
    }
  })
})
