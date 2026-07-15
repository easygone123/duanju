# Guided ComfyUI Workflow Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the overflowing, variable-first ComfyUI workflow creation UI with a full-width three-stage wizard that asks users only for required ambiguous mappings.

**Architecture:** Keep the deterministic analyzer and persisted workflow contract. Add a pure guided-review layer over `WorkflowAutoMappingResult`, render it through small wizard components, and lift creation mode into `ComfyUiSettings` so connection and library panels are hidden while creating. Saved workflows retain their advanced editor, test, publish, and compatibility flows.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, next-intl, Tailwind CSS, Vitest, Testing Library, existing ComfyUI workflow APIs.

---

## File Map

### Create

- `src/app/[locale]/profile/components/comfyui/guided-workflow-creation.ts`: pure naming, review bucketing, role compatibility, readiness, and request-generation helpers.
- `src/app/[locale]/profile/components/comfyui/WorkflowTypePicker.tsx`: five workflow-type cards.
- `src/app/[locale]/profile/components/comfyui/WorkflowJsonDropzone.tsx`: drag/drop, file picker, and editable filename-derived name.
- `src/app/[locale]/profile/components/comfyui/WorkflowAnalysisSummary.tsx`: capability summary without node fields.
- `src/app/[locale]/profile/components/comfyui/WorkflowMappingQuestions.tsx`: required ambiguity and primary-output questions only.
- `src/app/[locale]/profile/components/comfyui/WorkflowAdvancedMappingInspector.tsx`: collapsed technical mapping inspector.
- `src/app/[locale]/profile/components/comfyui/WorkflowCreationWizard.tsx`: three-stage creation state machine.
- `src/app/[locale]/profile/components/comfyui/workflow-requests.ts`: bounded authenticated analyze/create requests.
- `tests/unit/comfyui/guided-workflow-creation.test.ts`: pure model tests.
- `tests/unit/components/comfyui-guided-workflow-creation.test.tsx`: picker, upload, and review component tests.
- `tests/unit/components/comfyui-workflow-creation-wizard.test.tsx`: wizard state and interaction tests.

### Modify

- `src/app/[locale]/profile/components/comfyui/workflow-ui.ts`: preserve unresolved optional ambiguity.
- `src/app/[locale]/profile/components/comfyui/WorkflowAutoMappingTable.tsx`: reuse compatible-role helper and safe wrapping.
- `src/app/[locale]/profile/components/comfyui/WorkflowEditor.tsx`: saved-workflow advanced editor only.
- `src/app/[locale]/profile/components/comfyui/WorkflowLibraryPanel.tsx`: delegate creation and reselect newly created workflow.
- `src/app/[locale]/profile/components/comfyui/ComfyUiSettings.tsx`: overview/full-width-wizard mode switch.
- `messages/zh/comfyui.json` and `messages/en/comfyui.json`: guided UI copy.
- `tests/unit/components/comfyui-workflow-settings.test.ts`: confirmation, separation, and overflow contracts.

### Delete

- `src/app/[locale]/profile/components/comfyui/WorkflowUploadStep.tsx`: replaced by the full-width upload stage.

---

### Task 1: Define the Guided Review Contract

**Files:**
- Create: `src/app/[locale]/profile/components/comfyui/guided-workflow-creation.ts`
- Modify: `src/app/[locale]/profile/components/comfyui/workflow-ui.ts:153-218`
- Test: `tests/unit/comfyui/guided-workflow-creation.test.ts`
- Test: `tests/unit/components/comfyui-workflow-settings.test.ts`

- [ ] **Step 1: Write failing pure-model tests**

