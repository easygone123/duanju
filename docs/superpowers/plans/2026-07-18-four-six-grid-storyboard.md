# Four-grid and Six-grid Storyboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one-call `2×2` four-grid storyboard generation beside the existing `3×2` six-grid mode, default new projects to four-grid, and preserve all existing six-grid data and behavior.

**Architecture:** Introduce a canonical `StoryboardGridSpec` that drives planning count, sheet ratio, task snapshots, crop geometry, persistence, and UI. Existing `sixGrid*` database fields and public compatibility exports remain readable, while new shared implementations use neutral grid terminology and table-driven four/six mode behavior.

**Tech Stack:** TypeScript, Next.js App Router, React, Prisma/MySQL and SQLite schemas, BullMQ tasks, Sharp, Vitest, next-intl.

---

### Task 1: Canonical grid specification and new-project default

**Files:**
- Create: `src/lib/novel-promotion/grid-storyboard/spec.ts`
- Create: `tests/unit/novel-promotion/grid-storyboard-spec.test.ts`
- Modify: `src/lib/novel-promotion/six-grid/contracts.ts`
- Modify: `src/lib/novel-promotion/six-grid/run-settings.ts`
- Modify: `src/lib/config-service.ts`
- Modify: `src/types/project.ts`
- Modify: `src/app/api/novel-promotion/[projectId]/route.ts`
- Modify: `prisma/schema.prisma`
- Modify: `prisma/schema.sqlit.prisma`
- Create: `prisma/migrations/20260718010000_default_four_grid_storyboards/migration.sql`
- Modify: `tests/unit/novel-promotion/six-grid-run-settings.test.ts`

- [ ] **Step 1: Write failing table-driven grid-spec tests**

```ts
it.each([
  ['four_grid', '16:9', { columns: 2, rows: 2, panelCount: 4, sheetAspectRatio: '16:9' }],
  ['four_grid', '9:16', { columns: 2, rows: 2, panelCount: 4, sheetAspectRatio: '9:16' }],
  ['six_grid', '16:9', { columns: 3, rows: 2, panelCount: 6, sheetAspectRatio: '8:3' }],
  ['six_grid', '9:16', { columns: 3, rows: 2, panelCount: 6, sheetAspectRatio: '27:32' }],
] as const)('%s %s resolves its immutable layout', (mode, cellAspectRatio, expected) => {
  expect(resolveStoryboardGridSpec({ mode, cellAspectRatio })).toEqual({
    mode, cellAspectRatio, ...expected,
  })
})
```

- [ ] **Step 2: Run the new test and verify the missing module failure**

Run: `pnpm vitest run tests/unit/novel-promotion/grid-storyboard-spec.test.ts`
Expected: FAIL resolving `@/lib/novel-promotion/grid-storyboard/spec`.

- [ ] **Step 3: Implement the canonical resolver**

```ts
export type GridStoryboardMode = 'four_grid' | 'six_grid'
export type GridCellAspectRatio = '16:9' | '9:16'
export type StoryboardGridSpec = {
  mode: GridStoryboardMode
  columns: 2 | 3
  rows: 2
  panelCount: 4 | 6
  cellAspectRatio: GridCellAspectRatio
  sheetAspectRatio: '16:9' | '9:16' | '8:3' | '27:32'
}

export function resolveStoryboardGridSpec(input: {
  mode: GridStoryboardMode
  cellAspectRatio: GridCellAspectRatio
}): StoryboardGridSpec {
  const four = input.mode === 'four_grid'
  return {
    mode: input.mode,
    columns: four ? 2 : 3,
    rows: 2,
    panelCount: four ? 4 : 6,
    cellAspectRatio: input.cellAspectRatio,
    sheetAspectRatio: four
      ? input.cellAspectRatio
      : input.cellAspectRatio === '16:9' ? '8:3' : '27:32',
  }
}
```

- [ ] **Step 4: Extend project/run-setting contracts without renaming legacy storage fields**

```ts
export type StoryboardGenerationMode = 'individual' | GridStoryboardMode
export type SixGridCellAspectRatio = GridCellAspectRatio // compatibility alias

const isGridMode = mode === 'four_grid' || mode === 'six_grid'
const gridSpec = isGridMode && candidateRatio
  ? resolveStoryboardGridSpec({ mode, cellAspectRatio: candidateRatio })
  : null
```

