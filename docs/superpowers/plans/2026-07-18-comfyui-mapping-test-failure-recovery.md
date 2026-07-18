# ComfyUI Mapping Test Failure Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user return from a failed ComfyUI live test to an unlocked input/output mapping editor, save a repaired immutable version, and test that exact version.

**Architecture:** `WorkflowActivationPanel` reports an explicit edit-mappings intent without mutating workflow state. `WorkflowLibraryPanel` owns a short-lived repair mode and focus request, while `WorkflowEditor` and `WorkflowMappingTable` only implement the focus handoff. Existing workflow version creation remains the sole boundary between edited drafts and live tests.

**Tech Stack:** React 19, TypeScript, Next.js 15, next-intl, Testing Library, Vitest

---

## File Structure

- `src/app/[locale]/profile/components/comfyui/WorkflowActivationPanel.tsx`: expose the recovery action only after a live-test failure.
- `src/app/[locale]/profile/components/comfyui/WorkflowLibraryPanel.tsx`: close activation, retain the author draft, show repair guidance, and request mapping focus.
- `src/app/[locale]/profile/components/comfyui/WorkflowEditor.tsx`: forward the focus request to the mapping surface.
- `src/app/[locale]/profile/components/comfyui/WorkflowMappingTable.tsx`: provide the stable programmatic focus target.
- `messages/zh/comfyui.json`: Chinese recovery action and repair hint.
- `messages/en/comfyui.json`: English recovery action and repair hint.
- `tests/unit/components/comfyui-workflow-activation.test.tsx`: prove the failed-test recovery action is correctly gated and dispatched.
- `tests/unit/components/comfyui-workflow-library-actions.test.tsx`: prove activation closes, draft data survives, the editor unlocks, focus is requested, and repair mode clears.
- `tests/unit/components/comfyui-workflow-mapping-table.test.tsx`: prove the mapping table performs the accessible focus handoff.

### Task 1: Expose an explicit recovery action after live-test failure

**Files:**
- Modify: `tests/unit/components/comfyui-workflow-activation.test.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowActivationPanel.tsx`
- Modify: `messages/zh/comfyui.json`
- Modify: `messages/en/comfyui.json`

- [ ] **Step 1: Write the failing activation-panel test**

Add this behavior test:

```tsx
it('offers mapping repair only after a failed live test', async () => {
  requestWorkflowActionMock.mockRejectedValueOnce(new Error('test failed'))
  const onEditMappings = vi.fn()
  const view = renderPanel({ onEditMappings })

  expect(view.queryByRole('button', { name: 'Return to edit mappings' })).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Test and enable' }))
  await waitFor(() => expect(view.getByRole('button', {
    name: 'Return to edit mappings',
  })).toBeTruthy())

  fireEvent.click(view.getByRole('button', { name: 'Return to edit mappings' }))
  expect(onEditMappings).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cross-env BILLING_TEST_BOOTSTRAP=0 vitest run tests/unit/components/comfyui-workflow-activation.test.tsx
```

Expected: FAIL because `WorkflowActivationPanel` does not accept `onEditMappings` and no recovery button exists.

- [ ] **Step 3: Implement the minimal activation callback and localized action**

Add the optional callback:

```tsx
interface Props {
  workflowId: string
  version: WorkflowVersionView
  onClose(): void
  onEditMappings?(): void
  onActivated?(): void | Promise<void>
}
```

Render the action only for the failed-test state:

```tsx
{activation.error === 'test' && onEditMappings && <button
  type="button"
  disabled={busy}
  className="glass-btn-base px-4 py-2 text-sm disabled:opacity-50"
  onClick={onEditMappings}
>
  {t('activation.editMappings')}
</button>}
```

Add matching locale keys:

```json
"editMappings": "返回修改映射"
```

```json
"editMappings": "Return to edit mappings"
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2.

Expected: all activation component tests PASS.

- [ ] **Step 5: Commit the isolated behavior**

```bash
git add messages/zh/comfyui.json messages/en/comfyui.json \
  'src/app/[locale]/profile/components/comfyui/WorkflowActivationPanel.tsx' \
  tests/unit/components/comfyui-workflow-activation.test.tsx