Create `tests/unit/comfyui/guided-workflow-creation.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { WorkflowAutoMappingResult } from '@/lib/comfyui/workflow-auto-mapping-types'
import {
  buildGuidedWorkflowReview,
  createWorkflowAnalysisCoordinator,
  deriveWorkflowName,
  guidedCompatibleRoles,
  isGuidedWorkflowReady,
} from '@/app/[locale]/profile/components/comfyui/guided-workflow-creation'

const analysis = (patch: Partial<WorkflowAutoMappingResult> = {}): WorkflowAutoMappingResult => ({
  graph: { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'portrait' } } },
  mediaType: 'image', purpose: 'generation', referenceCapacity: 0, issues: [],
  proposals: [
    { id: 'prompt', canonicalName: 'prompt', nodeId: '1', inputPath: 'text', valueType: 'string', confidence: 'high', reasonCode: 'COMFY_MAPPING_PROMPT_POSITIVE_LABEL', required: true, nodeTitle: 'Positive prompt' },
    { id: 'seed', canonicalName: 'seed', nodeId: '2', inputPath: 'seed', valueType: 'number', confidence: 'preserve_original', reasonCode: 'COMFY_MAPPING_SEED_INPUT', required: false, nodeTitle: 'Sampler' },
  ],
  outputs: [{ name: 'image', nodeId: '9', fieldPath: 'images', mediaType: 'image', primary: true }],
  ...patch,
})

describe('guided ComfyUI workflow creation model', () => {
  it('derives a name from only the final json suffix', () => {
    expect(deriveWorkflowName('portrait.v2.json')).toBe('portrait.v2')
    expect(deriveWorkflowName('  demo.JSON  ')).toBe('demo')
  })

  it('summarizes resolved capabilities and preserved optional values', () => {
    expect(buildGuidedWorkflowReview('image_generation', analysis(), {}, '')).toMatchObject({
      resolvedInputs: ['prompt'], preservedCount: 1, questions: [],
      primaryOutputNodeId: '9', missingRequiredInputs: [], blockingIssueCodes: [],
    })
  })

  it('asks only for required ambiguity', () => {
    const review = buildGuidedWorkflowReview('image_edit', analysis({ proposals: [
      { id: 'required', canonicalName: 'sourceImage', nodeId: '3', inputPath: 'image', valueType: 'image_ref', confidence: 'ambiguous', reasonCode: 'COMFY_MAPPING_IMAGE_ROLE_AMBIGUOUS', required: true },
      { id: 'optional', canonicalName: 'referenceImages', nodeId: '4', inputPath: 'image', valueType: 'image_ref', confidence: 'ambiguous', reasonCode: 'COMFY_MAPPING_IMAGE_ROLE_AMBIGUOUS', required: false },
    ] }), {}, '')
    expect(review.questions.map((item) => item.id)).toEqual(['required'])
    expect(review.preservedCount).toBe(1)
  })

  it('requires one output choice when several outputs have no primary', () => {
    const review = buildGuidedWorkflowReview('image_generation', analysis({ outputs: [
      { name: 'preview', nodeId: '8', fieldPath: 'images', mediaType: 'image', primary: false },
      { name: 'save', nodeId: '9', fieldPath: 'images', mediaType: 'image', primary: false },
    ] }), {}, '')
    expect(review.needsPrimaryOutput).toBe(true)
    expect(isGuidedWorkflowReady({ name: 'demo', review, busy: false })).toBe(false)
  })

  it('offers only value-type-compatible roles', () => {
    expect(guidedCompatibleRoles({
      id: 'image', canonicalName: 'sourceImage', nodeId: '3', inputPath: 'image', valueType: 'image_ref', confidence: 'ambiguous', reasonCode: 'x', required: true,
    })).toEqual(['sourceImage', 'referenceImages', 'firstFrame', 'lastFrame'])
  })

  it('blocks creation when the selected type has no required source input', () => {
    const review = buildGuidedWorkflowReview('image_edit', analysis(), {}, '')
    expect(review.missingRequiredInputs).toEqual(['sourceImage'])
    expect(isGuidedWorkflowReady({ name: 'demo', review, busy: false })).toBe(false)
  })

  it('lets only the latest async analysis commit', () => {
    const controller = createWorkflowAnalysisCoordinator()
    const first = controller.begin()
    const second = controller.begin()
    expect(controller.isCurrent(first)).toBe(false)
    expect(controller.isCurrent(second)).toBe(true)
    controller.dispose()
    expect(controller.isCurrent(second)).toBe(false)
  })
})
```

- [ ] **Step 2: Add a failing optional-ambiguity confirmation test**

Extend `tests/unit/components/comfyui-workflow-settings.test.ts`:

```ts
it('preserves unresolved optional ambiguity but blocks required ambiguity', () => {
  const base = {
    graph: { '9': { class_type: 'SaveImage', inputs: {} } },
    mediaType: 'image' as const, purpose: 'generation' as const,
    outputs: [{ name: 'output', nodeId: '9', fieldPath: 'images', mediaType: 'image' as const, primary: true }],
    issues: [], referenceCapacity: 1,
  }
  const optional = confirmWorkflowAnalysis({ ...base, proposals: [{
    id: 'optional', canonicalName: 'referenceImages' as const, nodeId: '2', inputPath: 'image', valueType: 'image_ref' as const,
    confidence: 'ambiguous' as const, reasonCode: 'COMFY_MAPPING_IMAGE_ROLE_AMBIGUOUS', required: false,
  }] }, { roles: {} })
  expect(optional.variableDefinitions).toEqual([])
  expect(optional.bindings).toEqual([])

  expect(() => confirmWorkflowAnalysis({ ...base, proposals: [{
    id: 'required', canonicalName: 'sourceImage' as const, nodeId: '2', inputPath: 'image', valueType: 'image_ref' as const,
    confidence: 'ambiguous' as const, reasonCode: 'COMFY_MAPPING_IMAGE_ROLE_AMBIGUOUS', required: true,
  }] }, { roles: {} })).toThrow('workflowMappingConfirmationRequired')
})
```

- [ ] **Step 3: Run focused tests and confirm RED**

Run:

```bash
npx vitest run tests/unit/comfyui/guided-workflow-creation.test.ts tests/unit/components/comfyui-workflow-settings.test.ts
```

Expected: FAIL because the guided module does not exist and current confirmation requires every ambiguous mapping.

- [ ] **Step 4: Implement the pure contract**

Create `guided-workflow-creation.ts`:

