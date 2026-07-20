# Four-Grid Sheet Submit Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the “Generate 2×2 four-grid” button reliably submit one whole-sheet image task, then require cropping instead of allowing independent panel generation.

**Architecture:** Split storyboard text-task state from grid-sheet-task state so unrelated or stale text work cannot disable the sheet button. Keep the existing single-provider `storyboard_sheet_generate` backend path, and add a server-side ownership/layout guard to the generic panel-image endpoint so grid panels cannot bypass the whole-sheet workflow.

**Tech Stack:** Next.js App Router, React, TanStack Query, TypeScript, Prisma, Vitest/Testing Library test sources.

**Verification constraint:** The user requires code changes without executing tests, build, TypeScript, Prisma, or provider/ComfyUI commands. Write regression tests before production changes, but do not execute them. Use only static source review, JSON parsing, and `git diff --check`; report the runtime verification gap explicitly.

---

### Task 1: Separate text and grid-sheet task state

**Files:**
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/hooks/useStoryboardTaskAwareStoryboards.ts`
- Modify: `src/types/project.ts`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardGroup.tsx`
- Test: `tests/unit/components/six-grid-storyboard-controls.test.ts`

- [ ] **Step 1: Add the regression contract before production changes**

Update the task-contract test so it requires separate text and grid task lists:

```ts
expect(buildStoryboardTaskTypeContract()).toEqual({
  text: ['regenerate_storyboard_text', 'insert_panel'],
  grid: ['storyboard_sheet_generate', 'storyboard_sheet_upscale', 'storyboard_sheet_crop'],
  panel: ['storyboard_panel_upscale'],
})
```

Add a source-level projection assertion requiring independent fields:

```ts
expect(taskAwareSource).toContain('storyboardTaskRunning:')
expect(taskAwareSource).toContain('gridTaskRunning:')
expect(groupSource).toContain('storyboard.gridTaskRunning')
expect(groupSource).not.toContain(
  'isGridGroupBusy(isSixGridTaskRunning, isSubmittingStoryboardTask)',
)
```

- [ ] **Step 2: Do not run the regression test**

The normal RED command would be:

```bash
pnpm vitest tests/unit/components/six-grid-storyboard-controls.test.ts
```

Do not execute it because the user explicitly prohibited test commands. Record that RED was not observed.

- [ ] **Step 3: Define the split task contract**

Replace the mixed contract with:

```ts
export function buildStoryboardTaskTypeContract() {
  return {
    text: ['regenerate_storyboard_text', 'insert_panel'],
    grid: ['storyboard_sheet_generate', 'storyboard_sheet_upscale', 'storyboard_sheet_crop'],
    panel: ['storyboard_panel_upscale'],
  }
}
```

Keep a compatibility alias only if another source consumer still imports `buildSixGridTaskTypeContract`; the alias must return the same split object rather than recombining text and grid states.

- [ ] **Step 4: Query and project the states independently**

Build one target list for text tasks and one for grid tasks. Call `useStoryboardTaskPresentation` separately because target whitelists are part of the query identity. Project the result as:

```ts
storyboardTaskRunning: isRunningPhase(
  storyboardTextStates.getTaskState(`storyboard:${storyboard.id}`)?.phase,
),
gridTaskRunning: isRunningPhase(
  storyboardGridStates.getTaskState(`storyboard-grid:${storyboard.id}`)?.phase,
),
```

Episode-level text targets remain text-only. Grid tasks remain scoped to `NovelPromotionStoryboard`.

- [ ] **Step 5: Add the derived type and consume it in the grid controls**

Add to `NovelPromotionStoryboard`:

```ts
gridTaskRunning?: boolean
```

Change the group busy state to:

```ts
const isGridGroupTaskRunning = isGridGroupBusy(
  isSixGridTaskRunning,
  Boolean(storyboard.gridTaskRunning),
)
```

Keep `isSubmittingStoryboardTask` for text overlays only; it must not disable the sheet button.

- [ ] **Step 6: Static review and commit**

Run only:

```bash
rg -n "storyboardTaskRunning|gridTaskRunning|storyboard_sheet_generate" \
  'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard' \
  src/types/project.ts tests/unit/components/six-grid-storyboard-controls.test.ts
git diff --check
```

Expected: text and grid states are visibly separate; `git diff --check` has no output.

Commit:

```bash
git add \
  'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/hooks/useStoryboardTaskAwareStoryboards.ts' \
  'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardGroup.tsx' \
  src/types/project.ts \
  tests/unit/components/six-grid-storyboard-controls.test.ts
git commit --no-verify -m "fix: separate grid sheet task state"
```

### Task 2: Make sheet submission feedback explicit

