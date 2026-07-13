# Finished-Film Combined Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one continuous, no-black-screen preview and clickable storyboard-node navigator to the novel-promotion finished-film page.

**Architecture:** Project the existing ordered `VideoPanel[]` and per-panel lip-sync preference into one immutable frame timeline. A single Remotion Player consumes that timeline, while a sibling node navigator seeks within the same player and a bounded preloader keeps only the previous/current/next videos warm. Static storyboard images and a non-black placeholder stay under every video layer so missing, buffering, and failed media never expose a black frame.

**Tech Stack:** TypeScript, React, Next.js client components, Remotion 4 (`@remotion/player`, `remotion`), next-intl, Vitest, Testing Library.

---

## File Structure

- Create `src/lib/novel-promotion/video/combined-preview.ts`: pure source selection, duration resolution, frame projection, active-node binary search, and complementary crossfade audio envelope.
- Create `tests/unit/novel-promotion/combined-preview.test.ts`: pure timeline and no-black invariants.
- Create `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video-stage/combined-preview/CombinedPreviewComposition.tsx`: Remotion composition and resilient media layers.
- Create `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video-stage/combined-preview/useCombinedPreviewPreload.ts`: bounded previous/current/next Remotion prefetch lifecycle.
- Create `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video-stage/combined-preview/CombinedPreviewPanel.tsx`: one Player, controls, node navigator, seeking, active-node sync, and empty state.
- Create `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video-stage/combined-preview/index.ts`: focused public export.
- Create `tests/unit/components/finished-film-combined-preview.test.tsx`: interaction, stable Player, state, fallback, and prefetch coverage.
- Modify `src/lib/novel-promotion/stages/video-stage-runtime-core.tsx`: mount the preview after the toolbar and pass projected panels, preferences, and ratio.
- Modify `messages/zh/video.json` and `messages/en/video.json`: all new user-facing labels and statuses.

### Task 1: Pure combined-preview timeline

**Files:**
- Create: `src/lib/novel-promotion/video/combined-preview.ts`
- Create: `tests/unit/novel-promotion/combined-preview.test.ts`

- [ ] **Step 1: Write failing source, duration, and ordering tests**

Create test fixtures with individual panels followed by two six-grid groups. Assert that projection preserves `allPanels` order, chooses the lip-sync URL only when preference is enabled and available, falls back to `videoUrl`, and always emits an item even when both video and image are missing.

```ts
const timeline = buildCombinedPreviewTimeline({
  panels: [
    panel({ panelId: 'p1', videoUrl: 'base-1.mp4', lipSyncVideoUrl: 'lip-1.mp4', durationOverride: 4 }),
    panel({ panelId: 'p2', imageUrl: 'p2.png', estimatedDuration: 5 }),
    panel({ panelId: 'p3' }),
  ],
  panelVideoPreference: new Map([['p1', true]]),
  fps: 30,
})

expect(timeline.items.map((item) => item.panelKey)).toEqual(['p1', 'p2', 'p3'])
expect(timeline.items[0]).toMatchObject({ videoUrl: 'lip-1.mp4', durationInFrames: 120, status: 'video' })
expect(timeline.items[1]).toMatchObject({ videoUrl: null, imageUrl: 'p2.png', durationInFrames: 150, status: 'image' })
expect(timeline.items[2]).toMatchObject({ videoUrl: null, imageUrl: null, status: 'missing' })
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
npx vitest run tests/unit/novel-promotion/combined-preview.test.ts
```

Expected: FAIL because `buildCombinedPreviewTimeline` does not exist.

- [ ] **Step 3: Implement stable keys, selected media, and duration priority**

Define the public types and helpers. Use `panelId`, falling back to `${storyboardId}:${panelIndex}`. The preference lookup must accept both the stable panel ID and `buildVideoSubmissionKey`-compatible fallback key so current card selection and preview selection cannot diverge.

```ts
export type CombinedPreviewStatus = 'video' | 'image' | 'generating' | 'failed' | 'missing'

export interface CombinedPreviewItem {
  panelKey: string
  panelId?: string
  storyboardId: string
  panelIndex: number
  groupSequence?: number | null
  gridCellIndex?: number | null
  videoUrl: string | null
  imageUrl: string | null
  durationInFrames: number
  startFrame: number
  endFrame: number
  transitionInFrames: number
  transitionOutFrames: number
  status: CombinedPreviewStatus
}

function resolveDurationSeconds(panel: VideoPanel): number {
  const candidates = [
    panel.durationOverride,
    panel.estimatedDuration,
    panel.textPanel?.duration,
    3,
  ]
  return candidates.find((value) => typeof value === 'number' && Number.isFinite(value) && value > 0) as number
}
```

