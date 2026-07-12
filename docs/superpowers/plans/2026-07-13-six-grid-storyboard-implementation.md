# Six-Grid Storyboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in continuous six-shot storyboard pipeline that generates one 3-by-2 sheet, supports deterministic crop and both upscale orders, and carries dialogue, duration, and first/last-frame data into video generation.

**Architecture:** Preserve the existing Clip/Storyboard/Panel downstream model while making one six-grid storyboard own exactly six panels. Add explicit media lineage and immutable task snapshots, use Sharp for deterministic crop, and route image/upscale work through the existing provider and ComfyUI task infrastructure.

**Tech Stack:** Next.js 15, React 19, TypeScript, Prisma/MySQL, BullMQ/Redis, Sharp, React Query, Vitest, ComfyUI provider runtime.

---

## File Structure

New focused modules:

- `src/lib/novel-promotion/six-grid/contracts.ts`: six-grid enums, schemas, and runtime validation.
- `src/lib/novel-promotion/six-grid/scene-planner.ts`: scene grouping and exactly-six validation.
- `src/lib/novel-promotion/six-grid/prompt-builder.ts`: sheet prompt and continuity-anchor composition.
- `src/lib/novel-promotion/six-grid/duration.ts`: duration estimation and capability resolution.
- `src/lib/novel-promotion/six-grid/crop-geometry.ts`: exact pixel partitioning and normalized crops.
- `src/lib/novel-promotion/six-grid/crop-service.ts`: Sharp/media storage crop execution.
- `src/lib/workers/handlers/storyboard-sheet-task-handler.ts`: sheet generation and full-sheet upscale.
- `src/lib/workers/handlers/storyboard-crop-task-handler.ts`: group crop and panel upscale orchestration.
- `src/app/api/novel-promotion/[projectId]/storyboard-sheet/route.ts`: sheet task submission.
- `src/app/api/novel-promotion/[projectId]/storyboard-sheet/crop/route.ts`: crop/recrop submission.
- `src/app/api/novel-promotion/[projectId]/storyboard-panel/upscale/route.ts`: panel upscale submission.
- `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/SixGridGroupControls.tsx`: group actions.
- `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/SixGridCropModal.tsx`: ratio-locked crop UI.

Existing orchestration, cards, video runtime, task catalogs, translations, and API contracts are extended rather than duplicated.

### Task 1: Persisted Six-Grid Domain Contract

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `prisma/schema.sqlit.prisma`
- Create: `prisma/migrations/20260713010000_add_six_grid_storyboards/migration.sql`
- Create: `src/lib/novel-promotion/six-grid/contracts.ts`
- Create: `tests/unit/novel-promotion/six-grid-contracts.test.ts`
- Modify: `src/types/project.ts`

- [ ] **Step 1: Write failing schema and runtime-contract tests**

```ts
import { describe, expect, it } from 'vitest'
import { parseSixGridRunSettings, parseCropRect } from '@/lib/novel-promotion/six-grid/contracts'

describe('six-grid contracts', () => {
  it('accepts a snapshotted portrait crop-after-upscale run', () => {
    expect(parseSixGridRunSettings({
      mode: 'six_grid', cellAspectRatio: '9:16',
      processingOrder: 'sheet_upscale_then_crop',
    })).toEqual({
      mode: 'six_grid', cellAspectRatio: '9:16',
      processingOrder: 'sheet_upscale_then_crop',
    })
  })

  it('rejects an out-of-bounds crop rectangle', () => {
    expect(() => parseCropRect({ x: -0.01, y: 0, width: 1 / 3, height: 1 / 2 }))
      .toThrow('SIX_GRID_CROP_OUT_OF_BOUNDS')
  })
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/novel-promotion/six-grid-contracts.test.ts`

Expected: FAIL because `six-grid/contracts` does not exist.

- [ ] **Step 3: Add explicit schema fields and strict parsers**

Add nullable/default-compatible project settings, storyboard sheet media relations and snapshots, and panel crop/dialogue/duration/lineage fields. Define:

```ts
export type StoryboardGenerationMode = 'individual' | 'six_grid'
export type SixGridCellAspectRatio = '16:9' | '9:16'
export type SixGridProcessingOrder = 'sheet_upscale_then_crop' | 'crop_then_panel_upscale'
export type NormalizedCropRect = { x: number; y: number; width: number; height: number }
```

Migration defaults existing rows to `individual`, leaves new media fields nullable, adds indexes for `(episodeId, layoutMode, groupSequence)` and does not rewrite media URLs.

