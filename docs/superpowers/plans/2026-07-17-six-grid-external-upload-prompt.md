# Six-Grid External Upload and Prompt Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users copy the stored six-grid prompt and upload an externally generated six-grid sheet before or after system generation, then reuse the existing upscale and crop flows safely.

**Architecture:** Add a shared ratio contract and bounded Sharp validator, then a transactional replacement service behind a project-owned multipart route. The client adds one upload mutation and two focused modals; uploaded media replaces the sheet under `sheetArtifactVersion` CAS and invalidates every panel image derived from the previous sheet.

**Tech Stack:** Next.js App Router, TypeScript, React, TanStack Query, Prisma/MySQL, Sharp, MediaObject/storage services, Vitest, Testing Library, next-intl.

---

## File Map

- Create `src/lib/novel-promotion/six-grid/upload-contract.ts` for shared ratio and size rules.
- Create `src/lib/novel-promotion/six-grid/upload-validation.ts` for bounded server decoding.
- Create `src/lib/novel-promotion/six-grid/upload-service.ts` for active-task checks and atomic replacement.
- Create `src/app/api/novel-promotion/[projectId]/storyboard-sheet/upload/route.ts` for multipart upload.
- Create `SixGridPromptModal.tsx` and `SixGridUploadModal.tsx` for the two dialogs.
- Modify the existing six-grid query hook, controller, group controls, group component, types, translations, and focused tests.

## Task 1: Shared Upload Contract and Server Validation

**Files:**
- Create: `src/lib/novel-promotion/six-grid/upload-contract.ts`
- Create: `src/lib/novel-promotion/six-grid/upload-validation.ts`
- Create: `tests/unit/novel-promotion/six-grid-upload-validation.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { expectedSixGridSheetRatio, isSixGridSheetRatioAllowed } from '@/lib/novel-promotion/six-grid/upload-contract'
import { validateAndNormalizeSixGridUpload } from '@/lib/novel-promotion/six-grid/upload-validation'

describe('six-grid upload validation', () => {
  it('uses canonical ratios and a three-percent inclusive tolerance', () => {
    expect(expectedSixGridSheetRatio('16:9')).toBeCloseTo(8 / 3)
    expect(expectedSixGridSheetRatio('9:16')).toBeCloseTo(27 / 32)
    expect(isSixGridSheetRatioAllowed((8 / 3) * 1.03, '16:9')).toBe(true)
    expect(isSixGridSheetRatioAllowed((8 / 3) * 1.0301, '16:9')).toBe(false)
  })

  it.each(['png', 'jpeg', 'webp'] as const)('normalizes valid %s', async (format) => {
    const image = sharp({ create: { width: 2400, height: 900, channels: 3, background: '#777' } })
    const result = await validateAndNormalizeSixGridUpload(await image[format]().toBuffer(), '16:9')
    expect(result).toMatchObject({ width: 2400, height: 900, mimeType: 'image/webp' })
  })

  it('rejects invalid bytes and a wrong ratio', async () => {
    await expect(validateAndNormalizeSixGridUpload(Buffer.from('not-image'), '16:9'))
      .rejects.toMatchObject({ code: 'SIX_GRID_UPLOAD_IMAGE_INVALID' })
    const square = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: '#777' } }).png().toBuffer()
    await expect(validateAndNormalizeSixGridUpload(square, '16:9'))
      .rejects.toMatchObject({ code: 'SIX_GRID_UPLOAD_RATIO_INVALID' })
  })

  it('rejects decodable formats outside PNG, JPEG, and WebP', async () => {
    const gif = await sharp({ create: { width: 2400, height: 900, channels: 3, background: '#777' } }).gif().toBuffer()
    await expect(validateAndNormalizeSixGridUpload(gif, '16:9'))
      .rejects.toMatchObject({ code: 'SIX_GRID_UPLOAD_IMAGE_INVALID' })
  })
})
```

- [ ] **Step 2: Verify RED**

