# Robot Consortium

Multi-agent orchestration CLI for Claude Code. Gastown without the bullshit.

You give it a task. It spins up a team of AI agents that explore your codebase, plan an approach, challenge the plan for flaws, implement the code, verify the result, and open a PR — all automatically.

```
You: "Add rate limiting to the API"

  Surfers explore your codebase to understand what exists
  Planners propose how to build it from different angles
  Rats poke holes in the plans and find what'll break
  Robot King merges the best ideas into one battle-tested plan
  You review and approve the plan
  Dawgs write the code in parallel
  Pigs verify it works (lint, tests, code review)
  PR gets opened with a clean description

You: review the PR
```

## Installation

```bash
npm install
npm run build
npm link
```

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

# Skip verification and CI
rc start "Add button" --skip-oink --skip-ci

# Skip rat challengers during planning
rc start "Simple fix" --skip-rats

# Auto-proceed through checkpoints
rc start "Add feature" --yes

# Verbose mode (stream agent output)
rc start "Debug issue" --verbose

# Check status
rc status

# Resume a paused task
rc resume

# Resume with flags
rc resume --skip-oink --verbose

# Abort and clean up
rc abort
```

Shorthand: `rc` works the same as `robot-consortium`.

### Options

| Option | Description |
|--------|-------------|
| `"description"` | Inline task description |
| `--file <path>` | Read from markdown file |
| `--issue <ref>` | Fetch from GitHub issue (requires `gh` CLI) |
| `--branch <name>` | Custom git branch name |
| `--no-branch` | Skip branch creation, use current branch |
| `--yes` | Auto-proceed through all checkpoints |
| `--verbose` | Stream agent output in real-time |
| `--skip-oink` | Skip the OINK verification phase |
| `--skip-ci` | Skip the CI_CHECK phase |
| `--skip-rats` | Skip the Rat challenge phase during planning |

For `--issue`, you can provide:
- Just the number: `--issue 123` (uses current repo)
- Full URL: `--issue https://github.com/owner/repo/issues/123`

Issue content includes title, body, labels, and comments.

## How It Works

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          ROBOT CONSORTIUM                                   │
│                                                                             │
│  rc start "task description"                                                │
│  ┌──────┐    ┌──────┐    ┌──────┐    ┌──────┐    ┌────┐    ┌────────┐      │
│  │ SURF │───▶│ PLAN │───▶│BUILD │───▶│ OINK │───▶│ PR │───▶│CI_CHECK│──▶DONE
│  └──┬───┘    └──┬───┘    └──┬───┘    └──┬───┘    └────┘    └───┬────┘      │
│     │           │           │           │                       │           │
│     │           │           │           │    ┌──────────────────┘           │
│     │           │           │           │    │ Up to 3 fix attempts         │
│     │           │           │    FAIL?  │    │                              │
│     │           │           │◀──────────┘    │  --skip-ci                   │
│     │           │           │                │  skips this ──────────▶ DONE │
│     │           │           │                │                              │
│     │           │      --skip-oink           │                              │
│     │           │      skips OINK ───────────┼──────────────────────▶ DONE  │
│     │           │           │                │                              │
└─────┼───────────┼───────────┼────────────────┼──────────────────────────────┘
      │           │           │                │
      ▼           ▼           ▼                ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                           AGENT DETAILS                                   │
