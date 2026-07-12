# Workspace Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make workspace stage entry and switching responsive by code-splitting stages, fetching stage-specific data, patching targeted cache entries, sharing query observers, and virtualizing long card lists.

**Architecture:** Establish measurable request/render budgets first, then replace monolithic remount/refetch behavior behind compatible hooks. Each optimization ships independently with behavioral and performance-contract tests so cached stage switching remains correct while payload and mounted-card counts fall.

**Tech Stack:** Next.js 15 dynamic imports, React 19, TanStack React Query, Prisma/MySQL, SSE, IntersectionObserver/CSS containment, Vitest, Playwright-compatible browser timing harness.

---

## File Structure

- `src/lib/performance/workspace-metrics.ts`: development-only timing and count collector.
- `src/lib/query/hooks/useEpisodeStageData.ts`: stage-specific endpoint/query facade.
- `src/lib/query/cache/task-event-patcher.ts`: exact SSE cache patches.
- `src/components/virtualization/VirtualCardRange.tsx`: bounded card rendering primitive.
- `scripts/measure-workspace-performance.ts`: reproducible cold/cached measurement report.
- `tests/performance/workspace-performance.contract.test.ts`: request, payload, and mount budgets.

### Task 1: Baseline Metrics and Enforced Budgets

**Files:**
- Create: `src/lib/performance/workspace-metrics.ts`
- Create: `scripts/measure-workspace-performance.ts`
- Create: `tests/unit/performance/workspace-metrics.test.ts`
- Create: `tests/performance/workspace-performance.contract.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing metric-collector tests**

```ts
it('records stage latency, request bytes, refetch count, and mounted cards', () => {
  const metrics = createWorkspaceMetrics()
  metrics.stageStart('storyboard', 100)
  metrics.recordRequest('/storyboards', 42_000)
  metrics.recordRefetch(['storyboards', 'episode-1'])
  metrics.setMountedCards('storyboard', 18)
  metrics.stageVisible('storyboard', 260)
  expect(metrics.snapshot()).toMatchObject({
    stages: { storyboard: { visibleMs: 160, mountedCards: 18 } },
    requestBytes: 42_000,
    refetchCount: 1,
  })
})
```

- [ ] **Step 2: Verify RED**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/performance/workspace-metrics.test.ts`

Expected: FAIL because the collector does not exist.

- [ ] **Step 3: Implement a development-only collector and baseline command**

The collector is a no-op in production unless `WORKSPACE_PERF_METRICS=1`. The script writes console/JSON evidence for cold entry, cached switch latency, request count/bytes, refetches, JS chunks, and mounted card count. The contract test initially records current values as observations, while final budgets are activated task-by-task.

- [ ] **Step 4: Verify GREEN and capture baseline**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/performance/workspace-metrics.test.ts tests/performance/workspace-performance.contract.test.ts && npm run perf:workspace -- --baseline`

Expected: tests pass and the command prints a baseline report with all required fields.

- [ ] **Step 5: Commit**

```bash
git add src/lib/performance scripts/measure-workspace-performance.ts tests/unit/performance tests/performance package.json
git commit -m "test: baseline workspace performance"
```

### Task 2: Dynamic Stage Boundaries and Cached Stage Shells

**Files:**
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/WorkspaceStageContent.tsx`
- Create: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/WorkspaceStageCache.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/NovelPromotionWorkspace.tsx`
- Create: `tests/unit/novel-promotion/workspace-stage-cache.test.ts`

- [ ] **Step 1: Write failing stage-cache tests**

Assert only the active stage loader is invoked on cold entry, a visited stage remains cached after navigation, returning shows cached content before network completion, and the removed `key={currentStage}` no longer forces root remount.

- [ ] **Step 2: Verify RED**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/novel-promotion/workspace-stage-cache.test.ts`

Expected: FAIL because all stages are statically imported and the active root is keyed.

- [ ] **Step 3: Implement dynamic imports and bounded visited-stage cache**

Use `next/dynamic` for Config, Script, Storyboard, Videos, and Voice. Keep the current stage plus the two most recently visited stage shells; suspend inactive expensive bodies and retain lightweight scroll/form state. Prefetch a likely next-stage chunk after idle without fetching its data.