The project PATCH schema accepts `four_grid`; config loading preserves stored `individual`/`six_grid` and returns `four_grid` for newly inserted default rows.

- [ ] **Step 5: Change only the database default for future project rows**

```sql
ALTER TABLE `novel_promotion_projects`
  MODIFY COLUMN `storyboardGenerationMode` VARCHAR(191) NOT NULL DEFAULT 'four_grid';
```

Apply the same default in both Prisma schemas. Do not update existing rows.

- [ ] **Step 6: Run contract, config, and Prisma validation**

Run: `pnpm vitest run tests/unit/novel-promotion/grid-storyboard-spec.test.ts tests/unit/novel-promotion/six-grid-run-settings.test.ts tests/unit/workspace/config-actions.test.ts`
Expected: all PASS.

Run: `pnpm prisma validate && pnpm prisma validate --schema prisma/schema.sqlit.prisma`
Expected: both schemas valid.

- [ ] **Step 7: Commit**

```bash
git add src/lib/novel-promotion/grid-storyboard/spec.ts src/lib/novel-promotion/six-grid/contracts.ts src/lib/novel-promotion/six-grid/run-settings.ts src/lib/config-service.ts src/types/project.ts src/app/api/novel-promotion/[projectId]/route.ts prisma/schema.prisma prisma/schema.sqlit.prisma prisma/migrations/20260718010000_default_four_grid_storyboards/migration.sql tests/unit/novel-promotion/grid-storyboard-spec.test.ts tests/unit/novel-promotion/six-grid-run-settings.test.ts
git commit -m "feat: add canonical storyboard grid modes"
```

### Task 2: Parameterized group planning and prompt phases

**Files:**
- Create: `src/lib/novel-promotion/grid-storyboard/scene-planner.ts`
- Modify: `src/lib/novel-promotion/six-grid/scene-planner.ts`
- Modify: `src/lib/novel-promotion/six-grid/prompt-builder.ts`
- Modify: `src/lib/novel-promotion/script-to-storyboard/orchestrator.ts`
- Modify: `src/lib/workers/handlers/script-to-storyboard.ts`
- Modify: `src/lib/workers/handlers/script-to-storyboard-helpers.ts`
- Modify: `src/lib/novel-promotion/six-grid/run-artifacts.ts`
- Modify: `src/lib/run-runtime/types.ts`
- Create: `tests/unit/novel-promotion/grid-storyboard-scene-planner.test.ts`
- Modify: `tests/unit/novel-promotion/six-grid-scene-planner.test.ts`
- Modify: `tests/unit/worker/script-to-storyboard.test.ts`

- [ ] **Step 1: Write failing exact-count and numbering tests for both modes**

```ts
it.each([
  ['four_grid', 4],
  ['six_grid', 6],
] as const)('validates %s groups with exactly %i panels', (mode, panelCount) => {
  const spec = resolveStoryboardGridSpec({ mode, cellAspectRatio: '16:9' })
  const panels = Array.from({ length: panelCount }, (_, index) => validPanel(index + 1))
  expect(validateGridSceneGroups([validGroup(panels)], spec)[0].panels).toHaveLength(panelCount)
  expect(() => validateGridSceneGroups([validGroup(panels.slice(1))], spec))
    .toThrow(/GRID_REQUIRES_EXACT_PANEL_COUNT/)
})
```

Also assert four-grid accepts numbers `1..4`, rejects `1,2,3,5`, and produces group IDs prefixed with `four-grid:` while six-grid keeps `six-grid:` IDs.

- [ ] **Step 2: Run the new planner test and verify it fails**

Run: `pnpm vitest run tests/unit/novel-promotion/grid-storyboard-scene-planner.test.ts`
Expected: FAIL because generic validators do not exist.

- [ ] **Step 3: Implement generic group validation**

```ts
export function validateGridSceneGroups(
  value: unknown,
  spec: StoryboardGridSpec,
): GridSceneGroup[] {
  const groups = readGroups(value)
  return groups.map((group, groupIndex) => {
    if (!Array.isArray(group.panels) || group.panels.length !== spec.panelCount) {
      throw gridValidationError('GRID_REQUIRES_EXACT_PANEL_COUNT', {
        mode: spec.mode,
        expectedPanelCount: spec.panelCount,
        actualPanelCount: Array.isArray(group.panels) ? group.panels.length : -1,
        groupIndex,
      })
    }
    const panels = group.panels.map((panel, index) => normalizePanel(panel, groupIndex, index))
    assertSequentialPanelNumbers(panels, spec.panelCount, { groupIndex })
    return normalizeContinuityGroup(group, panels, groupIndex)
  })
}
```

