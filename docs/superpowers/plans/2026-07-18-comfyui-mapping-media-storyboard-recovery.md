# ComfyUI Mapping, Media, and Storyboard Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ComfyUI workflow mappings fully repairable, retrieve remote video outputs correctly, normalize owned reference images through internal storage, and expose the active four/six-grid mode from the storyboard stage.

**Architecture:** Keep automatic analysis as an editable draft. Graph-derived helpers validate input additions, while output node selection is graph-bound and its history field remains safely editable. Preserve the existing remote `/history` → `/view` media transfer, use internal object URLs for server-side reference reads, and add a storyboard-mode summary without moving the authoritative planning setting.

**Tech Stack:** TypeScript, React 19, Next.js 15, next-intl, ComfyUI HTTP API, Vitest, Testing Library.

---

## File Structure

- `src/app/[locale]/profile/components/comfyui/guided-workflow-mapping-draft.ts`: graph-derived input candidates and immutable draft edit helpers.
- `src/app/[locale]/profile/components/comfyui/WorkflowGuidedMappingEditor.tsx`: guided add/edit/remove controls for input and output mappings.
- `src/app/[locale]/profile/components/comfyui/WorkflowCreationWizard.tsx`: owns and confirms one edited mapping draft.
- `src/app/[locale]/profile/components/comfyui/manual-workflow-mapping.ts`: removed after its prompt-only correction state is replaced by the complete draft.
- `src/app/[locale]/profile/components/comfyui/WorkflowManualMappingCorrections.tsx`: removed after the complete editor replaces the missing-input-only UI.
- `src/app/[locale]/profile/components/comfyui/guided-workflow-creation.ts`: computes readiness from effective mappings after removals and additions.
- `src/app/[locale]/profile/components/comfyui/WorkflowActivationPanel.tsx`: exposes live-test recovery.
- `src/app/[locale]/profile/components/comfyui/WorkflowLibraryPanel.tsx`: unlocks and focuses the saved mapping editor.
- `src/app/[locale]/profile/components/comfyui/WorkflowEditor.tsx`: forwards the focus request.
- `src/app/[locale]/profile/components/comfyui/WorkflowMappingTable.tsx`: accessible focus target and existing saved-draft add/remove controls.
- `src/lib/comfyui/workflow-auto-mapper.ts`: class-aware output history-field defaults.
- `src/lib/media/outbound-image.ts`: internal storage resolution for server-side normalization.
- `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/StoryboardModeSummary.tsx`: active-mode summary and navigation.
- `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/StoryboardStage.tsx`: renders the summary above storyboard groups.
- `messages/{zh,en}/comfyui.json`: guided editor and test-recovery copy.
- `messages/{zh,en}/novel-promotion.json`: storyboard-mode summary copy.

### Task 1: Rebase the existing failed-test recovery work onto current main

**Files:**
- Existing worktree: `.worktrees/comfyui-mapping-test-recovery`
- Existing commits: `e3b3207`, `4932974`

- [ ] **Step 1: Verify the isolated worktree is clean and ignored**

Run:

```bash
git check-ignore -q .worktrees
git -C .worktrees/comfyui-mapping-test-recovery status --short
```

Expected: `.worktrees` is ignored and the feature worktree has no local changes.

- [ ] **Step 2: Rebase the recovery commits onto current main**

Run:

```bash
git -C .worktrees/comfyui-mapping-test-recovery rebase main
```

Expected: the branch contains current internal-media commits and retains the two mapping-recovery commits without conflicts.

- [ ] **Step 3: Verify the already test-driven recovery behavior**

Run:

```bash
cd .worktrees/comfyui-mapping-test-recovery
npx cross-env BILLING_TEST_BOOTSTRAP=0 vitest run \
  tests/unit/components/comfyui-workflow-activation.test.tsx \
  tests/unit/components/comfyui-workflow-library-actions.test.tsx \
  tests/unit/components/comfyui-workflow-mapping-table.test.tsx
```

Expected: all recovery tests pass, including unlock, draft retention, focus, and repair-state clearing.

### Task 2: Define one editable guided mapping draft

