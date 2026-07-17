# Character Reference Prompt Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every character-sheet prompt place art style before the fixed white-background suffix, persist canonical prompt/media fields for reference conversions, and safely repair legacy image ownership links on first use.

**Architecture:** Add one pure prompt composer shared by the three character-generation workers. New reference conversions create a `MediaObject` and persist both scalar and indexed descriptions; the ComfyUI ownership resolver proves an exact scoped asset row before creating and attaching missing media metadata.

**Tech Stack:** TypeScript, Next.js worker modules, Prisma, Vitest, MinIO-compatible storage.

---

### Task 1: Shared character asset prompt composer

**Files:**
- Create: `src/lib/character-asset-prompt.ts`
- Create: `tests/unit/character-asset-prompt.test.ts`
- Modify: `src/lib/workers/handlers/reference-to-character.ts`
- Modify: `src/lib/workers/handlers/character-image-task-handler.ts`
- Modify: `src/lib/workers/handlers/asset-hub-image-task-handler.ts`
- Modify: `tests/unit/worker/reference-to-character.test.ts`
- Modify: `tests/unit/worker/character-image-task-handler.test.ts`
- Modify: `tests/unit/worker/asset-hub-image-suffix.test.ts`

- [ ] **Step 1: Write the failing helper test**

```ts
expect(buildCharacterAssetPrompt('黑发角色', '电影写实风格'))
  .toBe(`黑发角色，电影写实风格，${CHARACTER_PROMPT_SUFFIX}`)
expect(countOccurrences(result, CHARACTER_PROMPT_SUFFIX)).toBe(1)
```

- [ ] **Step 2: Run the helper test and verify it fails because the module does not exist**

Run: `pnpm vitest run tests/unit/character-asset-prompt.test.ts`
Expected: FAIL with an import-resolution error for `@/lib/character-asset-prompt`.

- [ ] **Step 3: Implement the pure composer**

```ts
import { addCharacterPromptSuffix, removeCharacterPromptSuffix } from '@/lib/constants'

export function buildCharacterAssetPrompt(basePrompt: string, artStylePrompt?: string | null): string {
  const base = removeCharacterPromptSuffix(basePrompt).replace(/，+$/, '').trim()
  const style = (artStylePrompt || '').trim()
  return addCharacterPromptSuffix([base, style].filter(Boolean).join('，'))
}
```

- [ ] **Step 4: Replace the three inline prompt constructions and assert exact ordering in worker tests**

```ts
const prompt = buildCharacterAssetPrompt(raw, artStyle)
expect(prompt.indexOf(artStyle)).toBeLessThan(prompt.indexOf(CHARACTER_PROMPT_SUFFIX))
```

- [ ] **Step 5: Run the focused prompt tests**

Run: `pnpm vitest run tests/unit/character-asset-prompt.test.ts tests/unit/worker/reference-to-character.test.ts tests/unit/worker/character-image-task-handler.test.ts tests/unit/worker/asset-hub-image-suffix.test.ts`
Expected: all tests PASS.

- [ ] **Step 6: Commit the prompt composer**

```bash
git add src/lib/character-asset-prompt.ts src/lib/workers/handlers/reference-to-character.ts src/lib/workers/handlers/character-image-task-handler.ts src/lib/workers/handlers/asset-hub-image-task-handler.ts tests/unit/character-asset-prompt.test.ts tests/unit/worker/reference-to-character.test.ts tests/unit/worker/character-image-task-handler.test.ts tests/unit/worker/asset-hub-image-suffix.test.ts
git commit -m "fix: normalize character asset prompt ordering"
```

### Task 2: Persist reference-conversion descriptions and media relation

**Files:**
- Modify: `src/lib/workers/handlers/reference-to-character.ts`
- Modify: `tests/unit/worker/reference-to-character.test.ts`

- [ ] **Step 1: Write failing project and Asset Hub persistence assertions**

```ts
expect(updateData).toEqual(expect.objectContaining({
  description: 'AI_EXTRACTED_DESCRIPTION',
  descriptions: JSON.stringify(Array(successfulCount).fill('AI_EXTRACTED_DESCRIPTION')),
  imageMediaId: 'media-reference-generated',
}))
expect(ensureMediaObjectFromStorageKey).toHaveBeenCalledWith(updateData.imageUrl)
```

- [ ] **Step 2: Run the reference worker test and verify the new assertions fail**

Run: `pnpm vitest run tests/unit/worker/reference-to-character.test.ts`
Expected: FAIL because `descriptions` and `imageMediaId` are absent.

- [ ] **Step 3: Resolve media for the primary generated key and persist canonical fields**

```ts
const mainMedia = await ensureMediaObjectFromStorageKey(successfulCosKeys[0])
const indexedDescriptions = description
  ? JSON.stringify(successfulCosKeys.map(() => description))
  : undefined

data: {
  imageUrl: successfulCosKeys[0],
  imageUrls: encodeImageUrls(successfulCosKeys),
  imageMediaId: mainMedia.id,
  description: description || undefined,
  descriptions: indexedDescriptions,
}
```