Run `pnpm vitest run tests/unit/novel-promotion/six-grid-upload-validation.test.ts`.

Expected: FAIL because both upload modules are missing.

- [ ] **Step 3: Implement the shared contract**

```ts
import type { SixGridCellAspectRatio } from './contracts'

export const SIX_GRID_UPLOAD_RATIO_TOLERANCE = 0.03
export const SIX_GRID_UPLOAD_MAX_BYTES = 25 * 1024 * 1024
export const SIX_GRID_UPLOAD_MAX_PIXELS = 80_000_000
export const SIX_GRID_UPLOAD_MAX_DIMENSION = 16_384

export function expectedSixGridSheetRatio(value: SixGridCellAspectRatio) {
  if (value === '16:9') return 8 / 3
  if (value === '9:16') return 27 / 32
  throw new Error('SIX_GRID_CELL_RATIO_INVALID')
}

export function sheetRatio(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error('SIX_GRID_UPLOAD_DIMENSIONS_INVALID')
  }
  return width / height
}

export function isSixGridSheetRatioAllowed(actual: number, cellRatio: SixGridCellAspectRatio) {
  const expected = expectedSixGridSheetRatio(cellRatio)
  return Number.isFinite(actual) && Math.abs(actual - expected) / expected <= SIX_GRID_UPLOAD_RATIO_TOLERANCE
}
```

- [ ] **Step 4: Implement bounded Sharp normalization**

```ts
import sharp from 'sharp'
import type { SixGridCellAspectRatio } from './contracts'
import { isSixGridSheetRatioAllowed, sheetRatio, SIX_GRID_UPLOAD_MAX_BYTES, SIX_GRID_UPLOAD_MAX_DIMENSION, SIX_GRID_UPLOAD_MAX_PIXELS } from './upload-contract'

export class SixGridUploadError extends Error {
  constructor(
    readonly code: 'SIX_GRID_UPLOAD_IMAGE_INVALID' | 'SIX_GRID_UPLOAD_TOO_LARGE' | 'SIX_GRID_UPLOAD_RATIO_INVALID',
    readonly details?: Record<string, number>,
  ) { super(code); this.name = 'SixGridUploadError' }
}

export async function validateAndNormalizeSixGridUpload(source: Buffer, cellRatio: SixGridCellAspectRatio) {
  if (source.byteLength === 0 || source.byteLength > SIX_GRID_UPLOAD_MAX_BYTES) {
    throw new SixGridUploadError('SIX_GRID_UPLOAD_TOO_LARGE')
  }
  try {
    const decoder = sharp(source, { failOn: 'error', limitInputPixels: SIX_GRID_UPLOAD_MAX_PIXELS })
    const metadata = await decoder.metadata()
    if (!metadata.format || !['png', 'jpeg', 'webp'].includes(metadata.format)) {
      throw new SixGridUploadError('SIX_GRID_UPLOAD_IMAGE_INVALID')
    }
    const result = await decoder
      .rotate().webp({ quality: 95 }).toBuffer({ resolveWithObject: true })
    const { width, height } = result.info
    if (width > SIX_GRID_UPLOAD_MAX_DIMENSION || height > SIX_GRID_UPLOAD_MAX_DIMENSION) {
      throw new SixGridUploadError('SIX_GRID_UPLOAD_TOO_LARGE')
    }
    const actualRatio = sheetRatio(width, height)
    if (!isSixGridSheetRatioAllowed(actualRatio, cellRatio)) {
      throw new SixGridUploadError('SIX_GRID_UPLOAD_RATIO_INVALID', { width, height, actualRatio })
    }
    return { bytes: result.data, width, height, sizeBytes: result.data.byteLength, mimeType: 'image/webp' as const }
  } catch (error) {
    if (error instanceof SixGridUploadError) throw error
    throw new SixGridUploadError('SIX_GRID_UPLOAD_IMAGE_INVALID')
  }
}
```

