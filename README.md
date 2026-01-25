# Robot Consortium

Multi-agent orchestration CLI for Claude Code. Gastown without the bullshit.

## Installation

```bash
npm install
npm run build
npm link
```

## Usage

```bash
# Start a new task
robot-consortium start "Add user authentication to the API"

# Check status
robot-consortium status

# Resume a paused task
robot-consortium resume

# Abort and clean up
robot-consortium abort
```

Shorthand: `rc` works the same as `robot-consortium`.

## How It Works

```
User → Robot King → SURF → PLAN → BUILD → OINK → Done
                      ↓       ↓       ↓
                   Surfers  City    Dawgs   Pigs
                   (3x)    Planners (Nx)   (3x)
                           (3x)
```

### Phases

1. **SURF** - 3 Surfers explore the codebase in parallel
   - Focus areas: patterns, similar features, tests
   - Output: `findings/*.md`

2. **PLAN** - 3 City Planners propose approaches (Opus)
   - Perspectives: conservative, ambitious, minimal
   - Robot King synthesizes into final plan
   - Output: `plans/*.md`, `final-plan.md`

3. **BUILD** - Dawgs implement the code (Opus)
   - Parallel execution for independent tasks
   - Sequential for dependent tasks
   - Output: actual code changes

4. **OINK** - 3 Pigs verify the implementation
   - Checks: tests, code review, spec compliance
   - Pass → Done
   - Fail → Back to BUILD with feedback

### User Checkpoints

You approve at key points:
- After SURF: Review findings before planning
- After PLAN: Review plan before implementation

### Agent Questions

Agents can ask clarifying questions at any phase. These are surfaced to you for answers before continuing.

## State

All state is stored in `.robot-consortium/`:
- `state.json` - Current phase, tasks, costs
- `findings/` - Surfer outputs
- `plans/` - City Planner outputs
- `reviews/` - Pig outputs
- `final-plan.md` - Approved implementation plan

## Cost

Tracks token usage per phase. City Planners and Dawgs use Opus (expensive but smart). Surfers and Pigs use the default model.

## License

MIT
