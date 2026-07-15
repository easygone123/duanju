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

function withZh(
  node: React.ReactNode,
  onError?: React.ComponentProps<typeof NextIntlClientProvider>['onError'],
) {
  return <NextIntlClientProvider
    locale="zh"
    messages={{ comfyui: zhComfyui }}
    timeZone="Asia/Shanghai"
    onError={onError}
  >
    {node}
  </NextIntlClientProvider>
}

function withEn(node: React.ReactNode) {
  return <NextIntlClientProvider
    locale="en"
    messages={{ comfyui: enComfyui }}
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
      { name: 'output_17', nodeId: '17', fieldPath: 'images', mediaType: 'image', primary: false },
      { name: 'output_22', nodeId: '22', fieldPath: 'images', mediaType: 'image', primary: false },
    ],
  }
}

function textOutsideDetails(element: HTMLElement) {
  const clone = element.cloneNode(true) as HTMLElement
  clone.querySelectorAll('details').forEach((details) => details.remove())
  return clone.textContent || ''
}

function toggleDetails(details: HTMLDetailsElement) {
  fireEvent.click(details.querySelector('summary') as HTMLElement)
  fireEvent(details, new Event('toggle', { bubbles: true }))
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
  it('uses a safe localized fallback for unknown reason codes in guided and advanced views', () => {
    const unknownReasonCode = 'COMFY_MAPPING_PLUGIN_PRIVATE_REASON'
    const analysis = guidedAnalysis()
    analysis.proposals = analysis.proposals.map((proposal) => proposal.id === 'source-question'
      ? { ...proposal, reasonCode: unknownReasonCode }
      : proposal)
    const review = buildGuidedWorkflowReview('image_edit', analysis, {}, '')
    const strictIntlError = (error: unknown) => { throw error }

    let guidedView: ReturnType<typeof render> | undefined
    expect(() => {
      guidedView = render(withZh(<WorkflowMappingQuestions
        analysis={analysis}
        review={review}
        roles={{}}
        primaryOutputNodeId=""
        onRoleChange={vi.fn()}
        onPrimaryOutputChange={vi.fn()}
      />, strictIntlError))
    }).not.toThrow()
    expect(guidedView?.container.textContent).toContain('无法识别这项映射的技术依据。')
    expect(guidedView?.container.textContent).not.toContain(unknownReasonCode)
    guidedView?.unmount()

    let advancedView: ReturnType<typeof render> | undefined
    expect(() => {
      advancedView = render(withZh(<WorkflowAdvancedMappingInspector
        analysis={analysis}
        roles={{}}
        primaryOutputNodeId=""
        onRoleChange={vi.fn()}
        onPrimaryOutputChange={vi.fn()}
      />, strictIntlError))
    }).not.toThrow()
    const disclosure = advancedView?.getByText('高级设置').closest('details') as HTMLDetailsElement
    expect(() => toggleDetails(disclosure)).not.toThrow()
    expect(disclosure.textContent).toContain('无法识别这项映射的技术依据。')
    expect(disclosure.textContent).not.toContain(unknownReasonCode)
  })

  it('summarizes automatic recognition and preserved workflow defaults without raw identifiers', () => {
    const analysis = guidedAnalysis()
    const review = buildGuidedWorkflowReview('image_edit', analysis, {}, '')
    const view = render(withZh(<WorkflowAnalysisSummary
      review={review}
      outputCount={analysis.outputs.length}
      automaticPrimaryOutputNodeId=""
    />))

    expect(view.getByText('提示词已自动识别')).toBeTruthy()
    expect(view.getByText('已保留 1 项工作流默认值')).toBeTruthy()
    expect(view.container.textContent).not.toContain('prompt-node')
    expect(view.container.textContent).not.toContain('text')
    expect(view.container.textContent).not.toContain('COMFY_MAPPING_PROMPT_POSITIVE_LABEL')
  })

  it('distinguishes unavailable, automatic, manually confirmed, and unresolved output states', () => {
    const base = guidedAnalysis()
    const renderSummary = (
      analysis: WorkflowAutoMappingResult,
      selectedPrimaryOutput = '',
      automaticPrimaryOutputNodeId = '',
    ) => {
      const review = buildGuidedWorkflowReview('image_edit', analysis, {}, selectedPrimaryOutput)
      return render(withZh(<WorkflowAnalysisSummary
        review={review}
        outputCount={analysis.outputs.length}
        automaticPrimaryOutputNodeId={automaticPrimaryOutputNodeId}
      />))
    }

    const unavailable = renderSummary({ ...base, outputs: [] })
    expect(unavailable.getByText('未检测到可用输出')).toBeTruthy()
    unavailable.unmount()

    const analyzerPrimary = { ...base, outputs: base.outputs.map((output, index) => ({
      ...output,
      primary: index === 0,
    })) }
    const automatic = renderSummary(analyzerPrimary, '', '17')
    expect(automatic.getByText('已自动识别最终输出')).toBeTruthy()
    automatic.unmount()

    const manual = renderSummary(base, '22')
    expect(manual.getByText('已确认最终输出')).toBeTruthy()
    expect(manual.container.textContent).not.toContain('22')
    manual.unmount()

    const unresolved = renderSummary(base)
    expect(unresolved.getByText('请选择一个最终输出')).toBeTruthy()
  })

  it('formats multiple missing inputs with locale-aware English list punctuation', () => {
    const analysis = guidedAnalysis()
    const review = buildGuidedWorkflowReview('image_edit', analysis, {}, '')
    review.missingRequiredInputs = ['prompt', 'sourceImage', 'sourceVideo']
    const view = render(withEn(<WorkflowAnalysisSummary
      review={review}
      outputCount={analysis.outputs.length}
      automaticPrimaryOutputNodeId=""
    />))

    expect(view.getByText(
      'Required input still missing: Prompt, Source image, and Source video',
    )).toBeTruthy()
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
    expect(view.getByRole('group', {
      name: '这张图片在工作流中是什么用途？（输入候选 1）',
    })).toBeTruthy()
    expect(view.queryByRole('group', { name: /种子/ })).toBeNull()
    expect(textOutsideDetails(view.container)).not.toContain('image-loader')
    expect(textOutsideDetails(view.container)).not.toContain('image')
    expect(textOutsideDetails(view.container)).not.toContain('ambiguous')
    expect(textOutsideDetails(view.container)).not.toContain('COMFY_MAPPING_IMAGE_ROLE_AMBIGUOUS')

    fireEvent.click(view.getByRole('radio', { name: '源图片' }))
    expect(onRoleChange).toHaveBeenCalledWith('source-question', 'sourceImage')
  })

  it('distinguishes multiple same-kind ambiguity questions with safe ordinal legends', () => {
    const analysis = guidedAnalysis()
    const firstImageQuestion = analysis.proposals.find((proposal) => proposal.id === 'source-question')!
    analysis.proposals = analysis.proposals
      .filter((proposal) => proposal.id !== 'source-question')
      .concat([
        { ...firstImageQuestion, id: 'source-question-17', nodeId: 'image-loader-17', nodeTitle: 'Load Image' },
        { ...firstImageQuestion, id: 'source-question-22', nodeId: 'image-loader-22', nodeTitle: 'Load Image' },
      ])
    const review = buildGuidedWorkflowReview('image_edit', analysis, {}, '')
    const view = render(withZh(<WorkflowMappingQuestions
      analysis={analysis}
      review={review}
      roles={{}}
      primaryOutputNodeId=""
      onRoleChange={vi.fn()}
      onPrimaryOutputChange={vi.fn()}
    />))

    expect(review.questions).toHaveLength(2)
    expect(view.getByRole('group', {
      name: '这张图片在工作流中是什么用途？（输入候选 1）',
    })).toBeTruthy()
    expect(view.getByRole('group', {
      name: '这张图片在工作流中是什么用途？（输入候选 2）',
    })).toBeTruthy()
    const visibleText = textOutsideDetails(view.container)
    expect(visibleText).not.toContain('image-loader-17')
    expect(visibleText).not.toContain('image-loader-22')
    expect(visibleText).not.toContain('ambiguous')
    expect(visibleText).not.toContain('COMFY_MAPPING_IMAGE_ROLE_AMBIGUOUS')
  })

  it('keeps a genuinely user-facing node title in the ordinal candidate descriptor', () => {
    const analysis = guidedAnalysis()
    analysis.proposals = analysis.proposals.map((proposal) => proposal.id === 'source-question'
      ? { ...proposal, nodeTitle: 'Character portrait' }
      : proposal)
    const review = buildGuidedWorkflowReview('image_edit', analysis, {}, '')
    const view = render(withZh(<WorkflowMappingQuestions
      analysis={analysis}
      review={review}
      roles={{}}
      primaryOutputNodeId=""
      onRoleChange={vi.fn()}
      onPrimaryOutputChange={vi.fn()}
    />))

    expect(view.getByRole('group', {
      name: '这张图片在工作流中是什么用途？（Character portrait · 输入候选 1）',
    })).toBeTruthy()
  })

  it('replaces technical output names with friendly ordinal labels outside closed technical details', () => {
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
    expect(view.getByRole('radio', { name: '候选输出 1' })).toBeTruthy()
    expect(view.getByRole('radio', { name: '候选输出 2' })).toBeTruthy()
    expect(textOutsideDetails(view.container)).not.toContain('output_17')
    expect(textOutsideDetails(view.container)).not.toContain('output_22')
    expect(textOutsideDetails(view.container)).not.toContain('17')
    expect(textOutsideDetails(view.container)).not.toContain('22')
    expect(textOutsideDetails(view.container)).not.toContain('images')
    fireEvent.click(view.getByRole('radio', { name: '候选输出 1' }))
    expect(onPrimaryOutputChange).toHaveBeenCalledWith('17')

    const outputDetails = view.getAllByText('技术信息')
      .map((summary) => summary.closest('details'))
      .find((details) => details?.textContent?.includes('output_17')) as HTMLDetailsElement
    expect(outputDetails.open).toBe(false)
    fireEvent.click(outputDetails.querySelector('summary') as HTMLElement)
    expect(outputDetails.open).toBe(true)
    expect(outputDetails.textContent).toContain('output_17')
    expect(outputDetails.textContent).toContain('17')
    expect(outputDetails.textContent).toContain('images')
  })

  it('rejects generic and identifier-like output labels while preserving friendly names', () => {
    const analysis = guidedAnalysis()
    const technicalNames = [
      'output',
      'images',
      'files',
      'results/images',
      'result.image',
      'save_image',
    ]
    analysis.outputs = [...technicalNames, 'Final image'].map((name, index) => ({
      name,
      nodeId: `node-${index + 1}`,
      fieldPath: 'images',
      mediaType: 'image' as const,
      primary: false,
    }))
    const review = buildGuidedWorkflowReview('image_edit', analysis, {}, '')
    const view = render(withEn(<WorkflowMappingQuestions
      analysis={analysis}
      review={review}
      roles={{}}
      primaryOutputNodeId=""
      onRoleChange={vi.fn()}
      onPrimaryOutputChange={vi.fn()}
    />))
    const outputGroup = view.getByRole('group', { name: 'Which output is the final result?' })
    const visibleOutputText = textOutsideDetails(outputGroup)

    technicalNames.forEach((name, index) => {
      expect(view.getByRole('radio', { name: `Output candidate ${index + 1}` })).toBeTruthy()
      expect(view.queryByRole('radio', { name })).toBeNull()
      if (name !== 'output') expect(visibleOutputText).not.toContain(name)
    })
    expect(view.getByRole('radio', { name: 'Final image' })).toBeTruthy()
  })

  it('defers the advanced table until first open and keeps it mounted after closing', () => {
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
    expect(disclosure.textContent).not.toContain('自动输入映射')
    expect(disclosure.querySelector('.overflow-x-auto')).toBeNull()
    toggleDetails(disclosure)
    expect(disclosure.open).toBe(true)
    expect(disclosure.textContent).toContain('自动输入映射')
    expect(disclosure.querySelector('.overflow-x-auto')).toBeTruthy()
    toggleDetails(disclosure)
    expect(disclosure.open).toBe(false)
    expect(disclosure.textContent).toContain('自动输入映射')
  })
})