- [ ] **Step 4: Write failing overlap, audio-envelope, and active-node tests**

Assert the second item starts before the first ends, total duration equals the last item end, complementary audio-envelope values sum to `1` at every integer frame in an overlap, and frame lookup selects the newly entered node. Add 1,024 items and an `onProbe` callback assertion limiting binary-search probes to at most 11.

```ts
for (let frame = second.startFrame; frame < first.endFrame; frame += 1) {
  const outgoing = resolveCombinedPreviewOpacity(first, frame - first.startFrame)
  const incoming = resolveCombinedPreviewOpacity(second, frame - second.startFrame)
  expect(outgoing + incoming).toBeCloseTo(1, 6)
}

let probes = 0
expect(findCombinedPreviewItemIndexAtFrame(large.items, large.items[700].startFrame, () => { probes += 1 })).toBe(700)
expect(probes).toBeLessThanOrEqual(11)
```

- [ ] **Step 5: Run the new tests and verify RED**

Run the same Vitest command. Expected: source tests pass; overlap/search tests fail because the helpers are missing.

- [ ] **Step 6: Implement timeline overlap, exact audio envelope, and binary search**

For each adjacent pair, calculate:

```ts
const transitionFrames = Math.min(
  15,
  Math.floor(current.durationInFrames / 4),
  Math.floor(next.durationInFrames / 4),
)
next.startFrame = current.endFrame - transitionFrames
current.transitionOutFrames = transitionFrames
next.transitionInFrames = transitionFrames
```

`resolveCombinedPreviewOpacity()` is the complementary audio envelope and must use complementary progress for transition-in and transition-out. `findCombinedPreviewItemIndexAtFrame()` must use upper-bound binary search on `startFrame`, clamped to the first and last item.

- [ ] **Step 7: Run Task 1 tests and commit**

Run:

```bash
npx vitest run tests/unit/novel-promotion/combined-preview.test.ts
npm run typecheck
git diff --check
git add src/lib/novel-promotion/video/combined-preview.ts tests/unit/novel-promotion/combined-preview.test.ts
git commit -m "feat: project combined video preview timeline"
```

Expected: all commands pass and the commit succeeds.

### Task 2: Resilient Remotion composition

**Files:**
- Create: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video-stage/combined-preview/CombinedPreviewComposition.tsx`
- Create: `tests/unit/novel-promotion/combined-preview-composition.test.ts`

- [ ] **Step 1: Write failing composition contract tests**

Render the composition tree with `react-dom/server` or a shallow Remotion test harness. Assert that every item gets a non-black base layer, image-only items render an `<img>`, video items retain the image/placeholder base and add one video layer, and the root background is not black.

```ts
const html = renderToStaticMarkup(createElement(CombinedPreviewComposition, { timeline }))
expect(html).toContain('data-preview-base="p1"')
expect(html).toContain('data-preview-video="p1"')
expect(html).toContain('data-preview-base="missing"')
expect(html).not.toContain('background-color:black')
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npx vitest run tests/unit/novel-promotion/combined-preview-composition.test.ts
```

Expected: FAIL because the composition module does not exist.

- [ ] **Step 3: Implement the composition and resilient media layer**

Use one `AbsoluteFill` with a neutral surface color. Map items to overlapping `Sequence` components. Each sequence renders a base layer first, then renders `Video` above it only when `status === 'video'` and `videoUrl` exists. Keep video opacity at zero until `onCanPlay`; on `onError`, leave the base visible. For source-over visuals, keep the outgoing outer layer at opacity `1` and fade only the incoming outer layer, so `incoming + outgoing * (1 - incoming) === 1`. Pass the complementary `resolveCombinedPreviewOpacity()` value as numeric video volume, so overlap volumes sum to `1` and non-overlap volume is `1`.

```tsx
<AbsoluteFill style={{ backgroundColor: '#111827' }}>
  {timeline.items.map((item) => (
    <Sequence key={item.panelKey} from={item.startFrame} durationInFrames={item.durationInFrames}>
      <CombinedPreviewMedia item={item} />
    </Sequence>
  ))}
