Now I have a complete understanding. Let me write the plan.

---

# Implementation Plan: Region-Aware Configuration for robot-consortium

## Summary of Approach

**Key finding:** The robot-consortium codebase does not implement MCP OAuth flows, token exchange, or regional endpoint routing. It is an orchestration tool that spawns `claude` CLI processes and passes credentials via environment variables. The MCP OAuth regional issue lives in the Claude Code CLI or Anthropic's backend — **not in this repo**.

However, robot-consortium **can** help non-US tenants by forwarding regional configuration to the Claude CLI processes it spawns. The Claude CLI respects `ANTHROPIC_BASE_URL` to route API traffic to the correct regional endpoint. Today, robot-consortium does not propagate this variable — meaning non-US users who set it in their environment get it silently dropped when running in container mode.

**The fix:** Ensure `ANTHROPIC_BASE_URL` (and the related `CLAUDE_API_BASE_URL`) environment variables are propagated through to both:
1. **Container mode** — via the env file written at `src/container.ts:239-245`
2. **Local mode** — these already inherit from the parent process env via `spawn('claude', ...)` at `src/agents.ts:91`, so local mode works today. The fix is container-mode only.

**User experience approach:** Use environment variable passthrough (zero-friction for users who already set `ANTHROPIC_BASE_URL`) plus an optional `--api-base-url` CLI flag for explicit override. No auto-detection magic — explicit is better than implicit for regional routing, and this follows the existing credential resolution pattern (`env > .env file > fallback`).

---

## Test Tasks

**Note:** This project has no test framework or test suite (confirmed in conventions). There are no test patterns to follow. Per the project conventions: "No test framework or test files found in the repository." 

Given this, test-first development is not feasible within the existing project structure. Instead, verification will be done via `npm run lint` (TypeScript type-checking) and manual validation of the container env file output.

**Verification task (in lieu of automated tests):**
- After implementation, run `npm run lint` to ensure type-safety
- Manually test container mode with `ANTHROPIC_BASE_URL` set and verify it appears in the generated env file

---

## Implementation Tasks

### Task 1: Propagate `ANTHROPIC_BASE_URL` through the container env file

**File to modify:** `src/container.ts`

**Change 1a — Add base URL resolution function** (insert after `resolveGhToken` at line 112, following the tiered resolution pattern from `resolveClaudeAuth` at lines 79-89 and `resolveGhToken` at lines 91-112):

```typescript
const resolveApiBaseUrl = (envVars: Record<string, string>): string | undefined => {
  // 1. Environment variables (Claude CLI convention)
  if (process.env.ANTHROPIC_BASE_URL) return process.env.ANTHROPIC_BASE_URL;
  if (process.env.CLAUDE_API_BASE_URL) return process.env.CLAUDE_API_BASE_URL;

  // 2. .env file
  if (envVars.ANTHROPIC_BASE_URL) return envVars.ANTHROPIC_BASE_URL;
  if (envVars.CLAUDE_API_BASE_URL) return envVars.CLAUDE_API_BASE_URL;

  return undefined;
};
```

**Pattern reference:** Follows the exact tiered resolution pattern from `resolveGhToken` (`src/container.ts:91-112`) — check env vars first, then .env file. No third-tier fallback needed since there's no CLI equivalent of `gh auth token` for base URLs.

**Change 1b — Add base URL to env file** (modify `envLines` at lines 239-245, following the conditional env line pattern from `baseBranch` at line 245):

```typescript
const apiBaseUrl = resolveApiBaseUrl(envVars);
// ... existing envLines ...
if (baseBranch) envLines.push(`CLONE_BRANCH=${baseBranch}`);
if (apiBaseUrl) envLines.push(`ANTHROPIC_BASE_URL=${apiBaseUrl}`);
```

**Pattern reference:** Follows the conditional env line pattern from `if (baseBranch) envLines.push(...)` at `src/container.ts:245`.

**Change 1c — Log the base URL for visibility** (add after the `Base branch` log at line 204, following the diagnostic logging pattern at lines 203-205):

```typescript
if (apiBaseUrl) {
  console.log(chalk.dim(`  API base URL: ${apiBaseUrl}`));
}
```