**Files:**
- Modify: `src/lib/query/hooks/useSixGridStoryboard.ts`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/GridGroupControls.tsx`
- Modify: `messages/zh/storyboard.json`
- Modify: `messages/en/storyboard.json`
- Test: `tests/unit/components/grid-storyboard-controls.test.tsx`
- Test: `tests/unit/query/grid-sheet-submit-mutation.test.ts`

- [ ] **Step 1: Write UI and mutation regression tests first**

Add component cases requiring visible running feedback and a reason on the disabled button:

```tsx
const view = render(withIntl(
  <GridGroupControls
    storyboard={storyboard('four_grid', { sheetImageUrl: null })}
    {...controlProps}
    isTaskRunning
  />,
))
expect(view.getByRole('button', { name: 'Submitting whole sheet' }))
  .toHaveProperty('disabled', true)
expect(view.getByText('Generating one complete 2x2 sheet')).toBeTruthy()
```

Add a mutation-options test that invokes `onError` and requires both overlay cleanup and the storyboard-scoped error to be set. Require `onSuccess` to refresh the storyboard group while preserving task-state handoff.

- [ ] **Step 2: Do not execute the tests**

Do not run:

```bash
pnpm vitest \
  tests/unit/components/grid-storyboard-controls.test.tsx \
  tests/unit/query/grid-sheet-submit-mutation.test.ts
```

Record that runtime event handling remains user-verified.

- [ ] **Step 3: Extract sheet mutation options for deterministic behavior**

Export a focused factory from `useSixGridStoryboard.ts`:

```ts
export function createSheetTaskMutationOptions(params: {
  queryClient: QueryClient
  projectId: string
  episodeId: string
  onGenerationError: (storyboardId: string, message: string | null) => void
  nextAttempt: (storyboardId: string) => number
  currentAttempt: (storyboardId: string) => number
}) {
  return {
    mutationFn: (input: SheetTaskInput) =>
      submitTask(buildSheetTaskRequest(params.projectId, input)),
    // Preserve the existing optimistic overlay, error ordering, and scoped refresh.
  }
}
```

The hook must use this factory. On request rejection, clear the optimistic overlay and store the actual error. On successful submission, refresh the group and let task-state polling/SSE represent the queued task.

- [ ] **Step 4: Show unambiguous whole-sheet progress**

In `GridGroupControls`, change only the running label/description. The generate button remains the sole sheet-generation action:

```tsx
<button
  type="button"
  disabled={isTaskRunning}
  aria-busy={isTaskRunning}
  title={isTaskRunning ? t('wholeSheetRunningHint') : undefined}
  onClick={onGenerateSheet}
>
  {isTaskRunning ? t('submittingWholeSheet') : generateLabel}
</button>
```

Render a compact status message while busy:

```tsx
{isTaskRunning && <p role="status">{t(`wholeSheetRunning.${mode}`)}</p>}
```

Add Chinese and English translations that explicitly say one complete sheet is being generated, not four independent images.

- [ ] **Step 5: Parse locales and commit**

Run only:

```bash
node -e "for (const f of ['messages/zh/storyboard.json','messages/en/storyboard.json']) JSON.parse(require('fs').readFileSync(f,'utf8'))"
git diff --check
```

Expected: exit code 0; no output from `git diff --check`.

Commit:

```bash
git add \
  src/lib/query/hooks/useSixGridStoryboard.ts \
  'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/GridGroupControls.tsx' \
  messages/zh/storyboard.json messages/en/storyboard.json \
  tests/unit/components/grid-storyboard-controls.test.tsx \
  tests/unit/query/grid-sheet-submit-mutation.test.ts
git commit --no-verify -m "fix: surface four-grid sheet submission"
```

### Task 3: Enforce whole-sheet generation on the server

**Files:**
- Modify: `src/app/api/novel-promotion/[projectId]/regenerate-panel-image/route.ts`
- Test: `tests/integration/api/contract/grid-panel-image-generation.route.test.ts`
- Modify if required by the test harness: `tests/integration/api/contract/direct-submit-routes.test.ts`

- [ ] **Step 1: Write route behavior tests first**

Create focused route cases:

```ts
it.each(['four_grid', 'six_grid'])('rejects %s panel image generation', async (layoutMode) => {
  prismaMock.novelPromotionPanel.findFirst.mockResolvedValueOnce({
    id: 'panel-1', storyboard: { layoutMode },
  })
  const response = await invoke({ panelId: 'panel-1' })
  expect(response.status).toBe(400)
  await expect(response.json()).resolves.toMatchObject({
    error: expect.objectContaining({
      code: 'INVALID_PARAMS',
      details: expect.objectContaining({
        code: 'GRID_PANEL_INDIVIDUAL_GENERATION_UNSUPPORTED',
      }),
    }),
  })
  expect(submitTaskMock).not.toHaveBeenCalled()
})