- [ ] **Step 4: Verify GREEN and chunk boundaries**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/novel-promotion/workspace-stage-cache.test.ts && npm run build`

Expected: tests pass and build output contains separate stage chunks rather than one workspace-stage bundle.

- [ ] **Step 5: Commit**

```bash
git add src/app/[locale]/workspace/[projectId]/modes/novel-promotion tests/unit/novel-promotion/workspace-stage-cache.test.ts
git commit -m "perf: split and cache workspace stages"
```

### Task 3: Stage-Specific Episode APIs and Query Hooks

**Files:**
- Create: `src/app/api/novel-promotion/[projectId]/episodes/[episodeId]/stage/[stage]/route.ts`
- Create: `src/lib/query/hooks/useEpisodeStageData.ts`
- Modify: `src/lib/query/keys.ts`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/hooks/useWorkspaceEpisodeStageData.ts`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/AssetsStage.tsx`
- Modify: `tests/contracts/route-catalog.ts`
- Create: `tests/integration/api/contract/episode-stage-data.route.test.ts`
- Create: `tests/unit/query/episode-stage-query.test.ts`

- [ ] **Step 1: Write failing API projection tests**

Seed an episode with panels, media history, voice lines, and videos. Assert:

```ts
expect(await stagePayload('script')).toHaveProperty('clips')
expect(await stagePayload('script')).not.toHaveProperty('storyboards')
expect(await stagePayload('storyboard')).not.toHaveProperty('voiceLines')
expect(JSON.stringify(await stagePayload('storyboard')).length).toBeLessThan(250_000)
```

Also assert project ownership and stable cursor behavior.

- [ ] **Step 2: Verify RED**

Run: `BILLING_TEST_BOOTSTRAP=1 npx vitest run tests/integration/api/contract/episode-stage-data.route.test.ts tests/unit/query/episode-stage-query.test.ts`

Expected: FAIL because the endpoint and query keys do not exist.

- [ ] **Step 3: Implement precise stage projections and compatibility facade**

Use a strict stage enum and Prisma `select` per stage. Return thumbnails and current media only; history/source media load from existing detail routes. Add `queryKeys.episodeStage(projectId, episodeId, stage, cursor)` and make workspace stage consumers use the new hook. Keep the monolithic hook only for callers not yet migrated.

- [ ] **Step 4: Verify GREEN and route guards**

Run: `BILLING_TEST_BOOTSTRAP=1 npx vitest run tests/integration/api/contract/episode-stage-data.route.test.ts tests/unit/query/episode-stage-query.test.ts && npm run check:api-handler`

Expected: projection, payload, ownership, and route tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/novel-promotion src/lib/query src/app/[locale]/workspace tests/contracts tests/integration/api/contract/episode-stage-data.route.test.ts tests/unit/query/episode-stage-query.test.ts
git commit -m "perf: load episode data by workspace stage"
```

### Task 4: Shared Model/Asset Snapshot and Targeted SSE Patching

**Files:**
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/WorkspaceProvider.tsx`
- Create: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/WorkspaceDataProvider.tsx`
- Create: `src/lib/query/cache/task-event-patcher.ts`
- Modify: `src/lib/query/hooks/useSSE.ts`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/ImageSection.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/PanelEditForm.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video/panel-card/runtime/hooks/usePanelVideoModel.ts`
- Create: `tests/unit/optimistic/workspace-task-event-patcher.test.ts`
- Create: `tests/unit/query/workspace-shared-data.test.ts`

- [ ] **Step 1: Write failing observer and patch tests**

Assert 100 panel consumers produce one user-model observer and one project-assets observer. Feed a `task.completed` event for one panel and assert only its storyboard/video stage cache entry changes; project, assets, voice, and unrelated panel references remain identical.

- [ ] **Step 2: Verify RED**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/optimistic/workspace-task-event-patcher.test.ts tests/unit/query/workspace-shared-data.test.ts`

Expected: FAIL because cards subscribe independently and SSE invalidates broad keys.

- [ ] **Step 3: Implement shared snapshots and exact patch reducers**

Subscribe once in `WorkspaceDataProvider`, expose memoized model options/assets, and remove per-card `useUserModels`/`useProjectAssets` calls. Decode task target metadata and patch only matching stage/card data. Unknown events schedule one debounced stage-level recovery refetch, not an all-scope refresh.