The old `validateAndNormalizeSixGridGroups`, rule validators, error constants, and error class remain thin wrappers/aliases around the generic implementation with the six-grid spec.

- [ ] **Step 4: Parameterize every planning prompt with layout/count**

```ts
const layoutInstruction = spec.mode === 'four_grid'
  ? '输出且仅输出4个连续分镜，编号严格为1、2、3、4，最终排成2×2四宫格。'
  : '输出且仅输出6个连续分镜，编号严格为1至6，最终排成3×2六宫格。'
```

Pass the immutable spec through episode plan, phase 1, cinematography, acting, and detail prompts. Sparse groups request grounded reaction/environment/insert/detail shots; dense content may produce another group and must not drop script coverage.

- [ ] **Step 5: Make orchestrator and retry behavior grid-aware**

```ts
if (isGridStoryboardMode(runSettings.storyboardGenerationMode)) {
  const spec = resolveStoryboardGridSpec({
    mode: runSettings.storyboardGenerationMode,
    cellAspectRatio: runSettings.sixGridCellAspectRatio!,
  })
  return await runGridStoryboardPhases({ ...input, gridSpec: spec })
}
```

Retry the whole grid run for both grid modes, while preserving individual-mode behavior and existing six-grid artifact keys through compatibility readers.

- [ ] **Step 6: Run planner/orchestrator suites**

Run: `pnpm vitest run tests/unit/novel-promotion/grid-storyboard-scene-planner.test.ts tests/unit/novel-promotion/six-grid-scene-planner.test.ts tests/unit/novel-promotion/six-grid-prompt.test.ts tests/unit/worker/script-to-storyboard.test.ts`
Expected: all PASS, including existing six-grid regressions.

- [ ] **Step 7: Commit**

```bash
git add src/lib/novel-promotion/grid-storyboard/scene-planner.ts src/lib/novel-promotion/six-grid/scene-planner.ts src/lib/novel-promotion/six-grid/prompt-builder.ts src/lib/novel-promotion/script-to-storyboard/orchestrator.ts src/lib/workers/handlers/script-to-storyboard.ts src/lib/workers/handlers/script-to-storyboard-helpers.ts src/lib/novel-promotion/six-grid/run-artifacts.ts src/lib/run-runtime/types.ts tests/unit/novel-promotion/grid-storyboard-scene-planner.test.ts tests/unit/novel-promotion/six-grid-scene-planner.test.ts tests/unit/worker/script-to-storyboard.test.ts
git commit -m "feat: parameterize grid storyboard planning"
```

### Task 3: Grid-aware persistence with six-grid compatibility

**Files:**
- Create: `src/lib/novel-promotion/grid-storyboard/persistence.ts`
- Modify: `src/lib/novel-promotion/six-grid/persistence.ts`
- Modify: `src/lib/novel-promotion/six-grid/persistence-contract.ts`
- Modify: `src/lib/novel-promotion/six-grid/persistence-voice.ts`
- Modify: `src/lib/workers/handlers/script-to-storyboard.ts`
- Create: `tests/unit/novel-promotion/grid-storyboard-persistence.test.ts`
- Modify: `tests/integration/six-grid/six-grid-persistence.integration.test.ts`

- [ ] **Step 1: Write failing persistence tests for four panels and legacy six panels**

```ts
expect(await persistGridStoryboardOutputs(fourGridParams)).toMatchObject({
  storyboards: [expect.objectContaining({ panelCount: 4 })],
})
expect(prisma.novelPromotionStoryboard.create).toHaveBeenCalledWith(expect.objectContaining({
  data: expect.objectContaining({ layoutMode: 'four_grid', panelCount: 4 }),
}))
expect(prisma.novelPromotionPanel.createMany).toHaveBeenCalledWith(expect.objectContaining({
  data: expect.arrayContaining([
    expect.objectContaining({ gridCellIndex: 0 }),
    expect.objectContaining({ gridCellIndex: 3 }),
  ]),
}))
```

The existing six-grid integration test must still assert six rows, indexes `0..5`, and unchanged stable IDs.

- [ ] **Step 2: Run persistence tests and verify four-grid fails**

