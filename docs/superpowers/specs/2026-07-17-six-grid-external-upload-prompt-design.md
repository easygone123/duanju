# Six-Grid External Upload and Prompt Access Design

- Date: 2026-07-17
- Status: Approved
- Target branch: `main`

## 1. Summary

Add two actions to every six-grid storyboard group: a read-only prompt viewer with one-click copy, and an external sheet upload flow. The upload action is available even when the system has never generated a sheet. A successful upload becomes the current original sheet and can immediately enter either existing processing path: full-sheet upscale followed by crop, or direct crop followed by per-panel upscale.

The feature reuses the existing six-grid prompt snapshot, media model, crop modal, upscale tasks, task overlays, and artifact-version fencing. It does not introduce another prompt-generation call or a parallel crop/upscale implementation.

## 2. Goals

1. Let users copy the six-grid prompt created during screenplay-to-storyboard planning and use it in an external image generator.
2. Let users upload an externally generated six-grid sheet before or after any system-generated sheet exists.
3. Make the uploaded sheet the authoritative original sheet for the storyboard group.
4. Preserve the two existing processing orders:
   - `sheet_upscale_then_crop`
   - `crop_then_panel_upscale`
5. Prevent stale generated, upscaled, or cropped artifacts from being mixed with a newly uploaded sheet.
6. Keep ownership, media lineage, ratio validation, and concurrent-task behavior fail-closed.

## 3. Non-Goals

- Do not call an LLM when the user opens the prompt viewer.
- Do not provide prompt editing or saving in this feature.
- Do not keep an end-user restore history for replaced sheets.
- Do not add a third crop or upscale path.
- Do not accept arbitrary sheet ratios and rely on manual crop to repair them.
- Do not make upload depend on a prior system image-generation attempt.

## 4. User Interface

### 4.1 Group controls

Every storyboard with `layoutMode === "six_grid"` displays two additional controls:

- **View prompt** opens the prompt viewer.
- **Upload six-grid** opens the upload dialog.

Upload does not require `sheetImageUrl`. It remains available before the first system generation. Both actions remain visible at all times, but upload is temporarily disabled while the same storyboard group has an active sheet generation, sheet upscale, or sheet crop operation. This prevents an upload from racing an already visible local operation.

The existing generate/regenerate, preview, full-sheet upscale, and crop controls remain in place.

### 4.2 Prompt viewer

The prompt viewer reads `sheetPromptSnapshot` from the current storyboard data. It contains:

- A read-only multiline prompt field.
- A copy action that copies the prompt exactly as stored.
- The group sequence and configured cell aspect ratio as context.
- A visible copy-success acknowledgement.

If `sheetPromptSnapshot` is empty, the viewer explains that the group has no planned six-grid prompt and asks the user to rerun storyboard planning. It does not synthesize a replacement prompt.

### 4.3 Upload dialog

The upload dialog supports file selection and drag-and-drop for PNG, JPEG, and WebP. Before confirmation it shows:

- A local image preview.
- Pixel dimensions.
- File size.
- Detected sheet ratio.
- Required sheet ratio derived from `sixGridCellAspectRatio`.
- A direct-replacement warning.

The client performs an early usability check, but the server is authoritative. The confirmation action uploads the file with the storyboard identity and the artifact version observed when the dialog opened.

After success, the dialog closes, the active storyboard-stage query refreshes, and the existing full-sheet upscale and crop actions become available immediately.

## 5. Image Validation

Accepted encoded formats are PNG, JPEG, and WebP. The server decodes image metadata and validates the actual bytes rather than trusting the filename or browser MIME type.

The canonical sheet ratios are:

- `16:9` cells: overall `8:3` sheet.
- `9:16` cells: overall `27:32` sheet.

The relative ratio error must be at most 3 percent:

```text
abs(actualRatio - expectedRatio) / expectedRatio <= 0.03
```

The upload route uses bounded file-byte, decoded-pixel, width, and height limits consistent with the application's existing image-upload safety limits. A low-resolution but otherwise valid sheet is allowed because the user may intentionally upscale it afterward. Invalid encoding, spoofed MIME data, decompression-limit violations, and ratios outside the tolerance are rejected before persistence changes.

## 6. API and Persistence

### 6.1 Upload endpoint

Add a project-scoped multipart endpoint for six-grid sheets. Its inputs are:

- `file`
- `episodeId`
- `storyboardId`
- `expectedSheetArtifactVersion`

The route must:

1. Authenticate the user against the project.
2. Load an owned storyboard constrained by project, episode, storyboard ID, and `layoutMode === "six_grid"`.
3. Reject upload while an authoritative active sheet task owns that storyboard group.
4. Decode and validate the image.
5. Upload the validated original bytes or normalized encoded image to object storage.
6. Create or resolve its `MediaObject`.
7. Atomically replace the sheet only when `sheetArtifactVersion` still equals `expectedSheetArtifactVersion`.
8. Return the new media identity and artifact version.

