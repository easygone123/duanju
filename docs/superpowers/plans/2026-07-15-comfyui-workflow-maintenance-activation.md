# ComfyUI Workflow Maintenance and Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make workflow analysis understandable, workflow archival usable, and newly created workflows activatable as selectable models after a successful live test.

**Architecture:** Preserve safe server reason codes through a typed client error, unwrap only the recognized `{prompt: graph}` API payload, and keep archival at the owner-scoped service boundary. Build activation from the existing test-run, publish, connection, test-input, and user-model invalidation primitives so eligibility rules remain unchanged.

**Tech Stack:** React, Next.js, TypeScript, Prisma, next-intl, TanStack Query, Vitest, Testing Library

---

### Task 1: Analysis diagnostics and wrapped API graphs

**Files:**
- Modify: `src/lib/comfyui/workflow-auto-mapper.ts`
- Modify: `src/app/api/comfyui/workflows/analyze/route.ts`
- Modify: `src/app/[locale]/profile/components/comfyui/workflow-ui.ts`
- Modify: `src/app/[locale]/profile/components/comfyui/workflow-requests.ts`
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowCreationWizard.tsx`
- Modify: `messages/zh/comfyui.json`
- Modify: `messages/en/comfyui.json`
- Test: `tests/unit/comfyui/workflow-auto-mapper.test.ts`
- Test: `tests/integration/api/contract/comfyui-workflow-analyze-route.test.ts`
- Test: `tests/unit/components/comfyui-workflow-creation-wizard.test.tsx`

- [ ] **Step 1: Write failing server and mapper tests**

Prove a wrapped graph is accepted:

```ts
const result = analyzeComfyApiWorkflow({
  graph: { prompt: apiGraph },
  kind: 'image_generation',
})
expect(result.graph).toEqual(apiGraph)
```

Keep distinct assertions for normal UI `{nodes, links}` yielding `COMFY_WORKFLOW_API_FORMAT_REQUIRED` and malformed nodes yielding `COMFY_WORKFLOW_API_FORMAT_INVALID`.

- [ ] **Step 2: Write a failing client diagnostic test**

Mock a 400 response:

```ts
{
  error: {
    code: 'INVALID_PARAMS',
    details: { reason: 'COMFY_WORKFLOW_API_FORMAT_REQUIRED' },
  },
}
```

Assert the wizard renders the localized API Format re-export instruction, not the generic invalid-settings text and not any raw response content.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
npx vitest run tests/unit/comfyui/workflow-auto-mapper.test.ts tests/integration/api/contract/comfyui-workflow-analyze-route.test.ts tests/unit/components/comfyui-workflow-creation-wizard.test.tsx
```

Expected: wrapper and reason-preservation cases fail.

- [ ] **Step 4: Implement bounded wrapper extraction and typed reasons**

Only unwrap an object-valued `prompt` graph. Do not convert normal UI Workflow JSON. Extend `WorkflowRequestError` to retain an optional allowlisted `reason`, map known reasons to `guided.issues.*`, and map unknown reasons to the existing safe fallback.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 3 command. Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/comfyui/workflow-auto-mapper.ts src/app/api/comfyui/workflows/analyze/route.ts 'src/app/[locale]/profile/components/comfyui/workflow-ui.ts' 'src/app/[locale]/profile/components/comfyui/workflow-requests.ts' 'src/app/[locale]/profile/components/comfyui/WorkflowCreationWizard.tsx' messages/zh/comfyui.json messages/en/comfyui.json tests/unit/comfyui/workflow-auto-mapper.test.ts tests/integration/api/contract/comfyui-workflow-analyze-route.test.ts tests/unit/components/comfyui-workflow-creation-wizard.test.tsx
git commit -m "fix: explain ComfyUI workflow analysis failures"
```

### Task 2: Archived-workflow filtering

**Files:**
- Modify: `src/lib/comfyui/workflow-service.ts`
- Test: `tests/integration/api/contract/comfyui-workflows-route.test.ts`

- [ ] **Step 1: Write the failing list query test**

Assert `listOwnedWorkflows('user-1')` queries:

```ts
where: { userId: 'user-1', status: { not: 'archived' } }
```

Retain the existing project-default conflict and owner-scope tests.

- [ ] **Step 2: Run the route suite and verify RED**

```bash
npx vitest run tests/integration/api/contract/comfyui-workflows-route.test.ts
```

Expected: the list filter assertion fails.

- [ ] **Step 3: Filter archived workflows in `listOwnedWorkflows`**

Change only the active list query; keep ordering and version includes intact.

- [ ] **Step 4: Run the route suite and verify GREEN**

Run the Step 2 command. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/comfyui/workflow-service.ts tests/integration/api/contract/comfyui-workflows-route.test.ts
git commit -m "fix: hide archived ComfyUI workflows"
```

### Task 3: Confirmed workflow archival in the library

