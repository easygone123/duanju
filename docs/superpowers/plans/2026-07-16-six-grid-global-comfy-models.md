# Six-Grid and Global ComfyUI Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make first-time 3×2 storyboard-sheet generation use the project's effective image model with visible failures, and make executable ComfyUI image/video workflows selectable and persistable as global default models.

**Architecture:** The six-grid API remains authoritative for model resolution and falls back from request input to storyboard snapshot to the effective project configuration. Global selectors consume `/api/user/models` as a read-only dynamic option source, while `/api/user/api-config` validates every persisted `comfyui::workflowId` against the authenticated user's published, tested current workflow version. ComfyUI workflow options are never copied into provider or custom-model storage.

**Tech Stack:** Next.js App Router, React, TypeScript, TanStack Query, Prisma, next-intl, Zod.

**Owner verification override:** Do not add or run automated tests. Verify with TypeScript, affected-file ESLint, locale-key parity, focused static contract checks, and `git diff --check` only.

---

### Task 1: Resolve the six-grid generation model on the server

**Files:**
- Modify: `src/app/api/novel-promotion/[projectId]/storyboard-sheet/route.ts`

- [ ] **Step 1: Import the effective project model resolver**

Use the existing configuration service instead of adding a second default-model implementation:

```ts
import {
  getProjectModelConfig,
  resolveProjectImageTaskGenerationOptions,
} from '@/lib/config-service'
```

- [ ] **Step 2: Resolve the generation model in the approved order**

For `operation === 'generate'`, resolve the model from explicit request input, then the storyboard snapshot, then the project's effective storyboard model. Do not load project configuration for upscale requests:

```ts
const projectModelConfig = operation === 'generate'
  && !body.imageModel
  && !storyboard.sheetModelSnapshot
  ? await getProjectModelConfig(projectId, auth.session.user.id)
  : null
const model = operation === 'generate'
  ? body.imageModel || storyboard.sheetModelSnapshot || projectModelConfig?.storyboardModel
  : `comfyui::${workflow!.workflow.id}`
```

Keep `prompt = body.prompt ?? storyboard.sheetPromptSnapshot`, fail closed if either snapshot is missing, and retain the existing ComfyUI ownership/publish/test lookup and generation-option resolution.

- [ ] **Step 3: Preserve the resolved snapshots in the queued task**

Confirm `promptSnapshot`, `modelSnapshot`, `imageModel`, and `generationOptions` all use the resolved values so retries and workers cannot silently switch models.

- [ ] **Step 4: Run focused static checks**

Run:

```bash
npx eslint 'src/app/api/novel-promotion/[projectId]/storyboard-sheet/route.ts'
npx tsc --noEmit
git diff --check
```

Expected: exit code 0 for all commands.

- [ ] **Step 5: Commit the server fix**

```bash
git add 'src/app/api/novel-promotion/[projectId]/storyboard-sheet/route.ts'
HUSKY=0 git commit -m "fix: resolve six-grid generation model"
```

### Task 2: Show per-storyboard six-grid submission failures

**Files:**
- Modify: `src/lib/query/hooks/useSixGridStoryboard.ts`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/hooks/useStoryboardStageController.ts`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardCanvas.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardGroup.types.ts`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardGroup.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/SixGridGroupControls.tsx`
- Modify: `messages/zh/storyboard.json`
- Modify: `messages/en/storyboard.json`

- [ ] **Step 1: Track the failed storyboard and readable message**

Expose the sheet mutation error and input storyboard ID from `useSixGridStoryboard`; keep the existing `Error` produced by `submitTask`. In the controller, derive a stable value:

```ts
const sixGridSheetError = sixGridTasks.sheet.error instanceof Error
  ? {
      storyboardId: sixGridTasks.sheet.variables?.storyboardId || null,
      message: sixGridTasks.sheet.error.message,
    }
  : null