The update is compare-and-swap fenced. If the sheet version changes between dialog open and database write, the route returns a conflict and does not switch the current sheet.

### 6.2 Replacement semantics

A successful upload directly replaces the current original sheet:

- Set `sheetImageMediaId` and `sheetImageUrl` to the uploaded media.
- Increment `sheetArtifactVersion` exactly once.
- Clear `upscaledSheetImageMediaId` and `upscaledSheetImageUrl`.
- Clear sheet-level processing history that points to a previous sheet.
- Preserve the planned `sheetPromptSnapshot`, `sheetModelSnapshot`, group continuity data, panel descriptions, and panel ordering.

For all six panels owned by the storyboard, clear image artifacts derived from the previous sheet:

- Current cropped-sheet image linkage.
- Previous image linkage and reversible image history.
- Cropped source media linkage.
- Per-panel upscale media linkage.
- Stored crop rectangle when it belongs to the previous sheet version.

The update must not delete panel text, dialogue metadata, duration, video prompt data, or character/location/prop planning.

The old sheet and derived media are no longer reachable through the storyboard UI. Physical object deletion is left to the existing media garbage-collection policy so a failed transaction never deletes still-referenced media.

## 7. Downstream Processing

The uploaded media follows the same lineage contract as a system-generated original sheet.

For `sheet_upscale_then_crop`:

```text
uploaded original sheet -> existing sheet upscale task -> existing crop task -> six panel images
```

For `crop_then_panel_upscale`:

```text
uploaded original sheet -> existing crop task -> six panel images -> optional existing panel upscale tasks
```

No downstream route accepts the old artifact version or an old source media ID after replacement. Existing source ownership and checksum checks continue to apply.

## 8. Concurrency and Failure Handling

- An active local or server sheet operation disables upload in the UI.
- The server independently rejects a conflicting authoritative task or artifact-version mismatch.
- A generation, upscale, or crop task created from an older version cannot overwrite the uploaded sheet or attach derived artifacts to it.
- Upload and validation failure leave all current sheet and panel records unchanged.
- Object-storage success followed by database conflict leaves an unreferenced object for normal media cleanup; it never changes the visible sheet.
- Query invalidation occurs only after a successful replacement.
- Errors distinguish invalid image, unsupported ratio, upload-size limit, ownership failure, active-task conflict, and stale-version conflict.

## 9. Localization and Accessibility

Add Chinese and English strings for both controls, dialog titles, direct-replacement warning, required and detected ratios, validation errors, copy success, upload progress, and stale/conflict recovery.

Both dialogs must:

- Have an accessible title.
- Trap and restore focus using the existing modal pattern.
- Support keyboard file selection and confirmation.
- Expose validation errors with an alert role.
- Keep the prompt field selectable while remaining read-only.

## 10. Testing and Acceptance

### 10.1 Component tests

- Upload is available when `sheetImageUrl` is absent.
- Prompt viewer renders `sheetPromptSnapshot` read-only and copies it unchanged.
- Missing prompt shows planning guidance without invoking generation.
- Upload preview reports dimensions and ratio state.
- Invalid ratio prevents confirmation.
- Successful upload closes the dialog and refreshes the group.
- Active group processing disables upload.

### 10.2 API and service tests

- Owned PNG, JPEG, and WebP sheets with ratios within 3 percent are accepted.
- Invalid bytes, spoofed types, oversized images, excessive decoded pixels, and out-of-tolerance ratios are rejected.
- Cross-project, cross-episode, non-six-grid, and stale-version uploads are rejected.
- Successful replacement increments `sheetArtifactVersion`, installs the uploaded media, and preserves prompt/planning data.
- Replacement clears old sheet upscale and all six panels' prior crop/upscale image lineage in one transaction.
- A failed database compare-and-swap leaves the previous sheet and panels unchanged.

### 10.3 Workflow regression tests

- An uploaded sheet can enter `sheet_upscale_then_crop` and produce six new panel images.
- An uploaded sheet can enter `crop_then_panel_upscale` and produce six new panel images.
- An older generation, crop, or upscale task cannot attach results after upload.
- Existing system sheet generation still works and does not require using upload.

## 11. Acceptance Criteria

The feature is complete when a user can plan a six-grid storyboard, copy its stored prompt, generate an image elsewhere, upload it without first generating inside the application, and then complete either existing upscale/crop processing order. At no point may images derived from the replaced sheet remain attached to the new sheet, and concurrent stale tasks must fail closed.