**Files:**
- Create: `src/app/[locale]/profile/components/comfyui/guided-workflow-mapping-draft.ts`
- Create: `tests/unit/components/comfyui-guided-mapping-draft.test.ts`
- Modify: `src/app/[locale]/profile/components/comfyui/guided-workflow-creation.ts`

- [ ] **Step 1: Write failing tests for graph-derived additions and removals**

Add tests equivalent to:

```ts
it('offers scalar, image, and video fields as compatible input candidates', () => {
  const draft = createGuidedMappingDraft(analyzeComfyApiWorkflow({
    kind: 'video_to_video',
    graph: {
      text: { class_type: 'TextInput', inputs: { value: 'prompt' } },
      image: { class_type: 'LoadImage', inputs: { image: 'frame.png' } },
      video: { class_type: 'LoadVideo', inputs: { video: 'clip.mp4' } },
      output: { class_type: 'VHS_VideoCombine', inputs: { images: ['image', 0] } },
    },
  }))

  expect(guidedInputCandidates(draft.analysis, draft.inputs)).toEqual(expect.arrayContaining([
    expect.objectContaining({ nodeId: 'text', inputPath: 'value', roles: expect.arrayContaining(['prompt']) }),
    expect.objectContaining({ nodeId: 'image', inputPath: 'image', roles: expect.arrayContaining(['firstFrame', 'referenceImages']) }),
    expect.objectContaining({ nodeId: 'video', inputPath: 'video', roles: ['sourceVideo'] }),
  ]))
})

it('removes an unwanted automatic mapping and adds a verified replacement', () => {
  const initial = createGuidedMappingDraft(analysis)
  const removed = removeGuidedInput(initial, initial.inputs[0]!.id)
  const repaired = addGuidedInput(removed, candidate.id, 'prompt')

  expect(effectiveGuidedAnalysis(repaired).proposals).toEqual([
    expect.objectContaining({ nodeId: candidate.nodeId, inputPath: candidate.inputPath, canonicalName: 'prompt' }),
  ])
})

it('rejects duplicate, missing-node, and type-incompatible additions', () => {
  expect(() => addGuidedInput(draft, forgedCandidate, 'sourceVideo'))
    .toThrow('workflowGuidedMappingInvalid')
})
```

- [ ] **Step 2: Run the draft tests and verify RED**

Run:

```bash
npx cross-env BILLING_TEST_BOOTSTRAP=0 vitest run tests/unit/components/comfyui-guided-mapping-draft.test.ts
```

Expected: FAIL because the draft module does not exist.

- [ ] **Step 3: Implement the immutable draft contract**

Use these public types and functions:

```ts
export interface GuidedInputCandidate {
  id: string
  nodeId: string
  inputPath: string
  nodeTitle?: string
  roles: CanonicalWorkflowInput[]
  valueTypeByRole: Partial<Record<CanonicalWorkflowInput, ComfyVariableType>>
  transformByRole: Partial<Record<CanonicalWorkflowInput, ComfyBindingTransform>>
}

export interface GuidedWorkflowMappingDraft {
  analysis: WorkflowAutoMappingResult
  inputs: WorkflowMappingProposal[]
  outputs: ComfyOutputBinding[]
}

export function createGuidedMappingDraft(analysis: WorkflowAutoMappingResult): GuidedWorkflowMappingDraft
export function guidedInputCandidates(
  analysis: WorkflowAutoMappingResult,
  inputs: WorkflowMappingProposal[],
): GuidedInputCandidate[]
export function addGuidedInput(
  draft: GuidedWorkflowMappingDraft,
  candidateId: string,
  role: CanonicalWorkflowInput,
): GuidedWorkflowMappingDraft
export function updateGuidedInputRole(
  draft: GuidedWorkflowMappingDraft,
  proposalId: string,
  role: CanonicalWorkflowInput,
): GuidedWorkflowMappingDraft
export function removeGuidedInput(
  draft: GuidedWorkflowMappingDraft,
  proposalId: string,
): GuidedWorkflowMappingDraft
export function guidedOutputNodeCandidates(
  analysis: WorkflowAutoMappingResult,
): Array<{ nodeId: string; classType: string; nodeTitle?: string; suggestedField: string }>
export function addGuidedOutput(
  draft: GuidedWorkflowMappingDraft,
  nodeId: string,
): GuidedWorkflowMappingDraft
export function updateGuidedOutput(
  draft: GuidedWorkflowMappingDraft,
  index: number,
  patch: Partial<Pick<ComfyOutputBinding, 'nodeId' | 'fieldPath' | 'name'>>,
): GuidedWorkflowMappingDraft
export function removeGuidedOutput(
  draft: GuidedWorkflowMappingDraft,
  index: number,
): GuidedWorkflowMappingDraft
export function setGuidedPrimaryOutput(
  draft: GuidedWorkflowMappingDraft,
  index: number,
): GuidedWorkflowMappingDraft
export function guidedMappingDraftIssues(
  draft: GuidedWorkflowMappingDraft,
): Array<'outputRequired' | 'primaryRequired' | 'unsafeField' | 'duplicateTarget'>
export function effectiveGuidedAnalysis(
  draft: GuidedWorkflowMappingDraft,
): WorkflowAutoMappingResult
```