it('keeps individual panel generation available', async () => {
  prismaMock.novelPromotionPanel.findFirst.mockResolvedValueOnce({
    id: 'panel-1', storyboard: { layoutMode: 'individual' },
  })
  const response = await invoke({ panelId: 'panel-1' })
  expect(response.status).toBe(200)
  expect(submitTaskMock).toHaveBeenCalledTimes(1)
})
```

Also require a foreign/missing panel to return `NOT_FOUND` before model selection, billing, output lookup, or task submission.

- [ ] **Step 2: Do not execute the route test**

Do not run:

```bash
pnpm vitest tests/integration/api/contract/grid-panel-image-generation.route.test.ts
```

- [ ] **Step 3: Add an owned panel layout lookup before side effects**

Immediately after request validation and locale resolution, query:

```ts
const panel = await prisma.novelPromotionPanel.findFirst({
  where: {
    id: panelId,
    storyboard: {
      episode: {
        novelPromotionProject: {
          projectId,
          project: { userId: session.user.id },
        },
      },
    },
  },
  select: { storyboard: { select: { layoutMode: true } } },
})
if (!panel) throw new ApiError('NOT_FOUND')
if (panel.storyboard.layoutMode === 'four_grid'
  || panel.storyboard.layoutMode === 'six_grid') {
  throw new ApiError('INVALID_PARAMS', {
    code: 'GRID_PANEL_INDIVIDUAL_GENERATION_UNSUPPORTED',
    field: 'panelId',
  })
}
```

This check must run before `getProjectModelConfig`, `resolveModelSelection`, billing construction, `hasPanelImageOutput`, and `submitTask`.

- [ ] **Step 4: Check direct-submit contract compatibility and commit**

Update existing route mocks/fixtures so the normal authenticated direct-submit case returns an owned `individual` panel. Do not weaken the new ownership/layout assertions.

Run only:

```bash
rg -n "GRID_PANEL_INDIVIDUAL_GENERATION_UNSUPPORTED|layoutMode|submitTask" \
  'src/app/api/novel-promotion/[projectId]/regenerate-panel-image/route.ts' \
  tests/integration/api/contract/grid-panel-image-generation.route.test.ts \
  tests/integration/api/contract/direct-submit-routes.test.ts
git diff --check
```

Commit:

```bash
git add \
  'src/app/api/novel-promotion/[projectId]/regenerate-panel-image/route.ts' \
  tests/integration/api/contract/grid-panel-image-generation.route.test.ts \
  tests/integration/api/contract/direct-submit-routes.test.ts
git commit --no-verify -m "fix: require sheet generation for grid panels"
```

### Task 4: Static verification and local integration

**Files:**
- Review all files changed by Tasks 1-3.
- Preserve the user's unrelated main-worktree `package-lock.json` modification.

- [ ] **Step 1: Check the direct sheet path has no compositor**

Run:

```bash
rg -n "STORYBOARD_SHEET_GENERATE|resolveImageSourceFromGeneration|uploadImageSourceToCos" \
  src/lib/workers/image.worker.ts \
  src/lib/workers/handlers/storyboard-sheet-task-handler.ts
rg -n "composite\(|stitch|montage" \
  src/lib/workers/handlers/storyboard-sheet-task-handler.ts \
  src/lib/novel-promotion/grid-storyboard
```

Expected: one task handler/provider call path; no image-compositing hit.

- [ ] **Step 2: Run allowed static gates**

```bash
git diff --check
node -e "for (const f of ['messages/zh/storyboard.json','messages/en/storyboard.json']) JSON.parse(require('fs').readFileSync(f,'utf8'))"
rg -n "TBD|TODO|FIXME|<<<<<<<|=======|>>>>>>>" \
  src/lib/query/hooks/useSixGridStoryboard.ts \
  'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard' \
  'src/app/api/novel-promotion/[projectId]/regenerate-panel-image/route.ts'
```

Expected: clean diff/JSON; marker scan has no implementation placeholders or conflict markers.

- [ ] **Step 3: Explicitly record unexecuted validation**

Do not run Vitest/Jest, build, TypeScript, Prisma, or provider/ComfyUI commands. The handoff must say that test sources were authored but neither RED nor GREEN was executed, and the user must verify the browser/network/ComfyUI behavior.

- [ ] **Step 4: Review the full branch**

```bash
git status --short
git log --oneline --decorate main..HEAD
git diff --stat main..HEAD
git diff --name-only main..HEAD
```

Expected: only the design, plan, task-state/UI, route, locale, and regression-test files; no `package-lock.json`.

- [ ] **Step 5: Integrate locally only after review**

After spec and quality review, fast-forward local `main`, rerun the allowed static gates on the merged result, remove this worktree and temporary branch, and leave `duanju/main` untouched until the user explicitly asks to push.