Run: `pnpm vitest run tests/unit/novel-promotion/grid-storyboard-persistence.test.ts tests/integration/six-grid/six-grid-persistence.integration.test.ts`
Expected: four-grid FAILS at the six-grid run snapshot/count guards; six-grid remains green.

- [ ] **Step 3: Implement generic persistence driven by the immutable spec**

```ts
export async function persistGridStoryboardOutputs(params: PersistGridParams) {
  const gridSpec = resolveRunSnapshotGridSpec(params.runSnapshot)
  const groups = normalizeGridPersistenceGroups(params.clipPanels, gridSpec)
  return await persistGroupsTransaction({ ...params, groups, gridSpec })
}
```

Persist `layoutMode: gridSpec.mode`, `panelCount: gridSpec.panelCount`, legacy cell-ratio/order columns, row-major `gridCellIndex`, exact prompt snapshot, and the existing media/voice/runtime artifacts. Stable storyboard IDs include the mode so four-grid and six-grid groups cannot collide.

- [ ] **Step 4: Preserve six-grid exports as wrappers**

```ts
export async function persistSixGridStoryboardOutputs(params: PersistSixGridParams) {
  return await persistGridStoryboardOutputs(params)
}
```

Existing six-grid voice validation uses the resolved panel count internally while retaining old exported names.

- [ ] **Step 5: Run persistence suites**

Run: `pnpm vitest run tests/unit/novel-promotion/grid-storyboard-persistence.test.ts tests/integration/six-grid/six-grid-persistence.integration.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/novel-promotion/grid-storyboard/persistence.ts src/lib/novel-promotion/six-grid/persistence.ts src/lib/novel-promotion/six-grid/persistence-contract.ts src/lib/novel-promotion/six-grid/persistence-voice.ts src/lib/workers/handlers/script-to-storyboard.ts tests/unit/novel-promotion/grid-storyboard-persistence.test.ts tests/integration/six-grid/six-grid-persistence.integration.test.ts
git commit -m "feat: persist four and six grid storyboards"
```

### Task 4: Immutable task snapshots, capability validation, and one-call sheet generation

**Files:**
- Modify: `src/lib/workers/handlers/storyboard-sheet-task-handler.ts`
- Modify: `src/lib/novel-promotion/six-grid/image-task-route.ts`
- Modify: `src/app/api/novel-promotion/[projectId]/storyboard-sheet/route.ts`
- Modify: `src/app/api/novel-promotion/[projectId]/storyboard-panel/upscale/route.ts`
- Modify: `src/lib/config-service.ts`
- Create: `tests/unit/worker/grid-storyboard-sheet-task-handler.test.ts`
- Modify: `tests/unit/worker/storyboard-sheet-task-handler.test.ts`
- Modify: `tests/unit/model-capabilities/image-task-overrides.test.ts`
- Modify: `tests/integration/api/contract/six-grid-routes.test.ts`

- [ ] **Step 1: Write failing snapshot and provider-call tests**

```ts
expect(parseGridImageTaskSnapshot(fourSnapshot).gridSpec).toEqual({
  mode: 'four_grid', columns: 2, rows: 2, panelCount: 4,
  cellAspectRatio: '16:9', sheetAspectRatio: '16:9',
})

await handleStoryboardSheetTask(job(fourSnapshot))
expect(resolveImageSourceFromGeneration).toHaveBeenCalledTimes(1)
expect(resolveImageSourceFromGeneration).toHaveBeenCalledWith(expect.anything(),
  expect.objectContaining({ options: expect.objectContaining({ aspectRatio: '16:9' }) }))
```

Add dedupe tests proving otherwise-identical four/six snapshots produce different keys.

- [ ] **Step 2: Run route/worker tests and verify four-grid fails**

Run: `pnpm vitest run tests/unit/worker/grid-storyboard-sheet-task-handler.test.ts tests/unit/worker/storyboard-sheet-task-handler.test.ts tests/unit/model-capabilities/image-task-overrides.test.ts`
Expected: FAIL because task schemas only accept six-grid and fixed count/index ranges.

- [ ] **Step 3: Add versioned grid spec to new task snapshots**

