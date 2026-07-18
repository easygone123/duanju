# ComfyUI Media Ownership and Video Variable Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair same-project legacy panel media relations and translate legacy ComfyUI video runtime variables into the canonical names produced by guided workflow mapping.

**Architecture:** Keep the existing owner/project relation query as the primary authorization gate. Add a narrowly scoped legacy panel repair beside the existing character/location repair, then add a definition-driven system-variable canonicalizer before strict ComfyUI request validation so both guided and legacy workflow contracts continue to work.

**Tech Stack:** TypeScript, Prisma, Vitest, Next.js worker/provider services, ESLint.

---

## File Map

- Modify `src/lib/comfyui/media-ownership.ts`: recognize exact storage-key and `/m/{publicId}` aliases, prove panel ownership, and conditionally attach `imageMediaId`.
- Modify `tests/unit/comfyui/media-ownership-legacy.test.ts`: reproduce same-project panel repair and cross-project refusal.
- Modify `src/lib/comfyui/request-service.ts`: canonicalize known video runtime aliases against the pinned workflow definitions.
- Modify `tests/unit/comfyui/request-state-machine.test.ts`: reproduce guided-video `INVALID_PARAMS`, preserve legacy contracts, and reject ambiguous aliases.

### Task 1: Repair legacy current-panel media ownership

**Files:**
- Modify: `tests/unit/comfyui/media-ownership-legacy.test.ts`
- Modify: `src/lib/comfyui/media-ownership.ts`

- [ ] **Step 1: Add failing same-project panel repair tests**

Extend the Prisma mock with `mediaObject.findUnique` and `novelPromotionPanel.findFirst/updateMany`, then add tests equivalent to:

```ts
it('repairs a same-project current panel image with a missing media relation', async () => {
  prismaMock.characterAppearance.findFirst.mockResolvedValue(null)
  prismaMock.novelPromotionPanel.findFirst.mockResolvedValue({ id: 'panel-1' })
  prismaMock.novelPromotionPanel.updateMany.mockResolvedValue({ count: 1 })

  await expect(resolveOwnedComfyMediaRefFromValue({
    userId: 'user-1', projectId: 'project-1', mediaType: 'image',
    value: 'images/panel.png',
  })).resolves.toEqual({ storageKey: 'images/panel.png', mimeType: 'image/png' })

  expect(prismaMock.novelPromotionPanel.updateMany).toHaveBeenCalledWith({
    where: {
      id: 'panel-1',
      imageUrl: { in: ['images/panel.png'] },
      storyboard: { episode: { novelPromotionProject: {
        projectId: 'project-1', project: { userId: 'user-1' },
      } } },
    },
    data: { imageMediaId: 'media-legacy' },
  })
})
```

Add a `/m/{publicId}` case by returning `{ publicId: 'public-panel' }` from `mediaObject.findUnique`, resolving the route to `images/panel.png`, and expecting the panel query to accept both exact aliases. Add a cross-project case where `novelPromotionPanel.findFirst` returns `null` and assert that no media is created or attached.

- [ ] **Step 2: Run the media test and verify RED**

Run:

```bash
npx vitest run tests/unit/comfyui/media-ownership-legacy.test.ts
```

Expected: the new panel cases fail because `findExactOwnedLegacyAsset` does not query `novelPromotionPanel`.

- [ ] **Step 3: Add exact legacy URL aliases and scoped panel repair**

In `src/lib/comfyui/media-ownership.ts`, build aliases without creating media before ownership is proven:

```ts
async function legacyImageUrlAliases(storageKey: string) {
  const existing = await prisma.mediaObject.findUnique({
    where: { storageKey },
    select: { publicId: true },
  })
  return existing?.publicId
    ? [storageKey, `/m/${encodeURIComponent(existing.publicId)}`]
    : [storageKey]
}
```

Use `{ in: aliases }` for the existing character/location/global exact-match queries. After those checks, add a current-panel query and conditional attachment:

```ts
const projectPanelWhere = {
  imageUrl: { in: aliases },
  storyboard: {
    episode: {
      novelPromotionProject: {
        projectId: input.projectId,
        project: { userId: input.userId },
      },
    },
  },
}
const projectPanel = await prisma.novelPromotionPanel.findFirst({
  where: projectPanelWhere,
  select: { id: true },
})
if (projectPanel) {
  return {
    attach: async (mediaId) => prisma.novelPromotionPanel.updateMany({
      where: { id: projectPanel.id, ...projectPanelWhere },
      data: { imageMediaId: mediaId },
    }),
  }
}
```

Do not match candidate arrays, history, previous images, or storage prefixes.

- [ ] **Step 4: Run the media test and verify GREEN**

Run:

```bash
npx vitest run tests/unit/comfyui/media-ownership-legacy.test.ts tests/unit/comfyui/provider-routing.test.ts tests/unit/comfyui/worker-poll.test.ts
```

Expected: all selected test files pass, including existing cross-owner rejection.

- [ ] **Step 5: Commit the ownership repair**

```bash
git add src/lib/comfyui/media-ownership.ts tests/unit/comfyui/media-ownership-legacy.test.ts
git commit -m "fix: repair legacy panel media ownership"
```

### Task 2: Canonicalize guided video workflow variables

**Files:**
- Modify: `tests/unit/comfyui/request-state-machine.test.ts`
- Modify: `src/lib/comfyui/request-service.ts`

- [ ] **Step 1: Add failing guided-video compatibility tests**

Add a request with guided definitions and legacy runtime values:

```ts
const dependencies = requestDependenciesWithDefinitions([
  { name: 'prompt', type: 'string', required: true },
  { name: 'duration', type: 'number', required: false, defaultValue: 5 },
  { name: 'firstFrame', type: 'image_ref', required: true },
  { name: 'lastFrame', type: 'image_ref', required: false, missingValuePolicy: 'preserve_original' },
])
dependencies.resolveOwnedMedia.mockResolvedValue(true)

await createComfyGenerationRequest({
  invocationKey: 'invoke-guided-video', userId: 'user-1', projectId: 'project-1',
  taskId: 'task-1', mediaType: 'video', workflowId: 'workflow-1',
  variables: {
    prompt: 'move', duration_seconds: 6,
    first_frame: { storageKey: 'images/first.png' },
    last_frame: { storageKey: 'images/last.png' },
  },
}, dependencies)

expect(dependencies.create).toHaveBeenCalledWith(expect.objectContaining({
  variableSnapshot: {
    prompt: 'move', duration: 6,
    firstFrame: { storageKey: 'images/first.png' },
    lastFrame: { storageKey: 'images/last.png' },
  },
}))
```

Add cases proving that legacy definitions preserve `duration_seconds`, `first_frame`, and `last_frame`; known legacy video values are omitted when neither alias is declared; and declaring both `duration` and `duration_seconds` or supplying both forms rejects with `INVALID_PARAMS`.

- [ ] **Step 2: Run the request-state test and verify RED**

Run:

```bash
npx vitest run tests/unit/comfyui/request-state-machine.test.ts
```

Expected: guided video cases fail because the strict validator sees undeclared snake-case variables.

- [ ] **Step 3: Generalize definition-driven system alias normalization**

Rename `normalizeReferenceImageVariables` to `normalizeSystemVariables` and retain the existing reference/aspect behavior. Add a helper with explicit collision rules:

```ts
function normalizeSystemAlias(input: {
  normalized: Record<string, ComfyVariableValue>
  names: Set<string>
  legacy: string
  canonical: string
  omitLegacyWhenUndeclared?: boolean
}) {
  const declaresLegacy = input.names.has(input.legacy)
  const declaresCanonical = input.names.has(input.canonical)
  if (declaresLegacy && declaresCanonical) throw new ApiError('INVALID_PARAMS')

  const hasLegacy = Object.hasOwn(input.normalized, input.legacy)
  const hasCanonical = Object.hasOwn(input.normalized, input.canonical)
  if (hasLegacy && hasCanonical) throw new ApiError('INVALID_PARAMS')
  if (declaresCanonical && hasLegacy) {
    input.normalized[input.canonical] = input.normalized[input.legacy]
    delete input.normalized[input.legacy]
  } else if (!declaresLegacy && !declaresCanonical && input.omitLegacyWhenUndeclared) {
    delete input.normalized[input.legacy]
  }
}
```

Apply it to:

```ts
normalizeSystemAlias({ normalized, names, legacy: 'input_images', canonical: 'referenceImages' })
normalizeSystemAlias({ normalized, names, legacy: 'duration_seconds', canonical: 'duration', omitLegacyWhenUndeclared: true })
normalizeSystemAlias({ normalized, names, legacy: 'first_frame', canonical: 'firstFrame', omitLegacyWhenUndeclared: true })
normalizeSystemAlias({ normalized, names, legacy: 'last_frame', canonical: 'lastFrame', omitLegacyWhenUndeclared: true })
if (!names.has('fps')) delete normalized.fps
```

Call `normalizeSystemVariables` from `createComfyGenerationRequest` before `sanitizeVariableSnapshot`. Do not filter unrelated unknown keys.

- [ ] **Step 4: Run focused ComfyUI tests and verify GREEN**

Run:

```bash
npx vitest run tests/unit/comfyui/request-state-machine.test.ts tests/unit/comfyui/provider-routing.test.ts tests/unit/generator-api.test.ts tests/unit/comfyui/generate-video-route.test.ts
```

Expected: all selected tests pass; guided canonical names and legacy names both remain supported.

- [ ] **Step 5: Commit the video compatibility repair**

```bash
git add src/lib/comfyui/request-service.ts tests/unit/comfyui/request-state-machine.test.ts
git commit -m "fix: adapt ComfyUI video runtime variables"
```

### Task 3: Verify the combined regression surface

**Files:**
- Verify: `src/lib/comfyui/media-ownership.ts`
- Verify: `src/lib/comfyui/request-service.ts`
- Verify: `tests/unit/comfyui/media-ownership-legacy.test.ts`
- Verify: `tests/unit/comfyui/request-state-machine.test.ts`

- [ ] **Step 1: Run affected-file lint and TypeScript checks**

```bash
npx eslint src/lib/comfyui/media-ownership.ts src/lib/comfyui/request-service.ts tests/unit/comfyui/media-ownership-legacy.test.ts tests/unit/comfyui/request-state-machine.test.ts
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 2: Run the complete ComfyUI unit surface**

```bash
npx vitest run tests/unit/comfyui
```

Expected: every ComfyUI unit test passes.

- [ ] **Step 3: Run the repository verification gate**

```bash
npm run verify:commit
npm run build
git diff --check
```

Expected: verification and build exit with status 0; existing lint warnings may remain, with no new errors; `git diff --check` prints nothing.

- [ ] **Step 4: Inspect final scope and history**

```bash
git status --short --branch
git log -5 --oneline
git diff duanju/main...HEAD --stat
```

Expected: only the approved design, plan, two production files, and their focused tests are present in commits; no unrelated working-tree changes remain.
