# Six-Grid Panel Inline Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep cropped six-grid images visible directly in their storyboard cards, remove redundant per-panel preview buttons, and remove the broken external original-image link from the in-app preview.

**Architecture:** Reuse the existing `ImageSection` main image and root `ImagePreviewModal`; no media schema, API, or persistence changes are needed. Narrow `SixGridPanelActions` to processing actions only, then simplify the preview modal so it renders the resolved image without exposing a separate external URL.

**Tech Stack:** React 19, TypeScript, Next.js, next-intl, Vitest, Testing Library

---

## File Structure

- Modify `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/ImageSectionActionButtons.tsx`: remove preview-only props and buttons from the six-grid panel action bar.
- Modify `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardPanelList.tsx`: stop passing preview lineage URLs and callback into the action bar; keep the existing main-image click preview unchanged.
- Modify `src/components/ui/ImagePreviewModal.tsx`: remove the external “view original” anchor and retain the in-app resolved image.
- Modify `tests/unit/components/six-grid-storyboard-controls.test.ts`: specify that panel actions contain only recrop, upscale, and undo.
- Modify `tests/unit/components/workspace-lazy-media.test.ts`: specify that an open in-app preview has no external link.

### Task 1: Remove redundant six-grid panel preview buttons

**Files:**
- Modify: `tests/unit/components/six-grid-storyboard-controls.test.ts:135-166`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/ImageSectionActionButtons.tsx:25-57`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardPanelList.tsx:188-213`

- [ ] **Step 1: Write the failing panel-action test**

Replace the existing lineage-preview test with:

```ts
it('keeps only processing actions on each six-grid card because the image is shown inline', () => {
  const props = {
    currentUrl: '/current.webp', croppedUrl: '/crop.webp', upscaledUrl: '/upscale.webp',
    sourceUrl: '/sheet.webp', previousUrl: '/previous.webp', isBusy: false, canUpscale: true,
    onRecrop: () => undefined, onUpscale: () => undefined,
    onPreview: () => undefined, onUndo: () => undefined,
  } as unknown as React.ComponentProps<typeof SixGridPanelActions>
  const html = renderWithIntl(createElement(SixGridPanelActions, props))
  expect(html).toContain('Recrop')
  expect(html).toContain('Upscale panel')
  expect(html).toContain('Undo previous')
  expect(html).not.toContain('Preview current')
  expect(html).not.toContain('Preview crop')
  expect(html).not.toContain('Preview upscale')
  expect(html).not.toContain('Preview source')
})
```

Update the busy-state fixture to omit `currentUrl`, `croppedUrl`, and `onPreview`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm vitest run tests/unit/components/six-grid-storyboard-controls.test.ts --reporter=dot
```

Expected: FAIL because `SixGridPanelActions` still renders “Preview current”, “Preview crop”, “Preview upscale”, and “Preview source”.

- [ ] **Step 3: Implement the minimal panel-action change**

Narrow the props and render only processing actions:

```tsx
export interface SixGridPanelActionProps {
  previousUrl?: string | null
  isBusy: boolean
  canUpscale: boolean
  upscaleDisabledReason?: string
  onRecrop: () => void
  onUpscale: () => void
  onUndo?: () => void
}

export function SixGridPanelActions({
  previousUrl, isBusy, canUpscale, upscaleDisabledReason, onRecrop, onUpscale, onUndo,
}: SixGridPanelActionProps) {
  const t = useTranslations('storyboard.sixGrid.panel')
  return (
    <div className="flex flex-wrap gap-1 border-t border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] p-2" aria-label={t('actions')}>
      <button type="button" className="glass-btn-base glass-btn-secondary rounded px-2 py-1 text-[10px]" disabled={isBusy} onClick={onRecrop}>{t('recrop')}</button>
      <button type="button" className="glass-btn-base glass-btn-secondary rounded px-2 py-1 text-[10px]" disabled={isBusy || !canUpscale} title={!canUpscale ? (upscaleDisabledReason || t('upscaleUnavailable')) : undefined} onClick={onUpscale}>{t('upscale')}</button>
      {previousUrl && onUndo && <button type="button" className="glass-btn-base glass-btn-secondary rounded px-2 py-1 text-[10px]" disabled={isBusy} onClick={onUndo}>{t('undo')}</button>}
    </div>
  )
}
```

In `StoryboardPanelList.tsx`, remove `currentUrl`, `croppedUrl`, `upscaledUrl`, `sourceUrl`, and `onPreview` from the `sixGridActions` object. Keep `onPreviewImage={onPreviewImage}` on `PanelCard`; that is the existing inline main-image click path.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm vitest run tests/unit/components/six-grid-storyboard-controls.test.ts --reporter=dot
```

Expected: all tests in the file PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add tests/unit/components/six-grid-storyboard-controls.test.ts \
  'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/ImageSectionActionButtons.tsx' \
  'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardPanelList.tsx'
git commit -m "fix: show six-grid panel images inline"
```

### Task 2: Remove the invalid external original-image link

**Files:**
- Modify: `tests/unit/components/workspace-lazy-media.test.ts:55-69`
- Modify: `src/components/ui/ImagePreviewModal.tsx:3-73`

- [ ] **Step 1: Write the failing modal test**

Replace the original-link test with:

```ts
it('keeps an opened preview inside the app without exposing an external media link', () => {
  const opened = render(React.createElement(ImagePreviewModal, {
    imageUrl: '/_next/image?url=images%2Foriginal.png&w=640&q=75',
    onClose: vi.fn(),
  }))
  expect(opened.getByAltText('preview').getAttribute('src'))
    .toBe('/api/storage/sign?key=images%2Foriginal.png')
  expect(opened.queryByRole('link')).toBeNull()
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm vitest run tests/unit/components/workspace-lazy-media.test.ts --reporter=dot
```

Expected: FAIL because the open preview still contains the “view original” anchor.

- [ ] **Step 3: Implement the minimal modal change**

Change the import and remove the external-link block:

```tsx
import { toDisplayImageUrl } from '@/lib/media/image-url'

const displayImageUrl = toDisplayImageUrl(imageUrl)
if (!displayImageUrl) return null
```

Keep only the close button and `MediaImageWithLoading`; delete `originalImageUrl` and the `<a target="_blank">` element.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm vitest run tests/unit/components/workspace-lazy-media.test.ts --reporter=dot
```

Expected: all tests in the file PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add tests/unit/components/workspace-lazy-media.test.ts src/components/ui/ImagePreviewModal.tsx
git commit -m "fix: keep image previews inside the app"
```

### Task 3: Verify the complete interaction

**Files:**
- Verify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/ImageSection.tsx`
- Verify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/index.tsx`

- [ ] **Step 1: Run the complete relevant component suite**

```bash
pnpm vitest run \
  tests/unit/components/six-grid-storyboard-controls.test.ts \
  tests/unit/components/workspace-lazy-media.test.ts \
  tests/unit/novel-promotion/storyboard-root-modal-activity.test.ts \
  --reporter=dot
```

Expected: all tests PASS, including the existing root click-to-preview and inactive-stage cleanup cases.

- [ ] **Step 2: Run static verification**

```bash
pnpm exec tsc --noEmit
git diff --check
```

Expected: both commands exit with status 0.

- [ ] **Step 3: Confirm the diff is limited to the approved interaction**

```bash
git diff --stat HEAD~2..HEAD
git status --short
```

Expected: only the three production components and their two tests changed; the worktree is clean after commits.