- [ ] **Step 4: Generate Prisma clients and verify GREEN**

Run: `npx prisma generate && BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/novel-promotion/six-grid-contracts.test.ts && npm run typecheck`

Expected: contract tests and typecheck pass.

- [ ] **Step 5: Commit**

```bash
git add prisma src/lib/novel-promotion/six-grid/contracts.ts src/types/project.ts tests/unit/novel-promotion/six-grid-contracts.test.ts
git commit -m "feat: add six-grid storyboard domain"
```

### Task 2: Configuration and Immutable Run Snapshot

**Files:**
- Modify: `src/lib/config-service.ts`
- Modify: `src/lib/model-config-contract.ts`
- Modify: `src/app/api/novel-promotion/[projectId]/script-to-storyboard-stream/route.ts`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/ConfigStage.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/hooks/useWorkspaceConfigActions.ts`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/hooks/useWorkspaceExecution.ts`
- Create: `tests/unit/novel-promotion/six-grid-run-settings.test.ts`
- Create: `tests/integration/api/contract/script-to-storyboard-stream.route.test.ts`
- Modify: `messages/zh.json`
- Modify: `messages/en.json`

- [ ] **Step 1: Write failing tests for selection and snapshot precedence**

```ts
it('snapshots explicit launch settings ahead of project defaults', () => {
  expect(resolveStoryboardRunSettings({
    task: { mode: 'six_grid', cellAspectRatio: '16:9' },
    project: { mode: 'individual', cellAspectRatio: '9:16' },
  })).toMatchObject({ mode: 'six_grid', cellAspectRatio: '16:9' })
})
```

Also assert inherited project video ratio resolves only to `16:9` or `9:16`, and an unsupported inherited ratio blocks six-grid launch.

- [ ] **Step 2: Verify RED**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/novel-promotion/six-grid-run-settings.test.ts`

Expected: FAIL because the resolver and launch fields are absent.

- [ ] **Step 3: Implement settings resolution and launch UI**

Add the mode, cell ratio, processing order, upscale model, and dialogue video model to the project configuration contract. Send the complete resolved settings in the script-to-storyboard task payload and GraphRun input. The UI displays the mode and ratio before launch; settings are disabled once the run starts.

- [ ] **Step 4: Verify GREEN and route coverage**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/novel-promotion/six-grid-run-settings.test.ts tests/integration/api/contract/script-to-storyboard-stream.route.test.ts && npm run check:api-handler`

Expected: settings and route tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/config-service.ts src/lib/model-config-contract.ts src/app messages tests/unit/novel-promotion/six-grid-run-settings.test.ts
git commit -m "feat: configure six-grid storyboard runs"
```

### Task 3: Continuous Scene Planner

**Files:**
- Create: `src/lib/novel-promotion/six-grid/scene-planner.ts`
- Create: `tests/unit/novel-promotion/six-grid-scene-planner.test.ts`
- Modify: `src/lib/novel-promotion/script-to-storyboard/orchestrator.ts`
- Modify: `src/lib/workers/handlers/script-to-storyboard.ts`

- [ ] **Step 1: Write failing scene and grouping tests**

```ts
it('never crosses a hard location boundary to fill six cells', () => {
  const groups = validateAndNormalizeSixGridGroups([
    group('room-a', sixShots('room-a')),
    group('street', sixShots('street')),
  ])
  expect(groups).toHaveLength(2)
  expect(groups.every((g) => new Set(g.panels.map((p) => p.location)).size === 1)).toBe(true)
})

it('rejects five-shot output instead of persisting it', () => {
  expect(() => validateAndNormalizeSixGridGroups([group('room-a', sixShots('room-a').slice(0, 5))]))
    .toThrow('SIX_GRID_REQUIRES_EXACTLY_SIX_PANELS')
})
```

Add a long-scene test proving group 2 receives group 1's outgoing anchor.

- [ ] **Step 2: Verify RED**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/novel-promotion/six-grid-scene-planner.test.ts`

Expected: FAIL because the planner does not exist.

- [ ] **Step 3: Implement the planner boundary**

Define `SixGridSceneGroup` with `sceneKey`, `incomingContinuity`, `outgoingContinuity`, and exactly six `StoryboardPanel` items. Add a whole-episode planning step before per-group cinematography. Preserve the existing per-clip branch when mode is `individual`.