HUSKY=0 git commit -m "feat: recover from failed ComfyUI workflow tests"
```

### Task 2: Unlock the saved draft and focus the mapping editor

**Files:**
- Modify: `tests/unit/components/comfyui-workflow-library-actions.test.tsx`
- Create: `tests/unit/components/comfyui-workflow-mapping-table.test.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowLibraryPanel.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowEditor.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowMappingTable.tsx`
- Modify: `messages/zh/comfyui.json`
- Modify: `messages/en/comfyui.json`

- [ ] **Step 1: Upgrade the library test doubles and write the failing recovery test**

Make the editor mock expose its disabled state and focus request:

```tsx
vi.mock('@/app/[locale]/profile/components/comfyui/WorkflowEditor', () => ({
  default: ({ value, disabled, mappingFocusRequestId }: {
    value: { name: string }
    disabled?: boolean
    mappingFocusRequestId?: number
  }) => <>
    <output aria-label="draft-name">{value.name}</output>
    <output aria-label="editor-disabled">{String(Boolean(disabled))}</output>
    <output aria-label="mapping-focus-request">{mappingFocusRequestId ?? 0}</output>
  </>,
}))
```

Make the activation mock preserve its existing completion action and expose the recovery callback:

```tsx
vi.mock('@/app/[locale]/profile/components/comfyui/WorkflowActivationPanel', () => ({
  default: ({ workflowId, onActivated, onEditMappings }: {
    workflowId: string
    onActivated?(): void | Promise<void>
    onEditMappings?(): void
  }) => <>
    <output aria-label="activation-workflow">{workflowId}</output>
    <button type="button" onClick={() => void onActivated?.()}>COMPLETE ACTIVATION</button>
    <button type="button" onClick={onEditMappings}>EDIT FAILED MAPPINGS</button>
  </>,
}))
```

Add the behavior assertion:

```tsx
it('returns from activation to an unlocked mapping repair draft', async () => {
  const view = renderLibrary()
  await selectSavedWorkflow(view)
  fireEvent.click(view.getByRole('button', { name: 'Test and enable' }))

  expect(view.getByLabelText('editor-disabled').textContent).toBe('true')
  fireEvent.click(view.getByRole('button', { name: 'EDIT FAILED MAPPINGS' }))

  expect(view.queryByLabelText('activation-workflow')).toBeNull()
  expect(view.getByLabelText('editor-disabled').textContent).toBe('false')
  expect(view.getByLabelText('draft-name').textContent).toBe('Portrait')
  expect(Number(view.getByLabelText('mapping-focus-request').textContent)).toBeGreaterThan(0)
  expect(view.getByRole('status').textContent).toContain('Repair the input or output mappings')
})
```

Add a real focus test in `comfyui-workflow-mapping-table.test.tsx`:

```tsx
it('focuses the input mapping heading when repair is requested', () => {
  const props = {
    variables: [], bindings: [], outputs: [], mediaType: 'image' as const,
    onBindingsChange: vi.fn(), onOutputsChange: vi.fn(),
  }
  const view = renderWithMessages(<WorkflowMappingTable {...props} focusRequestId={0} />)
  expect(document.activeElement).not.toBe(view.getByRole('heading', { name: 'Node input mappings' }))

  view.rerender(withMessages(<WorkflowMappingTable {...props} focusRequestId={1} />))
  expect(document.activeElement).toBe(view.getByRole('heading', { name: 'Node input mappings' }))
})
```

Add library assertions that selecting `Landscape` clears the repair hint, and
that a successful `Save draft` POST followed by a library reload clears the
hint while a rejected POST leaves it visible. These cases must use the existing
`apiFetchMock` and assert the repaired draft is never discarded on rejection.

- [ ] **Step 2: Run the two focused suites and verify RED**

Run:

```bash
cross-env BILLING_TEST_BOOTSTRAP=0 vitest run \
  tests/unit/components/comfyui-workflow-library-actions.test.tsx \
  tests/unit/components/comfyui-workflow-mapping-table.test.tsx
```

Expected: FAIL because the recovery callback, repair state, focus request, and focus target do not exist.

- [ ] **Step 3: Implement library-owned recovery state**

In `WorkflowLibraryPanel`, add:

```tsx
const [mappingRepairMode, setMappingRepairMode] = useState(false)
const [mappingFocusRequestId, setMappingFocusRequestId] = useState(0)

const editFailedMappings = () => {
  closeSelectedWorkflowActivation()
  setMappingRepairMode(true)
  setMappingFocusRequestId((current) => current + 1)
}
```

Pass `onEditMappings={editFailedMappings}` to `WorkflowActivationPanel`, pass
`mappingFocusRequestId` to `WorkflowEditor`, and show:

```tsx
{mappingRepairMode && !activationOpen && <p role="status" className="text-sm text-[var(--glass-text-secondary)]">
  {t('mappingRepairHint')}
</p>}
```

Clear `mappingRepairMode` in `selectWorkflow` and only after `saveDraft`
successfully creates and loads the new version. Do not clear it when saving
fails.

- [ ] **Step 4: Implement the focus handoff**

Add `mappingFocusRequestId?: number` to `WorkflowEditor`, then forward it:

```tsx
<WorkflowMappingTable
  focusRequestId={mappingFocusRequestId}
  variables={value.variableDefinitions}
  bindings={value.bindings}
  outputs={value.outputs}
  mediaType={value.mediaType}
  onBindingsChange={...}
  onOutputsChange={...}