```ts
const gridSpecSchema = z.object({
  version: z.literal(1),
  mode: z.enum(['four_grid', 'six_grid']),
  columns: z.union([z.literal(2), z.literal(3)]),
  rows: z.literal(2),
  panelCount: z.union([z.literal(4), z.literal(6)]),
  cellAspectRatio: z.enum(['16:9', '9:16']),
  sheetAspectRatio: z.enum(['16:9', '9:16', '8:3', '27:32']),
}).superRefine(assertInternallyConsistentGridSpec)
```

Parse legacy snapshots without `gridSpec` as six-grid using their existing `cellAspectRatio`. Include the normalized spec in dedupe identity.

- [ ] **Step 4: Make route loading and capability checks mode-aware**

```ts
const gridSpec = resolveStoryboardGridSpec({
  mode: storyboard.layoutMode as GridStoryboardMode,
  cellAspectRatio: storyboard.sixGridCellAspectRatio as GridCellAspectRatio,
})
const resolvedGenerationOptions = await resolveProjectImageTaskGenerationOptions({
  projectId, userId, imageModel: model,
  taskSelections: { aspectRatio: gridSpec.sheetAspectRatio },
  comfyWorkflowVersionId: workflow?.version.id,
})
```

Map capability rejection to `GRID_SHEET_RATIO_UNSUPPORTED` with `{ mode, sheetAspectRatio }`; keep the old six-grid code as a compatibility detail for existing clients.

- [ ] **Step 5: Generate each sheet with exactly one provider invocation**

Use `snapshot.gridSpec.sheetAspectRatio` and the existing combined prompt/reference call. Do not add per-panel generation. Persist sheet media and prompt/model/options snapshots exactly as today.

- [ ] **Step 6: Run worker and route suites**

Run: `pnpm vitest run tests/unit/worker/grid-storyboard-sheet-task-handler.test.ts tests/unit/worker/storyboard-sheet-task-handler.test.ts tests/unit/model-capabilities/image-task-overrides.test.ts tests/integration/api/contract/six-grid-routes.test.ts`
Expected: all PASS and one provider call per mode.

- [ ] **Step 7: Commit**

```bash
git add src/lib/workers/handlers/storyboard-sheet-task-handler.ts src/lib/novel-promotion/six-grid/image-task-route.ts src/app/api/novel-promotion/[projectId]/storyboard-sheet/route.ts src/app/api/novel-promotion/[projectId]/storyboard-panel/upscale/route.ts src/lib/config-service.ts tests/unit/worker/grid-storyboard-sheet-task-handler.test.ts tests/unit/worker/storyboard-sheet-task-handler.test.ts tests/unit/model-capabilities/image-task-overrides.test.ts tests/integration/api/contract/six-grid-routes.test.ts
git commit -m "feat: generate grid sheets from immutable specs"
```

### Task 5: Generic upload and crop geometry

**Files:**
- Create: `src/lib/novel-promotion/grid-storyboard/crop-geometry.ts`
- Modify: `src/lib/novel-promotion/six-grid/crop-geometry.ts`
- Modify: `src/lib/novel-promotion/six-grid/crop-service.ts`
- Modify: `src/lib/novel-promotion/six-grid/upload-contract.ts`
- Modify: `src/lib/novel-promotion/six-grid/upload-validation.ts`
- Modify: `src/lib/novel-promotion/six-grid/upload-service.ts`
- Modify: `src/app/api/novel-promotion/[projectId]/storyboard-sheet/upload/route.ts`
- Modify: `src/app/api/novel-promotion/[projectId]/storyboard-sheet/crop/route.ts`
- Create: `tests/unit/novel-promotion/grid-storyboard-crop-geometry.test.ts`
- Modify: `tests/system/six-grid-storyboard.system.test.ts`
- Modify: `tests/unit/components/six-grid-external-upload.test.tsx`
- Modify: `tests/integration/six-grid/six-grid-crop-media.integration.test.ts`

- [ ] **Step 1: Write failing table-driven geometry and ratio tests**

```ts
it.each([
  ['four_grid', 2, 2, 4],
  ['six_grid', 3, 2, 6],
] as const)('%s computes row-major pixel rectangles', (mode, columns, rows, count) => {
  const spec = resolveStoryboardGridSpec({ mode, cellAspectRatio: '16:9' })
  const rects = computeGridPixelRects({ width: 1200, height: 800 }, spec)
  expect(rects).toHaveLength(count)
  expect(new Set(rects.map((rect) => rect.cellIndex))).toEqual(new Set(Array.from({ length: count }, (_, i) => i)))
  expect(rects.every((rect) => rect.width === 1200 / columns && rect.height === 800 / rows)).toBe(true)
})
```