- [ ] **Step 4: Verify GREEN and existing orchestrator regressions**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/novel-promotion/six-grid-scene-planner.test.ts tests/unit/worker/script-to-storyboard-orchestrator.retry.test.ts tests/unit/worker/script-to-storyboard.test.ts`

Expected: new and existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/novel-promotion src/lib/workers/handlers/script-to-storyboard.ts tests/unit/novel-promotion tests/unit/worker
git commit -m "feat: plan continuous six-shot scenes"
```

### Task 4: Sheet Prompt, Dialogue Metadata, and Duration

**Files:**
- Create: `src/lib/novel-promotion/six-grid/prompt-builder.ts`
- Create: `src/lib/novel-promotion/six-grid/duration.ts`
- Create: `tests/unit/novel-promotion/six-grid-prompt.test.ts`
- Create: `tests/unit/novel-promotion/panel-duration.test.ts`
- Modify: `src/lib/prompt-i18n.ts`
- Modify: `messages/zh.json`
- Modify: `messages/en.json`

- [ ] **Step 1: Write failing prompt and duration tests**

```ts
it('builds a strict 3x2 prompt without literal dialogue', () => {
  const prompt = buildSixGridSheetPrompt(groupWithDialogue('不要离开'))
  expect(prompt).toContain('3 columns x 2 rows')
  expect(prompt).toContain('no text, captions, speech bubbles, watermarks, logos, borders, or gutters')
  expect(prompt).not.toContain('不要离开')
})

it('selects the nearest supported duration that is not shorter', () => {
  expect(resolveSupportedDuration(7.2, [5, 10])).toBe(10)
  expect(() => resolveSupportedDuration(12, [5, 10])).toThrow('VIDEO_DURATION_TOO_SHORT')
})
```

- [ ] **Step 2: Verify RED**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/novel-promotion/six-grid-prompt.test.ts tests/unit/novel-promotion/panel-duration.test.ts`

Expected: FAIL because builders do not exist.

- [ ] **Step 3: Implement pure builders**

Generate a shared continuity block plus six ordered visual beats. Store dialogue as `{ hasDialogue, speaker, text, emotion, includeInVideoPrompt }`. Estimate non-dialogue duration from action/camera complexity and dialogue duration from readable character count plus acting margin. Keep estimated and user override values separate.

- [ ] **Step 4: Verify GREEN**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/novel-promotion/six-grid-prompt.test.ts tests/unit/novel-promotion/panel-duration.test.ts && npm run check:prompt-i18n`

Expected: prompt, duration, and i18n guards pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/novel-promotion/six-grid src/lib/prompt-i18n.ts messages tests/unit/novel-promotion
git commit -m "feat: build six-grid prompts and timing"
```

### Task 5: Atomic Persistence and Media Lineage

**Files:**
- Modify: `src/lib/workers/handlers/script-to-storyboard-helpers.ts`
- Modify: `src/lib/run-runtime/types.ts`
- Modify: `src/lib/run-runtime/service.ts`
- Create: `tests/integration/six-grid/six-grid-persistence.integration.test.ts`

- [ ] **Step 1: Write failing persistence tests**

Seed a six-grid run, persist one group, and assert exactly six panels, immutable run settings, continuity JSON, dialogue metadata, estimated duration, and null image artifacts. Re-run the same persistence input and assert no duplicate storyboard or panels.

- [ ] **Step 2: Verify RED with Docker**

Run: `BILLING_TEST_BOOTSTRAP=1 npx vitest run tests/integration/six-grid/six-grid-persistence.integration.test.ts`

Expected: FAIL because schema fields and six-grid persistence mapping are not wired.

- [ ] **Step 3: Implement transactional persistence**

Extend `persistStoryboardOutputs` to branch by snapshotted mode. Upsert one storyboard per planned group, replace its six text panels atomically, persist GraphArtifacts for planner outputs, and map voice-line references to the new persisted panel IDs. Preserve current individual-mode behavior.

- [ ] **Step 4: Verify GREEN and legacy behavior**

Run: `BILLING_TEST_BOOTSTRAP=1 npx vitest run tests/integration/six-grid/six-grid-persistence.integration.test.ts tests/system/text-workflow.system.test.ts`

Expected: both modes pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workers/handlers/script-to-storyboard-helpers.ts src/lib/run-runtime tests/integration/six-grid
git commit -m "feat: persist six-grid storyboard groups"
```

### Task 6: Upscale Workflow Capability

