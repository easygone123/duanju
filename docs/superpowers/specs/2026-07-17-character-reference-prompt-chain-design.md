# Character reference prompt and media chain design

## Problem

The reference-to-character worker generates usable character sheets but leaves
three inconsistencies in the downstream asset chain:

1. Background persistence writes the extracted text only to `description`, while
   the canonical indexed representation is `descriptions`.
2. Character generation paths append the art-style text after the fixed character
   sheet and white-background constraint. This makes prompt ordering inconsistent
   with the intended priority: character identity and style first, asset layout
   constraints last.
3. Reference-to-character uploads do not create and attach a `MediaObject`, so
   ComfyUI ownership checks can reject the resulting asset even when its storage
   key belongs to the current user and project.

Existing prompt readers fall back from `descriptions` to `description`, so the
first issue is a consistency defect rather than the sole cause of missing
references. The missing media relation is the direct ownership failure mode.

## Chosen approach

Use one character-asset prompt composer, write all canonical fields for new
reference conversions, and lazily repair legacy media relations after scoped
ownership has been proven.

This is preferred over a reference-worker-only patch because project character
generation and Asset Hub character generation currently use the same prompt
ordering. It is also preferred over a database-wide migration because lazy repair
touches only assets that are actually used and preserves deployment safety.

## Prompt composition

Add a shared helper that accepts a base character description and an optional
localized art-style prompt. It composes:

1. base character description;
2. art-style prompt, when present;
3. the fixed character-sheet layout and pure-white-background suffix.

The suffix is normalized through the existing suffix helper, so it appears exactly
once and remains the final hard constraint. The helper is used by:

- reference-to-character generation;
- project character image generation;
- Asset Hub character image generation.

Location and prop generation are outside this change.

## New reference conversion persistence

After successful background generation:

- keep `description` equal to the extracted reference description;
- set `descriptions` to a JSON array whose length matches the successfully
  generated image list, repeating the extracted description for each render;
- create or resolve a `MediaObject` for the main generated storage key;
- set `imageMediaId` to that media object's id;
- continue storing `imageUrl` and `imageUrls` unchanged.

If no analysis model produced a description, both description fields remain
unchanged. Media creation is still required because it is independent of text
analysis.

The same persistence contract applies to project and global character
appearances.

## Legacy ownership repair

When a ComfyUI image reference has a valid storage key but no owned media
relation, repair follows this order:

1. verify that a project character appearance, project location image, or global
   character appearance with that exact `imageUrl` belongs to the current
   user/project scope;
2. only after that ownership check, create or resolve the `MediaObject` from the
   storage key;
3. attach its id to the verified asset row;
4. return the media record to the existing ownership resolver.

An unowned key, missing storage object, wrong MIME type, or failed repair returns
no owned reference. It must not create a media row before ownership is proven and
must not weaken the existing project/user boundary.

## Testing

Use separate red-green cycles for:

1. reference-to-character background persistence of `description`, indexed
   `descriptions`, and `imageMediaId` for both project and Asset Hub appearances;
2. exact prompt ordering in all three character generation paths, including one
   and only one fixed suffix;
3. legacy ownership repair creating and attaching missing media only for an
   in-scope asset, while rejecting unowned keys without creating media.

Run the focused worker and ComfyUI ownership suites, TypeScript, targeted ESLint,
and diff checks before integration.

## Scope

This change does not alter character analysis prompts, storyboard character-name
matching, location/prop prompt ordering, or perform a bulk database migration.
