// @vitest-environment jsdom

import React, { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, createEvent, fireEvent, render } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'

import WorkflowJsonDropzone from '@/app/[locale]/profile/components/comfyui/WorkflowJsonDropzone'
import WorkflowTypePicker from '@/app/[locale]/profile/components/comfyui/WorkflowTypePicker'
import WorkflowAdvancedMappingInspector from '@/app/[locale]/profile/components/comfyui/WorkflowAdvancedMappingInspector'
import WorkflowAnalysisSummary from '@/app/[locale]/profile/components/comfyui/WorkflowAnalysisSummary'
import WorkflowMappingQuestions from '@/app/[locale]/profile/components/comfyui/WorkflowMappingQuestions'
import { buildGuidedWorkflowReview } from '@/app/[locale]/profile/components/comfyui/guided-workflow-creation'
import {
  WORKFLOW_IMPORT_KIND_META,
  type WorkflowAutoMappingResult,
  type WorkflowImportKind,
} from '@/lib/comfyui/workflow-auto-mapping-types'
import enComfyui from '../../../messages/en/comfyui.json'
import zhComfyui from '../../../messages/zh/comfyui.json'

afterEach(cleanup)

const canonicalKinds = Object.keys(WORKFLOW_IMPORT_KIND_META) as WorkflowImportKind[]

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

function guidedAnalysis(): WorkflowAutoMappingResult {
  return {
    graph: {},
    mediaType: 'image',
    purpose: 'generation',
    referenceCapacity: 1,
    issues: [],
    proposals: [
      {
        id: 'positive-prompt', canonicalName: 'prompt', nodeId: 'prompt-node',
        inputPath: 'text', valueType: 'string', confidence: 'high', required: true,
        reasonCode: 'COMFY_MAPPING_PROMPT_POSITIVE_LABEL', nodeTitle: 'Positive Prompt',
      },
      {
        id: 'workflow-seed', canonicalName: 'seed', nodeId: 'sampler-node',
        inputPath: 'seed', valueType: 'number', confidence: 'preserve_original', required: false,
        reasonCode: 'COMFY_MAPPING_SEED_INPUT', nodeTitle: 'Sampler',
      },
      {
        id: 'source-question', canonicalName: 'sourceImage', nodeId: 'image-loader',
        inputPath: 'image', valueType: 'image_ref', confidence: 'ambiguous', required: true,
        reasonCode: 'COMFY_MAPPING_IMAGE_ROLE_AMBIGUOUS', nodeTitle: 'Load Image',
      },
    ],
    outputs: [
      { name: '最终图片', nodeId: 'save-final', fieldPath: 'images', mediaType: 'image', primary: false },
      { name: '预览图片', nodeId: 'preview-result', fieldPath: 'images', mediaType: 'image', primary: false },
    ],
  }
}

function textOutsideDetails(element: HTMLElement) {
  const clone = element.cloneNode(true) as HTMLElement
  clone.querySelectorAll('details').forEach((details) => details.remove())
  return clone.textContent || ''
}