Candidate rules are deterministic:

```ts
const SCALAR_ROLES = {
  prompt: 'string', negativePrompt: 'string',
  width: 'number', height: 'number', seed: 'number', duration: 'number', fps: 'number',
} as const

// LoadImage-like string fields: sourceImage, firstFrame, lastFrame, referenceImages.
// LoadVideo-like string fields: sourceVideo.
// Graph links, objects, unsafe dotted keys, and already-bound node/path pairs are excluded.
```

Media role conversion must assign `filename` for single images, `filename_at` plus a stable `referenceIndex` for reference lists, and `filename` for videos. Every add/update operation re-derives the candidate from the graph; caller-supplied node/path/type data is never trusted.

Output helpers accept only node IDs present in `analysis.graph`, require a non-empty safe dotted `fieldPath`, keep names and node/field targets unique, and normalize primary selection after removal. `effectiveGuidedAnalysis` removes stale analyzer-only `COMFY_WORKFLOW_OUTPUT_REQUIRED` and `COMFY_WORKFLOW_OUTPUT_AMBIGUOUS` issues, then derives output readiness from the edited output list.

- [ ] **Step 4: Make readiness use only the effective draft**

Remove the special case that temporarily counts unresolved required ambiguous proposals as mapped. Required inputs count as present only when `effectiveProposalRole` resolves to a canonical role.

```ts
const mappedInputs = new Set(dispositions
  .map(({ role }) => role)
  .filter((role): role is CanonicalWorkflowInput => Boolean(role && role !== 'preserve_original')))
```

- [ ] **Step 5: Run the focused helper tests and verify GREEN**

Run the command from Step 2 plus:

```bash
npx cross-env BILLING_TEST_BOOTSTRAP=0 vitest run \
  tests/unit/comfyui/guided-workflow-creation.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add 'src/app/[locale]/profile/components/comfyui/guided-workflow-mapping-draft.ts' \
  'src/app/[locale]/profile/components/comfyui/guided-workflow-creation.ts' \
  tests/unit/components/comfyui-guided-mapping-draft.test.ts
HUSKY=0 git commit -m "feat: make guided ComfyUI mappings editable"
```

### Task 3: Add guided input and output mapping controls

**Files:**
- Create: `src/app/[locale]/profile/components/comfyui/WorkflowGuidedMappingEditor.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowCreationWizard.tsx`
- Delete: `src/app/[locale]/profile/components/comfyui/manual-workflow-mapping.ts`
- Delete: `src/app/[locale]/profile/components/comfyui/WorkflowManualMappingCorrections.tsx`
- Modify: `messages/zh/comfyui.json`
- Modify: `messages/en/comfyui.json`
- Modify: `tests/unit/components/comfyui-workflow-creation-wizard.test.tsx`

- [ ] **Step 1: Write failing wizard tests for add, edit, and delete**

Add user-level tests that:

```tsx
it('removes an incorrect input and adds a missing media mapping before creation', async () => {
  const { view, onCreate } = await renderReviewedWizard(videoToVideoAnalysis)

  fireEvent.click(view.getByRole('button', { name: 'Remove Prompt mapping' }))
  fireEvent.click(view.getByRole('button', { name: 'Add input mapping' }))
  fireEvent.change(view.getByLabelText('Workflow field'), { target: { value: 'video.video' } })
  fireEvent.change(view.getByLabelText('Mapped role'), { target: { value: 'sourceVideo' } })
  fireEvent.click(view.getByRole('button', { name: 'Confirm input mapping' }))
  await createWorkflow(view)

  expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
    bindings: expect.arrayContaining([
      expect.objectContaining({ nodeId: 'video', inputPath: 'video', variable: 'sourceVideo' }),
    ]),
  }), expect.any(String))
})

it('adds, edits, removes, and selects a primary output mapping', async () => {
  const { view, onCreate } = await renderReviewedWizard(unknownVideoOutputAnalysis)

  fireEvent.click(view.getByRole('button', { name: 'Add output mapping' }))
  fireEvent.change(view.getByLabelText('Output node'), { target: { value: '99' } })
  fireEvent.change(view.getByLabelText('History field'), { target: { value: 'videos' } })
  fireEvent.click(view.getByRole('button', { name: 'Use as primary output' }))
  fireEvent.click(view.getByRole('button', { name: 'Remove output output_8' }))
  await createWorkflow(view)

  expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
    outputs: [expect.objectContaining({ nodeId: '99', fieldPath: 'videos', primary: true })],
  }), expect.any(String))
})
```

Also assert creation remains blocked for zero outputs, blank/unsafe history fields, duplicate targets, and a primary selection removed from the draft.

- [ ] **Step 2: Run the wizard suite and verify RED**

Run:

```bash
npx cross-env BILLING_TEST_BOOTSTRAP=0 vitest run \
  tests/unit/components/comfyui-workflow-creation-wizard.test.tsx
```

Expected: new tests fail because the complete guided editor is absent.

- [ ] **Step 3: Implement the guided mapping editor**

Render current input rows with a compatible-role selector and remove button. Render an `Add input mapping` disclosure using `guidedInputCandidates` and require both a field and role before confirmation.

Render current outputs with:

```tsx
<select aria-label={t('outputNode')} value={output.nodeId} onChange={...}>
  {graphNodes.map((node) => <option key={node.id} value={node.id}>
    {node.title || node.classType} · {node.id}
  </option>)}
</select>
<input
  aria-label={t('historyField')}
  value={output.fieldPath}
  onChange={(event) => onOutputChange(index, { fieldPath: event.target.value })}
/>
<input type="radio" checked={output.primary} onChange={() => onPrimaryOutputChange(index)} />
<button type="button" onClick={() => onRemoveOutput(index)}>{t('removeOutput')}</button>
```

New output rows use a selected graph node and a class-aware default field. Unknown nodes start with a blank history field and cannot be confirmed until a safe dotted path is entered. Prevent removing the last output only in the saved editor; in the guided editor, allow removal but keep creation blocked until another output is added.

- [ ] **Step 4: Make the wizard own exactly one mapping draft**

Replace separate `roles`, `manualMappings`, `selectedOutput`, and analyzer-only output rendering with `mappingDraft`. Initialize it after analysis and reset it with graph state.

```ts
const [mappingDraft, setMappingDraft] = useState<GuidedWorkflowMappingDraft | null>(null)
const effectiveAnalysis = mappingDraft ? effectiveGuidedAnalysis(mappingDraft) : null
const mappingIssues = mappingDraft ? guidedMappingDraftIssues(mappingDraft) : ['outputRequired']
const selectedOutput = mappingDraft?.outputs.find((output) => output.primary)?.nodeId || ''
const review = kind && effectiveAnalysis
  ? buildGuidedWorkflowReview(kind, effectiveAnalysis, {}, selectedOutput)
  : null
```

`ready` also requires `mappingIssues.length === 0`. `confirmWorkflowAnalysis` receives the same `effectiveAnalysis` and no stale analyzer proposal list. Preserve the uploaded source JSON unchanged.

