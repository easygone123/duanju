# ComfyUI Media Ownership and Video Variable Compatibility Design

## Problem

Two runtime failures remain in the native ComfyUI path:

- panel images created or selected by legacy write paths may have `imageUrl`
  without the corresponding `imageMediaId`; ComfyUI input ownership then fails
  with `COMFY_MEDIA_NOT_OWNED` even though the panel belongs to the requesting
  user and project;
- guided video workflow mappings use canonical variable names such as
  `duration`, `firstFrame`, and `lastFrame`, while the generation adapter still
  emits legacy names such as `duration_seconds`, `first_frame`, and
  `last_frame`; strict request validation rejects the undeclared names as
  `INVALID_PARAMS` before ComfyUI receives the workflow.

## Goal

Restore ordinary and first-last-frame ComfyUI video generation for existing
projects and guided workflows without weakening project ownership checks or
requiring a database migration before users can continue.

## Media Ownership Repair

The existing ownership query remains the primary gate. When it cannot find an
image relation, the legacy repair path may additionally recognize a current
panel image belonging to the same `userId` and `projectId`.

The repair flow is:

1. normalize the supplied media value to an opaque storage key;
2. query the existing media relation under the current user and project;
3. if missing, find a panel in that exact scope whose current `imageUrl`
   resolves to the same media object;
4. ensure the media object exists with an image MIME type;
5. attach its ID to `panel.imageMediaId` with a conditional update that repeats
   the owner, project, panel, and legacy-value constraints;
6. return the media reference only when that update succeeds.

Existing character, location, and global-asset repair remains supported. Media
from another user or project, an unrelated media object, or a non-image key
continues to fail closed.

The first patch targets the current panel image because it is the source used
by ordinary and first-last-frame video generation. It does not infer ownership
from arbitrary history arrays, candidate lists, or storage-key prefixes.

## Video Variable Compatibility

Request creation adds one canonicalization step before strict definition
validation. It compares runtime variables with the selected immutable workflow
version and translates only known system aliases:

- `duration_seconds` to `duration`;
- `first_frame` to `firstFrame`;
- `last_frame` to `lastFrame`;
- the already supported `input_images` to `referenceImages`;
- the already supported `aspect_ratio` to an explicit aspect-ratio variable or
  dynamic width and height.

Canonicalization is definition-driven:

- if the workflow declares the canonical name, the legacy runtime alias is
  moved to it;
- if it declares only the legacy name, that name is preserved;
- if both names are declared, or both values are supplied, request creation
  rejects the ambiguous contract;
- known system-supplied video values are omitted when the selected workflow
  does not declare either their canonical name or their legacy alias; this lets
  a text-to-video or fixed-duration workflow ignore inapplicable panel hints;
- unrelated unknown variables continue to fail strict validation.

`prompt` and `fps` already use the canonical names and remain unchanged.

## Data Flow

For a panel video task:

1. the worker loads the trusted first-frame panel and optional trusted
   last-frame panel from the task's project;
2. media ownership resolution returns or repairs their scoped media relations;
3. the generator emits the existing runtime variable envelope;
4. request creation canonicalizes that envelope against the pinned workflow
   version;
5. strict type, required-variable, capacity, and ownership validation runs on
   the canonical variables;
6. the request is queued for the remote ComfyUI instance.

The pinned workflow version and invocation idempotency behavior do not change.

## Error Handling

- Cross-project and cross-user media still produce `COMFY_MEDIA_NOT_OWNED`.
- A panel legacy URL that cannot be normalized or matched exactly is not
  repaired.
- Alias collisions still produce `INVALID_PARAMS` rather than selecting a
  value silently.
- Missing required workflow variables remain invalid after canonicalization.
- ComfyUI connection, execution, and output-transfer failures keep their
  existing task lifecycle and error codes.

## Validation

Test-driven coverage must include:

1. repairing a same-project panel whose `imageUrl` exists but `imageMediaId` is
   null;
2. resolving panel URLs represented by the supported media route form;
3. refusing the same storage key when the panel belongs to another project or
   user;
4. mapping normal-video `first_frame` to guided `firstFrame`;
5. mapping first-last-frame variables to guided `firstFrame` and `lastFrame`;
6. mapping `duration_seconds` to guided `duration` while preserving legacy
   workflow definitions;
7. rejecting dual declarations or dual supplied values;
8. retaining existing reference-image and aspect-ratio compatibility tests;
9. focused unit tests, TypeScript checking, affected-file lint, full test gate,
   build, and `git diff --check` before completion.

## Non-goals

- accepting assets from a different project merely because the user owns both
  projects;
- authorizing media from storage-key naming conventions alone;
- repairing candidate-image or history-array ownership;
- changing workflow JSON, output mappings, queue leasing, or billing;
- running a mandatory bulk database migration as part of this bug fix.
