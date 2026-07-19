# ComfyUI Video Input Fail-Closed Design

## Problem

Panel video generation always supplies a trusted first-frame image and a computed duration. When the pinned workflow version does not declare `sourceImage`, `firstFrame`, `first_frame`, or a duration variable, request normalization currently deletes those values. ComfyUI then receives the workflow JSON's original image and duration, making a correct mapping in a newer editor version look ineffective.

Six-grid crop media is not a special unsupported type: crop persistence writes the cropped media into the panel's current `imageMediaId` and `imageUrl`, and ownership validation includes both current and cropped panel-image relations.

## Approved Behavior

- Continue mapping `first_frame` to `sourceImage`, `firstFrame`, or legacy `first_frame` when the selected immutable workflow version declares one of them.
- Continue mapping `duration_seconds` to the selected canonical numeric duration definition.
- If a supplied first frame has no declared destination, reject request creation with `INVALID_PARAMS` and detail code `COMFY_FIRST_FRAME_BINDING_REQUIRED`.
- If a supplied duration has no declared destination, reject request creation with `INVALID_PARAMS` and detail code `COMFY_DURATION_BINDING_REQUIRED`.
- If a supplied last frame has no declared destination, reject request creation with `INVALID_PARAMS` and detail code `COMFY_LAST_FRAME_BINDING_REQUIRED`.
- Preserve existing collision detection and media ownership checks.
- Do not change six-grid persistence, media ownership, workflow JSON, project version pinning, or already queued task snapshots.

## Data Flow

The worker resolves the current panel image, proves that its media object belongs to the task's user and project, and emits `first_frame`. Request creation then canonicalizes that value against the pinned workflow version. A declared mapping reaches the workflow renderer and replaces the mapped ComfyUI input; a missing mapping now fails before submission instead of retaining the workflow author's default image.

## Verification Constraint

The user explicitly requested no test execution. The implementation therefore limits verification to code inspection and `git diff --check`; it does not claim runtime validation.
