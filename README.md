# Robot Consortium

Multi-agent orchestration CLI for Claude Code.

You give it a task. It spins up a team of AI agents that explore your codebase, plan an approach, challenge the plan for flaws, write tests, implement the code, verify everything works, and open a PR — all automatically.

```
You: "Add rate limiting to the API"

  Surfers explore your codebase to understand what exists
  Planners propose how to build it from different angles
  Rats poke holes in the plans and find what'll break
  Robot King merges the best ideas into one battle-tested plan
  You review and approve the plan
  Test Dawgs write tests defining expected behavior
  Impl Dawgs write code to pass those tests
  Each task is verified immediately — failures get retried
  Pigs run a final sweep (lint, full test suite, code review)
  PR gets opened with a clean description

You: review the PR
```

## Installation

```bash
npm install
npm run build
npm link
```

Requires [Claude Code](https://claude.ai/code) and the `gh` CLI for GitHub integration.

## Usage

```bash
# Start with inline description
rc start "Add user authentication to the API"

# Start from a markdown file
rc start --file ./tasks/auth-feature.md

# Start from a GitHub issue (current repo)
rc start --issue 123

# Start from a GitHub issue (any repo)
rc start --issue https://github.com/owner/repo/issues/456

# Custom branch name
rc start "Fix login bug" --branch fix/login-bug

# Use current branch (skip branch creation)
rc start "Fix login bug" --no-branch

# Auto-proceed through checkpoints
rc start "Add feature" --yes

# Verbose mode (stream agent output)
rc start "Debug issue" --verbose

# Check status
rc status

# Resume a paused task (with optional flags)
rc resume
rc resume --skip-oink --verbose

# Abort and clean up
rc abort
```

Shorthand: `rc` works the same as `robot-consortium`.

### Options

| Option | Description |
|--------|-------------|
| `"description"` | Inline task description |
| `--file <path>` | Read task from a markdown file |
| `--issue <ref>` | Fetch task from a GitHub issue (requires `gh` CLI) |
| `--branch <name>` | Custom git branch name |
| `--no-branch` | Skip branch creation, use current branch |
| `--yes` | Auto-proceed through all checkpoints |
| `--verbose` | Stream agent output in real-time |
| `--skip-oink` | Skip verification phase (lint, tests, code review) |
| `--skip-ci` | Skip CI monitoring and auto-fix phase |
| `--skip-rats` | Skip adversarial plan critique phase |
| `--plan-only` | Run SURF and PLAN only — output a plan document, no code changes |
| `--container` | Run the entire pipeline inside a Docker container (sandboxed) |
| `--repo <url>` | Repository URL to clone inside the container (also settable as `REPO_URL` in `.env`) |
| `--base-branch <branch>` | Branch to checkout before starting inside the container |
| `--container-image <name>` | Docker image name (default: `robot-consortium`) |

For `--issue`, you can provide just the number (`--issue 123`) or a full URL (`--issue https://github.com/owner/repo/issues/123`). Issue content includes title, body, labels, and comments.

### Skip Flags

Skip flags let you control which phases run. Useful during development or when you want faster iteration.

**`--skip-rats`** — Skips the adversarial critique step during planning. Planners still propose approaches and Robot King still synthesizes a final plan, but no one challenges it for flaws first. Use this for simple, low-risk tasks where the extra scrutiny isn't worth the time.

**`--skip-oink`** — Skips the final verification sweep (lint, full test suite, code review, spec compliance). Per-task verification during BUILD still runs, so individual tasks are still tested — you're just skipping the integration-level check. Use this when you want to review the code yourself before running the full suite.

**`--skip-ci`** — Skips the CI monitoring and auto-fix loop after the PR is created. The PR still gets opened, but the system won't wait for CI to pass or attempt fixes. Use this when you'll handle CI failures yourself.

**`--plan-only`** — Runs SURF and PLAN (including Rats, unless `--skip-rats`) but stops before BUILD. Outputs a human-readable implementation plan document instead of a machine-parseable task list. No code changes are made. Use this when you want to research and plan before committing to implementation, or when you want to hand the plan to a developer.

All skip flags work on both `start` and `resume`:

```bash
# Fast iteration: skip verification and CI, auto-proceed
rc start "Quick fix" --skip-oink --skip-ci --yes

# Research and plan without writing any code
rc start "Refactor auth system" --plan-only

# Plan without adversarial review
rc start "Simple feature" --plan-only --skip-rats --yes

# Resume and skip CI this time
rc resume --skip-ci
```

### Container Mode

Run the entire pipeline inside a Docker container with a fresh repo clone. Agents get full autonomy (`--dangerously-skip-permissions`) in a sandboxed environment — nothing touches the host filesystem.

```bash
rc start "Add rate limiting" --container
```

Credentials are resolved from a `.env` file in the working directory:

```
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
REPO_URL=https://github.com/org/repo
```

| Credential | Resolution order |
|---|---|
| Claude auth | `CLAUDE_CODE_OAUTH_TOKEN` > `ANTHROPIC_API_KEY` (env or `.env`) |
| GitHub auth | `GH_TOKEN` (env or `.env`) > `gh auth token` |
| Repo URL | `--repo` flag > `REPO_URL` in `.env` |

Run `claude setup-token` to generate an OAuth token (Max/Pro plan, no API billing).

## How It Works

The pipeline runs six phases in sequence. Each phase uses specialized agents working in parallel where possible.

```
SURF ──▶ PLAN ──▶ BUILD ──▶ OINK ──▶ PR ──▶ CI_CHECK ──▶ DONE
           │  │              │                    │
           │  │ --skip-rats  │ --skip-oink        │ --skip-ci
           │  │ skips rats   │ skips to PR         │ skips to DONE
           │  │ within PLAN  │                     │
           │
           └──▶ DONE  (--plan-only: outputs plan document, no code changes)
```

### Phase 1: SURF — Explore the codebase

Robot King analyzes the task and decides what to explore (2-5 focus areas like "api-patterns", "test-infrastructure", "similar-features"). A mandatory conventions surfer always runs first — it reads CLAUDE.md, `.claude/commands/`, config files (tsconfig, eslint, prettier, package.json) to extract project rules that all downstream agents must follow.

Surfers explore in parallel and produce structured findings: actual code blocks with file paths and line numbers, not prose summaries. This gives planners and implementers concrete patterns to reference.

**Output:** `findings/*.md` — one per surfer
**Checkpoint:** You review findings before planning begins.

### Phase 2: PLAN — Propose and challenge approaches

Robot King determines 1-5 planner perspectives based on the findings (e.g., "api-design", "testing-strategy", "migration-safety"). City Planners work in parallel, each proposing an approach from their angle. Every plan must reference specific existing code patterns and separate work into test tasks and implementation tasks.

Then the Rats attack. Robot King assigns 2-3 adversarial focuses (e.g., "technical-flaws", "overengineering", "missing-requirements") and Rats critique every plan — looking for edge cases, scope creep, vagueness, and gaps. Plans that say "follow existing patterns" without naming the specific file and lines get flagged.

Robot King synthesizes all plans and critiques into one final plan that addresses the valid concerns.

**Output:** `plans/*.md`, `critiques/*.md`, `final-plan.md`
**Checkpoint:** You review the final plan before implementation begins.
**Skippable:** `--skip-rats` skips the critique step. Plans still get synthesized.

### Phase 3: BUILD — Write tests, then implement

The plan gets broken into test tasks and implementation tasks.

**Stage 1: Tests first.** Test Dawgs write test suites defining expected behavior, edge cases, and error paths. They follow the testing patterns found during SURF. Tests run in parallel.

**Stage 2: Implementation.** Impl Dawgs write code to make the tests pass. They receive the project conventions, code patterns from SURF, and the test files from Stage 1. Independent tasks run in parallel with a live progress display showing each task's status (implementing → verifying → done). Dependent tasks run sequentially.

**Per-task verification:** After each implementation task finishes, a verification agent runs the relevant tests. If tests fail, the feedback is sent back to the implementer for a retry (up to 2 attempts). This catches issues immediately instead of waiting for the final sweep.

**Output:** Code changes written directly to the repo.

### Phase 4: OINK — Final verification sweep

Since per-task checks already ran during BUILD, OINK is a safety net for integration-level issues.

A lint pig runs first and auto-fixes formatting issues. Then three verification pigs run in parallel:
- **Tests pig** — runs the full test suite (catches cross-cutting regressions)
- **Code review pig** — reviews the changes for bugs, security issues, code smells
- **Spec compliance pig** — checks that the implementation matches the plan

If everything passes, the pipeline moves to PR. If anything fails, the feedback goes back to BUILD for another attempt.

**Output:** `reviews/*.md`
**Skippable:** `--skip-oink` skips straight to PR.

### Phase 5: PR — Open a pull request

Commits any uncommitted changes, pushes the branch, and creates a PR via `gh`. Robot King generates the PR title and description from the diff, commits, and plan.

**Output:** A GitHub pull request.

### Phase 6: CI_CHECK — Monitor and fix CI

Waits for CI checks to complete (up to 15 minutes). If CI passes, done. If CI fails, Robot King analyzes the failure logs, pushes a fix, and waits again — up to 3 fix attempts.

**Skippable:** `--skip-ci` (or `--skip-oink`) skips straight to DONE.

### User Checkpoints

You approve at two key points:
- **After SURF** — review what the agents found before planning starts
- **After PLAN** — review the final plan (with critiques addressed) before implementation

Use `--yes` to auto-proceed through all checkpoints.

### Agent Questions

Agents can surface clarifying questions at any phase. These are collected and presented to you for answers before the pipeline continues.

## Model Tiering

The system uses different models for different jobs to balance quality and speed:

- **Deep reasoning tasks** (planning, implementation, synthesis) use the most capable model
- **Routine tasks** (exploration, critiques, verification) use a faster, cheaper model

This keeps costs down without sacrificing quality where it matters most.

## State

All state is stored in `.robot-consortium/` in the working directory:

| Path | Contents |
|------|----------|
| `state.json` | Current phase, tasks, costs, configuration |
| `findings/` | Surfer exploration outputs |
| `conventions.md` | Project conventions extracted by conventions surfer |
| `code-patterns.md` | Code patterns extracted by surfers |
| `plans/` | Individual planner proposals |
| `critiques/` | Rat adversarial critiques |
| `final-plan.md` | Synthesized implementation plan |
| `reviews/` | OINK verification results |

Use `rc status` to see current progress. Use `rc resume` to pick up where you left off. Use `rc abort` to clean up and start fresh.

## License

MIT