**Files:**
- Modify: `src/lib/comfyui/domain.ts`
- Modify: `src/lib/comfyui/workflow-compiler.ts`
- Modify: `src/lib/comfyui/workflow-service.ts`
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowLibraryPanel.tsx`
- Modify: `src/app/[locale]/profile/components/comfyui/WorkflowEditor.tsx`
- Create: `tests/unit/comfyui/upscale-workflow.test.ts`
- Modify: `tests/integration/api/contract/comfyui-workflows-route.test.ts`

- [ ] **Step 1: Write failing workflow-purpose tests**

```ts
it('publishes an upscale workflow only with image input and image output', () => {
  expect(validateWorkflowPurpose(upscaleWorkflow())).toMatchObject({ purpose: 'upscale' })
  expect(() => validateWorkflowPurpose({ ...upscaleWorkflow(), outputBindings: [] }))
    .toThrow('COMFY_UPSCALE_OUTPUT_REQUIRED')
})
```

- [ ] **Step 2: Verify RED**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/comfyui/upscale-workflow.test.ts`

Expected: FAIL because workflow purpose has no upscale value.

- [ ] **Step 3: Implement purpose and picker filtering**

Add `purpose: 'generation' | 'upscale'` to workflow/version contracts and publication validation. An upscale workflow requires one media image input and one image output. Do not ship a template. Expose purpose in workflow settings and user-model discovery.

- [ ] **Step 4: Verify GREEN**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/comfyui/upscale-workflow.test.ts tests/integration/api/contract/comfyui-workflows-route.test.ts`

Expected: purpose validation and route tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/comfyui src/app/[locale]/profile tests/unit/comfyui tests/integration/api/contract/comfyui-workflows-route.test.ts
git commit -m "feat: support ComfyUI upscale workflows"
```

### Task 7: Exact Crop Geometry and Artifact Service

**Files:**
- Create: `src/lib/novel-promotion/six-grid/crop-geometry.ts`
- Create: `src/lib/novel-promotion/six-grid/crop-service.ts`
- Create: `tests/unit/novel-promotion/six-grid-crop-geometry.test.ts`
- Create: `tests/integration/six-grid/six-grid-crop-media.integration.test.ts`

- [ ] **Step 1: Write failing geometry tests**

```ts
it('partitions an odd-sized image without gaps or overlap', () => {
  const cells = computeSixGridPixelRects({ width: 3001, height: 2001 })
  expect(cells).toHaveLength(6)
  expect(cells[2].left + cells[2].width).toBe(3001)
  expect(cells[5].top + cells[5].height).toBe(2001)
  expect(cells.reduce((sum, r) => sum + r.width * r.height, 0)).toBe(3001 * 2001)
})
```

Add landscape, portrait, normalized-manual-crop, and out-of-cell rejection cases.

- [ ] **Step 2: Verify RED**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/novel-promotion/six-grid-crop-geometry.test.ts`

Expected: FAIL because geometry functions do not exist.

- [ ] **Step 3: Implement geometry and Sharp crop service**

Use cumulative boundaries `[0, round(w/3), round(2w/3), w]` and `[0, round(h/2), h]`. Fetch source bytes through the storage abstraction, inspect dimensions with Sharp, extract exact rectangles, store six MediaObjects, and return lineage metadata without mutating panels.

- [ ] **Step 4: Verify GREEN including stored bytes**

Run: `BILLING_TEST_BOOTSTRAP=1 npx vitest run tests/unit/novel-promotion/six-grid-crop-geometry.test.ts tests/integration/six-grid/six-grid-crop-media.integration.test.ts`

Expected: geometry and storage tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/novel-promotion/six-grid tests/unit/novel-promotion/six-grid-crop-geometry.test.ts tests/integration/six-grid/six-grid-crop-media.integration.test.ts
git commit -m "feat: crop six-grid sheets exactly"
```

### Task 8: Sheet, Crop, and Upscale Tasks

**Files:**
- Modify: `src/lib/task/types.ts`
- Modify: `src/lib/task/queues.ts`
- Modify: `src/lib/task/intent.ts`
- Modify: `src/lib/task/progress-message.ts`
- Modify: `src/lib/workers/image.worker.ts`
- Create: `src/lib/workers/handlers/storyboard-sheet-task-handler.ts`
- Create: `src/lib/workers/handlers/storyboard-crop-task-handler.ts`
- Create: `src/app/api/novel-promotion/[projectId]/storyboard-sheet/route.ts`
- Create: `src/app/api/novel-promotion/[projectId]/storyboard-sheet/crop/route.ts`
- Create: `src/app/api/novel-promotion/[projectId]/storyboard-panel/upscale/route.ts`
- Modify: `tests/contracts/task-type-catalog.ts`
- Modify: `tests/contracts/route-catalog.ts`
- Create: `tests/unit/worker/storyboard-sheet-task-handler.test.ts`
- Create: `tests/integration/api/contract/six-grid-routes.test.ts`