**Pattern reference:** Follows the diagnostic log pattern from `src/container.ts:203-205` where repo, base branch, and image are logged.

### Task 2: Add `--api-base-url` CLI flag for explicit override

**File to modify:** `src/cli.ts`

**Change 2a — Add to `StartOptions` interface** (at line 33, following the pattern of existing optional string fields like `repo` and `baseBranch`):

```typescript
apiBaseUrl?: string;
```

**Pattern reference:** Follows the interface field pattern from `StartOptions` at `src/cli.ts:17-33`, specifically `repo?: string` and `baseBranch?: string`.

**Change 2b — Add CLI option** (after the `--container-image` option at line 121, following the existing `.option()` chain pattern):

```typescript
.option('--api-base-url <url>', 'Anthropic API base URL for non-US regions (also settable as ANTHROPIC_BASE_URL in env/.env)')
```

**Pattern reference:** Follows the `.option()` pattern from `src/cli.ts:119` where `--repo` is defined with a similar "also settable as X" help text.

**Change 2c — Pass to `ContainerOptions`** (at line 140-152, in the `runInContainer` call):

```typescript
apiBaseUrl: options.apiBaseUrl,
```

**Change 2d — Add to `ContainerOptions` interface** in `src/container.ts` (at line 18):

```typescript
apiBaseUrl?: string;
```

**Pattern reference:** Follows the optional field pattern in `ContainerOptions` at `src/container.ts:8-19`, specifically `repo?: string`.

**Change 2e — Use CLI flag as highest priority** in `resolveApiBaseUrl` (modify the resolution function to accept the CLI override):

Update the env file construction to prefer `options.apiBaseUrl` over environment detection:

```typescript
const apiBaseUrl = options.apiBaseUrl || resolveApiBaseUrl(envVars);
```

This follows the same pattern as `options.repo || envVars.REPO_URL` at `src/container.ts:185`.

---

## Files to Modify

| File | Changes | Pattern Reference |
|------|---------|-------------------|
| `src/container.ts` | Add `resolveApiBaseUrl()` function, add `apiBaseUrl` to `ContainerOptions`, propagate to env file, add diagnostic log | `resolveGhToken` (lines 91-112), `envLines` (lines 239-245), diagnostic logs (lines 203-205) |
| `src/cli.ts` | Add `apiBaseUrl` to `StartOptions`, add `--api-base-url` CLI option, pass to `runInContainer` | `StartOptions` interface (lines 17-33), `.option('--repo')` (line 119) |

## Files to Create

None. All changes fit within existing files.

## Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Users may not know they need to set `ANTHROPIC_BASE_URL` | Medium | Add the base URL to the diagnostic log output so non-US users can see if it's set or missing. The `--api-base-url` help text mentions the env var alternative. |
| Env var may contain malicious content (shell injection via env file) | Low | The env file is written via `fs.writeFileSync` (line 247) and consumed by Docker's `--env-file` flag — no shell interpolation occurs. This follows the existing secure credential passing pattern. However, we should validate the URL is HTTPS, following the `validateRepoUrl` pattern at lines 39-43. |
| `CLAUDE_API_BASE_URL` vs `ANTHROPIC_BASE_URL` naming confusion | Low | Support both (Claude CLI accepts both), prefer `ANTHROPIC_BASE_URL` in the env file output since it's the more widely documented name. |
| Local (non-container) mode might also need changes | None | Local mode uses `spawn('claude', ...)` which inherits the parent process environment — `ANTHROPIC_BASE_URL` already flows through. No changes needed for local mode. |

---

## User Experience Summary

For non-US tenants, the path to correct operation is:

1. **Easiest (env var):** Set `ANTHROPIC_BASE_URL=https://api.eu.anthropic.com` in environment or `.env` file — works in both local and container mode with zero CLI changes
2. **Explicit (CLI flag):** Use `--api-base-url https://api.eu.anthropic.com` on the `rc start --container` command
3. **Diagnostic:** The container startup log will show `API base URL: https://api.eu.anthropic.com` so users can confirm correct routing