- [ ] **Step 5: Add matched English and Chinese labels**

Add localized text for add/remove input, workflow field, mapped role, confirm mapping, add/remove output, output node, history field, primary output, invalid field, duplicate target, and zero-output guidance. Check key parity.

- [ ] **Step 6: Run the wizard and contract suites and verify GREEN**

Run:

```bash
npx cross-env BILLING_TEST_BOOTSTRAP=0 vitest run \
  tests/unit/components/comfyui-guided-mapping-draft.test.ts \
  tests/unit/components/comfyui-workflow-creation-wizard.test.tsx \
  tests/unit/comfyui/workflow-compiler.test.ts
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add 'src/app/[locale]/profile/components/comfyui/WorkflowGuidedMappingEditor.tsx' \
  'src/app/[locale]/profile/components/comfyui/WorkflowCreationWizard.tsx' \
  'src/app/[locale]/profile/components/comfyui/manual-workflow-mapping.ts' \
  'src/app/[locale]/profile/components/comfyui/WorkflowManualMappingCorrections.tsx' \
  messages/zh/comfyui.json messages/en/comfyui.json \
  tests/unit/components/comfyui-workflow-creation-wizard.test.tsx
HUSKY=0 git commit -m "feat: add guided ComfyUI mapping editor"
```

### Task 4: Correct video history fields and preserve remote HTTP retrieval

**Files:**
- Modify: `src/lib/comfyui/workflow-auto-mapper.ts`
- Modify: `tests/unit/comfyui/workflow-auto-mapper.test.ts`
- Create: `tests/unit/comfyui/workflow-output.test.ts`
- Inspect: `src/lib/comfyui/workflow-output.ts`
- Inspect: `src/lib/comfyui/client.ts`

- [ ] **Step 1: Change the VHS expectation first**

```ts
it('maps VideoHelperSuite output to its gifs history field', () => {
  const result = analyzeComfyApiWorkflow({
    kind: 'video_generation',
    graph: { '8': { class_type: 'VHS_VideoCombine', inputs: { images: ['1', 0] } } },
  })
  expect(result.outputs).toEqual([
    expect.objectContaining({ nodeId: '8', fieldPath: 'gifs', mediaType: 'video', primary: true }),
  ])
})
```

Add a history-parser regression using `outputs: { '8': { gifs: [{ filename: 'clip.mp4', subfolder: 'video', type: 'output' }] } }` and assert the extracted reference is the `.mp4` entry.

- [ ] **Step 2: Run the mapper/output tests and verify RED**

Run:

```bash
npx cross-env BILLING_TEST_BOOTSTRAP=0 vitest run \
  tests/unit/comfyui/workflow-auto-mapper.test.ts \
  tests/unit/comfyui/workflow-output.test.ts
```

Expected: mapper test fails with received field `files`.

- [ ] **Step 3: Implement class-aware output defaults**

```ts
export function defaultHistoryFieldForOutput(
  classType: string,
  mediaType: ComfyMediaType,
): string | null {
  const normalized = normalize(classType)
  if (mediaType === 'image') return 'images'
  if (normalized === 'vhsvideocombine') return 'gifs'
  return null
}
```

`discoverOutputs` uses this helper and skips output-like nodes when no verified history field is known. Known nodes receive the default; unknown nodes remain available for manual output-node selection in the guided editor rather than being asserted as verified `files` mappings.

- [ ] **Step 4: Verify the existing remote transfer boundary**

Keep `workflow-output.ts` extracting `{ filename, subfolder, type }` and `client.ts` issuing `GET /view` against the configured instance base URL. Add or retain a client test asserting the encoded remote request; do not introduce filesystem APIs.

- [ ] **Step 5: Run tests and commit**

Run the command from Step 2. Expected: all pass.

```bash
git add src/lib/comfyui/workflow-auto-mapper.ts \
  tests/unit/comfyui/workflow-auto-mapper.test.ts \
  tests/unit/comfyui/workflow-output.test.ts
HUSKY=0 git commit -m "fix: map remote ComfyUI video outputs correctly"
```

