Now I have a thorough understanding of the codebase. Let me write the plan.

---

# Implementation Plan: Regional Config for MCP OAuth

## Summary of Approach

The surfers unanimously confirmed: **this repository (robot-consortium) contains zero MCP OAuth flow code, zero regional endpoint logic, and zero hardcoded Anthropic URLs.** It is a CLI orchestration tool that spawns `claude` CLI subprocesses and passes pre-issued tokens via environment variables.

The actionable fix within this codebase is to **propagate a regional API base URL** (`ANTHROPIC_BASE_URL`) through the container env-var pipeline so that the inner Claude CLI agent connects to the correct regional endpoint. Claude Code CLI itself respects `ANTHROPIC_BASE_URL` when set — the problem is that robot-consortium never passes it through.

The approach:
1. Accept an optional `--api-base-url` flag (or read `ANTHROPIC_BASE_URL` from env/.env)
2. Propagate it into the Docker container's env file alongside existing credentials
3. Pass it through to the `claude` subprocess environment in non-container (local) mode

This follows the established credential-resolution pattern in `src/container.ts` (lines 79–112) and the env-file propagation pattern (lines 239–245).

---

## Test Tasks

**No test framework exists in this project** (confirmed by conventions surfer: no `test` script, no `*.test.ts` files, no test directory). The project's only automated check is `npm run lint` (TypeScript type-checking via `tsc --noEmit`).

Given this, the "test" verification step is:

### Test Task 1: Type-check after implementation
- **What**: Run `npm run lint` (`tsc --noEmit`) to verify all new code type-checks
- **Pattern reference**: `package.json` scripts section — `"lint": "tsc --noEmit"`
- **Verification**: Zero TypeScript errors

### Test Task 2: Manual verification via `--help` output
- **What**: Run `npm run build && node dist/cli.js start --help` to verify new `--api-base-url` flag appears
- **Pattern reference**: CLI option registration pattern in `src/cli.ts` lines 107–121 (existing `.option()` calls)

---

## Implementation Tasks

### Task 1: Add `apiBaseUrl` to `ContainerOptions` interface

**File**: `src/container.ts` (line 8–19)
**Pattern**: Follow the existing optional field pattern — `baseBranch?: string` at line 12, `imageName?: string` at line 13
**Change**: Add `apiBaseUrl?: string` to the `ContainerOptions` interface

```typescript
export interface ContainerOptions {
  description: string;
  workingDir: string;
  repo?: string;
  baseBranch?: string;
  imageName?: string;
  apiBaseUrl?: string;  // NEW: regional Anthropic API base URL
  verbose?: boolean;
  skipOink?: boolean;
  skipCi?: boolean;
  skipRats?: boolean;
  planOnly?: boolean;
}
```

### Task 2: Add `resolveApiBaseUrl` function

**File**: `src/container.ts`
**Pattern**: Follow the tiered resolution pattern from `resolveGhToken` at lines 91–112 and `resolveClaudeAuth` at lines 79–89. Prioritize: env var > `.env` file > CLI flag.
**Change**: Add a new resolver function after `resolveGhToken`:

```typescript
const resolveApiBaseUrl = (envVars: Record<string, string>, cliValue?: string): string | undefined => {
  // 1. Environment variable (highest priority — set by deployment)
  if (process.env.ANTHROPIC_BASE_URL) return process.env.ANTHROPIC_BASE_URL;

  // 2. .env file
  if (envVars.ANTHROPIC_BASE_URL) return envVars.ANTHROPIC_BASE_URL;

  // 3. CLI flag (lowest priority)
  if (cliValue) return cliValue;

  return undefined;
};
```

### Task 3: Propagate `ANTHROPIC_BASE_URL` into container env file

**File**: `src/container.ts` (lines 239–245)
**Pattern**: Follow the conditional env-line pattern from `baseBranch` at line 245: `if (baseBranch) envLines.push(...)` 
**Change**: In `runInContainer`, resolve the API base URL and inject it into `envLines`:

```typescript
// After resolving other credentials (around line 191):
const apiBaseUrl = resolveApiBaseUrl(envVars, options.apiBaseUrl);

// In the envLines array (after line 245):
if (apiBaseUrl) envLines.push(`ANTHROPIC_BASE_URL=${apiBaseUrl}`);
```