**Files:**
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowLibraryPanel.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/workflow-ui.ts`
- Modify: `messages/zh/comfyui.json`
- Modify: `messages/en/comfyui.json`
- Create: `tests/unit/components/comfyui-workflow-library-actions.test.tsx`
- Test: `tests/unit/components/comfyui-workflow-settings.test.ts`

- [ ] **Step 1: Write failing UI behavior tests**

Cover canceling confirmation, confirmed DELETE to the encoded owned-workflow route, successful selection reset/reload, safe 409 project-default guidance, and absence of delete for `selectedId === 'new'`.

- [ ] **Step 2: Run component tests and verify RED**

```bash
npx vitest run tests/unit/components/comfyui-workflow-library-actions.test.tsx tests/unit/components/comfyui-workflow-settings.test.ts
```

Expected: no removal action exists.

- [ ] **Step 3: Implement the destructive action**

The success path must be equivalent to:

```ts
await requestJson(`/api/comfyui/workflows/${encodeURIComponent(selectedId)}`, {
  method: 'DELETE',
})
setSelectedId('new')
setSavedVersion(null)
setAuthorDraft(emptyWorkflowDraft())
await load()
```

Use confirmation, current busy/error regions, a destructive button tone, and a distinct safe message for the project-default conflict.

- [ ] **Step 4: Run component tests and verify GREEN**

Run the Step 2 command. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/[locale]/profile/components/comfyui/WorkflowLibraryPanel.tsx' 'src/app/[locale]/profile/components/comfyui/workflow-ui.ts' messages/zh/comfyui.json messages/en/comfyui.json tests/unit/components/comfyui-workflow-library-actions.test.tsx tests/unit/components/comfyui-workflow-settings.test.ts
git commit -m "feat: add ComfyUI workflow removal"
```

### Task 4: Guided live-test and publish activation

**Files:**
- Create: `src/app/[locale]/profile/components/comfyui/WorkflowActivationPanel.tsx`
- Create: `src/app/[locale]/profile/components/comfyui/workflow-activation.ts`
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowLibraryPanel.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowCreationWizard.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/workflow-requests.ts`
- Modify: `messages/zh/comfyui.json`
- Modify: `messages/en/comfyui.json`
- Create: `tests/unit/components/comfyui-workflow-activation.test.tsx`
- Test: `tests/integration/api/specific/user-models-comfyui.test.ts`

- [ ] **Step 1: Write failing activation state tests**

Define a small state model that proves:

```ts
expect(nextActivationState('test_succeeded')).toMatchObject({
  testComplete: true,
  publishRequired: true,
})
expect(nextActivationState('publish_failed', { testComplete: true })).toMatchObject({
  testComplete: true,
  publishRequired: true,
})
```

The retry after `publish_failed` must not request another test run.

- [ ] **Step 2: Write failing rendered-flow tests**

Cover: no enabled instance; incomplete required test inputs; test failure never calling publish; successful test calling publish with the exact tested version; successful publish invalidating `['user-models']`; and publish-only retry.

- [ ] **Step 3: Run activation tests and verify RED**

```bash
npx vitest run tests/unit/components/comfyui-workflow-activation.test.tsx tests/integration/api/specific/user-models-comfyui.test.ts
```

Expected: activation components and state model do not exist.

- [ ] **Step 4: Implement activation using existing primitives**

Reuse `WorkflowTestForm`, `useComfyConnections`, test-run, publish, and `invalidateUserModels`. After workflow creation, keep the created workflow/version selected and render activation. Submit:

```ts
await requestJson(`/api/comfyui/workflows/${workflowId}/test-run`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ versionId, connectionId, variables, uploads }),
})
await requestJson(`/api/comfyui/workflows/${workflowId}/publish`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ versionId }),
})
await invalidateUserModels(queryClient)
```

If test succeeds but publish fails, persist `testComplete: true` and retry only publish. Closing activation preserves the draft.

- [ ] **Step 5: Run activation tests and verify GREEN**

Run the Step 3 command. Expected: all pass and existing eligibility exclusions remain covered.

- [ ] **Step 6: Commit**

```bash
git add 'src/app/[locale]/profile/components/comfyui/WorkflowActivationPanel.tsx' 'src/app/[locale]/profile/components/comfyui/workflow-activation.ts' 'src/app/[locale]/profile/components/comfyui/WorkflowLibraryPanel.tsx' 'src/app/[locale]/profile/components/comfyui/WorkflowCreationWizard.tsx' 'src/app/[locale]/profile/components/comfyui/workflow-requests.ts' messages/zh/comfyui.json messages/en/comfyui.json tests/unit/components/comfyui-workflow-activation.test.tsx tests/integration/api/specific/user-models-comfyui.test.ts
git commit -m "feat: activate ComfyUI workflows as models"
```

### Task 5: Verification

**Files:**
- Verify only

- [ ] **Step 1: Run focused suites**

```bash
npx vitest run tests/unit/comfyui/workflow-auto-mapper.test.ts tests/integration/api/contract/comfyui-workflow-analyze-route.test.ts tests/integration/api/contract/comfyui-workflows-route.test.ts tests/unit/components/comfyui-workflow-creation-wizard.test.tsx tests/unit/components/comfyui-workflow-library-actions.test.tsx tests/unit/components/comfyui-workflow-activation.test.tsx tests/integration/api/specific/user-models-comfyui.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run the repository gate**

```bash
npm run verify:commit
```

Expected: lint has no errors, typecheck passes, and all tests pass.

- [ ] **Step 3: Confirm a clean diff**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and no uncommitted task files.