- [ ] **Step 1: Write failing task and API contract tests**

Assert owner scoping, exact source/version idempotency keys, compatible workflow requirement, no billing freeze before validation, group crop partial-failure behavior, and single-panel upscale isolation.

- [ ] **Step 2: Verify RED**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/worker/storyboard-sheet-task-handler.test.ts tests/integration/api/contract/six-grid-routes.test.ts`

Expected: FAIL because task types and routes do not exist.

- [ ] **Step 3: Implement task routing and recovery-safe handlers**

Add `STORYBOARD_SHEET_GENERATE`, `STORYBOARD_SHEET_UPSCALE`, `STORYBOARD_SHEET_CROP`, and `STORYBOARD_PANEL_UPSCALE`. Snapshot source media ID, workflow version, geometry, processing order, and artifact version. Use the existing ComfyUI provider route and zero-cost local billing policy where applicable. Reconcile existing task/artifact state before external submission.

- [ ] **Step 4: Verify GREEN and guards**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/worker/storyboard-sheet-task-handler.test.ts tests/integration/api/contract/six-grid-routes.test.ts && npm run test:guards`

Expected: tests and route/task guards pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/task src/lib/workers src/app/api/novel-promotion tests/contracts tests/unit/worker/storyboard-sheet-task-handler.test.ts tests/integration/api/contract/six-grid-routes.test.ts
git commit -m "feat: execute six-grid image tasks"
```

### Task 9: Storyboard Group Controls and Crop Modal

**Files:**
- Create: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/SixGridGroupControls.tsx`
- Create: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/SixGridCropModal.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardGroup.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/PanelCard.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/ImageSectionActionButtons.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/hooks/useStoryboardStageController.ts`
- Create: `src/lib/query/hooks/useSixGridStoryboard.ts`
- Create: `tests/unit/components/six-grid-storyboard-controls.test.ts`
- Modify: `messages/zh.json`
- Modify: `messages/en.json`

- [ ] **Step 1: Write failing component contract tests**

Assert group controls render only for `six_grid`, expose both processing orders, the crop modal lists original/upscaled sources, ratio remains locked, per-panel upscale is available, and dialogue cards have both color and icon/text indicators.

- [ ] **Step 2: Verify RED**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/components/six-grid-storyboard-controls.test.ts`

Expected: FAIL because controls do not exist.

- [ ] **Step 3: Implement UI and query mutations**

Keep the current card layout. Add group-level source preview and processing actions, card-level recrop/upscale/source/undo actions, optimistic task overlays, and accessible dialogue styling. Use signed thumbnails in cards and load source media only when the crop or preview modal opens.

- [ ] **Step 4: Verify GREEN and i18n guards**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/components/six-grid-storyboard-controls.test.ts && npm run check:prompt-i18n && npm run typecheck`

Expected: UI tests, i18n, and typecheck pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/[locale]/workspace src/lib/query/hooks/useSixGridStoryboard.ts messages tests/unit/components/six-grid-storyboard-controls.test.ts
git commit -m "feat: add six-grid crop and upscale controls"
```

### Task 10: Dialogue-Aware Video Model and Duration

**Files:**
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video/panel-card/runtime/hooks/usePanelVideoModel.ts`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video/panel-card/VideoPanelCardBody.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video/VideoPromptModal.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/hooks/useWorkspaceVideoActions.ts`
- Modify: `src/app/api/novel-promotion/[projectId]/generate-video/route.ts`
- Modify: `src/lib/workers/task-model-snapshot.ts`
- Create: `tests/unit/novel-promotion/dialogue-video-routing.test.ts`
- Modify: `tests/unit/novel-promotion/video-panel-card-body.test.ts`

- [ ] **Step 1: Write failing routing tests**

```ts
it('uses the dialogue model and includes dialogue only when enabled', () => {
  expect(resolvePanelVideoSubmission(dialoguePanel(), projectModels())).toMatchObject({
    model: 'comfyui::dialogue-video',
    prompt: expect.stringContaining('不要离开'),
    duration: 10,
  })
})
```

Also assert normal-model fallback is explicit, disabled dialogue is omitted, and unsupported duration blocks instead of shortening.