- [ ] **Step 5: Verify GREEN and commit**

Run the focused test and ESLint for the three changed files. Expected: PASS and zero errors.

Commit with `git commit -m "feat: validate external six-grid sheets"`.

## Task 2: Atomic Sheet Replacement Service

**Files:**
- Create: `src/lib/novel-promotion/six-grid/upload-service.ts`
- Create: `tests/integration/six-grid/six-grid-upload-replacement.integration.test.ts`

- [ ] **Step 1: Write failing replacement tests**

Build a store fixture with an owned six-grid storyboard at artifact version 4 and six populated panels. Assert success installs the new media, increments to 5, clears the old sheet upscale and all image lineage fields, while retaining descriptions, prompts, dialogue, and duration. Add independent cases for stale version, wrong owner, incomplete panel set, and active sheet task. Every failure must leave the fixture unchanged.

```ts
expect(result).toEqual({ mediaId: 'uploaded-media', url: '/m/uploaded', sheetArtifactVersion: 5 })
expect(store.storyboard).toMatchObject({
  sheetImageMediaId: 'uploaded-media', upscaledSheetImageMediaId: null,
  imageHistory: null, sheetArtifactVersion: 5,
})
for (const panel of store.panels) {
  expect(panel).toMatchObject({
    imageMediaId: null, imageUrl: null, imageHistory: null,
    previousImageMediaId: null, previousImageUrl: null,
    normalizedCropRect: null, croppedImageMediaId: null, croppedImageUrl: null,
    upscaledImageMediaId: null, upscaledImageUrl: null,
    imageDerivation: null, imageLineage: null,
  })
}
```

- [ ] **Step 2: Verify RED**

Run `pnpm vitest run tests/integration/six-grid/six-grid-upload-replacement.integration.test.ts`.

Expected: FAIL because `replaceSixGridSheet` does not exist.

- [ ] **Step 3: Implement the service**

Export `assertSixGridUploadAvailable`. It queries `Task` with the same `userId`, `projectId`, `episodeId`, `targetType: 'NovelPromotionStoryboard'`, and `targetId: storyboardId`; reject type `storyboard_sheet_generate`, `storyboard_sheet_upscale`, or `storyboard_sheet_crop` in status `queued`/`processing` with `SIX_GRID_UPLOAD_BUSY`. Call this once from the route before image decoding/storage and again from `replaceSixGridSheet` immediately before the transaction so the service remains fail-closed when called independently.

Inside a single Prisma transaction, execute this CAS and panel invalidation:

```ts
const updated = await tx.novelPromotionStoryboard.updateMany({
  where: {
    id: input.storyboardId,
    episodeId: input.episodeId,
    layoutMode: 'six_grid',
    sheetArtifactVersion: input.expectedSheetArtifactVersion,
    episode: { novelPromotionProject: { projectId: input.projectId, project: { userId: input.userId } } },
  },
  data: {
    sheetImageMediaId: input.media.id,
    sheetImageUrl: input.media.url,
    upscaledSheetImageMediaId: null,
    upscaledSheetImageUrl: null,
    imageHistory: null,
    lastError: null,
    sheetArtifactVersion: { increment: 1 },
  },
})
if (updated.count !== 1) throw new ApiError('CONFLICT', { code: 'SIX_GRID_UPLOAD_STALE' })

const panels = await tx.novelPromotionPanel.updateMany({
  where: { storyboardId: input.storyboardId },
  data: {
    imageMediaId: null, imageUrl: null, imageHistory: null, candidateImages: null,
    previousImageMediaId: null, previousImageUrl: null,
    normalizedCropRect: null, croppedImageMediaId: null, croppedImageUrl: null,
    upscaledImageMediaId: null, upscaledImageUrl: null,
    imageDerivation: null, imageLineage: null,
  },
})
if (panels.count !== 6) throw new ApiError('CONFLICT', { code: 'SIX_GRID_UPLOAD_PANEL_SET_CHANGED' })
```