Also add a log line following the existing pattern at lines 203–205:
```typescript
if (apiBaseUrl) console.log(chalk.dim(`  API base URL: ${apiBaseUrl}`));
```

### Task 4: Add `--api-base-url` CLI option

**File**: `src/cli.ts` (lines 107–121)
**Pattern**: Follow the existing CLI option registration pattern, specifically `--base-branch <branch>` at line 120 and `--container-image <name>` at line 121
**Change**: Add a new option to the `start` command and the `StartOptions` interface:

In `StartOptions` interface (line 17–33):
```typescript
apiBaseUrl?: string;
```

Add option after line 121:
```typescript
.option('--api-base-url <url>', 'Anthropic API base URL for regional routing (also settable as ANTHROPIC_BASE_URL in .env)')
```

Pass it through to `runInContainer` at lines 140–152:
```typescript
apiBaseUrl: options.apiBaseUrl,
```

### Task 5: Propagate `ANTHROPIC_BASE_URL` in local (non-container) mode

**File**: `src/agents.ts` (lines 85–94)
**Pattern**: The `spawn('claude', args, ...)` call at line 91. The `claude` CLI respects `ANTHROPIC_BASE_URL` in its environment.
**Change**: Pass `ANTHROPIC_BASE_URL` through to the spawned process environment by inheriting from `process.env` (which already happens via the default `spawn` behavior — `stdio` is set but `env` is not overridden, so `process.env` is inherited). **No code change needed here** — if `ANTHROPIC_BASE_URL` is set in the user's environment, the `claude` subprocess already inherits it.

This means the fix is only needed for container mode (where the env is isolated).

---

## Files to Modify

| File | Lines | Change | Pattern Reference |
|---|---|---|---|
| `src/container.ts` | 8–19 | Add `apiBaseUrl?: string` to `ContainerOptions` | Existing optional fields pattern (line 12–13) |
| `src/container.ts` | after 112 | Add `resolveApiBaseUrl()` function | `resolveGhToken` pattern (lines 91–112) |
| `src/container.ts` | ~191 | Call `resolveApiBaseUrl()` | `resolveGhToken(envVars)` call at line 177 |
| `src/container.ts` | ~205 | Add log line for API base URL | `chalk.dim` log pattern at lines 203–205 |
| `src/container.ts` | 239–245 | Add `ANTHROPIC_BASE_URL` to `envLines` | `baseBranch` conditional push at line 245 |
| `src/cli.ts` | 17–33 | Add `apiBaseUrl?: string` to `StartOptions` | Existing interface fields pattern |
| `src/cli.ts` | 119–121 | Add `--api-base-url <url>` option | `--base-branch` pattern at line 120 |
| `src/cli.ts` | 140–152 | Pass `apiBaseUrl` to `runInContainer` | `baseBranch: options.baseBranch` at line 144 |

## Files to Create

None.

---

## Risks and Mitigations

### Risk 1: URL Validation
**Risk**: A malformed `ANTHROPIC_BASE_URL` could cause confusing failures inside the container.
**Mitigation**: Reuse the existing `validateRepoUrl` pattern (lines 39–43) to validate that the URL uses HTTPS. Add a `validateApiBaseUrl` check or reuse the existing regex. Keep it simple — just check `https://` prefix.

### Risk 2: Credential Exposure in Logs
**Risk**: The API base URL is logged to console. While it's not a secret (it's a public endpoint), it could reveal tenant region.
**Mitigation**: This is acceptable — `repoUrl` is already logged at line 203 with the same pattern. Region information is not sensitive.

### Risk 3: Non-Container Mode Already Works
**Risk**: In local (non-container) mode, `process.env` is inherited by `spawn('claude', ...)`. Users who already have `ANTHROPIC_BASE_URL` set don't need any change. The fix is only for container mode where env isolation exists.
**Mitigation**: Document that container mode is the one being fixed. The `--api-base-url` flag plus env-var resolution provides the mechanism to pass it through the Docker boundary.

### Risk 4: The Real Fix May Be Elsewhere
**Risk**: The MCP OAuth issue may truly live in the Claude Code CLI itself or Anthropic's backend, not in endpoint routing.
**Mitigation**: This is acknowledged. The change here ensures that robot-consortium does not *prevent* regional routing by stripping `ANTHROPIC_BASE_URL` at the Docker boundary. If the underlying Claude CLI or backend is fixed separately, this change is still correct — it ensures env vars propagate cleanly.