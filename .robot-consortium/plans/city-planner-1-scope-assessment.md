Now I have a complete understanding of the codebase. Let me write the plan.

---

## Scope Assessment: MCP OAuth Fix Does NOT Belong in This Repository

### Summary

After thorough exploration of the robot-consortium codebase, the conclusion is unambiguous: **this repository does not contain MCP OAuth flow code, callback URL handling, token exchange endpoints, or regional routing logic.** The robot-consortium tool is a meta-orchestration CLI that:

1. Accepts a pre-issued `CLAUDE_CODE_OAUTH_TOKEN` as a raw credential string (`src/container.ts:79-82`)
2. Passes it through to Docker containers via secure env files (`src/container.ts:239-244`)
3. Spawns `claude` CLI subprocesses (`src/agents.ts:91`) that use the token — the actual OAuth flow happens inside the Claude Code binary or its backend

The task description asks us to fix MCP OAuth callback URLs and token exchange endpoints for non-US tenants. **None of these components exist in `/work/repo`.**

### What This Repository DOES Touch

| Component | File | Lines | Relevance |
|---|---|---|---|
| OAuth token reading | `src/container.ts` | 79-82 | Reads `CLAUDE_CODE_OAUTH_TOKEN` env var — no endpoint logic |
| Credential propagation | `src/container.ts` | 239-244 | Passes token to Docker — could pass additional env vars |
| Claude CLI invocation | `src/agents.ts` | 91-94 | Spawns `claude --print` — inherits env, no URL config |
| State tracking | `src/types.ts` | 49-76 | No region/tenant/endpoint fields |

### What This Repository Does NOT Contain

- No MCP server implementation
- No OAuth authorization code flow
- No `/oauth/callback` handler
- No token exchange endpoint
- No `redirect_uri` construction
- No regional URL mapping (US, EU, EMEA)
- No hardcoded Anthropic service URLs
- No tenant detection logic

### Recommended Action: No Code Changes

**The correct fix is to investigate the actual MCP server/OAuth service that handles the authorization flow** — not this orchestration tool. The robot-consortium repo is the wrong target.

However, if the team decides that robot-consortium should become **region-aware** (e.g., to pass a regional base URL to the inner Claude agent), the minimal change boundary would be:

### Hypothetical Minimal Change (ONLY if explicitly requested)

If — and only if — the fix requires robot-consortium to forward a regional endpoint override:

**Test tasks** (No test framework exists — project conventions confirm no test suite. Any "tests" would be manual verification or require introducing a test framework, which is out of scope for a minimal fix.)

**Implementation tasks** (3 changes, referencing existing patterns):

1. **Add `ANTHROPIC_BASE_URL` passthrough** — In `src/container.ts:239-244`, following the existing `CLONE_BRANCH` conditional pattern at line 245:
   ```typescript
   const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL || envVars.ANTHROPIC_BASE_URL;
   if (anthropicBaseUrl) envLines.push(`ANTHROPIC_BASE_URL=${anthropicBaseUrl}`);
   ```
   This follows the exact pattern of `if (baseBranch) envLines.push(...)` at line 245.

2. **Document the new env var** — In the error message at `src/container.ts:172-173`, optionally mention `ANTHROPIC_BASE_URL` for regional users.

3. **No state changes needed** — The `ConsortiumState` type (`src/types.ts:49-76`) does not need a `region` field because this is a passthrough, not a persisted concept.

**Files to modify**: `src/container.ts` only (2-3 lines added)
**Files to create**: None

### Risks and Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Fixing the wrong repo wastes time | **Critical** | Confirm the actual MCP OAuth service location before writing code |
| Adding region config without understanding the downstream system | Medium | Only add env var passthrough, don't construct URLs |
| No test coverage for new env var | Low | The existing env var pattern (line 245) is already untested; this mirrors it exactly |
| Over-engineering a region abstraction | Medium | Stick to simple env var passthrough — no region detection, no URL mapping |

### Verdict

**Do not implement code changes in this repository.** Redirect the investigation to the system that actually implements MCP OAuth (the Claude Code CLI binary, an MCP backend service, or Anthropic's OAuth provider). If forced to act in this repo, the maximal reasonable change is a 2-line env var passthrough in `src/container.ts`.