- [ ] **Step 2: Verify RED**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/novel-promotion/dialogue-video-routing.test.ts tests/unit/novel-promotion/video-panel-card-body.test.ts`

Expected: FAIL because dialogue routing and effective duration are absent.

- [ ] **Step 3: Implement routing and card editing**

Resolve dialogue model before task snapshot, compose video prompt from visual plus optional dialogue fragment, display/edit effective duration, and validate capabilities before billing freeze. Persist estimated and override durations separately.

- [ ] **Step 4: Verify GREEN**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/novel-promotion/dialogue-video-routing.test.ts tests/unit/novel-promotion/video-panel-card-body.test.ts tests/unit/comfyui/generate-video-route.test.ts`

Expected: routing, card, and route tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app src/lib/workers/task-model-snapshot.ts tests/unit/novel-promotion tests/unit/comfyui/generate-video-route.test.ts
git commit -m "feat: route dialogue video and duration"
```

### Task 11: Continuous First/Last-Frame Linking

**Files:**
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video/FirstLastFramePanel.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video/panel-card/VideoPanelCardHeader.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/hooks/useWorkspaceVideoActions.ts`
- Modify: `src/app/api/novel-promotion/[projectId]/panel-link/route.ts`
- Create: `src/lib/novel-promotion/video/frame-link-resolver.ts`
- Create: `tests/unit/novel-promotion/frame-link-resolver.test.ts`
- Create: `tests/integration/api/contract/panel-link.route.test.ts`

- [ ] **Step 1: Write failing sequence tests**

Assert cell 0 links to cell 1, cell 5 links to the next continuous group's cell 0, scene boundary does not auto-link, final shot has no last frame, manual source wins, and incompatible model preserves but blocks stored choices.

- [ ] **Step 2: Verify RED**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/novel-promotion/frame-link-resolver.test.ts tests/integration/api/contract/panel-link.route.test.ts`

Expected: FAIL because sequence-aware resolver is absent.

- [ ] **Step 3: Implement resolver and source metadata**

Resolve links from persisted group sequence and continuity scene key rather than visual list position. Store `{ mode: 'automatic' | 'manual', sourcePanelId }`. Show source badges and allow replace, clear, unlink, and restore-auto actions.

- [ ] **Step 4: Verify GREEN**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/novel-promotion/frame-link-resolver.test.ts tests/integration/api/contract/panel-link.route.test.ts tests/unit/novel-promotion/workspace-video-actions.test.ts`

Expected: link and existing video-action tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/novel-promotion/video src/app tests/unit/novel-promotion/frame-link-resolver.test.ts tests/integration/api/contract/panel-link.route.test.ts
git commit -m "feat: link continuous storyboard frames"
```

### Task 12: Full Acceptance and Documentation

**Files:**
- Create: `tests/system/six-grid-storyboard.system.test.ts`
- Create: `tests/contracts/six-grid-requirements-matrix.test.ts`
- Modify: `tests/contracts/requirements-matrix.ts`
- Modify: `README.md`
- Modify: `README_en.md`
- Modify: `docker-compose.yml`
- Modify: `.env.example`

- [ ] **Step 1: Write the end-to-end acceptance test**

Use a fake ComfyUI HTTP/WS server and real production compiler/client/dispatcher. Cover landscape and portrait sheets, automatic crop, both upscale orders, manual recrop, dialogue routing, duration resolution, cross-group first/last frame, retry without duplicate prompt, and legacy individual mode.

- [ ] **Step 2: Verify RED before completing wiring**

Run: `SYSTEM_TEST_BOOTSTRAP=1 npx vitest run tests/system/six-grid-storyboard.system.test.ts tests/contracts/six-grid-requirements-matrix.test.ts`

Expected: FAIL on the first acceptance path not yet fully wired.

- [ ] **Step 3: Complete only missing integration wiring and docs**

Wire task registration/runtime startup, environment variables for crop/upscale limits, route and task catalogs, user documentation, diagnostics, and migration instructions. Do not add built-in workflows.

- [ ] **Step 4: Run focused and full verification**

Run:

```bash
npm run lint:all
npm run typecheck
npm run test:guards
npm run test:unit:all
npm run test:integration:api
npm run test:integration:provider
npm run test:integration:chain
npm run test:integration:task
npm run test:system
npm run test:regression:cases
npm run build
git diff --check
```

Expected: all commands exit 0; lint may report only the existing warning baseline and no errors.

- [ ] **Step 5: Commit**

```bash
git add tests README.md README_en.md docker-compose.yml .env.example src
git commit -m "test: verify six-grid storyboard workflow"
```
