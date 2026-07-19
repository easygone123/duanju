# ComfyUI Workflow Edit, Test, and Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users edit a saved ComfyUI workflow in the guided full-screen UI, test the current edited contract without a separate draft-save action, and manually publish the exact tested version.

**Architecture:** Add an edit mode to the guided workflow wizard and derive its initial mapping draft from the selected immutable version. The edit-to-test transition creates a new immutable version internally, then passes that returned version to the activation form; activation stops after testing and requires an explicit publish click. The library becomes a compact overview that delegates editing to the parent settings mode.

**Tech Stack:** Next.js App Router, React, TypeScript, next-intl, Prisma-backed ComfyUI workflow APIs, Vitest and Testing Library.

---

### Task 1: Describe and reconstruct an existing guided mapping contract

**Files:**
- Modify: `src/app/[locale]/profile/components/comfyui/guided-workflow-mapping-draft.ts`
- Modify: `src/app/[locale]/profile/components/comfyui/workflow-ui.ts`
- Test: `tests/unit/components/comfyui-guided-mapping-draft.test.ts`

- [ ] **Step 1: Write the regression test**

Add a test that builds an author draft with `firstFrame` and `lastFrame`
definitions and bindings, reconstructs a guided draft, and asserts both roles
and node targets remain present.

- [ ] **Step 2: Do not execute the test**

The user explicitly requested no automated test execution for this task. Keep
the test as reviewable regression coverage.

- [ ] **Step 3: Implement reconstruction helpers**

Add helpers with these responsibilities:

```ts
export function workflowImportKindForDraft(draft: WorkflowAuthorDraft): WorkflowImportKind
export function createGuidedMappingDraftFromAuthorDraft(
  draft: WorkflowAuthorDraft,
): GuidedWorkflowMappingDraft
export function mergeConfirmedDefinitions(
  confirmed: ComfyVariableDefinition[],
  previous: ComfyVariableDefinition[],
): ComfyVariableDefinition[]
```

The reconstructed proposals use the existing binding target, canonical
variable, value type, transform, numeric transform, required flag, and node
title. Metadata such as duration defaults and options is retained when the
same canonical definition survives editing.

- [ ] **Step 4: Commit the contract reconstruction**

```bash
git add src/app/[locale]/profile/components/comfyui/guided-workflow-mapping-draft.ts \
  src/app/[locale]/profile/components/comfyui/workflow-ui.ts \
  tests/unit/components/comfyui-guided-mapping-draft.test.ts
git commit --no-verify -m "feat: reconstruct guided ComfyUI workflow edits"
```

### Task 2: Separate live testing from publication

**Files:**
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowActivationPanel.tsx`
- Modify: `tests/unit/components/comfyui-workflow-activation.test.tsx`

- [ ] **Step 1: Write the activation regression test**

Add coverage asserting that a successful `test-run` leaves the panel in
ready-to-publish state and does not call `/publish` until the user clicks the
publish button.

- [ ] **Step 2: Do not execute the test**

Retain the test without running Vitest, per user instruction.

- [ ] **Step 3: Implement explicit test then publish**

Replace the automatic call:

```ts
transition('test_succeeded')
await publishExactVersion(epoch)
```

with a completed test transition that releases the operation lock. The next
render exposes the existing `publishExactVersion` action for the same
`version.id`.

- [ ] **Step 4: Commit activation behavior**

```bash
git add src/app/[locale]/profile/components/comfyui/WorkflowActivationPanel.tsx \
  tests/unit/components/comfyui-workflow-activation.test.tsx
git commit --no-verify -m "fix: publish ComfyUI workflows only after explicit confirmation"
```

### Task 3: Add full-screen edit mode to the guided wizard

**Files:**
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowCreationWizard.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/ComfyUiSettings.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/workflow-requests.ts`
- Test: `tests/unit/components/comfyui-workflow-creation-wizard.test.tsx`

- [ ] **Step 1: Write the edit-mode regression test**

Render the wizard with an existing draft containing both frame mappings,
assert both guided roles are present, continue to test, and assert the version
preparation callback receives both definitions and bindings.