Add upload tests accepting four-grid `1600×900` and `900×1600`, while preserving six-grid `2400×900` and `1350×1600` tolerance behavior.

- [ ] **Step 2: Run geometry/upload tests and verify four-grid fails**

Run: `pnpm vitest run tests/unit/novel-promotion/grid-storyboard-crop-geometry.test.ts tests/unit/components/six-grid-external-upload.test.tsx`
Expected: FAIL on fixed six rectangles and fixed six-grid ratios.

- [ ] **Step 3: Implement generic row/column geometry**

```ts
export function computeGridPixelRects(
  dimensions: ImageDimensions,
  spec: Pick<StoryboardGridSpec, 'columns' | 'rows' | 'panelCount'>,
): GridPixelRect[] {
  const xs = boundaries(dimensions.width, spec.columns)
  const ys = boundaries(dimensions.height, spec.rows)
  return Array.from({ length: spec.panelCount }, (_, cellIndex) => {
    const column = cellIndex % spec.columns
    const row = Math.floor(cellIndex / spec.columns)
    return {
      cellIndex, x: xs[column], y: ys[row],
      width: xs[column + 1] - xs[column],
      height: ys[row + 1] - ys[row],
    }
  })
}
```

Manual crop validates `0 <= cellIndex < spec.panelCount`, exact unique rect count, containment in the derived cell, and cell aspect ratio.

- [ ] **Step 4: Parameterize upload and crop services/routes**

Resolve the spec from the owned storyboard. Validate `actualRatio` against `gridSpec.sheetAspectRatio`, persist only to the same storyboard/mode/version, and preserve ownership, claim, CAS, replacement, undo, and media-lineage checks.

- [ ] **Step 5: Keep compatibility exports**

```ts
export const computeSixGridPixelRects = (dimensions: ImageDimensions) =>
  computeGridPixelRects(dimensions, resolveStoryboardGridSpec({
    mode: 'six_grid', cellAspectRatio: '16:9',
  }))
```

Old exported names remain for existing callers/tests but delegate to generic code.

- [ ] **Step 6: Run upload/crop/system suites**

Run: `pnpm vitest run tests/unit/novel-promotion/grid-storyboard-crop-geometry.test.ts tests/unit/components/six-grid-external-upload.test.tsx tests/integration/six-grid/six-grid-crop-media.integration.test.ts tests/system/six-grid-storyboard.system.test.ts`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/novel-promotion/grid-storyboard/crop-geometry.ts src/lib/novel-promotion/six-grid/crop-geometry.ts src/lib/novel-promotion/six-grid/crop-service.ts src/lib/novel-promotion/six-grid/upload-contract.ts src/lib/novel-promotion/six-grid/upload-validation.ts src/lib/novel-promotion/six-grid/upload-service.ts src/app/api/novel-promotion/[projectId]/storyboard-sheet/upload/route.ts src/app/api/novel-promotion/[projectId]/storyboard-sheet/crop/route.ts tests/unit/novel-promotion/grid-storyboard-crop-geometry.test.ts tests/unit/components/six-grid-external-upload.test.tsx tests/integration/six-grid/six-grid-crop-media.integration.test.ts tests/system/six-grid-storyboard.system.test.ts
git commit -m "feat: crop and upload configurable grid sheets"
```

### Task 6: Page controls, dynamic layout, and localized compatibility guidance

**Files:**
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/ConfigStage.tsx`
- Create: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/GridGroupControls.tsx`
- Create: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/GridCropModal.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardGroup.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardPanelList.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardGroup.types.ts`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/SixGridGroupControls.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/SixGridCropModal.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/hooks/useWorkspaceProjectSnapshot.ts`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/hooks/useWorkspaceExecution.ts`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/hooks/useWorkspaceStageRuntime.ts`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/WorkspaceStageRuntimeContext.tsx`
- Modify: `src/lib/query/hooks/useScriptToStoryboardRunStream.ts`
- Modify: `src/lib/query/hooks/useSixGridStoryboard.ts`
- Modify: `messages/zh/storyboard.json`
- Modify: `messages/en/storyboard.json`
- Create: `tests/unit/components/grid-storyboard-controls.test.tsx`
- Modify: `tests/unit/components/six-grid-storyboard-controls.test.ts`
- Modify: `tests/unit/components/six-grid-crop-modal-interaction.test.ts`

