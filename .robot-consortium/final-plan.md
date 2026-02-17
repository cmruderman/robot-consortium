Now I have a complete picture. Let me write the final synthesized plan.

# Implementation Plan

## Approach

**Env-var passthrough for `ANTHROPIC_BASE_URL` in container mode.** All three planners agree: this repository does not implement MCP OAuth flows, token exchange, or regional endpoint routing. It is an orchestration CLI that spawns `claude` CLI subprocesses. The actual OAuth/regional fix belongs in the Claude Code CLI or Anthropic's backend.

However, robot-consortium **actively blocks** regional routing in container mode. When it builds the Docker env file (`src/container.ts:239-247`), it only passes through a fixed set of variables. If a user has `ANTHROPIC_BASE_URL` set in their environment or `.env` file, it gets silently dropped at the Docker boundary. Non-US tenants running `rc start --container` will always hit US endpoints regardless of their configuration.

The fix: propagate `ANTHROPIC_BASE_URL` through the container env file, following the exact existing pattern for `CLONE_BRANCH` at line 245. Optionally accept a `--api-base-url` CLI flag for explicit override.

**Why this approach over alternatives:**
- Planner 1 suggested "no code changes" — rejected because the Docker env-file boundary is a concrete bug: it strips a valid env var that the inner Claude CLI would otherwise respect.
- Planner 2 proposed a `resolveApiBaseUrl` function and full CLI flag — adopted, but simplified (no `CLAUDE_API_BASE_URL` alias, no URL validation beyond HTTPS check).
- Planner 3 added `CLAUDE_API_BASE_URL` support — rejected as unnecessary complexity. `ANTHROPIC_BASE_URL` is the documented name; supporting aliases without evidence they're needed violates "avoid over-engineering."

## Key Decisions

### 1. Simple passthrough, not region detection
**Decision:** Pass `ANTHROPIC_BASE_URL` as-is. Don't auto-detect regions, don't map tenant IDs to URLs.
**Alternatives considered:** Auto-detection based on OAuth token claims, hardcoded region map. Rejected because we don't know the downstream URL scheme, and explicit configuration is more robust.

### 2. Add a resolver function following existing patterns
**Decision:** Create `resolveApiBaseUrl()` following the `resolveGhToken()` pattern (env var > `.env` file). No third tier (no CLI equivalent of `gh auth token`).
**Alternative:** Inline the check without a function. Rejected because the existing code consistently uses resolver functions for credential-like values, and this maintains readability.

### 3. Add `--api-base-url` CLI flag
**Decision:** Add a CLI flag so users can override without modifying their environment.
**Alternative:** Env-var-only (no CLI flag). Rejected because every other credential/config (`--repo`, `--base-branch`, `--container-image`) has a CLI flag equivalent.

### 4. No URL validation beyond HTTPS check
**Decision:** Validate with `validateRepoUrl()` pattern (just check `https://` prefix). Don't validate the hostname or path.
**Alternative:** Hostname allowlist, URL parsing. Rejected as over-engineering — we don't know all valid Anthropic regional hostnames, and the `validateRepoUrl` pattern at line 39-43 already sets the project convention for URL validation.

### 5. Local mode needs no changes
**Decision:** No changes to `src/agents.ts`. The `spawn('claude', args, ...)` call at line 91 doesn't override `env`, so `process.env` (including `ANTHROPIC_BASE_URL`) is already inherited by child processes.
**Alternative:** Explicitly pass env vars to spawn. Rejected — the current behavior is correct and changing it would be unnecessary.

## Changes Required

### Container Options Interface
- **File:** `src/container.ts` (lines 8-19)
- **What to change:** Add `apiBaseUrl?: string` field to `ContainerOptions` interface
- **Pattern to follow:** Existing optional fields `baseBranch?: string` at line 12 and `imageName?: string` at line 13

### API Base URL Resolver Function
- **File:** `src/container.ts` (insert after `resolveGhToken` at line 112)
- **What to change:** Add `resolveApiBaseUrl` function with two-tier resolution: `process.env.ANTHROPIC_BASE_URL` > `envVars.ANTHROPIC_BASE_URL`
- **Pattern to follow:** `resolveGhToken()` at lines 91-112 (env var > `.env` file tiers), but without the third tier (no CLI fallback equivalent)

```typescript
const resolveApiBaseUrl = (envVars: Record<string, string>, cliValue?: string): string | undefined => {
  if (cliValue) return cliValue;
  if (process.env.ANTHROPIC_BASE_URL) return process.env.ANTHROPIC_BASE_URL;
  if (envVars.ANTHROPIC_BASE_URL) return envVars.ANTHROPIC_BASE_URL;
  return undefined;
};
```

Note: CLI value takes highest priority (matching how `options.repo || envVars.REPO_URL` works at line 185).