```

Return it with the other six-grid controller state. A new mutation automatically clears React Query's previous mutation error, so retry begins cleanly.

- [ ] **Step 2: Thread only the matching error through the storyboard component tree**

Add `sixGridSheetError: { storyboardId: string | null; message: string } | null` to the canvas/group props and pass `message` to `SixGridGroupControls` only when `storyboardId === storyboard.id`.

- [ ] **Step 3: Render a visible accessible failure under the controls**

Extend `SixGridGroupControls` with `generationError?: string | null` and render:

```tsx
{generationError && (
  <p role="alert" className="mt-3 text-xs text-[var(--glass-danger)]">
    {t('generationFailed', { message: generationError })}
  </p>
)}
```

Add matching locale strings:

```json
"generationFailed": "生成失败：{message}"
```

```json
"generationFailed": "Generation failed: {message}"
```

- [ ] **Step 4: Run focused static checks**

Run affected-file ESLint, `npx tsc --noEmit`, a script that confirms the `storyboard.sixGrid` key sets match in English and Chinese, and `git diff --check`. Expected: all commands exit 0.

- [ ] **Step 5: Commit the UI feedback**

```bash
git add src/lib/query/hooks/useSixGridStoryboard.ts \
  'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard' \
  messages/zh/storyboard.json messages/en/storyboard.json
HUSKY=0 git commit -m "fix: show six-grid generation failures"
```

### Task 3: Add executable ComfyUI options to global image and video selectors

**Files:**
- Modify: `src/app/[locale]/profile/components/api-config-tab/ApiConfigTabContainer.tsx`
- Modify: `src/app/[locale]/profile/components/api-config-tab/DefaultModelCards.tsx`
- Reuse: `src/lib/query/hooks/useUserModels.ts`

- [ ] **Step 1: Load the canonical dynamic model list**

Call `useUserModels()` in `ApiConfigTabContainer`. Do not block the API configuration page on this secondary query and do not merge its data into `providers` or `models`.

- [ ] **Step 2: Adapt generation workflows into selector options**

Create a memoized wrapper around `getEnabledModelsByType`. For `image`, append only `userModels.data.image` options whose provider is `comfyui` and whose `workflowPurpose` is `generation`. For `video`, apply the same rule to `userModels.data.video`. Map each dynamic option to the existing selector contract:

```ts
{
  modelKey: option.value,
  name: option.label,
  provider: 'comfyui',
  providerName: option.providerName || 'ComfyUI',
  capabilities: option.capabilities,
}
```

Deduplicate by `modelKey`, with saved provider models first. Never append `data.upscale` to image or video selectors.

- [ ] **Step 3: Keep `DefaultModelCards` source-agnostic**

Export its `ModelOption` and `ModelType` types if the container needs them. Pass the wrapped callback to `DefaultModelCards`; all four image pipeline selectors and the single video selector will then include eligible ComfyUI workflows without changing their storage behavior.

- [ ] **Step 4: Run focused static checks**

Run:

```bash
npx eslint 'src/app/[locale]/profile/components/api-config-tab/ApiConfigTabContainer.tsx' 'src/app/[locale]/profile/components/api-config-tab/DefaultModelCards.tsx'
npx tsc --noEmit
git diff --check
```

Expected: exit code 0 for all commands.

- [ ] **Step 5: Commit the selector integration**

```bash
git add 'src/app/[locale]/profile/components/api-config-tab/ApiConfigTabContainer.tsx' \
  'src/app/[locale]/profile/components/api-config-tab/DefaultModelCards.tsx'
