# ComfyUI API Workflow Upload and Auto-Mapping Design

**Date:** 2026-07-13

## Goal

Replace manual-first ComfyUI workflow creation with an upload-first flow for
ComfyUI API Format JSON. Automatically map only the inputs that waoowaoo
actually supplies, require confirmation for ambiguous mappings, and preserve
the uploaded graph topology.

## Scope

The importer accepts only ComfyUI API Format JSON. It does not accept or
convert the normal browser Workflow JSON format. When the wrong format is
uploaded, the UI instructs the user to export with Save (API Format) in
ComfyUI.

The importer parameterizes existing nodes but never adds, removes, clones, or
reconnects nodes. Model selection, LoRA, sampler, scheduler, steps, CFG, and
other workflow-owned settings remain unchanged in the uploaded graph.

## Upload and Versioning Flow

1. The user selects the workflow purpose: image generation, image editing,
   image upscaling, video generation, or video-to-video.
2. The user uploads one `.json` API Format file.
3. The server parses the file, enforces size and structural limits, and
   rejects non-API workflow formats.
4. The unmodified upload is stored as an immutable source snapshot.
5. A deterministic analyzer inspects node classes, input names, node titles,
   and graph connections.
6. The analyzer produces canonical variable definitions, input bindings, a
   primary output, confidence levels, and human-readable mapping reasons.
7. The UI presents the proposed mappings for confirmation.
8. Confirmation creates a draft workflow version. A user-owned ComfyUI
   connection must successfully test that exact version before publication.
9. Published and successfully tested versions are the only versions available
   for project model selection and task execution.

A later upload creates a new immutable version and runs analysis again. It
never mutates a published version.

## Canonical Parameters

### Image workflows

- `prompt`
- `negativePrompt`
- `width`
- `height`
- `seed`
- `sourceImage`
- `referenceImages[]`

### Video workflows

- `prompt`
- `negativePrompt`
- `width`
- `height`
- `seed`
- `duration`
- `fps`
- `firstFrame`
- `lastFrame`
- `sourceVideo`
- `referenceImages[]`

No other node inputs are exposed as waoowaoo task parameters.

## Deterministic Mapping

Mapping uses a deterministic scoring engine. Evidence includes:

- ComfyUI node `class_type`.
- Input field name.
- `_meta.title` and other safe node labels present in API Format.
- The input's position and downstream consumers in the graph.
- The selected workflow purpose and output media type.

The analyzer recognizes prompt and negative-prompt encoders, dimensions,
seed, duration, FPS, image/video loaders, reference-image consumers, and
image/video output nodes. Common third-party nodes can be supported through
small rule adapters, but there is no AI-based graph interpretation.

### Media roles

- Names or graph roles containing `first` or `start` prefer `firstFrame`.
- Names or graph roles containing `last` or `end` prefer `lastFrame`.
- `init`, `source`, or img2img roles prefer `sourceImage`.
- Reference, IPAdapter, ControlNet, character, and style inputs are assigned to
  `referenceImages[0..n]` in stable graph order.
- A video loader used as the primary transformation input maps to
  `sourceVideo`.

If several media inputs remain ambiguous, the user must classify each as
source, first frame, last frame, reference image, source video, or preserve
original.

The number of mapped reference-image slots is the workflow's maximum accepted
reference count. The analyzer never invents extra slots.

## Confidence and Confirmation

Each proposal has one of four UI states:

- High confidence: green and selected by default.
- Ambiguous: yellow and requires user confirmation.
- Preserve original: gray and not overridden at runtime.
- Blocking incompatibility: red and prevents publication.

The confirmation table shows canonical parameter, node title and ID, input
path, required state, default/missing-value policy, confidence, and mapping
reason. A single-value ComfyUI input cannot be assigned to multiple canonical
parameters. Array-style reference mappings must have a stable order.

## Missing Values and Runtime Contract

Optional inputs use `preserve_original`. When a task does not supply an
optional source or reference image, runtime rendering preserves the value from
the uploaded graph instead of injecting an empty string or invalid media
reference.

Required inputs and the primary output are validated before queue submission
and billing. If the task supplies more reference images than the published
workflow supports, submission is blocked with the workflow's maximum count.

Tasks pin the published workflow version. Runtime values are applied only to
the confirmed binding overlay; the immutable source graph is not edited in
place.

## Primary Output

An image-purpose workflow must select exactly one primary image output. A
video-purpose workflow must select exactly one primary video output. The
analyzer selects a unique high-confidence output automatically. Multiple or
uncertain candidates require user confirmation. No valid output is a blocking
error.

## User Interface

Workflow creation has three stages:

1. **Upload:** choose purpose and upload an API Format JSON file.
2. **Auto-map:** inspect and correct the proposed canonical mappings.
3. **Validate and save:** run structural validation, save a draft version,
   select an owned ComfyUI connection, perform a real test, and publish only
   after success.

Pasting raw JSON and manually creating arbitrary variables are not the primary
creation flow. Advanced correction is limited to selecting among compatible
existing nodes and canonical parameter roles.

## Errors

- Normal Workflow JSON: reject with API Format export instructions.
- Invalid JSON or oversized file: reject before creating a draft.
- Missing primary output: block saving the confirmed mapping.
- Missing required task input: allow an incomplete draft but block testing and
  publication.
- Ambiguous image roles: require confirmation.
- Failed real-node test: preserve the draft and diagnostics for retry.
- Excess task reference images: block before queue submission and billing.
- Missing optional input: preserve the graph's original value.

Errors expose safe codes and actionable localized messages without returning
credentials, raw authorization headers, or unbounded workflow content.

## Testing

Tests cover:

- API Format detection and normal Workflow JSON rejection.
- Text-to-image, image-to-image, single-reference, multi-reference, and
  upscale workflows.
- Text-to-video, first-frame, first/last-frame, video-to-video, and
  multi-reference video workflows.
- Prompt, negative prompt, dimensions, seed, duration, and FPS inference.
- Stable reference ordering and reference-capacity enforcement.
- Multiple outputs, missing outputs, ambiguous bindings, duplicate bindings,
  optional missing inputs, and incomplete drafts.
- Upload, analysis, confirmation, draft persistence, real-node test,
  publication, pinned execution, and new-version remapping.

## Acceptance Criteria

1. New workflow creation starts with an API Format file upload.
2. Only the canonical waoowaoo parameters in this design are exposed.
3. Existing compatible inputs and one primary output are mapped
   deterministically with confidence and reasons.
4. Ambiguous mappings require explicit confirmation.
5. Multi-image workflows support every existing confirmed image slot without
   changing graph topology.
6. Optional absent inputs preserve graph defaults.
7. Incompatible drafts cannot be published or selected by projects.
8. Published tasks pin and execute the tested workflow version and binding
   overlay.