describe('guided ComfyUI workflow type selection', () => {
  it('renders the five supported user-facing workflow kinds', () => {
    const view = typePicker(null)
    const buttons = view.getAllByRole('button')

    expect(buttons).toHaveLength(5)
    expect(buttons.map((button) => button.getAttribute('value'))).toEqual(canonicalKinds)
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

  it('shows a localized non-color selected indicator only on the active card', () => {
    const view = typePicker('image_edit')
    const buttons = view.getAllByRole('button')
    const selected = buttons.find((button) => button.getAttribute('aria-pressed') === 'true')

    expect(selected?.textContent).toContain('已选择')
    expect(buttons.filter((button) => button.textContent?.includes('已选择'))).toEqual([selected])
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
    let selectedValue = 'C:\\fakepath\\portrait.v2.json'
    const resetValue = vi.fn((value: string) => { selectedValue = value })
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => selectedValue,
      set: resetValue,
    })
    fireEvent.change(input, { target: { files: [pickerFile] } })
    expect(onFile).toHaveBeenLastCalledWith(pickerFile, 'portrait.v2')
    expect(resetValue).toHaveBeenCalledWith('')
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
    const region = view.getByRole('region', { name: '上传工作流 JSON' })

    expect(region.getAttribute('aria-busy')).toBe('true')
    expect((view.getByLabelText('工作流 JSON 文件') as HTMLInputElement).disabled).toBe(true)
    expect((view.getByRole('button', { name: '正在分析…' }) as HTMLButtonElement).disabled).toBe(true)
    expect(view.getByRole('status').textContent).toBe('正在分析…')
  })

  it('keeps the focused file button and persistent live status stable when processing starts', () => {
    const props = {
      name: '初始名称',
      onFile: vi.fn(),
      onNameChange: vi.fn(),
    }
    const view = render(withZh(createElement(WorkflowJsonDropzone, { ...props, busy: false })))
    const button = view.getByRole('button', { name: '选择 JSON 文件' })
    const status = view.getByRole('status')

    expect(status.textContent).toBe('')
    button.focus()
    expect(document.activeElement).toBe(button)

    view.rerender(withZh(createElement(WorkflowJsonDropzone, { ...props, busy: true })))

    expect(view.getByRole('button', { name: '正在分析…' })).toBe(button)
    expect(document.activeElement).toBe(button)
    expect(view.getByRole('status')).toBe(status)
    expect(status.textContent).toBe('正在分析…')
    const processingRegion = view.getByRole('region', { name: '上传工作流 JSON' })
    expect(processingRegion.getAttribute('aria-busy')).toBe('true')
    expect(processingRegion.contains(status)).toBe(false)
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

describe('guided ComfyUI workflow review', () => {
  it('summarizes automatic recognition and preserved workflow defaults without raw identifiers', () => {
    const analysis = guidedAnalysis()
    const review = buildGuidedWorkflowReview('image_edit', analysis, {}, '')
    const view = render(withZh(<WorkflowAnalysisSummary review={review} />))

    expect(view.getByText('提示词已自动识别')).toBeTruthy()
    expect(view.getByText('已保留 1 项工作流默认值')).toBeTruthy()
    expect(view.container.textContent).not.toContain('prompt-node')
    expect(view.container.textContent).not.toContain('text')
    expect(view.container.textContent).not.toContain('COMFY_MAPPING_PROMPT_POSITIVE_LABEL')
  })

  it('asks only the unresolved required image question and reports canonical role changes', () => {
    const analysis = guidedAnalysis()
    const review = buildGuidedWorkflowReview('image_edit', analysis, {}, '')
    const onRoleChange = vi.fn()
    const view = render(withZh(<WorkflowMappingQuestions
      analysis={analysis}
      review={review}
      roles={{}}
      primaryOutputNodeId=""
      onRoleChange={onRoleChange}
      onPrimaryOutputChange={vi.fn()}
    />))

    expect(review.questions).toHaveLength(1)
    expect(view.container.querySelectorAll('fieldset')).toHaveLength(2)
    expect(view.getByRole('group', { name: '这张图片在工作流中是什么用途？' })).toBeTruthy()
    expect(view.queryByRole('group', { name: /种子/ })).toBeNull()
    expect(textOutsideDetails(view.container)).not.toContain('image-loader')
    expect(textOutsideDetails(view.container)).not.toContain('image')
    expect(textOutsideDetails(view.container)).not.toContain('ambiguous')
    expect(textOutsideDetails(view.container)).not.toContain('COMFY_MAPPING_IMAGE_ROLE_AMBIGUOUS')

    fireEvent.click(view.getByRole('radio', { name: '源图片' }))
    expect(onRoleChange).toHaveBeenCalledWith('source-question', 'sourceImage')
  })

  it('selects a named output while keeping its node and field identifiers in closed technical details', () => {
    const analysis = guidedAnalysis()
    const review = buildGuidedWorkflowReview('image_edit', analysis, {}, '')
    const onPrimaryOutputChange = vi.fn()
    const view = render(withZh(<WorkflowMappingQuestions
      analysis={analysis}
      review={review}
      roles={{}}
      primaryOutputNodeId=""
      onRoleChange={vi.fn()}
      onPrimaryOutputChange={onPrimaryOutputChange}
    />))

    expect(review.needsPrimaryOutput).toBe(true)
    expect(view.getByRole('group', { name: '哪一个输出是最终结果？' })).toBeTruthy()
    expect(textOutsideDetails(view.container)).not.toContain('save-final')
    expect(textOutsideDetails(view.container)).not.toContain('images')
    fireEvent.click(view.getByRole('radio', { name: '最终图片' }))
    expect(onPrimaryOutputChange).toHaveBeenCalledWith('save-final')

    const outputDetails = view.getAllByText('技术信息')
      .map((summary) => summary.closest('details'))
      .find((details) => details?.textContent?.includes('save-final')) as HTMLDetailsElement
    expect(outputDetails.open).toBe(false)
    fireEvent.click(outputDetails.querySelector('summary') as HTMLElement)
    expect(outputDetails.open).toBe(true)
    expect(outputDetails.textContent).toContain('save-final')
    expect(outputDetails.textContent).toContain('images')
  })

  it('keeps the complete mapping table in closed Advanced Settings', () => {
    const analysis = guidedAnalysis()
    const review = buildGuidedWorkflowReview('image_edit', analysis, {}, '')
    const view = render(withZh(<WorkflowAdvancedMappingInspector
      analysis={analysis}
      roles={{}}
      primaryOutputNodeId={review.primaryOutputNodeId}
      onRoleChange={vi.fn()}
      onPrimaryOutputChange={vi.fn()}
    />))

    const disclosure = view.getByText('高级设置').closest('details') as HTMLDetailsElement
    expect(disclosure.open).toBe(false)
    expect(disclosure.className).toContain('glass-surface-soft')
    expect(disclosure.className).toContain('min-w-0')
    expect(disclosure.querySelector('.overflow-x-auto')).toBeTruthy()
    fireEvent.click(disclosure.querySelector('summary') as HTMLElement)
    expect(disclosure.open).toBe(true)
    expect(disclosure.textContent).toContain('自动输入映射')
  })
})

describe('guided workflow translations', () => {
  const requiredKeys = [
    'typeTitle', 'typeHint', 'jsonInput', 'dropTitle', 'dropHint',
    'chooseFile', 'analyzing', 'name', 'selected', 'summaryTitle',
    'recognizedInputs', 'recognizedInput', 'preservedDefaults', 'recognizedOutput',
    'outputReady', 'outputNeedsChoice', 'missingRequiredInputs', 'questionsTitle',
    'sourceRoleQuestion', 'promptRoleQuestion', 'inputRoleQuestion', 'outputQuestion',
    'technicalDetails', 'nodeTitle', 'nodeId', 'inputPath', 'outputFieldPath',
    'confidence', 'reason', 'advancedSettings', 'issues',
  ]

  it('keeps the English and Chinese guided message objects structurally identical', () => {
    const zh = zhComfyui.workflows.guided
    const en = enComfyui.workflows.guided

    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    expect(Object.keys(zh).sort()).toEqual([...requiredKeys, 'types'].sort())
    expect(Object.keys(zh.issues).sort()).toEqual(Object.keys(en.issues).sort())
    expect(Object.keys(zh.issues).sort()).toEqual([
      'COMFY_WORKFLOW_API_FORMAT_REQUIRED', 'COMFY_WORKFLOW_API_FORMAT_INVALID',
      'COMFY_WORKFLOW_OUTPUT_REQUIRED', 'COMFY_WORKFLOW_OUTPUT_AMBIGUOUS', 'unknown',
    ].sort())
    expect(Object.keys(zh.types)).toEqual(canonicalKinds)
    expect(Object.keys(en.types)).toEqual(canonicalKinds)
    for (const kind of canonicalKinds) {
      expect(Object.keys(zh.types[kind]).sort()).toEqual(['hint', 'title'])
      expect(Object.keys(en.types[kind]).sort()).toEqual(['hint', 'title'])
    }
  })
})
