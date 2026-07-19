# ComfyUI Unconstrained Duration Design

## Goal

Allow a video panel's calculated duration to flow into a ComfyUI workflow whose `duration` binding accepts arbitrary positive seconds and does not declare fixed options or a workflow default.

## Behavior

- Keep fixed ComfyUI duration contracts unchanged.
- For an unconstrained ComfyUI duration binding, resolve the runtime duration in this order:
  1. panel duration override;
  2. panel estimated duration;
  3. legacy panel duration;
  4. workflow variable default.
- Reject the request with `VIDEO_DURATION_INVALID` only when none of those values is a positive finite number.
- Continue passing the resolved seconds through the existing `generationOptions.duration` and numeric binding pipeline.

## Scope

Change only the server-side duration-contract adapter used by panel video submission. Do not change workflow mappings, numeric conversion, image handling, or remote-provider duration behavior.

## Verification Constraint

Per user instruction, this change will receive static diff inspection only. No tests, type checking, linting, or build commands will be run.