- [ ] **Step 1: Write failing selector and dynamic-label component tests**

```tsx
expect(screen.getByRole('option', { name: /四宫格/ })).toHaveValue('four_grid')
expect(renderControls(fourStoryboard)).toContain('生成2×2四宫格')
expect(renderControls(sixStoryboard)).toContain('生成3×2六宫格')
expect(renderCrop(fourStoryboard).container.querySelector('[data-grid-overlay]'))
  .toHaveAttribute('data-columns', '2')
expect(screen.getAllByRole('tab')).toHaveLength(4)
```

Add a six-grid unsupported-ratio error assertion containing a switch-to-four-grid recommendation.

- [ ] **Step 2: Run component tests and verify four-grid fails**

Run: `pnpm vitest run tests/unit/components/grid-storyboard-controls.test.tsx tests/unit/components/six-grid-storyboard-controls.test.ts tests/unit/components/six-grid-crop-modal-interaction.test.ts`
Expected: FAIL because mode filters and overlay/tab counts are six-grid-only.

- [ ] **Step 3: Add the three-mode configuration selector**

```tsx
<select value={runtime.storyboardGenerationMode} disabled={settingsLocked}>
  <option value="individual">{t('mode.individual')}</option>
  <option value="four_grid">{t('mode.four_grid')}</option>
  <option value="six_grid">{t('mode.six_grid')}</option>
</select>
```

Show the derived sheet ratio for either grid mode. Four-grid is labeled recommended; six-grid notes special model-ratio support. Existing project values are displayed unchanged.

- [ ] **Step 4: Implement generic grid group controls and crop modal**

Resolve the spec from `storyboard.layoutMode` and legacy ratio fields. Render dynamic title/button text, inline sheet preview, upload/prompt/upscale/crop actions, `columns × rows` overlay, and exactly `panelCount` tabs. Keep `SixGridGroupControls` and `SixGridCropModal` as compatibility re-exports during migration.

- [ ] **Step 5: Carry grid mode through runtime hooks without duplicating mutations**

Use one grid generation/upload/crop mutation path for `four_grid` and `six_grid`. Existing `useSixGridStoryboard` query keys remain compatible or receive neutral aliases; cache invalidation continues to scope by project/episode/storyboard/panel.

- [ ] **Step 6: Add Chinese and English messages**

```json
{
  "mode": {
    "four_grid": "四宫格（推荐）",
    "six_grid": "六宫格"
  },
  "grid": {
    "generateFour": "生成2×2四宫格",
    "generateSix": "生成3×2六宫格",
    "sixRatioUnsupported": "当前模型不支持六宫格整图比例，请切换四宫格或更换模型。"
  }
}
```

Provide equivalent English strings and keep existing translation keys used by six-grid compatibility components.

- [ ] **Step 7: Run component and runtime tests**