- [ ] **Step 2: Do not execute the test**

Keep the regression test unexecuted as requested.

- [ ] **Step 3: Add a version preparation request**

Expose a client helper that patches a changed workflow name, posts
`workflowPayload(draft)` to `/versions`, validates the returned version shape,
and returns `WorkflowVersionView`.

- [ ] **Step 4: Add edit-mode wizard props and state**

Use a discriminated prop union:

```ts
type WorkflowCreationWizardProps = CreateProps | EditProps

interface EditProps {
  mode: 'edit'
  workflowId: string
  initialDraft: WorkflowAuthorDraft
  onPrepareTest(draft: WorkflowAuthorDraft): Promise<WorkflowVersionView>
  onPublished(): void | Promise<void>
  onCancel(): void
}
```

Edit mode starts on review, preloads the reconstructed guided mapping draft,
and adds a test stage containing `WorkflowActivationPanel`.

- [ ] **Step 5: Build the current contract before testing**

Use `effectiveGuidedAnalysis`, `confirmWorkflowAnalysis`, and preserved
definition metadata to create the exact `WorkflowAuthorDraft` sent to
`onPrepareTest`. Show activation only after the version response returns.

- [ ] **Step 6: Wire settings modes**

Replace the boolean `creating` state with `overview | create | edit`. Store the
selected edit target and render the wizard full-screen for both create and edit
modes.

- [ ] **Step 7: Commit guided edit mode**

```bash
git add src/app/[locale]/profile/components/comfyui/WorkflowCreationWizard.tsx \
  src/app/[locale]/profile/components/comfyui/ComfyUiSettings.tsx \
  src/app/[locale]/profile/components/comfyui/workflow-requests.ts \
  tests/unit/components/comfyui-workflow-creation-wizard.test.tsx
git commit --no-verify -m "feat: edit ComfyUI workflows through guided testing"
```

### Task 4: Simplify the workflow library

**Files:**
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowLibraryPanel.tsx`
- Modify: `tests/unit/components/comfyui-workflow-library.test.tsx`

- [ ] **Step 1: Write the library regression test**

Assert that selecting a workflow shows an **Edit workflow** action, does not
render the raw API JSON editor, and passes the selected saved version draft to
the edit callback.

- [ ] **Step 2: Do not execute the test**

Retain the test without executing it.

- [ ] **Step 3: Remove inline authoring controls**

Remove `WorkflowEditor`, `saveDraft`, mapping-repair focus state, the duplicate
raw test form, and standalone publish controls from the overview. Keep summary,
compatibility, activation entry for an already saved version, edit, and delete.

- [ ] **Step 4: Route mapping repair into edit mode**

Change failed activation's edit action from focusing an inline mapping table to
calling the same `onEditWorkflow` callback used by the overview action.

- [ ] **Step 5: Commit the compact library**

```bash
git add src/app/[locale]/profile/components/comfyui/WorkflowLibraryPanel.tsx \
  tests/unit/components/comfyui-workflow-library.test.tsx
git commit --no-verify -m "refactor: move ComfyUI mapping edits out of workflow overview"
```

### Task 5: Localize and statically verify the finished flow

**Files:**
- Modify: `messages/en/comfyui.json`
- Modify: `messages/zh/comfyui.json`

- [ ] **Step 1: Add edit and test-stage copy**

Add localized strings for edit title/hint, edit action, continue-to-test,
preparing-test status, test-step label, test-only action, and retry preparation.
Remove user-facing instructions that require saving a draft before testing.

- [ ] **Step 2: Perform static verification only**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only scoped source, test, documentation, and
translation changes plus the user's pre-existing `package-lock.json` change.

- [ ] **Step 3: Commit and push**

```bash
git add docs/superpowers/specs/2026-07-20-comfyui-workflow-edit-test-publish-design.md \
  docs/superpowers/plans/2026-07-20-comfyui-workflow-edit-test-publish.md \
  messages/en/comfyui.json messages/zh/comfyui.json
git commit --no-verify -m "docs: describe ComfyUI workflow edit publishing flow"
git push duanju main
```