HUSKY=0 git commit -m "feat: add ComfyUI workflows to global selectors"
```

### Task 4: Validate and sanitize persisted ComfyUI global defaults

**Files:**
- Create: `src/lib/comfyui/workflow-default-model.ts`
- Modify: `src/app/api/user/api-config/route.ts`

- [ ] **Step 1: Centralize default-field eligibility**

Create a helper that parses only `comfyui::workflowId` defaults and queries all referenced workflows in one Prisma call. The allowed fields are:

```ts
export const COMFY_DEFAULT_MEDIA_BY_FIELD = {
  characterModel: 'image',
  locationModel: 'image',
  storyboardModel: 'image',
  editModel: 'image',
  videoModel: 'video',
} as const
```

A valid workflow must belong to `userId`, have `status: 'published'`, use its current version, have `purpose: 'generation'`, match the expected media type, have non-empty `contentHash`, have `publishedAt` and `lastSuccessfulTestAt`, and have a last-test connection owned by the same user. Reuse `isExecutableOwnedWorkflow` for the shared executable checks.

- [ ] **Step 2: Return field-level invalid-default information**

Expose a function accepting `userId` and a partial record of default fields. Return the set of valid Comfy model keys plus invalid entries containing `field` and `modelKey`. Treat ComfyUI keys in analysis/audio/lipsync/voice-design fields as invalid without querying them.

- [ ] **Step 3: Reject invalid ComfyUI defaults on PUT**

Before writing normalized defaults, call the helper. If any invalid entry exists, throw:

```ts
throw new ApiError('INVALID_PARAMS', {
  code: 'COMFY_DEFAULT_MODEL_NOT_EXECUTABLE',
  field: `defaultModels.${invalid.field}`,
  modelKey: invalid.modelKey,
})
```

Update `validateDefaultModelPricing` so a ComfyUI key bypasses built-in cloud pricing only after the authoritative workflow validation has passed.

- [ ] **Step 4: Sanitize stale ComfyUI defaults on GET**

Validate `rawDefaults` for the authenticated user. Preserve valid ComfyUI defaults even when billing is enabled; replace invalid/stale ComfyUI keys with `''`. Then apply the existing billing sanitizer to non-ComfyUI defaults. Do not mutate `customModels` or `customProviders`.

- [ ] **Step 5: Run focused static checks**

Run:

```bash
npx eslint src/lib/comfyui/workflow-default-model.ts 'src/app/api/user/api-config/route.ts'
npx tsc --noEmit
git diff --check
```

Expected: exit code 0 for all commands.

- [ ] **Step 6: Commit the persistence guard**

```bash
git add src/lib/comfyui/workflow-default-model.ts 'src/app/api/user/api-config/route.ts'
HUSKY=0 git commit -m "feat: validate ComfyUI global defaults"
```

### Task 5: Give existing workflows the same test-and-enable path

**Files:**
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowLibraryPanel.tsx`
- Modify: `messages/zh/comfyui.json`
- Modify: `messages/en/comfyui.json`

- [ ] **Step 1: Open activation for the currently selected saved version**

Add local activation state for existing workflows and compute the active ID from the parent-provided activation ID first, then the local one. Add a `testAndEnable` button beside save/delete actions that sets the local activation ID to `selectedId`. Keep `WorkflowActivationPanel` as the single implementation of test → publish → `invalidateUserModels`.

- [ ] **Step 2: Close and refresh cleanly**

When the activation panel closes, clear local activation state and call `onActivationClosed` for parent-driven activation. After activation, reload the selected workflow so its tested/published badges and eligibility update immediately.

- [ ] **Step 3: Add matching labels**

Add `testAndEnable` beneath `comfyui.workflows` in both locale files with Chinese `测试并启用` and English `Test and enable`.

- [ ] **Step 4: Run focused static checks**

Run affected-file ESLint, `npx tsc --noEmit`, locale-key parity for `comfyui.workflows`, and `git diff --check`. Expected: all commands exit 0.

- [ ] **Step 5: Commit the unified activation entry**

```bash
git add 'src/app/[locale]/profile/components/comfyui/WorkflowLibraryPanel.tsx' \
  messages/zh/comfyui.json messages/en/comfyui.json
HUSKY=0 git commit -m "feat: enable existing ComfyUI workflows"
```

### Task 6: Integration review and GitHub delivery

**Files:**
- Review: all files changed since `b4b3e04`

- [ ] **Step 1: Check spec coverage**

Confirm: first six-grid generation has a server default; failures are visible per storyboard; global image selectors include generation but not upscale workflows; global video includes video generation workflows; invalid or cross-user Comfy defaults are rejected; stale GET defaults are cleared; valid Comfy defaults bypass cloud pricing; existing workflows expose test-and-enable.

- [ ] **Step 2: Run the owner-approved verification suite**

Run TypeScript, ESLint on every changed source file, English/Chinese locale parity for changed namespaces, focused source assertions for the model-resolution order and ComfyUI field/media mapping, and `git diff --check`. Do not run repository-wide or automated tests.

- [ ] **Step 3: Review the final diff and history**

```bash
git status --short
git diff --stat b4b3e04..HEAD
git log --oneline b4b3e04..HEAD
```

Expected: only scoped source, locale, spec, and plan changes; each implementation concern has an intentional commit.

- [ ] **Step 4: Push the branch**

```bash
git push --no-verify duanju feat/comfyui-guided-workflow-creation
git rev-parse HEAD
git ls-remote duanju refs/heads/feat/comfyui-guided-workflow-creation
```

Expected: local and remote SHAs match; draft PR `easygone123/duanju#1` receives the updates.