Read and return the new artifact version from the same transaction. Keep the store injectable so tests exercise the transaction behavior without a live database.

- [ ] **Step 4: Verify GREEN and commit**

Run the replacement integration test and `pnpm typecheck`. Expected: PASS.

Commit with `git commit -m "feat: replace six-grid sheets atomically"`.

## Task 3: Owned Multipart Upload Route

**Files:**
- Create: `src/app/api/novel-promotion/[projectId]/storyboard-sheet/upload/route.ts`
- Create: `tests/integration/api/contract/six-grid-upload-route.test.ts`
- Modify: `tests/contracts/route-catalog.ts`

- [ ] **Step 1: Write failing route tests**

Cover authentication before decoding, strict required fields, file-size rejection before `arrayBuffer`, valid PNG/JPEG/WebP upload, ratio error mapping, stale CAS, and cross-project ownership. A valid response must contain only the new media identity, URL, dimensions, and artifact version.

```ts
expect(response.status).toBe(200)
expect(replaceSixGridSheetMock).toHaveBeenCalledWith(expect.objectContaining({
  userId: 'user-1', projectId: 'project-1', episodeId: 'episode-1',
  storyboardId: 'storyboard-1', expectedSheetArtifactVersion: 4,
  media: expect.objectContaining({ id: 'media-uploaded' }),
}))
expect(await response.json()).toMatchObject({
  sheetImageMediaId: 'media-uploaded', sheetImageUrl: '/m/uploaded', sheetArtifactVersion: 5,
})
```

- [ ] **Step 2: Verify RED**

Run `pnpm vitest run tests/integration/api/contract/six-grid-upload-route.test.ts`.

Expected: FAIL because the route is missing.

- [ ] **Step 3: Implement the route**

Authenticate first, parse `FormData`, and validate these fields:

```ts
const parsed = z.object({
  episodeId: z.string().trim().min(1).max(200),
  storyboardId: z.string().trim().min(1).max(200),
  expectedSheetArtifactVersion: z.coerce.number().int().nonnegative(),
}).safeParse({
  episodeId: form.get('episodeId'),
  storyboardId: form.get('storyboardId'),
  expectedSheetArtifactVersion: form.get('expectedSheetArtifactVersion'),
})
if (!(file instanceof File) || !parsed.success || file.size > SIX_GRID_UPLOAD_MAX_BYTES) {
  throw new ApiError('INVALID_PARAMS', { code: 'SIX_GRID_UPLOAD_PAYLOAD_INVALID' })
}
```

Load the owned six-grid to obtain the cell ratio, then call `assertSixGridUploadAvailable` before `file.arrayBuffer()` or storage. Normalize the bytes, upload a `.webp` key with `uploadObject(..., 1, 'image/webp')`, create a MediaObject with MIME/size/width/height, then call `replaceSixGridSheet`. Map `SixGridUploadError.code` to stable invalid-parameter details. Register the route in the route catalog.

- [ ] **Step 4: Verify GREEN and commit**

Run the route test, `pnpm vitest run tests/integration/api/contract/crud-routes.test.ts`, and `pnpm run check:api-handler`. Expected: PASS.

Commit with `git commit -m "feat: add six-grid sheet upload endpoint"`.

## Task 4: Client Upload Mutation