```ts
import {
  WORKFLOW_IMPORT_KIND_META,
  type CanonicalWorkflowInput,
  type WorkflowAutoMappingResult,
  type WorkflowImportKind,
  type WorkflowMappingProposal,
} from '@/lib/comfyui/workflow-auto-mapping-types'

export interface GuidedWorkflowReview {
  resolvedInputs: CanonicalWorkflowInput[]
  preservedCount: number
  questions: WorkflowMappingProposal[]
  primaryOutputNodeId: string
  needsPrimaryOutput: boolean
  missingRequiredInputs: CanonicalWorkflowInput[]
  blockingIssueCodes: string[]
}

export const deriveWorkflowName = (filename: string) => filename.trim().replace(/\.json$/i, '').trim()

export function guidedCompatibleRoles(proposal: WorkflowMappingProposal): CanonicalWorkflowInput[] {
  if (proposal.valueType === 'video_ref') return ['sourceVideo']
  if (proposal.valueType === 'image_ref' || proposal.valueType === 'image_ref_list') return ['sourceImage', 'referenceImages', 'firstFrame', 'lastFrame']
  if (proposal.canonicalName === 'prompt' || proposal.canonicalName === 'negativePrompt') return ['prompt', 'negativePrompt']
  return [proposal.canonicalName]
}

export function buildGuidedWorkflowReview(
  kind: WorkflowImportKind,
  analysis: WorkflowAutoMappingResult,
  roles: Record<string, CanonicalWorkflowInput | 'preserve_original'>,
  selectedPrimaryOutput: string,
): GuidedWorkflowReview {
  const questions = analysis.proposals.filter((proposal) => proposal.required && proposal.confidence === 'ambiguous' && !roles[proposal.id])
  const resolvedInputs = [...new Set(analysis.proposals
    .filter((proposal) => proposal.confidence === 'high' || Boolean(roles[proposal.id] && roles[proposal.id] !== 'preserve_original'))
    .map((proposal) => roles[proposal.id] || proposal.canonicalName)
    .filter((value): value is CanonicalWorkflowInput => value !== 'preserve_original'))]
  const automaticPrimary = analysis.outputs.find((output) => output.primary)?.nodeId || (analysis.outputs.length === 1 ? analysis.outputs[0]?.nodeId : '')
  const primaryOutputNodeId = selectedPrimaryOutput || automaticPrimary || ''
  const mappedInputs = new Set<CanonicalWorkflowInput>([
    ...resolvedInputs,
    ...analysis.proposals.filter((proposal) => proposal.required).map((proposal) => proposal.canonicalName),
  ])
  const missingRequiredInputs = WORKFLOW_IMPORT_KIND_META[kind].requiredInputs
    .filter((name) => !mappedInputs.has(name))
  return {
    resolvedInputs,
    preservedCount: analysis.proposals.filter((proposal) => !proposal.required && (!roles[proposal.id] || roles[proposal.id] === 'preserve_original')).length,
    questions,
    primaryOutputNodeId,
    needsPrimaryOutput: analysis.outputs.length > 1 && !primaryOutputNodeId,
    missingRequiredInputs,
    blockingIssueCodes: analysis.issues
      .filter((issue) => issue.code !== 'COMFY_WORKFLOW_OUTPUT_AMBIGUOUS')
      .map((issue) => issue.code),
  }
}

export function isGuidedWorkflowReady(input: { name: string; review: GuidedWorkflowReview; busy: boolean }) {
  return Boolean(input.name.trim()) && !input.busy && input.review.questions.length === 0
    && !input.review.needsPrimaryOutput && input.review.missingRequiredInputs.length === 0
    && input.review.blockingIssueCodes.length === 0
}

export function createWorkflowAnalysisCoordinator() {
  let generation = 0
  let disposed = false
  return {
    begin: () => ({ generation: ++generation }),
    isCurrent: (ticket: { generation: number }) => !disposed && ticket.generation === generation,
    dispose: () => { disposed = true; generation += 1 },
  }
}
```

- [ ] **Step 5: Preserve only unresolved optional ambiguity**

In `confirmWorkflowAnalysis`, use:

```ts
const selectedRole = confirmation.roles[proposal.id]
if (proposal.confidence === 'ambiguous' && proposal.required && !selectedRole) {
  throw new Error('workflowMappingConfirmationRequired')
}
const canonicalName = selectedRole
  || (proposal.confidence === 'ambiguous' || proposal.confidence === 'preserve_original'
    ? 'preserve_original'
    : proposal.canonicalName)
if (canonicalName === 'preserve_original') continue
```

Do not change high-confidence bindings, reference ordering, or output selection.

- [ ] **Step 6: Verify and commit**

Run:

```bash
npx vitest run tests/unit/comfyui/guided-workflow-creation.test.ts tests/unit/components/comfyui-workflow-settings.test.ts
npx eslint src/app/'[locale]'/profile/components/comfyui/guided-workflow-creation.ts src/app/'[locale]'/profile/components/comfyui/workflow-ui.ts tests/unit/comfyui/guided-workflow-creation.test.ts
npm run typecheck
git add src/app/'[locale]'/profile/components/comfyui/guided-workflow-creation.ts src/app/'[locale]'/profile/components/comfyui/workflow-ui.ts tests/unit/comfyui/guided-workflow-creation.test.ts tests/unit/components/comfyui-workflow-settings.test.ts
git commit -m "feat: define guided workflow review model"
```

Expected: tests PASS, lint has 0 errors, typecheck exits 0, commit succeeds.

---

### Task 2: Build Type Selection and JSON Upload

**Files:**
- Create: `src/app/[locale]/profile/components/comfyui/WorkflowTypePicker.tsx`
- Create: `src/app/[locale]/profile/components/comfyui/WorkflowJsonDropzone.tsx`
- Create: `tests/unit/components/comfyui-guided-workflow-creation.test.tsx`
- Modify: `messages/zh/comfyui.json`
- Modify: `messages/en/comfyui.json`

