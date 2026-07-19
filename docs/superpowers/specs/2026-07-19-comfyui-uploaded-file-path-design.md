# ComfyUI Uploaded File Path Design

## Goal

Ensure standard ComfyUI filename bindings reference media uploaded into Waoowaoo request subfolders.

## Behavior

- Reuse the existing safe uploaded-path formatter that returns `subfolder/name` and avoids double-prefixing.
- Apply it to `filename`, `filename_at`, and `filename_list` transforms.
- Keep structured `image_ref` output unchanged as `{ filename, subfolder, type }`.
- Do not change workflow variable names, ownership checks, upload destinations, or Bernini slot behavior.

## Verification Constraint

Per user instruction, inspect the source diff only. Do not run tests, type checking, linting, or builds.