- [ ] **Step 4: Run the reference worker test**

Run: `pnpm vitest run tests/unit/worker/reference-to-character.test.ts`
Expected: all tests PASS for both project and global background conversions.

- [ ] **Step 5: Commit canonical persistence**

```bash
git add src/lib/workers/handlers/reference-to-character.ts tests/unit/worker/reference-to-character.test.ts
git commit -m "fix: link converted character references to media"
```

### Task 3: Scoped lazy repair for legacy image relations

**Files:**
- Modify: `src/lib/media/service.ts`
- Modify: `src/lib/comfyui/media-ownership.ts`
- Modify: `tests/unit/comfyui/media-ownership-legacy.test.ts`

- [ ] **Step 1: Write failing tests for scoped repair and fail-closed behavior**

```ts
expect(prisma.characterAppearance.findFirst).toHaveBeenCalledWith({
  where: expect.objectContaining({ imageUrl: 'images/legacy.png' }),
  select: { id: true },
})
expect(ensureMediaObjectFromStorageKey).toHaveBeenCalledAfter(prisma.characterAppearance.findFirst)
expect(prisma.characterAppearance.updateMany).toHaveBeenCalledWith({
  where: expect.objectContaining({ id: 'appearance-legacy' }),
  data: { imageMediaId: 'media-legacy' },
})
```

For an unowned key and a non-image extension, assert the resolver returns `null`, `ensureMediaObjectFromStorageKey` is not called, and no asset row is updated.

- [ ] **Step 2: Run the legacy ownership test and verify it fails under media-first repair**

Run: `pnpm vitest run tests/unit/comfyui/media-ownership-legacy.test.ts`
Expected: FAIL because current code queries `MediaObject` before proving asset ownership.

- [ ] **Step 3: Export MIME inference and implement ownership-first repair**

```ts
export function guessMimeTypeFromStorageKey(storageKey: string): string | null

const mimeType = guessMimeTypeFromStorageKey(input.storageKey)
if (!mimeType?.startsWith('image/')) return null
const ownedAsset = await findExactOwnedLegacyAsset(input)
if (!ownedAsset) return null
const media = await ensureMediaObjectFromStorageKey(input.storageKey, { mimeType })
const result = await ownedAsset.update(media.id)
return result.count > 0 ? media : null
```

The exact scope predicates remain:

```ts
character: {
  novelPromotionProject: {
    projectId: input.projectId,
    project: { userId: input.userId },
  },
}
```

Global assets use `character.userId` or `location.userId`; project assets require both project and user.

- [ ] **Step 4: Run ComfyUI ownership tests**

Run: `pnpm vitest run tests/unit/comfyui/media-ownership.test.ts tests/unit/comfyui/media-ownership-legacy.test.ts tests/unit/comfyui/provider-routing.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit lazy repair**

```bash
git add src/lib/media/service.ts src/lib/comfyui/media-ownership.ts tests/unit/comfyui/media-ownership-legacy.test.ts
git commit -m "fix: repair scoped legacy asset media links"
```

### Task 4: Verification and integration

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run all focused suites**

Run: `pnpm vitest run tests/unit/character-asset-prompt.test.ts tests/unit/worker/reference-to-character.test.ts tests/unit/worker/character-image-task-handler.test.ts tests/unit/worker/asset-hub-image-suffix.test.ts tests/unit/comfyui/media-ownership.test.ts tests/unit/comfyui/media-ownership-legacy.test.ts tests/unit/comfyui/provider-routing.test.ts tests/unit/storage/streaming-object.test.ts tests/integration/api/contract/infra-routes.test.ts`
Expected: all tests PASS.

- [ ] **Step 2: Run static checks**

Run: `pnpm exec tsc --noEmit`
Expected: exit 0.

Run: `pnpm exec eslint src/lib/character-asset-prompt.ts src/lib/workers/handlers/reference-to-character.ts src/lib/workers/handlers/character-image-task-handler.ts src/lib/workers/handlers/asset-hub-image-task-handler.ts src/lib/comfyui/media-ownership.ts src/lib/storage/providers/minio.ts tests/unit/character-asset-prompt.test.ts tests/unit/worker/reference-to-character.test.ts tests/unit/comfyui/media-ownership-legacy.test.ts tests/unit/storage/streaming-object.test.ts`
Expected: exit 0.

- [ ] **Step 3: Verify repository diff and commit the plan**

Run: `git diff --check && git status --short`
Expected: no whitespace errors and only intended files.

```bash
git add -f docs/superpowers/plans/2026-07-17-character-reference-prompt-chain.md
git commit -m "docs: add character prompt chain implementation plan"
```