</AbsoluteFill>
```

The base uses Remotion `Img` with `maxRetries={0}` when `imageUrl` exists; an image error removes that image node while retaining the gradient, and a URL change resets the local failure state. Otherwise the base renders a gradient placeholder with no hard-coded user text. The video uses `pauseWhenBuffering`, `muted={false}`, and `objectFit: 'cover'`.

- [ ] **Step 4: Verify and commit Task 2**

Run:

```bash
npx vitest run tests/unit/novel-promotion/combined-preview-composition.test.ts tests/unit/novel-promotion/combined-preview.test.ts
npm run typecheck
npx eslint 'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video-stage/combined-preview/CombinedPreviewComposition.tsx'
git diff --check
git add 'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video-stage/combined-preview/CombinedPreviewComposition.tsx' tests/unit/novel-promotion/combined-preview-composition.test.ts
git commit -m "feat: render no-black combined preview composition"
```

Expected: all commands pass.

### Task 3: Player controls, nodes, and bounded preloading

**Files:**
- Create: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video-stage/combined-preview/useCombinedPreviewPreload.ts`
- Create: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video-stage/combined-preview/CombinedPreviewPanel.tsx`
- Create: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video-stage/combined-preview/index.ts`
- Create: `tests/unit/components/finished-film-combined-preview.test.tsx`

- [ ] **Step 1: Write failing interaction tests with a controlled Player mock**

Mock `@remotion/player` with a `forwardRef` Player exposing `seekTo`, `play`, `pause`, `getCurrentFrame`, and event registration. Track mount count. Render three panels and assert three node buttons, one Player mount, click-to-seek, playback-state preservation, and active-node update after a simulated `frameupdate`.

```ts
fireEvent.click(view.getByRole('button', { name: /镜头 2/ }))
expect(seekTo).toHaveBeenLastCalledWith(timeline.items[1].startFrame)
expect(playerMounts).toBe(1)

emitFrame(timeline.items[2].startFrame)
expect(view.getByRole('button', { name: /镜头 3/ })).toHaveAttribute('aria-current', 'true')
```

Add a rapid-click assertion: click node 1, 2, 3 synchronously and require the final seek and active state to be node 3.

- [ ] **Step 2: Run component tests and verify RED**

Run:

```bash
npx vitest run tests/unit/components/finished-film-combined-preview.test.tsx
```

Expected: FAIL because `CombinedPreviewPanel` does not exist.

- [ ] **Step 3: Implement one stable Player and node synchronization**

Build the timeline with `useMemo`. Keep `Player` mounted while items exist. Use the player ref for seek/play/pause. Register `frameupdate`, `play`, `pause`, and `ended` exactly once per player instance. Derive the active index with the pure binary-search helper and only call `setActiveIndex` when it changes.

Node buttons must include `aria-current`, lazy thumbnail images, status badge, formatted duration, and a `data-group-start` marker when `groupSequence` changes. On active-key change call `scrollIntoView({ block: 'nearest', inline: 'center' })` on that node.

- [ ] **Step 4: Write failing bounded-preload tests**

Mock Remotion `prefetch()` to return `{ free, waitUntilDone }`. Assert initial desired URLs are items 0 and 1; after jumping to item 2 they are items 1, 2, and 3; URLs leaving the window call `free()`; duplicates are prefetched once; unmount frees all handles.

```ts
expect(prefetch).toHaveBeenCalledWith('clip-1.mp4', expect.anything())
expect(prefetch).toHaveBeenCalledWith('clip-2.mp4', expect.anything())
fireEvent.click(node3)
expect(freeByUrl.get('clip-1.mp4')).toHaveBeenCalledTimes(1)
```

- [ ] **Step 5: Run preload tests and verify RED**

Run the component test command again. Expected: interaction tests pass; preload lifecycle tests fail because the hook is missing.

- [ ] **Step 6: Implement the bounded preload hook**

Maintain `Map<string, ReturnType<typeof prefetch>>` in a ref. On each active index, calculate the unique non-null video URLs for indices `active - 1` through `active + 1`. Add missing handles; call `free()` and delete handles outside the set. The unmount cleanup frees every remaining handle. Do not await `waitUntilDone()` to update active selection.

- [ ] **Step 7: Cover empty, missing, generating, and failed states**

Extend the component test to assert no Player for an empty list; image fallback nodes remain clickable; generating and failed badges render; and a node without any media uses the non-black placeholder. Implement the exact states from `CombinedPreviewStatus` without filtering items.

- [ ] **Step 8: Verify and commit Task 3**

Run:

```bash
npx vitest run tests/unit/components/finished-film-combined-preview.test.tsx tests/unit/novel-promotion/combined-preview.test.ts
npm run typecheck
npx eslint 'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video-stage/combined-preview'
git diff --check
git add 'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video-stage/combined-preview' tests/unit/components/finished-film-combined-preview.test.tsx
git commit -m "feat: navigate combined finished-film preview"
```

Expected: all commands pass.

