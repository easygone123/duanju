# ComfyUI Video Input Fail-Closed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent silently discarded ComfyUI panel images and durations when the selected workflow version lacks their mappings.

**Architecture:** Keep the existing definition-driven alias normalization. Replace only the undeclared-value deletion branches with explicit `ApiError` details so valid legacy and canonical workflow mappings remain unchanged.

**Tech Stack:** TypeScript, Prisma-backed ComfyUI request state machine.

---

### Task 1: Fail closed for undeclared video inputs

**Files:**
- Modify: `src/lib/comfyui/request-service.ts`
- Modify: `tests/unit/comfyui/request-state-machine.test.ts`

- [ ] Extend the alias normalizer with an optional undeclared-binding error descriptor.
- [ ] Configure first-frame and last-frame aliases with specific detail codes and fields.
- [ ] Replace undeclared duration deletion with `COMFY_DURATION_BINDING_REQUIRED`.
- [ ] Preserve canonical, legacy, `sourceImage`, and collision behavior.
- [ ] Update the existing undeclared-video-hints expectation to document the three explicit failures without executing the test suite.

### Task 2: Inspect the patch without running tests

**Files:**
- Verify: `src/lib/comfyui/request-service.ts`
- Verify: `tests/unit/comfyui/request-state-machine.test.ts`

- [ ] Review the focused diff for unrelated behavior changes.
- [ ] Run `git diff --check` only.
- [ ] Report explicitly that runtime tests were not run at the user's request.