Run: `pnpm vitest run tests/unit/components/grid-storyboard-controls.test.tsx tests/unit/components/six-grid-storyboard-controls.test.ts tests/unit/components/six-grid-crop-modal-interaction.test.ts tests/unit/components/six-grid-external-upload.test.tsx tests/unit/workspace/config-actions.test.ts tests/unit/novel-promotion/workspace-stage-side-effects.test.ts`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/ConfigStage.tsx src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/GridGroupControls.tsx src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/GridCropModal.tsx src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardGroup.tsx src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardPanelList.tsx src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardGroup.types.ts src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/SixGridGroupControls.tsx src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/SixGridCropModal.tsx src/app/[locale]/workspace/[projectId]/modes/novel-promotion/hooks/useWorkspaceProjectSnapshot.ts src/app/[locale]/workspace/[projectId]/modes/novel-promotion/hooks/useWorkspaceExecution.ts src/app/[locale]/workspace/[projectId]/modes/novel-promotion/hooks/useWorkspaceStageRuntime.ts src/app/[locale]/workspace/[projectId]/modes/novel-promotion/WorkspaceStageRuntimeContext.tsx src/lib/query/hooks/useScriptToStoryboardRunStream.ts src/lib/query/hooks/useSixGridStoryboard.ts messages/zh/storyboard.json messages/en/storyboard.json tests/unit/components/grid-storyboard-controls.test.tsx tests/unit/components/six-grid-storyboard-controls.test.ts tests/unit/components/six-grid-crop-modal-interaction.test.ts
git commit -m "feat: add four-grid storyboard controls"
```

### Task 7: Downstream ordering, system acceptance, and final verification

**Files:**
- Modify: `src/lib/novel-promotion/video/frame-link-resolver.ts`
- Modify: `src/lib/novel-promotion/stages/video-stage-runtime/useVideoPanelLinking.ts`
- Create: `tests/system/four-grid-storyboard.system.test.ts`
- Modify: `tests/system/six-grid-storyboard.system.test.ts`
- Modify: `tests/unit/novel-promotion/frame-link-resolver.test.ts`
- Modify: `tests/contracts/requirements-matrix.ts`
- Modify: `tests/contracts/six-grid-requirements-matrix.test.ts`

- [ ] **Step 1: Write failing downstream ordering and four-grid system tests**

The ordering test supplies four-grid panels out of database order and asserts row-major `gridCellIndex` order `0,1,2,3`. The system test executes planning → persistence → one sheet generation → crop → four owned panel media records.

```ts
expect(result.panels.map((panel) => panel.gridCellIndex)).toEqual([0, 1, 2, 3])
expect(resolveImageSourceFromGeneration).toHaveBeenCalledTimes(1)
expect(persisted.panels).toHaveLength(4)
expect(persisted.panels.every((panel) => panel.imageMediaId)).toBe(true)
```

- [ ] **Step 2: Run downstream/system tests and verify four-grid fails**

Run: `pnpm vitest run tests/unit/novel-promotion/frame-link-resolver.test.ts tests/system/four-grid-storyboard.system.test.ts tests/system/six-grid-storyboard.system.test.ts`
Expected: four-grid FAILS while six-grid remains green.

- [ ] **Step 3: Generalize downstream grid ordering**

Treat both `four_grid` and `six_grid` as grid-derived panels, sort by group sequence then `gridCellIndex`, and retain individual-mode panel-index behavior. No video API changes are introduced.

- [ ] **Step 4: Update executable requirements coverage**

Add four-grid requirements for defaulting, exact four-panel planning, common-ratio one-call generation, upload, crop, and backward-compatible six-grid behavior. Point every requirement to an executable test.

- [ ] **Step 5: Run focused acceptance**

Run: `pnpm vitest run tests/unit/novel-promotion/grid-storyboard-spec.test.ts tests/unit/novel-promotion/grid-storyboard-scene-planner.test.ts tests/unit/novel-promotion/grid-storyboard-persistence.test.ts tests/unit/novel-promotion/grid-storyboard-crop-geometry.test.ts tests/unit/worker/grid-storyboard-sheet-task-handler.test.ts tests/unit/components/grid-storyboard-controls.test.tsx tests/system/four-grid-storyboard.system.test.ts tests/system/six-grid-storyboard.system.test.ts tests/contracts/six-grid-requirements-matrix.test.ts`
Expected: all PASS.

- [ ] **Step 6: Run static and schema verification**

Run: `pnpm exec tsc --noEmit`
Expected: exit 0.

Run: `pnpm exec eslint src/lib/novel-promotion/grid-storyboard src/lib/novel-promotion/six-grid src/lib/workers/handlers/storyboard-sheet-task-handler.ts src/app/api/novel-promotion/[projectId]/storyboard-sheet src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard tests/unit/novel-promotion/grid-storyboard-*.test.ts tests/system/four-grid-storyboard.system.test.ts`
Expected: exit 0.

Run: `pnpm prisma validate && pnpm prisma validate --schema prisma/schema.sqlit.prisma && git diff --check`
Expected: both schemas valid and no whitespace errors.

- [ ] **Step 7: Review and commit final integration changes**

```bash
git add src/lib/novel-promotion/video/frame-link-resolver.ts src/lib/novel-promotion/stages/video-stage-runtime/useVideoPanelLinking.ts tests/system/four-grid-storyboard.system.test.ts tests/system/six-grid-storyboard.system.test.ts tests/unit/novel-promotion/frame-link-resolver.test.ts tests/contracts/requirements-matrix.ts tests/contracts/six-grid-requirements-matrix.test.ts
git commit -m "test: accept four-grid storyboard workflow"
```

After verification, use the finishing-development-branch workflow to merge into `main`, rerun focused acceptance on the merged result, push `main` to `easygone123/duanju`, and verify the remote SHA.