### Task 5: Normalize owned references through internal storage

**Files:**
- Modify: `src/lib/media/outbound-image.test.ts`
- Modify: `src/lib/media/outbound-image.ts`

- [ ] **Step 1: Write the failing internal-boundary test**

Update the storage mock:

```ts
const getInternalObjectUrl = vi.fn(async (key: string) => `http://minio:9000/bucket/${key}`)
const getSignedUrl = vi.fn((key: string) => `http://localhost:19000/bucket/${key}`)

vi.mock('@/lib/storage', () => ({
  getInternalObjectUrl,
  getSignedUrl,
  toFetchableUrl: vi.fn((value: string) => value),
}))
```

Assert both direct storage keys and `/m/{publicId}` references fetch the internal URL and never call `getSignedUrl`.

```ts
expect(fetchMock).toHaveBeenCalledWith(
  'http://minio:9000/bucket/images/from-media.png',
  expect.any(Object),
)
expect(getSignedUrl).not.toHaveBeenCalled()
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npx cross-env BILLING_TEST_BOOTSTRAP=0 vitest run src/lib/media/outbound-image.test.ts
```

Expected: FAIL because `getInternalObjectUrl` is not called and the public signer is used.

- [ ] **Step 3: Replace server-side signing with internal object resolution**

```ts
type StorageHelpers = Pick<
  typeof import('@/lib/storage'),
  'getInternalObjectUrl' | 'toFetchableUrl'
>

async function resolveInternalStorageKey(storageKey: string): Promise<string> {
  const { getInternalObjectUrl } = await getStorageHelpers()
  return await getInternalObjectUrl(storageKey, SIGNED_URL_TTL_SECONDS)
}
```

Use `resolveInternalStorageKey` for owned storage keys and resolved `/m` references. Retain `toFetchableUrl` only for application-relative `/api` inputs.

- [ ] **Step 4: Run reference normalization and task-handler regressions**

Run:

```bash
npx cross-env BILLING_TEST_BOOTSTRAP=0 vitest run \
  src/lib/media/outbound-image.test.ts \
  tests/unit/worker/panel-image-task-handler.test.ts \
  tests/unit/worker/storyboard-sheet-task-handler.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/media/outbound-image.ts src/lib/media/outbound-image.test.ts
HUSKY=0 git commit -m "fix: fetch generation references through internal storage"
```

### Task 6: Show four/six-grid mode on the storyboard stage

**Files:**
- Create: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/StoryboardModeSummary.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/StoryboardStage.tsx`
- Modify: `messages/zh/novel-promotion.json`
- Modify: `messages/en/novel-promotion.json`
- Create: `tests/unit/components/storyboard-mode-summary.test.tsx`

- [ ] **Step 1: Write the failing mode-summary tests**

```tsx
it.each([
  ['four_grid', '16:9', '2×2', '16:9'],
  ['six_grid', '16:9', '3×2', '8:3'],
] as const)('shows %s layout and returns to story settings', (mode, ratio, layout, sheetRatio) => {
  const onOpenSettings = vi.fn()
  const view = render(<StoryboardModeSummary
    mode={mode}
    cellRatio={ratio}
    videoRatio="16:9"
    onOpenSettings={onOpenSettings}
  />)

  expect(view.getByText(layout)).toBeTruthy()
  expect(view.getByText(sheetRatio)).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'Change in story settings' }))
  expect(onOpenSettings).toHaveBeenCalledOnce()
})
```

- [ ] **Step 2: Run the component test and verify RED**

Run:

```bash
npx cross-env BILLING_TEST_BOOTSTRAP=0 vitest run tests/unit/components/storyboard-mode-summary.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the summary from the canonical grid spec**

For grid modes, call `resolveStoryboardGridSpec(mode, selectedCellRatio)` and display `columns × rows` plus `sheetAspectRatio`. For individual mode, display the localized individual label and no sheet ratio. The action calls `runtime.onStageChange('config')`; it does not mutate persisted storyboard groups.

```tsx
<StoryboardModeSummary
  mode={runtime.storyboardGenerationMode}
  cellRatio={runtime.sixGridCellAspectRatio}
  videoRatio={runtime.videoRatio}
  onOpenSettings={() => runtime.onStageChange('config')}