### URL Resolution and Validation in `runInContainer`
- **File:** `src/container.ts` (around line 177, after `resolveGhToken`)
- **What to change:** Call `resolveApiBaseUrl(envVars, options.apiBaseUrl)`. If a value is returned, validate it with the HTTPS check pattern from `validateRepoUrl` (line 39-43).
- **Pattern to follow:** `const ghToken = resolveGhToken(envVars)` at line 177; `validateRepoUrl(repoUrl)` at line 195

### Diagnostic Logging
- **File:** `src/container.ts` (after line 205)
- **What to change:** Add `if (apiBaseUrl) console.log(chalk.dim(`  API base URL: ${apiBaseUrl}`));`
- **Pattern to follow:** Existing diagnostic logs at lines 203-205 (`chalk.dim` with repo, base branch, image)

### Env File Propagation
- **File:** `src/container.ts` (after line 245)
- **What to change:** Add `if (apiBaseUrl) envLines.push(`ANTHROPIC_BASE_URL=${apiBaseUrl}`);`
- **Pattern to follow:** `if (baseBranch) envLines.push(`CLONE_BRANCH=${baseBranch}`);` at line 245 — exact same conditional-push pattern

### CLI Option Registration
- **File:** `src/cli.ts` (line 33, `StartOptions` interface)
- **What to change:** Add `apiBaseUrl?: string` to `StartOptions`
- **Pattern to follow:** Existing fields like `repo?: string` at line 30 and `baseBranch?: string` at line 31

- **File:** `src/cli.ts` (after line 121)
- **What to change:** Add `.option('--api-base-url <url>', 'Anthropic API base URL for non-US regions (also settable as ANTHROPIC_BASE_URL in env/.env)')`
- **Pattern to follow:** `.option('--repo <url>', ...)` at line 119 and `.option('--container-image <name>', ...)` at line 121

### CLI-to-Container Option Passthrough
- **File:** `src/cli.ts` (lines 140-151, the `runInContainer` call)
- **What to change:** Add `apiBaseUrl: options.apiBaseUrl,` to the options object
- **Pattern to follow:** `baseBranch: options.baseBranch,` at line 144

## New Files

None. All changes fit within `src/container.ts` and `src/cli.ts`.

## Testing Strategy

- **Test files to create/modify:** None. The project has no test framework, no test files, and no `test` script in `package.json`. All three planners confirmed this.
- **Verification approach:**
  1. Run `npm run lint` (`tsc --noEmit`) to verify type-safety of all changes
  2. Run `npm run build && node dist/cli.js start --help` to verify `--api-base-url` appears in help output
  3. Manual verification: set `ANTHROPIC_BASE_URL` in environment, run `rc start --container` with `--verbose`, confirm the diagnostic log shows the URL and it appears in the generated env file

## Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **The real MCP OAuth fix is elsewhere** | Medium | This change is still correct — it unblocks regional routing at the Docker boundary. Even if the upstream fix is in Claude CLI or Anthropic's backend, robot-consortium should not silently strip `ANTHROPIC_BASE_URL`. |
| **Malformed URL in env file** | Low | Validate with the existing HTTPS-prefix check (`validateRepoUrl` pattern, line 39-43). The env file is written via `fs.writeFileSync` and consumed by Docker's `--env-file` — no shell interpolation occurs (confirmed at lines 247, 254). |
| **No automated test coverage** | Low | The existing env-var passthrough for `CLONE_BRANCH` (line 245) is also untested. This follows the identical pattern. Type-checking via `tsc --noEmit` catches interface mismatches. |
| **Unknown regional URL format** | Low | We pass through the user's value verbatim. No URL construction or hostname assumptions. If Anthropic changes their regional URL scheme, this code still works. |

## Open Questions

1. **Is `ANTHROPIC_BASE_URL` the correct env var name?** The Claude Code CLI documentation should confirm this. All three planners assumed this name, and it follows Anthropic SDK conventions, but verification against Claude CLI source would be ideal.
2. **Should we also forward `ANTHROPIC_AUTH_URL` or `CLAUDE_API_BASE_URL`?** If the OAuth flow uses a separate auth endpoint URL, there may be additional env vars to propagate. For now, start with `ANTHROPIC_BASE_URL` and add others as needed — keep the change minimal.
3. **Is this repository actually used by the affected non-US tenants?** The container mode env-file stripping is a real bug, but confirming that non-US users actually use `rc start --container` would validate the urgency.

## Estimated Scope

- **Files touched:** 2 (`src/container.ts`, `src/cli.ts`)
- **Lines added:** ~15-20
- **Lines modified:** 0 (all additions, no existing lines changed)
- **New files:** 0
- **Test files:** 0
- **Complexity:** Low — follows established patterns exactly, no new abstractions