**Files:**
- Modify: `src/lib/query/hooks/useSixGridStoryboard.ts`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/hooks/useStoryboardStageController.ts`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardGroup.types.ts`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardCanvas.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/index.tsx`
- Create: `tests/unit/query/six-grid-upload-mutation.test.ts`

- [ ] **Step 1: Write failing request-builder tests**

```ts
const request = buildSheetUploadRequest('project-1', {
  file: new File(['image'], 'sheet.webp', { type: 'image/webp' }),
  episodeId: 'episode-1', storyboardId: 'storyboard-1', expectedSheetArtifactVersion: 4,
})
expect(request.endpoint).toBe('/api/novel-promotion/project-1/storyboard-sheet/upload')
expect(request.body.get('episodeId')).toBe('episode-1')
expect(request.body.get('expectedSheetArtifactVersion')).toBe('4')
```

Also assert that success clears the synchronous task overlay and invalidates the group key and active episode stage, while error clears the overlay and preserves the current sheet.

- [ ] **Step 2: Verify RED**

Run `pnpm vitest run tests/unit/query/six-grid-upload-mutation.test.ts`.

Expected: FAIL because the builder and mutation are missing.

- [ ] **Step 3: Implement FormData submission**

```ts
export function buildSheetUploadRequest(projectId: string, input: SheetUploadInput) {
  const body = new FormData()
  body.set('file', input.file)
  body.set('episodeId', input.episodeId)
  body.set('storyboardId', input.storyboardId)
  body.set('expectedSheetArtifactVersion', String(input.expectedSheetArtifactVersion))
  return { endpoint: `/api/novel-promotion/${projectId}/storyboard-sheet/upload`, body }
}
```

Submit with `apiFetch(endpoint, { method: 'POST', body })` and no manual `Content-Type`. Add an `upload` mutation using the existing storyboard overlay and `refreshGroup`; because upload is synchronous and creates no durable `Task`, clear its overlay on both success and error. Include `sixGridTasks.upload.isPending` when deriving `sixGridTaskStoryboardId`, so every group control remains busy until replacement and refresh finish. Expose this controller callback and thread its prop through `index.tsx` and `StoryboardCanvas` to `StoryboardGroup`:

```ts
const uploadSixGridSheet = useCallback(
  (storyboardId: string, file: File, version: number) => sixGridTasks.upload.mutateAsync({
    file, episodeId, storyboardId, expectedSheetArtifactVersion: version,
  }),
  [episodeId, sixGridTasks.upload],
)
```

- [ ] **Step 4: Verify GREEN and commit**

Run the mutation test and `pnpm typecheck`. Expected: PASS.

Commit with `git commit -m "feat: submit external six-grid uploads"`.

## Task 5: Prompt Viewer and Upload Dialog

**Files:**
- Create: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/SixGridPromptModal.tsx`
- Create: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/SixGridUploadModal.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/SixGridGroupControls.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardGroup.tsx`
- Modify: `messages/zh/storyboard.json`
- Modify: `messages/en/storyboard.json`
- Create: `tests/unit/components/six-grid-external-upload.test.tsx`
- Modify: `tests/unit/components/six-grid-storyboard-controls.test.ts`

- [ ] **Step 1: Write failing component tests**

Test that upload is enabled without `sheetImageUrl`, active processing disables it, prompt is read-only and copied exactly, missing prompt shows planning guidance, valid preview enables confirmation, wrong ratio shows an alert, and success closes the upload dialog.

```tsx
render(<SixGridPromptModal open onClose={vi.fn()} prompt={'line 1\nline 2'} groupSequence={2} cellRatio="16:9" />)
expect(screen.getByRole('textbox')).toHaveAttribute('readonly')
await user.click(screen.getByRole('button', { name: /copy/i }))
expect(navigator.clipboard.writeText).toHaveBeenCalledWith('line 1\nline 2')
```

- [ ] **Step 2: Verify RED**

Run the two component test files. Expected: FAIL because the new controls and modals are missing.

- [ ] **Step 3: Implement the prompt modal**

Use `GlassModalShell`, a `readOnly` textarea, missing-prompt guidance, and this exact copy operation:

```ts
const copy = async () => {
  if (!prompt) return
  await navigator.clipboard.writeText(prompt)
  setCopied(true)
}
```

Reset copy acknowledgement whenever the prompt or open state changes.

- [ ] **Step 4: Implement the upload modal**

Use `GlassModalShell`, file input and drag/drop for PNG/JPEG/WebP, `createImageBitmap(file)` for preview dimensions, and the shared ratio helper. Revoke object URLs on replacement and unmount. Confirm only when the ratio is valid:

```ts
const submit = async () => {
  if (!preview?.validRatio || submitting) return
  setSubmitting(true)
  setError(null)
  try {
    await onSubmit(preview.file, expectedSheetArtifactVersion)
    onClose()
  } catch (caught) {
    setError(caught instanceof Error ? caught.message : String(caught))
  } finally {
    setSubmitting(false)
  }
}
```

- [ ] **Step 5: Wire controls and translations**

Add `View prompt` and `Upload six-grid` actions. Upload must depend only on group busy state, never on `hasSheet`. Store `promptOpen`/`uploadOpen` in `StoryboardGroup`, include both in virtual-card retention, and render:

```tsx
<SixGridUploadModal
  open={uploadOpen}
  onClose={() => setUploadOpen(false)}
  cellRatio={storyboard.sixGridCellAspectRatio === '9:16' ? '9:16' : '16:9'}
  expectedSheetArtifactVersion={storyboard.sheetArtifactVersion ?? 0}
  onSubmit={(file, version) => onUploadSixGridSheet(file, version)}