- [ ] **Step 4: Verify GREEN and existing optimistic tests**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/optimistic/workspace-task-event-patcher.test.ts tests/unit/query/workspace-shared-data.test.ts tests/unit/optimistic tests/unit/query`

Expected: shared-observer and cache-patch tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/[locale]/workspace src/lib/query tests/unit/optimistic tests/unit/query
git commit -m "perf: share workspace data and patch tasks"
```

### Task 5: Virtualized Card Bodies and Lazy Media

**Files:**
- Create: `src/components/virtualization/VirtualCardRange.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardCanvas.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardPanelList.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video-stage/VideoRenderPanel.tsx`
- Modify: `src/components/media/MediaImageWithLoading.tsx`
- Create: `tests/unit/components/virtual-card-range.test.ts`
- Create: `tests/unit/components/workspace-lazy-media.test.ts`

- [ ] **Step 1: Write failing viewport budget tests**

```ts
it('mounts a bounded range for 600 cards', () => {
  const range = computeVirtualRange({ count: 600, scrollTop: 4200, viewportHeight: 900, estimatedRowHeight: 420, overscan: 2 })
  expect(range.end - range.start).toBeLessThanOrEqual(10)
})
```

Assert offscreen rows render stable spacers only, thumbnails use lazy loading and responsive `sizes`, and original media is not requested until preview/crop opens.

- [ ] **Step 2: Verify RED**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/components/virtual-card-range.test.ts tests/unit/components/workspace-lazy-media.test.ts`

Expected: FAIL because all cards and media mount eagerly.

- [ ] **Step 3: Implement bounded rendering with measured rows**

Use an IntersectionObserver/ResizeObserver-backed range with stable estimated heights and overscan. Preserve focused/edited/running cards even when outside the nominal range. Use CSS `content-visibility` as a fallback. Pass thumbnail sources to cards and fetch original media only for explicit detail actions.

- [ ] **Step 4: Verify GREEN and interaction regressions**

Run: `BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/components/virtual-card-range.test.ts tests/unit/components/workspace-lazy-media.test.ts tests/unit/components tests/unit/optimistic`

Expected: viewport budgets and card interactions pass.

- [ ] **Step 5: Commit**

```bash
git add src/components src/app/[locale]/workspace tests/unit/components tests/unit/optimistic
git commit -m "perf: virtualize workspace cards and media"
```

### Task 6: Performance Acceptance and Full Regression

**Files:**
- Modify: `tests/performance/workspace-performance.contract.test.ts`
- Create: `tests/system/workspace-stage-performance.system.test.ts`
- Modify: `scripts/measure-workspace-performance.ts`
- Modify: `README.md`
- Modify: `README_en.md`

- [ ] **Step 1: Activate failing final budgets**

The performance contract must require:

```ts
expect(cachedStageVisibleMs).toBeLessThanOrEqual(300)
expect(wholeProjectRefetchesOnStageSwitch).toBe(0)
expect(initialStageRequestNames).toEqual(['project-shell', 'storyboard-stage'])
expect(initialMountedCardBodies).toBeLessThanOrEqual(20)
expect(taskCompletionUnrelatedRefetches).toBe(0)
```

Use deterministic test clocks for unit/system contracts and retain a real browser measurement as supporting evidence.

- [ ] **Step 2: Verify RED against any remaining gap**

Run: `SYSTEM_TEST_BOOTSTRAP=1 npx vitest run tests/performance/workspace-performance.contract.test.ts tests/system/workspace-stage-performance.system.test.ts`

Expected: FAIL on any budget not yet met; if all pass, temporarily restore one old broad-refetch or eager-mount behavior to prove the corresponding assertion fails, then restore the implementation.

- [ ] **Step 3: Fix only measured remaining gaps and record comparison**

Run `npm run perf:workspace -- --compare` and record cold/cached latency, requests, bytes, chunks, mounted cards, and refetch counts in README performance notes. Avoid unrelated visual or architectural refactors.

- [ ] **Step 4: Run complete verification**

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
npm run perf:workspace -- --compare
git diff --check
```

Expected: all commands exit 0, cached stage latency is at most 300 ms on the reference machine, and the comparison report shows no whole-project stage-switch refetch.

- [ ] **Step 5: Commit**

```bash
git add tests/performance tests/system/workspace-stage-performance.system.test.ts scripts/measure-workspace-performance.ts README.md README_en.md src
git commit -m "test: verify workspace performance budgets"
```