### Task 4: Finished-film page integration and localization

**Files:**
- Modify: `src/lib/novel-promotion/stages/video-stage-runtime-core.tsx`
- Modify: `messages/zh/video.json`
- Modify: `messages/en/video.json`
- Modify: `tests/unit/components/finished-film-combined-preview.test.tsx`

- [ ] **Step 1: Write failing localization and runtime integration assertions**

Extend the component test to provide a deterministic `next-intl` mock and assert titles/control/status labels are obtained from `video.combinedPreview`. Add a runtime test seam by exporting a small `VideoCombinedPreviewSlot` component from the combined-preview index or by mocking `CombinedPreviewPanel` while rendering the runtime shell with existing test helpers; assert it receives `projectedPanels`, `panelVideoPreference`, and `videoRatio` and appears before `VideoTimelinePanel`.

```ts
expect(view.getByRole('region', { name: '全片连续预览' })).toBeTruthy()
expect(combinedPreviewProps).toMatchObject({ videoRatio: '16:9' })
expect(combinedPreviewProps.panels).toHaveLength(3)
```

- [ ] **Step 2: Run integration-focused tests and verify RED**

Run:

```bash
npx vitest run tests/unit/components/finished-film-combined-preview.test.tsx
```

Expected: FAIL because runtime and message catalogs do not expose the new feature.

- [ ] **Step 3: Add message catalogs**

Add the same key structure to Chinese and English:

```json
"combinedPreview": {
  "title": "全片连续预览",
  "empty": "暂无可预览分镜",
  "play": "播放",
  "pause": "暂停",
  "previous": "上一分镜",
  "next": "下一分镜",
  "shot": "镜头 {number}",
  "video": "视频可用",
  "image": "静态分镜",
  "generating": "生成中",
  "failed": "生成失败",
  "missing": "缺少媒体"
}
```

The English catalog must use natural equivalents under identical keys.

- [ ] **Step 4: Mount the preview on the finished-film page**

Import `CombinedPreviewPanel` into `video-stage-runtime-core.tsx` and render it immediately after `VideoToolbar`:

```tsx
<CombinedPreviewPanel
  panels={projectedPanels}
  panelVideoPreference={panelVideoPreference}
  videoRatio={videoRatio}
/>
```

Do not change generation, download, voice, first/last-frame, or editor callbacks.

- [ ] **Step 5: Run focused and regression verification**

Run:

```bash
npx vitest run tests/unit/components/finished-film-combined-preview.test.tsx tests/unit/novel-promotion/combined-preview.test.ts tests/unit/novel-promotion/video-panel-card-body.test.ts tests/unit/novel-promotion/video-panels-projection-error-code.test.ts
npm run typecheck
npx eslint src/lib/novel-promotion/video/combined-preview.ts src/lib/novel-promotion/stages/video-stage-runtime-core.tsx 'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video-stage/combined-preview'
git diff --check
```

Expected: every command passes.

- [ ] **Step 6: Commit integration**

```bash
git add src/lib/novel-promotion/stages/video-stage-runtime-core.tsx messages/zh/video.json messages/en/video.json tests/unit/components/finished-film-combined-preview.test.tsx
git commit -m "feat: add combined preview to finished-film stage"
```

Expected: full commit hook passes and the worktree is clean.

### Task 5: Final acceptance verification

**Files:**
- No production changes unless a failing acceptance test exposes a defect.

- [ ] **Step 1: Run the complete feature gate**

```bash
npx vitest run tests/unit/novel-promotion/combined-preview.test.ts tests/unit/components/finished-film-combined-preview.test.tsx tests/unit/novel-promotion/video-panel-card-body.test.ts tests/unit/novel-promotion/frame-link-resolver.test.ts tests/unit/worker/video-worker.test.ts
npm run typecheck
npm run lint -- .
git diff --check
git status --short
```

Expected: tests, typecheck, and lint pass; diff check passes; status is empty.

- [ ] **Step 2: Verify acceptance behavior in a local browser when the app fixture is available**

Open an episode containing at least four panels: a normal video, a lip-sync video, an image-only panel, and a failed panel. Confirm one Player, all four nodes, click-to-seek without remount, continuous crossfade without black, image fallback, failed badge, active-node auto-scroll, and preserved play/pause state. If the local app fixture is unavailable, record this exact limitation and retain the automated interaction evidence instead of claiming manual browser verification.

- [ ] **Step 3: Request final spec and code-quality review**

Review the complete diff from the design-doc commit through the final implementation commit. Any Critical or Important finding must return to the relevant implementer with a new failing test, then be re-reviewed by the same reviewer.