/>
```

Add complete Chinese and English labels for prompt, copy/copy success, missing guidance, file drop, dimensions, expected/detected ratio, replacement warning, validation, progress, cancel, and confirm.

- [ ] **Step 6: Verify GREEN and commit**

Run both component tests, targeted ESLint, and `pnpm typecheck`. Expected: PASS.

Commit with `git commit -m "feat: add six-grid prompt and upload dialogs"`.

## Task 6: Downstream Regression and Final Verification

**Files:**
- Modify: `tests/integration/six-grid/six-grid-crop-media.integration.test.ts`
- Modify: `tests/unit/worker/storyboard-sheet-task-handler.test.ts`
- Modify: `tests/contracts/six-grid-requirements-matrix.test.ts`

- [ ] **Step 1: Add failing lineage tests**

Add one case for each processing order using uploaded media. Assert direct crop uses the uploaded original; sheet-upscale-then-crop uses the newly upscaled media. Add a stale generation worker assertion proving version 4 cannot overwrite uploaded version 5:

```ts
await expect(handleStoryboardSheetTask(jobWithSnapshot({ expectedSheetArtifactVersion: 4 })))
  .rejects.toThrow('SIX_GRID_SHEET_STALE')
```

Extend the requirements matrix with upload-before-generation, exact prompt copy, replacement invalidation, and both downstream order cases.

- [ ] **Step 2: Verify RED, correct only uncovered lineage behavior, then verify GREEN**

Run:

```bash
pnpm vitest run tests/integration/six-grid/six-grid-crop-media.integration.test.ts tests/unit/worker/storyboard-sheet-task-handler.test.ts tests/contracts/six-grid-requirements-matrix.test.ts
```

Expected before correction: any uncovered lineage case fails. Correct only upload-service, snapshot fencing, or query invalidation behavior. Do not change crop geometry or add another processing path. Re-run and expect PASS.

- [ ] **Step 3: Run complete focused verification**

Run every new test plus existing six-grid crop, sheet handler, controls, route catalog, `pnpm typecheck`, targeted ESLint, and `git diff --check`. Expected: zero focused failures, zero type errors, zero changed-file lint errors, and no whitespace errors.

- [ ] **Step 4: Request code review**

Review authorization, decoded-image limits, CAS and active-task behavior, complete panel invalidation, exact prompt copy, object-URL cleanup, and both processing orders. Fix each Critical or Important finding with a failing test first.

- [ ] **Step 5: Commit regression coverage**

Commit with `git commit -m "test: cover external six-grid sheet lineage"`.

- [ ] **Step 6: Push after fresh verification**

Re-run Step 3, confirm no unrelated worktree changes, push the approved target branch, and report the exact SHA. Report unrelated pre-existing full-suite failures separately rather than hiding them or widening this feature.