│                                                                           │
│  SURF                          PLAN                                       │
│  ┌─────────────────────┐       ┌─────────────────────────────────────┐    │
│  │ Robot King (Opus)    │       │ Robot King (Opus)                   │    │
│  │ analyzes task,       │       │ analyzes findings,                  │    │
│  │ assigns focuses      │       │ assigns perspectives                │    │
│  │         │            │       │         │                           │    │
│  │         ▼            │       │         ▼                           │    │
│  │ ┌─────┐┌─────┐┌───┐ │       │ ┌──────┐┌──────┐┌──────┐          │    │
│  │ │Surf1││Surf2││...│ │       │ │Plan1 ││Plan2 ││Plan3 │          │    │
│  │ │Sonnt││Sonnt││   │ │       │ │Opus  ││Opus  ││Opus  │          │    │
│  │ └──┬──┘└──┬──┘└─┬─┘ │       │ └──┬───┘└──┬───┘└──┬───┘          │    │
│  │    └──────┴─────┘    │       │    └───────┴───────┘               │    │
│  │         │            │       │            │                        │    │
│  │         ▼            │       │            ▼                        │    │
│  │   findings/*.md      │       │     plans/*.md                     │    │
│  └─────────────────────┘       │            │                        │    │
│                                 │            ▼                        │    │
│                                 │  🐀 RAT PHASE (--skip-rats to skip)│    │
│                                 │  ┌──────┐┌──────┐┌──────┐         │    │
│                                 │  │Rat 1 ││Rat 2 ││Rat 3 │         │    │
│                                 │  │Sonnt ││Sonnt ││Sonnt │         │    │
│                                 │  │flaws ││scope ││gaps  │         │    │
│                                 │  └──┬───┘└──┬───┘└──┬───┘         │    │
│                                 │     └───────┴───────┘              │    │
│                                 │             │                       │    │
│                                 │             ▼                       │    │
│                                 │      critiques/*.md                │    │
│                                 │             │                       │    │
│                                 │             ▼                       │    │
│                                 │  Robot King (Opus)                  │    │
│                                 │  synthesizes plans + critiques      │    │
│                                 │             │                       │    │
│                                 │             ▼                       │    │
│                                 │      final-plan.md                 │    │
│                                 └─────────────────────────────────────┘    │
│                                                                           │
│  BUILD                          OINK                                      │
│  ┌─────────────────────┐       ┌─────────────────────────────────────┐    │
│  │ Robot King (Opus)    │       │ Lint Pig (Sonnet) ── runs first     │    │
│  │ extracts tasks,      │       │         │                           │    │
│  │ resolves deps        │       │         ▼                           │    │
│  │         │            │       │ ┌──────┐┌──────┐┌──────┐          │    │
│  │         ▼            │       │ │Tests ││Review││Spec  │          │    │
│  │ Independent tasks:   │       │ │Sonnt ││Sonnt ││Sonnt │          │    │
│  │ ┌─────┐┌─────┐┌───┐ │       │ └──┬───┘└──┬───┘└──┬───┘          │    │
│  │ │Dawg1││Dawg2││...│ │       │    └───────┴───────┘               │    │
│  │ │Opus ││Opus ││   │ │       │         │                           │    │
│  │ └─────┘└─────┘└───┘ │       │    PASS/FAIL verdict               │    │
│  │         │            │       │         │                           │    │
│  │         ▼            │       │  FAIL ──┼──▶ back to BUILD         │    │
│  │ Dependent tasks:     │       │         │    with feedback          │    │
│  │ ┌─────┐ then ┌─────┐│       │  PASS ──┼──▶ proceed to PR         │    │
│  │ │Dawg3│─────▶│Dawg4││       │         │                           │    │
│  │ │Opus │      │Opus ││       │   reviews/*.md                     │    │
│  │ └─────┘      └─────┘│       └─────────────────────────────────────┘    │
│  │                      │                                                  │
│  │  Code changes        │                                                  │
│  │  written to repo     │                                                  │
│  └─────────────────────┘                                                  │
│                                                                           │
│  CHECKPOINTS                                                              │
│  ┌───────────────────────────────────────────────────────────────────┐    │
│  │ ✋ After SURF ── review findings before planning                  │    │
│  │ ✋ After PLAN ── review final plan before building                │    │
│  │                                                                   │    │
│  │ Use --yes to auto-proceed through all checkpoints                 │    │
│  └───────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────────────┘
```

### Phases

1. **SURF** — Robot King analyzes the task and spawns 2-5 Surfers (Sonnet) in parallel
   - Each surfer gets a dynamically assigned focus area (e.g. "api-patterns", "test-infrastructure")
   - Output: `findings/*.md`
   - User checkpoint: review findings before planning

2. **PLAN** — Robot King determines planner perspectives, spawns 1-5 City Planners (Opus) in parallel
   - Each planner proposes an approach from a distinct angle
   - **Rat phase**: 2-3 Rats (Sonnet) then critique all plans, finding flaws and gaps
   - Robot King synthesizes plans + critiques into one final plan
   - Output: `plans/*.md`, `critiques/*.md`, `final-plan.md`
   - User checkpoint: review final plan before building

3. **BUILD** — Robot King extracts implementation tasks from the plan
   - Independent tasks run in parallel via Dawgs (Opus)
   - Dependent tasks run sequentially
   - Output: actual code changes

4. **OINK** — 3 Pigs (Sonnet) verify the implementation
   - Lint pig runs first (fixes formatting issues)
   - Then in parallel: tests, code review, spec compliance
   - Pass → proceed to PR
   - Fail → back to BUILD with feedback
   - Skippable with `--skip-oink`

5. **PR** — Commits changes, pushes branch, creates PR via `gh`
   - Robot King generates PR title and description from the diff

6. **CI_CHECK** — Waits for CI, auto-fixes failures (up to 3 attempts)
   - Robot King analyzes failure logs and pushes fixes
   - Skippable with `--skip-ci`

### Model Tiering

| Agent | Model | Rationale |
|-------|-------|-----------|
| Robot King | Opus | Synthesis, coordination, decisions |
| City Planners | Opus | Strategic planning |
| Dawgs | Opus | Implementation requires deep reasoning |
| Surfers | Sonnet | Read-only exploration, speed matters |
| Rats | Sonnet | Critical analysis, not creation |
| Pigs | Sonnet | Running lint/tests, structured review |

### User Checkpoints

You approve at key points:
- After SURF: review findings before planning
- After PLAN: review final plan (with rat critiques addressed) before implementation

Use `--yes` to auto-proceed through all checkpoints.

### Agent Questions

Agents can ask clarifying questions at any phase. These are surfaced to you for answers before continuing.

## State

All state is stored in `.robot-consortium/`:
- `state.json` — Current phase, tasks, costs
- `findings/` — Surfer outputs
- `plans/` — City Planner outputs
- `critiques/` — Rat outputs
- `reviews/` — Pig outputs
- `final-plan.md` — Synthesized implementation plan

## License

MIT
