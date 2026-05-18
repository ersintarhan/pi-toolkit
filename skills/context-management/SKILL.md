---
name: context-management
description: "Agentic context management for pi sessions using pi-auto-context: anchors, pivots, and cross-session recall. Use when continuing or recalling prior work, at task boundaries, before risky or irreversible changes, after repeated failures or direction shifts, or when context is under pressure."
---

# Context Management

Manage your own context window proactively. Read the conversation for signals of phase shifts, risk points, and topic recurrence. Never wait for the user to tell you.

## Mental Model

Your session is an **append-only tape** forming a tree. **Anchors** mark past state at meaningful boundaries (retrospective only, not todos). Changing direction is a **pivot** within a session — jump back to an earlier anchor and carry forward the lessons.

Tool results older than the last anchor are auto-truncated; anchors themselves stay verbatim. Inline signals throughout this skill reference `context=` / `tool=` / `anchor=` from the pi-auto-context status line.

## Core Loop

```
(signals → recall) → work
  → (signals → boundary) → anchor
    → work → pivot as signals demand
```

## Recall Before Starting

Signals: user mentions a topic you might have worked on, task resembles prior work, user says "continue from where we were".

1. `context(recall, keyword=<topic>)` — default scope is `cwd`; pass `scope="all"` for cross-project.
2. If a relevant session is found, use the built-in `/resume` slash command to switch into it.
3. Otherwise proceed fresh.

`recall` only reads anchor summaries across stored sessions — it does not switch you. That keeps it safe to call speculatively.

## Anchor

Signals: subtask complete, about to do something risky, user confirmed a decision, phase shifting (plan→implement), heavy tool-use coming, non-trivial state since last anchor.

- `name`: short phase/intent. Suggested format `<task-slug>-<phase>` (e.g. `auth-jwt-start`, `runner-timeout-impl`, `review-round-2`).
- `summary`: what's done/known/decided — **retrospective, not todo**.

Bad: `anchor(name="add-tests", summary="will add tests next")` — that's a todo.
Good: `anchor(name="auth-impl-done", summary="auth flow implemented; tests next")`.

On name collision, error shows existing summary — pick a better name (e.g. `-v2`).

## Pivot (within-session)

Signals: same approach failed 2+ times, premise turned out wrong, topic shift, context full and want an earlier clean branch.

`context(pivot, target=<anchor>, carryover=<what to preserve>, message?=<directive>)`

Carryover = what survives the jump (attempts, learnings, decisions).
Pass `message` to drive the next turn after the pivot lands; otherwise the new branch starts idle and waits for input.

## View

`context(view)` before pivot, after resume, or to understand anchor topology.

## Recipes

### Research then return

You need to read a long doc / many files to decide, but the reading itself is noise.

```
context(anchor, name="auth-lib-choice-start", summary="about to evaluate PyJWT vs python-jose vs authlib for agent auth.")
# ... read 3 docs, skim 20 files ...
context(anchor, name="auth-lib-chosen-pyjwt", summary="chose PyJWT: active maintenance, stdlib-only deps, jose archives too much unused algo surface.")
# older tool-heavy entries are now auto-truncated before the start anchor.
```

Result: decision preserved, research noise dropped, no compact needed.

### Pivot to retry

Current approach failed twice. Roll back to a known-good anchor, carry the lessons across.

```
context(pivot,
  target="runner-timeout-start",
  carryover="Tried asyncio.wait_for (hung on cancel) and signal.alarm (not thread-safe). Switching to asyncio.timeout + TaskGroup.",
  message="Implement the TaskGroup-based variant; ignore previous attempts.")
```

## Anti-Patterns

| Don't | Do |
|---|---|
| Anchor every step (`step1-done`, `step2-done`) | Anchor phase changes (`plan-done`, `impl-done`) |
| Summarize as "discussed X" or "working on Y" | Summarize the outcome: decision, completed work, failure mode |
| Pivot without carryover (lose all learnings) | Carryover = attempts, decisions, lessons worth keeping |
| Pivot when the real problem is a 10KB curl dump in context | Externalize large tool output to `/tmp` first, read targeted sections |
| Guess anchor/entry IDs for pivot | `view` first, confirm the target |

## Rules

1. **Recall before starting.** Don't redo past work.
2. **Anchor at semantic boundaries.** Read signals, not step count.
3. **Anchors are retrospective.** Summary only; never encode future tasks.
4. **Anchor outcomes, not topics.** Good: decisions, completed implementations, stabilized theories/frameworks, pre-pivot state. Weak: "discussed X", vague topic labels, raw conversation progress, todos without completed state.
5. **Never pivot without carryover.** Carryover is your memory across the jump.
6. **View before pivot.** Confirm target from the anchor list first.