/>
```

- [ ] **Step 4: Add matched translations and run component regressions**

Run:

```bash
npx cross-env BILLING_TEST_BOOTSTRAP=0 vitest run \
  tests/unit/components/storyboard-mode-summary.test.tsx \
  tests/unit/components/grid-storyboard-controls.test.tsx
```

Expected: all pass and the existing configuration selector still exposes individual, four-grid, and six-grid.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/StoryboardModeSummary.tsx' \
  'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/StoryboardStage.tsx' \
  messages/zh/novel-promotion.json messages/en/novel-promotion.json \
  tests/unit/components/storyboard-mode-summary.test.tsx
HUSKY=0 git commit -m "feat: expose storyboard grid mode in storyboard stage"
```

### Task 7: Integrated verification and merge preparation

**Files:**
- Inspect: every file changed by Tasks 1–6

- [ ] **Step 1: Run the complete focused regression set**

```bash
npx cross-env BILLING_TEST_BOOTSTRAP=0 vitest run \
  tests/unit/components/comfyui-guided-mapping-draft.test.ts \
  tests/unit/components/comfyui-workflow-creation-wizard.test.tsx \
  tests/unit/components/comfyui-workflow-activation.test.tsx \
  tests/unit/components/comfyui-workflow-library-actions.test.tsx \
  tests/unit/components/comfyui-workflow-mapping-table.test.tsx \
  tests/unit/comfyui/workflow-auto-mapper.test.ts \
  tests/unit/comfyui/workflow-output.test.ts \
  src/lib/media/outbound-image.test.ts \
  tests/unit/worker/panel-image-task-handler.test.ts \
  tests/unit/worker/storyboard-sheet-task-handler.test.ts \
  tests/unit/components/storyboard-mode-summary.test.tsx \
  tests/unit/components/grid-storyboard-controls.test.tsx
```

Expected: all pass.

- [ ] **Step 2: Run static validation without traversing sibling worktrees**

```bash
npm run typecheck
npx eslint \
  'src/app/[locale]/profile/components/comfyui/**/*.{ts,tsx}' \
  'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/StoryboardModeSummary.tsx' \
  'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/StoryboardStage.tsx' \
  src/lib/comfyui/workflow-auto-mapper.ts \
  src/lib/media/outbound-image.ts \
  'tests/unit/components/comfyui-*.{ts,tsx}' \
  tests/unit/components/storyboard-mode-summary.test.tsx \
  tests/unit/comfyui/workflow-auto-mapper.test.ts \
  tests/unit/comfyui/workflow-output.test.ts \
  src/lib/media/outbound-image.test.ts
```

Expected: exit code `0`.

- [ ] **Step 3: Check locale parity and whitespace**

```bash
node - <<'NODE'
const fs = require('fs')
for (const file of ['comfyui.json', 'novel-promotion.json']) {
  const zh = JSON.parse(fs.readFileSync(`messages/zh/${file}`))
  const en = JSON.parse(fs.readFileSync(`messages/en/${file}`))
  const flatten = (value, prefix = '', out = []) => {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (child && typeof child === 'object' && !Array.isArray(child)) flatten(child, path, out)
      else out.push(path)
    }
    return out.sort()
  }
  if (JSON.stringify(flatten(zh)) !== JSON.stringify(flatten(en))) process.exit(1)
}
NODE
git diff --check main...HEAD
```

Expected: key sets match and diff check exits `0`.

- [ ] **Step 4: Run build and the repository test gate**

```bash
npm run build
npx cross-env BILLING_TEST_BOOTSTRAP=0 vitest run --exclude '.worktrees/**'
```

Expected: build passes and all repository tests pass. If an unrelated baseline failure appears, reproduce it on `main` before classifying it as pre-existing.

- [ ] **Step 5: Review commits and branch diff**

```bash
git status --short
git log --oneline main..HEAD
git diff --stat main...HEAD
```

Expected: clean worktree and only the approved mapping, media, and storyboard recovery scope.