describe('guided workflow translations', () => {
  const requiredKeys = [
    'typeTitle', 'typeHint', 'jsonInput', 'dropTitle', 'dropHint',
    'chooseFile', 'analyzing', 'name', 'selected', 'summaryTitle',
    'recognizedInputs', 'recognizedInput', 'preservedDefaults', 'recognizedOutput',
    'outputUnavailable', 'outputReady', 'outputConfirmed', 'outputNeedsChoice',
    'outputCandidate', 'outputName', 'missingRequiredInputs', 'questionsTitle',
    'questionCandidate', 'inputCandidate', 'inputCandidateNamed',
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
    expect(Object.keys(zhComfyui.workflows.mappingReasons).sort())
      .toEqual(Object.keys(enComfyui.workflows.mappingReasons).sort())
    expect(zhComfyui.workflows.mappingReasons.unknown).toBeTruthy()
    expect(enComfyui.workflows.mappingReasons.unknown).toBeTruthy()
    expect(Object.keys(zh.types)).toEqual(canonicalKinds)
    expect(Object.keys(en.types)).toEqual(canonicalKinds)
    for (const kind of canonicalKinds) {
      expect(Object.keys(zh.types[kind]).sort()).toEqual(['hint', 'title'])
      expect(Object.keys(en.types[kind]).sort()).toEqual(['hint', 'title'])
    }
  })
})
