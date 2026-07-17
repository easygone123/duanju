# Six-grid Stored Prompt Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return the six-grid sheet prompt already stored on each storyboard so the prompt modal displays and copies the original planning text.

**Architecture:** Keep `NovelPromotionStoryboard.sheetPromptSnapshot` as the single canonical source. Extend only the storyboard-stage database projection and its TypeScript payload contract; do not rebuild prompts or add fallback data sources.

**Tech Stack:** Next.js route handlers, Prisma selects, TypeScript, Vitest.

---

### Task 1: Lock the missing storyboard-stage field with a route contract test

**Files:**
- Modify: `tests/integration/api/contract/episode-stage-data.route.test.ts`

- [ ] **Step 1: Add an exact saved prompt to the storyboard fixture**

Add this field to the fixture row whose id is `storyboard-1` (the response sorts
that row first):

```ts
sheetPromptSnapshot: 'ORIGINAL SIX GRID PROMPT\nBeat 1',
```

- [ ] **Step 2: Assert only the storyboard-stage response exposes it**

In the `stage === 'storyboard'` branch, add:

```ts
expect(body.episode.storyboards[0].sheetPromptSnapshot).toBe(
  'ORIGINAL SIX GRID PROMPT\nBeat 1',
)
```

In the `stage === 'videos'` and `stage === 'voice'` branches, add:

```ts
expect(body.episode.storyboards[0]).not.toHaveProperty('sheetPromptSnapshot')
```

- [ ] **Step 3: Run the focused test and verify RED**

Run from the isolated worktree:

```bash
pnpm vitest run tests/integration/api/contract/episode-stage-data.route.test.ts --reporter=dot
```

Expected: FAIL because the storyboard-stage response does not contain `sheetPromptSnapshot`.

### Task 2: Return the canonical prompt through the storyboard-stage contract

**Files:**
- Modify: `src/app/api/novel-promotion/[projectId]/episodes/[episodeId]/stage/[stage]/route.ts`
- Modify: `src/lib/novel-promotion/episode-stage-data.ts`
- Test: `tests/integration/api/contract/episode-stage-data.route.test.ts`

- [ ] **Step 1: Add the field to the Prisma storyboard projection**

Add the following beside the other six-grid sheet fields in `storyboardSelect`:

```ts
sheetPromptSnapshot: true,
```

- [ ] **Step 2: Add the field to the typed storyboard-stage payload**

Add this member to `StoryboardFields`:

```ts
| 'sheetPromptSnapshot'
```

- [ ] **Step 3: Run the route contract test and verify GREEN**

```bash
pnpm vitest run tests/integration/api/contract/episode-stage-data.route.test.ts --reporter=dot
```

Expected: all tests pass and the exact saved prompt is present only in the storyboard projection.

- [ ] **Step 4: Run the prompt modal regression test**

```bash
pnpm vitest run tests/unit/components/six-grid-external-upload.test.tsx --reporter=dot
```

Expected: all tests pass, including exact display/copy and genuine-empty behavior.

- [ ] **Step 5: Run static checks**

```bash
pnpm exec tsc --noEmit
pnpm exec eslint \
  'src/app/api/novel-promotion/[projectId]/episodes/[episodeId]/stage/[stage]/route.ts' \
  src/lib/novel-promotion/episode-stage-data.ts \
  tests/integration/api/contract/episode-stage-data.route.test.ts
git diff --check
```

Expected: every command exits with status 0.

- [ ] **Step 6: Commit the fix**

```bash
git add \
  'src/app/api/novel-promotion/[projectId]/episodes/[episodeId]/stage/[stage]/route.ts' \
  src/lib/novel-promotion/episode-stage-data.ts \
  tests/integration/api/contract/episode-stage-data.route.test.ts
git commit -m "fix: return stored six-grid prompts"
```

Expected: one focused implementation commit containing the failing test and the minimal production changes.