/>
```

In `WorkflowMappingTable`, add a heading ref and effect:

```tsx
const headingRef = useRef<HTMLHeadingElement>(null)

useEffect(() => {
  if ((focusRequestId ?? 0) > 0) headingRef.current?.focus()
}, [focusRequestId])
```

Attach it to the input-mapping heading:

```tsx
<h4 ref={headingRef} tabIndex={-1} id="workflow-input-mappings" className="font-medium">
  {t('inputMappings')}
</h4>
```

Add locale text:

```json
"mappingRepairHint": "请修改输入或输出映射并保存草稿；保存后再测试，系统会测试新版本。"
```

```json
"mappingRepairHint": "Repair the input or output mappings and save the draft before testing the new version."
```

- [ ] **Step 5: Run the focused suites and verify GREEN**

Run:

```bash
cross-env BILLING_TEST_BOOTSTRAP=0 vitest run \
  tests/unit/components/comfyui-workflow-activation.test.tsx \
  tests/unit/components/comfyui-workflow-library-actions.test.tsx \
  tests/unit/components/comfyui-workflow-mapping-table.test.tsx
```

Expected: all focused tests PASS.

- [ ] **Step 6: Commit the recovery loop**

```bash
git add messages/zh/comfyui.json messages/en/comfyui.json \
  'src/app/[locale]/profile/components/comfyui/WorkflowLibraryPanel.tsx' \
  'src/app/[locale]/profile/components/comfyui/WorkflowEditor.tsx' \
  'src/app/[locale]/profile/components/comfyui/WorkflowMappingTable.tsx' \
  tests/unit/components/comfyui-workflow-library-actions.test.tsx \
  tests/unit/components/comfyui-workflow-mapping-table.test.tsx
HUSKY=0 git commit -m "feat: return failed workflows to mapping repair"
```

### Task 3: Verify version safety and repository quality

**Files:**
- Verify: all files changed in Tasks 1 and 2

- [ ] **Step 1: Verify locale parity and focused behavior**

Run:

```bash
node -e "const fs=require('fs');const z=JSON.parse(fs.readFileSync('messages/zh/comfyui.json'));const e=JSON.parse(fs.readFileSync('messages/en/comfyui.json'));const a=Object.keys(z.workflows.activation).sort();const b=Object.keys(e.workflows.activation).sort();if(JSON.stringify(a)!==JSON.stringify(b))process.exit(1);if(!z.workflows.mappingRepairHint||!e.workflows.mappingRepairHint)process.exit(1)"
cross-env BILLING_TEST_BOOTSTRAP=0 vitest run \
  tests/unit/components/comfyui-workflow-activation.test.tsx \
  tests/unit/components/comfyui-workflow-library-actions.test.tsx \
  tests/unit/components/comfyui-workflow-mapping-table.test.tsx
```

Expected: locale command exits 0 and all focused tests PASS.

- [ ] **Step 2: Verify TypeScript, lint, and patch cleanliness**

Run:

```bash
npm run typecheck
npx eslint \
  'src/app/[locale]/profile/components/comfyui/WorkflowActivationPanel.tsx' \
  'src/app/[locale]/profile/components/comfyui/WorkflowLibraryPanel.tsx' \
  'src/app/[locale]/profile/components/comfyui/WorkflowEditor.tsx' \
  'src/app/[locale]/profile/components/comfyui/WorkflowMappingTable.tsx' \
  tests/unit/components/comfyui-workflow-activation.test.tsx \
  tests/unit/components/comfyui-workflow-library-actions.test.tsx \
  tests/unit/components/comfyui-workflow-mapping-table.test.tsx
git diff --check
```

Expected: TypeScript and ESLint exit 0; `git diff --check` prints nothing.

- [ ] **Step 3: Re-run the existing system-test baseline before the push gate**

Run:

```bash
cross-env SYSTEM_TEST_BOOTSTRAP=1 vitest run tests/system/text-workflow.system.test.ts
```

Expected: record whether the two pre-existing `SIX_GRID_GROUP_IDENTITY_INVALID`
failures reproduce. Do not modify unrelated storyboard production code as part
of this ComfyUI UI fix.

- [ ] **Step 4: Run the repository push gate**

Run:

```bash
npm run verify:push
```

Expected: PASS. If the same pre-existing text-workflow fixture failures block
the gate, report them separately with the focused ComfyUI verification results
and do not claim the full gate passed.

- [ ] **Step 5: Push and verify the remote branch**

```bash
git push duanju main
git fetch duanju main
test "$(git rev-parse HEAD)" = "$(git rev-parse duanju/main)"
git status --short
```

Expected: push succeeds, local and remote SHAs match, and status is empty.