- [ ] **Step 1: Write failing component tests**

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { describe, expect, it, vi } from 'vitest'
import WorkflowTypePicker from '@/app/[locale]/profile/components/comfyui/WorkflowTypePicker'
import WorkflowJsonDropzone from '@/app/[locale]/profile/components/comfyui/WorkflowJsonDropzone'
import zh from '../../../messages/zh/comfyui.json'

const renderIntl = (node: React.ReactNode) => render(
  <NextIntlClientProvider locale="zh" messages={{ comfyui: zh }}>{node}</NextIntlClientProvider>,
)

describe('guided workflow creation components', () => {
  it('offers exactly five user-facing types', () => {
    const onSelect = vi.fn()
    renderIntl(<WorkflowTypePicker value={null} onSelect={onSelect} />)
    expect(screen.getAllByRole('button')).toHaveLength(5)
    fireEvent.click(screen.getByRole('button', { name: /图片编辑/ }))
    expect(onSelect).toHaveBeenCalledWith('image_edit')
  })

  it('shares one handler for file selection and drop', () => {
    const onFile = vi.fn()
    renderIntl(<WorkflowJsonDropzone busy={false} name="" onNameChange={vi.fn()} onFile={onFile} />)
    const file = new File(['{}'], 'portrait.v2.json', { type: 'application/json' })
    fireEvent.change(screen.getByLabelText(/JSON/), { target: { files: [file] } })
    expect(onFile).toHaveBeenCalledWith(file, 'portrait.v2')
    fireEvent.drop(screen.getByTestId('workflow-json-dropzone'), { dataTransfer: { files: [file] } })
    expect(onFile).toHaveBeenCalledTimes(2)
  })

  it('keeps the derived name editable', () => {
    const onNameChange = vi.fn()
    renderIntl(<WorkflowJsonDropzone busy={false} name="portrait" onNameChange={onNameChange} onFile={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox', { name: /工作流名称/ }), { target: { value: '商业人像' } })
    expect(onNameChange).toHaveBeenCalledWith('商业人像')
  })
})
```

- [ ] **Step 2: Run and confirm RED**

```bash
npx vitest run tests/unit/components/comfyui-guided-workflow-creation.test.tsx
```

Expected: FAIL because both components do not exist.

- [ ] **Step 3: Implement `WorkflowTypePicker`**

```tsx
'use client'
import { useTranslations } from 'next-intl'
import type { WorkflowImportKind } from '@/lib/comfyui/workflow-auto-mapping-types'

const KINDS: WorkflowImportKind[] = ['image_generation', 'image_edit', 'image_upscale', 'video_generation', 'video_to_video']

export default function WorkflowTypePicker(props: { value: WorkflowImportKind | null; onSelect(value: WorkflowImportKind): void }) {
  const t = useTranslations('comfyui.workflows.guided')
  return <section className="mx-auto w-full max-w-4xl min-w-0 space-y-4">
    <div><h2 className="text-xl font-semibold">{t('typeTitle')}</h2><p className="text-sm text-[var(--glass-text-secondary)]">{t('typeHint')}</p></div>
    <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {KINDS.map((kind) => <button key={kind} type="button" aria-pressed={props.value === kind} onClick={() => props.onSelect(kind)} className="glass-surface-soft min-w-0 rounded-xl p-4 text-left">
        <span className="block font-medium">{t(`types.${kind}.title`)}</span>
        <span className="mt-1 block text-xs text-[var(--glass-text-secondary)]">{t(`types.${kind}.hint`)}</span>
      </button>)}
    </div>
  </section>
}
```

- [ ] **Step 4: Implement `WorkflowJsonDropzone`**

```tsx
'use client'
import { useRef } from 'react'
import { useTranslations } from 'next-intl'
import { deriveWorkflowName } from './guided-workflow-creation'

export default function WorkflowJsonDropzone(props: { busy: boolean; name: string; onNameChange(value: string): void; onFile(file: File, derivedName: string): void }) {
  const t = useTranslations('comfyui.workflows.guided')
  const inputRef = useRef<HTMLInputElement>(null)
  const select = (file?: File) => { if (file) props.onFile(file, deriveWorkflowName(file.name)) }
  return <section className="mx-auto w-full max-w-3xl min-w-0 space-y-4">
    <div data-testid="workflow-json-dropzone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); select(event.dataTransfer.files[0]) }} className="glass-surface-soft min-w-0 rounded-2xl border border-dashed p-8 text-center sm:p-12">
      <input ref={inputRef} type="file" accept="application/json,.json" className="sr-only" aria-label={t('jsonInput')} disabled={props.busy} onChange={(event) => { select(event.target.files?.[0]); event.target.value = '' }} />
      <p className="font-medium">{t('dropTitle')}</p><p className="mt-2 text-sm text-[var(--glass-text-secondary)]">{t('dropHint')}</p>
      <button type="button" disabled={props.busy} onClick={() => inputRef.current?.click()} className="glass-btn-base glass-btn-tone-info mt-4 px-4 py-2 text-sm disabled:opacity-50">{props.busy ? t('analyzing') : t('chooseFile')}</button>
    </div>
    <label className="block min-w-0 text-sm">{t('name')}<input value={props.name} maxLength={160} onChange={(event) => props.onNameChange(event.target.value)} className="mt-1 w-full min-w-0 rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-3 py-2" /></label>
  </section>
}
```

- [ ] **Step 5: Add translation keys**

Add identical `guided` object shapes in zh/en with `typeTitle`, `typeHint`,
`jsonInput`, `dropTitle`, `dropHint`, `chooseFile`, `analyzing`, `name`, and all
five `types.<kind>.title` plus `types.<kind>.hint` keys.

- [ ] **Step 6: Verify and commit**

```bash
npx vitest run tests/unit/components/comfyui-guided-workflow-creation.test.tsx
npx eslint src/app/'[locale]'/profile/components/comfyui/WorkflowTypePicker.tsx src/app/'[locale]'/profile/components/comfyui/WorkflowJsonDropzone.tsx tests/unit/components/comfyui-guided-workflow-creation.test.tsx
npm run typecheck
git add src/app/'[locale]'/profile/components/comfyui/WorkflowTypePicker.tsx src/app/'[locale]'/profile/components/comfyui/WorkflowJsonDropzone.tsx tests/unit/components/comfyui-guided-workflow-creation.test.tsx messages/zh/comfyui.json messages/en/comfyui.json
git commit -m "feat: add guided workflow type and upload steps"
```

Expected: test PASS, lint has 0 errors, typecheck exits 0, commit succeeds.

## Task 3: Replace the Mapping Table With a Guided Review

**Files:**
- Create: `src/app/[locale]/profile/components/comfyui/WorkflowAnalysisSummary.tsx`
- Create: `src/app/[locale]/profile/components/comfyui/WorkflowMappingQuestions.tsx`
- Create: `src/app/[locale]/profile/components/comfyui/WorkflowAdvancedMappingInspector.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowAutoMappingTable.tsx`
- Modify: `messages/zh/comfyui.json`
- Modify: `messages/en/comfyui.json`
- Modify: `tests/unit/components/comfyui-guided-workflow-creation.test.tsx`

- [ ] **Step 1: Add failing review-component tests**

Extend the component test with one analyzed workflow containing a high-confidence
prompt, an optional seed, one ambiguous required image, and two output nodes.
Assert that:

```tsx
expect(screen.getByText(/已自动识别.*提示词/)).toBeInTheDocument()
expect(screen.getByText(/保留工作流默认值.*1/)).toBeInTheDocument()
expect(screen.getByRole('group', { name: /哪一个输入用来上传参考图/ })).toBeInTheDocument()
expect(screen.queryByText('node-17')).not.toBeInTheDocument()
expect(screen.getByText(/高级设置/).closest('details')).not.toHaveAttribute('open')
```

Also select a role and an output radio, then assert the callbacks receive the
proposal ID and output node ID.

- [ ] **Step 2: Run and confirm RED**

```bash
npx vitest run tests/unit/components/comfyui-guided-workflow-creation.test.tsx
```

Expected: FAIL because the three review components do not exist.

- [ ] **Step 3: Implement the summary using only the guided review contract**

`WorkflowAnalysisSummary` accepts `review: GuidedWorkflowReview`. Render cards
for recognized required inputs, the count of optional defaults that will be
preserved, detected outputs, missing required inputs, and localized blocking
issues. Resolve canonical
input labels through the existing `canonicalInputs` messages. Do not expose node
IDs or input paths in the default summary.

- [ ] **Step 4: Implement one-question-at-a-time mapping questions**

`WorkflowMappingQuestions` accepts the review, selected roles, selected output,
and change callbacks. Render only `review.questions`; use
`guidedCompatibleRoles(question.proposal)` for radio choices. Use one
`fieldset`/`legend` per question, and put node ID, input path, confidence, and
reason code inside a collapsed technical-details element. If output selection is
required, render the output candidates as a separate radio group.

- [ ] **Step 5: Put the existing mapping table behind Advanced Settings**

```tsx
export default function WorkflowAdvancedMappingInspector(props: WorkflowAdvancedMappingInspectorProps) {
  const t = useTranslations('comfyui.workflows.guided')
  return <details className="glass-surface-soft min-w-0 rounded-xl p-4">
    <summary className="cursor-pointer font-medium">{t('advancedSettings')}</summary>
    <div className="mt-4 min-w-0 overflow-x-auto">
      <WorkflowAutoMappingTable {...props} />
    </div>
  </details>
}
```

Update `WorkflowAutoMappingTable` to import `guidedCompatibleRoles` rather than
maintaining a second compatibility list. Preserve all existing advanced mapping
behavior.

- [ ] **Step 6: Add localized review text and analyzer guidance**

Add matching zh/en keys for recognized inputs, preserved defaults, outputs,
questions, technical details, primary output selection, Advanced Settings, and
the three analyzer issue codes:
`COMFY_WORKFLOW_API_FORMAT_REQUIRED`, `COMFY_WORKFLOW_API_FORMAT_INVALID`, and
`COMFY_WORKFLOW_OUTPUT_REQUIRED`.

- [ ] **Step 7: Verify and commit**

```bash
npx vitest run tests/unit/components/comfyui-guided-workflow-creation.test.tsx tests/unit/comfyui/workflow-auto-mapper.test.ts
npx eslint src/app/'[locale]'/profile/components/comfyui/WorkflowAnalysisSummary.tsx src/app/'[locale]'/profile/components/comfyui/WorkflowMappingQuestions.tsx src/app/'[locale]'/profile/components/comfyui/WorkflowAdvancedMappingInspector.tsx src/app/'[locale]'/profile/components/comfyui/WorkflowAutoMappingTable.tsx tests/unit/components/comfyui-guided-workflow-creation.test.tsx
npm run typecheck
git add src/app/'[locale]'/profile/components/comfyui/WorkflowAnalysisSummary.tsx src/app/'[locale]'/profile/components/comfyui/WorkflowMappingQuestions.tsx src/app/'[locale]'/profile/components/comfyui/WorkflowAdvancedMappingInspector.tsx src/app/'[locale]'/profile/components/comfyui/WorkflowAutoMappingTable.tsx tests/unit/components/comfyui-guided-workflow-creation.test.tsx messages/zh/comfyui.json messages/en/comfyui.json
git commit -m "feat: simplify workflow mapping review"
```

Expected: focused tests PASS, lint has 0 errors, typecheck exits 0.

## Task 4: Build the Race-Safe Three-Step Creation Wizard

**Files:**
- Create: `src/app/[locale]/profile/components/comfyui/workflow-requests.ts`
- Create: `src/app/[locale]/profile/components/comfyui/WorkflowCreationWizard.tsx`
- Create: `tests/unit/components/comfyui-workflow-creation-wizard.test.tsx`
- Modify: `messages/zh/comfyui.json`
- Modify: `messages/en/comfyui.json`

- [ ] **Step 1: Add failing wizard interaction tests**

Mock `workflow-requests.ts` and cover these deterministic cases:

1. Select a type, upload JSON, review, and create; assert the draft passed to
   the injected `onCreate`
   `WorkflowAuthorDraft` contains the selected type, derived editable name,
   analyzed graph, confirmed mappings, and selected output, then calls
   `onCreated(id)`.
2. Upload A, then upload B before A resolves; resolve B first and A second;
   assert only B is rendered and all answers from A were cleared immediately.
3. Keep Create disabled until every required ambiguity and output choice is
   answered.
4. Reject creation and assert the selected type and proposed workflow name remain
   available for retry.

Use deferred promises controlled by the test; do not use timers or sleeps.

- [ ] **Step 2: Run and confirm RED**

```bash
npx vitest run tests/unit/components/comfyui-workflow-creation-wizard.test.tsx
```

Expected: FAIL because the wizard and request helper do not exist.

- [ ] **Step 3: Extract typed request helpers**

Implement `analyzeWorkflowJson(kind, file)` using existing
`readWorkflowImportFile`, `parseWorkflowImportText`, and
the authenticated `apiFetch` client for `POST /api/comfyui/workflows/analyze`.
Implement `createWorkflowDraft(draft)`
using `workflowPayload` and `POST /api/comfyui/workflows`. Parse JSON only after
checking the response content type, and convert non-success payloads to the
existing safe `WorkflowRequestError` shape so raw server bodies are never shown.
The wizard receives creation as an injected async callback; the settings shell
uses `createWorkflowDraft` when it integrates the wizard in Task 5.

- [ ] **Step 4: Implement the wizard state machine**

Maintain `stage`, `kind`, `name`, `sourceText`, `analysis`, `roles`,
`selectedOutput`, `busy`, and `error`. Use
`createWorkflowAnalysisCoordinator()` for analysis tickets. When a new file is
chosen, clear the prior result, answers, and error before awaiting; commit the
result only when its ticket is current; dispose the coordinator on unmount.

On Create, call `confirmWorkflowAnalysis`, construct the existing
`WorkflowAuthorDraft`, call `props.onCreate(draft)`, then call
`props.onCreated(id)`. Keep the selected type and editable name after request
errors. This keeps creation submission outside the wizard while making the
state machine independently testable.

Use this containment structure so no page-wide horizontal scroll can occur:

```tsx
<main className="h-full min-h-0 min-w-0 overflow-hidden">
  <div className="h-full min-w-0 overflow-y-auto overflow-x-hidden">
    <div className="mx-auto w-full max-w-[60rem] min-w-0 px-4 py-6 sm:px-6">
      {/* step indicator and active step */}
    </div>
  </div>
</main>
```

Render only the active step. On review, compose `WorkflowAnalysisSummary`,
`WorkflowMappingQuestions`, and `WorkflowAdvancedMappingInspector`; keep Back,
Cancel, Retry, and Create actions in a consistent footer.

- [ ] **Step 5: Add wizard translations**

Add matching zh/en keys for the three steps, Back, Cancel, Retry, Create,
analysis and creation statuses, actionable request errors, and completion text.

- [ ] **Step 6: Verify and commit**

```bash
npx vitest run tests/unit/components/comfyui-workflow-creation-wizard.test.tsx tests/unit/components/comfyui-guided-workflow-creation.test.tsx
npx eslint src/app/'[locale]'/profile/components/comfyui/WorkflowCreationWizard.tsx src/app/'[locale]'/profile/components/comfyui/workflow-requests.ts tests/unit/components/comfyui-workflow-creation-wizard.test.tsx
npm run typecheck
git add src/app/'[locale]'/profile/components/comfyui/WorkflowCreationWizard.tsx src/app/'[locale]'/profile/components/comfyui/workflow-requests.ts tests/unit/components/comfyui-workflow-creation-wizard.test.tsx messages/zh/comfyui.json messages/en/comfyui.json
git commit -m "feat: add guided workflow creation wizard"
```

Expected: focused tests PASS, lint has 0 errors, typecheck exits 0.

## Task 5: Open Creation Full Width and Remove the Embedded Creator

**Files:**
- Modify: `src/app/[locale]/profile/components/comfyui/ComfyUiSettings.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowLibraryPanel.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowEditor.tsx`
- Delete: `src/app/[locale]/profile/components/comfyui/WorkflowUploadStep.tsx`
- Modify: `tests/unit/components/comfyui-workflow-settings.test.ts`
- Modify: `tests/unit/components/comfyui-workflow-creation-wizard.test.tsx`

- [ ] **Step 1: Add failing integration and source-boundary tests**

Add a rendered settings-shell test: click New Workflow, assert the connection
pool and workflow library are absent and the full-width wizard is present; click
Cancel and assert the overview is restored. Add source assertions that the
library calls `onCreateNew`, the saved editor no longer imports
`WorkflowUploadStep` or defines `WorkflowEditorStage`, and its existing
`WorkflowMappingTable` remains.

- [ ] **Step 2: Run and confirm RED**

```bash
npx vitest run tests/unit/components/comfyui-workflow-settings.test.ts tests/unit/components/comfyui-workflow-creation-wizard.test.tsx
```

Expected: FAIL because creation is still embedded in the library/editor.

- [ ] **Step 3: Switch `ComfyUiSettings` between overview and creation modes**

Add `creating` and `selectedWorkflowId` state. While creating, render only
`WorkflowCreationWizard` in the full available width. Cancel returns to the
overview. Successful creation stores the returned ID, exits creation mode, and
passes it to the library as `initialWorkflowId`. Supply `createWorkflowDraft`
as the wizard's `onCreate` callback.

- [ ] **Step 4: Make the library responsible only for saved workflows**

Change props to include `initialWorkflowId?: string` and `onCreateNew(): void`.
The New button calls `onCreateNew`. Select the requested newly created workflow
when present, otherwise the first saved workflow. Remove `selectedId === 'new'`
and the creation POST branch from `saveDraft`; do not render saved-workflow
actions when nothing is selected.

- [ ] **Step 5: Remove the old embedded creation branch**

Delete upload-stage imports, creation-only state, and the new-workflow branch
from `WorkflowEditor`; retain the saved-workflow raw JSON, mapping editor, test,
save, and publish behavior. Remove the obsolete upload component:

```bash
git rm src/app/'[locale]'/profile/components/comfyui/WorkflowUploadStep.tsx
```

- [ ] **Step 6: Verify and commit**

```bash
rg "WorkflowUploadStep|WorkflowEditorStage|selectedId === 'new'" src tests
npx vitest run tests/unit/components/comfyui-workflow-settings.test.ts tests/unit/components/comfyui-workflow-creation-wizard.test.tsx
npx eslint src/app/'[locale]'/profile/components/comfyui/ComfyUiSettings.tsx src/app/'[locale]'/profile/components/comfyui/WorkflowLibraryPanel.tsx src/app/'[locale]'/profile/components/comfyui/WorkflowEditor.tsx tests/unit/components/comfyui-workflow-settings.test.ts tests/unit/components/comfyui-workflow-creation-wizard.test.tsx
npm run typecheck
git add src/app/'[locale]'/profile/components/comfyui/ComfyUiSettings.tsx src/app/'[locale]'/profile/components/comfyui/WorkflowLibraryPanel.tsx src/app/'[locale]'/profile/components/comfyui/WorkflowEditor.tsx tests/unit/components/comfyui-workflow-settings.test.ts tests/unit/components/comfyui-workflow-creation-wizard.test.tsx
git add -u -- src/app/'[locale]'/profile/components/comfyui/WorkflowUploadStep.tsx
git commit -m "feat: open workflow creation in full width"
```

Expected: `rg` returns no removed creation symbols, focused tests PASS, lint has
0 errors, typecheck exits 0.

## Task 6: Harden Error Handling, Accessibility, and Responsive Layout

**Files:**
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowCreationWizard.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowAnalysisSummary.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowMappingQuestions.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowAdvancedMappingInspector.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/workflow-requests.ts`
- Modify: `messages/zh/comfyui.json`
- Modify: `messages/en/comfyui.json`
- Modify: `tests/unit/components/comfyui-workflow-creation-wizard.test.tsx`

- [ ] **Step 1: Add failing hardening tests**

Assert that the wizard has a named main region, progress and request status use
`aria-live`, every question has a legend and one radio name, and the review has
exactly one enabled primary action. Render a very long filename and node title;
assert their containers use `min-w-0` plus `break-words` or `truncate`, technical
details stay collapsed, and the raw body of a rejected server response is not
rendered.

- [ ] **Step 2: Run and confirm RED**

```bash
npx vitest run tests/unit/components/comfyui-workflow-creation-wizard.test.tsx
```

Expected: FAIL on the new semantic, safe-error, or containment assertions.

- [ ] **Step 3: Add semantics and keyboard-safe focus movement**

Give the wizard a localized accessible name, label the step navigation, use
`aria-current="step"`, announce busy/error/success state through a polite live
region, and move focus to the new step heading after a transition. Keep every
radio choice inside a `fieldset` and `legend`; never use a clickable `div` as a
control.

- [ ] **Step 4: Enforce overflow containment at every boundary**

Keep `min-w-0` from settings shell through wizard cards, `max-w-[60rem]` on the
content column, and `overflow-x-hidden` only on the wizard scroller. Use a
single-column question layout that becomes two columns at `md`; apply
`break-words` to user/workflow strings and keep technical tables inside their own
`overflow-x-auto` container. Do not add fixed pixel widths or minimum widths.

- [ ] **Step 5: Localize safe, actionable failures**

Map API-format-required, API-format-invalid, output-missing, invalid JSON,
oversized file, network failure, and unknown server failure to concise localized
guidance. Preserve the typed internal reason for diagnostics, but render only the
localized category and retry instruction.

- [ ] **Step 6: Verify and commit**

```bash
npx vitest run tests/unit/components/comfyui-workflow-creation-wizard.test.tsx tests/unit/components/comfyui-guided-workflow-creation.test.tsx
npx vitest run tests/unit/i18n-message-guard.test.ts
npx eslint src/app/'[locale]'/profile/components/comfyui/WorkflowCreationWizard.tsx src/app/'[locale]'/profile/components/comfyui/WorkflowAnalysisSummary.tsx src/app/'[locale]'/profile/components/comfyui/WorkflowMappingQuestions.tsx src/app/'[locale]'/profile/components/comfyui/WorkflowAdvancedMappingInspector.tsx src/app/'[locale]'/profile/components/comfyui/workflow-requests.ts tests/unit/components/comfyui-workflow-creation-wizard.test.tsx
npm run typecheck
git add src/app/'[locale]'/profile/components/comfyui/WorkflowCreationWizard.tsx src/app/'[locale]'/profile/components/comfyui/WorkflowAnalysisSummary.tsx src/app/'[locale]'/profile/components/comfyui/WorkflowMappingQuestions.tsx src/app/'[locale]'/profile/components/comfyui/WorkflowAdvancedMappingInspector.tsx src/app/'[locale]'/profile/components/comfyui/workflow-requests.ts tests/unit/components/comfyui-workflow-creation-wizard.test.tsx messages/zh/comfyui.json messages/en/comfyui.json
git commit -m "fix: harden guided workflow creation UI"
```

Expected: focused tests and locale guard PASS, lint has 0 errors, typecheck exits
0.

## Task 7: Run Full Verification and Hand Off the Branch

**Files:**
- Modify only files needed to fix verification findings

- [ ] **Step 1: Audit the final scope**

```bash
git status --short
git diff --stat main...HEAD
rg "WorkflowUploadStep|WorkflowEditorStage|selectedId === 'new'" src tests
rg "overflow-x-auto|min-w-0|max-w-\[60rem\]|overflow-x-hidden" src/app/'[locale]'/profile/components/comfyui
```

Expected: only planned ComfyUI UI, request, locale, and test files changed; old
embedded creation symbols are absent; containment classes exist at the intended
boundaries.

- [ ] **Step 2: Run the focused workflow suite**

```bash
npx vitest run tests/unit/components/comfyui-guided-workflow-creation.test.tsx tests/unit/components/comfyui-workflow-creation-wizard.test.tsx tests/unit/components/comfyui-workflow-settings.test.ts tests/unit/comfyui/workflow-auto-mapper.test.ts tests/integration/api/contract/comfyui-workflow-analyze-route.test.ts tests/integration/api/contract/comfyui-workflows-route.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 3: Run static and full automated verification**

```bash
npm run lint
npm run typecheck
npm run test:all
npm run build
```

Expected: every command exits 0. Existing lint warnings may remain unchanged;
there must be 0 lint errors.

- [ ] **Step 4: Verify responsive behavior in a real browser**

Start the app with its documented development command, open the ComfyUI settings,
and exercise widths 375, 768, and 1440 pixels. At each width verify:

```js
document.documentElement.scrollWidth <= document.documentElement.clientWidth
```

Exercise a long filename/title, one required ambiguity, two output candidates,
and expanded Advanced Settings. Confirm the default view stays concise and only
the advanced container scrolls horizontally when technical content needs it.

- [ ] **Step 5: Regression-check saved workflow behavior**

Open an existing workflow and confirm raw JSON editing, advanced mapping, test,
save, and publish still work. Return to the overview, create a draft, and confirm
the new draft is selected after the wizard closes.

- [ ] **Step 6: Commit verification-only fixes if present**

```bash
git status --short
git diff --check
git add path/to/each-file-fixed-during-verification
git commit -m "test: verify guided workflow creation"
```

Skip the commit when verification required no edits. Never commit development
logs, screenshots, generated build output, or local environment files.

- [ ] **Step 7: Prepare branch handoff**

```bash
git status --short
git log --oneline --decorate -8
git diff --check main...HEAD
git diff --stat main...HEAD
```

Expected: clean worktree, coherent task-sized commits, and no whitespace errors.
Then use the `superpowers:finishing-a-development-branch` workflow to present
merge, push/PR, keep, or discard options with the verified command results.
