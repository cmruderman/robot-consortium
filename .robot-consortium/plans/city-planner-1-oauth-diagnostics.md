Now I have a thorough understanding of the codebase. Let me write the implementation plan.

---

# Implementation Plan: OAuth Diagnostics for Region-Aware Error Messaging

## Summary of Approach

The core Cursor MCP OAuth bug (non-US tenants failing) lives in the **external Omni MCP server**, not in this repo. However, this repo (`robot-consortium`) is the user-facing CLI that resolves and validates OAuth tokens before launching agents. We can add **meaningful diagnostic value** by:

1. Adding a `diagnose-auth` CLI subcommand that inspects the current OAuth token, detects region/tenant mismatches, and reports actionable guidance
2. Enriching existing auth error messages in `src/container.ts` with region-aware hints when an OAuth token is present but appears malformed or region-scoped
3. Keeping changes minimal and focused — we are NOT building an MCP server or OAuth flow, just improving diagnostics on the consumer side

**Why this matters**: Users currently get a generic "Claude authentication not found" message. If they have a token that's been issued for the wrong region (or is expired/malformed), they get *no signal* about what went wrong. The "restart Cursor" workaround is also undocumented in our error output.

---

## Test Tasks (Write FIRST)

> **Note**: This project has no test framework configured (`package.json` has no test script, no jest/vitest/mocha dependency). We need to bootstrap a minimal test setup first.

### Task T1: Bootstrap test infrastructure

**Rationale**: No test patterns exist in the codebase (confirmed by surfer-1 findings: "No test framework, test scripts, or test file patterns are configured"). We must add one before writing tests.

- **Install**: `vitest` as a devDependency (lightweight, ESM-native, works with `"type": "module"` — matches the `package.json` ESM config)
- **Add script**: `"test": "vitest run"` to `package.json` scripts (following the existing script pattern at `package.json` lines 11-15)
- **Add config**: `vitest.config.ts` at project root — minimal config pointing at `src/`
- **Files to modify**: `package.json` (add devDependency + test script)
- **Files to create**: `vitest.config.ts`

### Task T2: Write tests for OAuth token inspection utility

**Pattern reference**: Follow the `resolveClaudeAuth` function signature from `src/container.ts` lines 79-89 — the test exercises the same interface.

- **File to create**: `src/__tests__/auth-diagnostics.test.ts`
- **Tests to write**:
  1. `inspectOAuthToken` returns `null` for empty/undefined input
  2. `inspectOAuthToken` returns `{ type: 'api-key' }` for strings matching the Anthropic API key format (`sk-ant-*`)
  3. `inspectOAuthToken` returns `{ type: 'oauth', claims: {...} }` for a valid JWT-shaped token (base64 header.payload.signature)
  4. `inspectOAuthToken` extracts `iss` (issuer) and `aud` (audience) claims from a JWT payload, which can reveal the tenant/region
  5. `inspectOAuthToken` returns `{ type: 'oauth', claims: null, raw: true }` for non-JWT OAuth tokens (opaque strings)
  6. `detectRegionFromToken` returns `'us'` for tokens with a US-region issuer URL
  7. `detectRegionFromToken` returns `'eu'` for tokens with an EU-region issuer URL
  8. `detectRegionFromToken` returns `'unknown'` for tokens with unrecognizable issuer
  9. `formatAuthDiagnostics` produces human-readable output including token type, detected region, and issuer

### Task T3: Write tests for enhanced auth error messaging

**Pattern reference**: Follow the auth validation pattern from `src/container.ts` lines 169-182 — test that `resolveClaudeAuth` callers surface richer error messages.

- **File to create**: `src/__tests__/container-auth.test.ts`
- **Tests to write**:
  1. `formatAuthError` with no token returns the existing "authentication not found" message (regression test against `container.ts` lines 171-173)
  2. `formatAuthError` with a present-but-invalid OAuth token returns a message mentioning token inspection
  3. `formatAuthError` mentions "restart Cursor" when the `source` hint is `'mcp'`
  4. `formatAuthHints` includes a region mismatch warning when detected region doesn't match expected region

---

## Implementation Tasks (Make tests pass)

### Task I1: Create `src/auth-diagnostics.ts` — token inspection module

**Pattern reference**: Follow the pure-function style of `resolveClaudeAuth` and `resolveGhToken` in `src/container.ts` lines 79-112 — stateless functions that take input and return structured results. Follow the `ClaudeAuth` interface pattern from `src/container.ts` lines 74-77 for defining result types.

**File to create**: `src/auth-diagnostics.ts`

```
Exports:
- interface TokenInfo { type: 'api-key' | 'oauth'; claims: JwtClaims | null; raw?: boolean }
- interface JwtClaims { iss?: string; aud?: string; exp?: number; sub?: string; [key: string]: unknown }
- inspectOAuthToken(token: string | undefined): TokenInfo | null
- detectRegionFromToken(tokenInfo: TokenInfo): 'us' | 'eu' | 'unknown'
- formatAuthDiagnostics(token: string | undefined): string
```

**Key implementation details**:
- JWT decoding: base64url-decode the payload segment (no crypto verification needed — this is diagnostics, not auth)
- Region detection: match `iss` claim against known Omni domain patterns (e.g., `*.omni.co` → US, `*.eu.omni.co` → EU)
- Use `chalk` for colored output (following the existing chalk usage pattern throughout `src/container.ts`)
- Import style: ESM with `.js` extensions (per `tsconfig.json` `"module": "NodeNext"`)

### Task I2: Enhance auth error messages in `src/container.ts`

**Pattern reference**: Modify the existing error block at `src/container.ts` lines 169-175 following its own chalk formatting pattern.

**File to modify**: `src/container.ts`

**Changes**:
1. Import `inspectOAuthToken`, `detectRegionFromToken`, `formatAuthDiagnostics` from `./auth-diagnostics.js`
2. After the existing `if (!claudeAuth)` block (line 170), add a diagnostic path that checks if an OAuth token *was* present in env but failed resolution (this can happen if the token is empty string):
   - If token exists but is empty/whitespace: print "OAuth token is set but empty"
   - If token was resolved: run `inspectOAuthToken` on it and log the region detection result as a dim hint
3. Add a new hint line: `chalk.dim('  If using Cursor MCP OAuth, try restarting Cursor after authorization completes.')` — this addresses the core finding from jonath0n's repro that a restart is required

**Specific edit** (lines 170-175 of `container.ts`):
```typescript
  // Existing: resolveClaudeAuth(envVars)
  const claudeAuth = resolveClaudeAuth(envVars);
  if (!claudeAuth) {
    console.log(chalk.red('  ✗ Claude authentication not found'));
    // NEW: Check if token was set but empty
    const rawToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || envVars.CLAUDE_CODE_OAUTH_TOKEN;
    if (rawToken !== undefined) {
      console.log(chalk.yellow('  ⚠ CLAUDE_CODE_OAUTH_TOKEN is set but empty or whitespace'));
    }
    console.log(chalk.dim('  Set CLAUDE_CODE_OAUTH_TOKEN (Max/Pro plan) or ANTHROPIC_API_KEY (API billing)'));
    console.log(chalk.dim('  in your environment or .env file. Run "claude setup-token" to generate an OAuth token.'));
    console.log(chalk.dim('  If using Cursor MCP OAuth, try restarting Cursor after authorization completes.'));
    return 1;
  }
```

### Task I3: Add `diagnose-auth` CLI subcommand

**Pattern reference**: Follow the existing subcommand pattern from `src/cli.ts` — specifically the `status` command at lines 288-295 (simplest subcommand pattern: takes `--directory`, does work, exits).

**File to modify**: `src/cli.ts`

**Changes**: Add a new command after the `abort` command:

```typescript
program
  .command('diagnose-auth')
  .description('Inspect and diagnose OAuth/API key configuration')
  .option('-d, --directory <path>', 'Working directory (defaults to current)')
  .action((options: { directory?: string }) => {
    // 1. Load .env (reuse loadEnvFile pattern from container.ts)
    // 2. Resolve auth (reuse resolveClaudeAuth pattern)
    // 3. Run inspectOAuthToken + detectRegionFromToken
    // 4. Print formatted diagnostics
    // 5. Also check GH token presence
  });
```

This command will:
- Import `loadEnvFile` and auth resolution functions (requires exporting `loadEnvFile` and `resolveClaudeAuth` from `container.ts` — they are currently module-private)
- Import `formatAuthDiagnostics` from `auth-diagnostics.ts`
- Print a structured diagnostic report showing: token type, detected region, expiry (if JWT), and known issues

### Task I4: Export `loadEnvFile` and `resolveClaudeAuth` from `container.ts`

**Pattern reference**: `convertToHttpsUrl` is already exported at `src/container.ts` line 114 — follow the same pattern.

**File to modify**: `src/container.ts`

**Changes**:
- Add `export` keyword to `loadEnvFile` (line 45)
- Add `export` keyword to `resolveClaudeAuth` (line 79)
- Add `export` keyword to `resolveGhToken` (line 91)
- Export the `ClaudeAuth` interface (line 74) — already exported implicitly since it's used by `resolveClaudeAuth` return type

---

## Files Summary

| File | Action | Description |
|------|--------|-------------|
| `package.json` | Modify | Add `vitest` devDependency, add `"test"` script |
| `vitest.config.ts` | Create | Minimal vitest config |
| `src/auth-diagnostics.ts` | Create | Token inspection, region detection, diagnostic formatting |
| `src/__tests__/auth-diagnostics.test.ts` | Create | Tests for token inspection and region detection |
| `src/__tests__/container-auth.test.ts` | Create | Tests for enhanced auth error messages |
| `src/container.ts` | Modify | Export auth functions, enhance error messages with region hints + Cursor restart hint |
| `src/cli.ts` | Modify | Add `diagnose-auth` subcommand |

---

## Risks and Mitigations

### Risk 1: JWT token format assumption
**Risk**: OAuth tokens from Omni MCP may not be JWTs — they could be opaque tokens.
**Mitigation**: `inspectOAuthToken` handles both cases: if base64 decoding fails, it returns `{ type: 'oauth', claims: null, raw: true }` and diagnostics gracefully degrade to "opaque token detected, cannot determine region."

### Risk 2: Region detection heuristics may be wrong
**Risk**: We're guessing Omni's issuer URL patterns without access to their codebase.
**Mitigation**: The region detection is purely advisory (dim text hints), never blocks execution, and the `detectRegionFromToken` function returns `'unknown'` as the safe default. The core value is the "restart Cursor" hint and the "token is empty" detection, which don't depend on region heuristics at all.

### Risk 3: No existing test infrastructure
**Risk**: Adding vitest is a new dependency and could conflict with future test framework choices.
**Mitigation**: vitest is zero-config for ESM TypeScript projects (matches our `tsconfig.json`), has no runtime footprint, and is the most minimal option. If the team later prefers a different framework, migration from vitest is straightforward.

### Risk 4: Exporting previously-private functions from container.ts
**Risk**: Changing module boundaries could lead to unintended coupling.
**Mitigation**: `loadEnvFile`, `resolveClaudeAuth`, and `resolveGhToken` are pure functions with no side effects (except `resolveGhToken`'s `execSync` fallback). Exporting them doesn't change behavior — it just makes them available for the `diagnose-auth` command and tests.

### Risk 5: This doesn't fix the actual bug
**Risk**: Users still can't use MCP OAuth with non-US tenants — this only improves error messaging.
**Mitigation**: This is explicitly a diagnostics plan, not a fix. The actual fix must happen in the Omni MCP server (region-aware OAuth endpoints). What we provide is: (a) visibility into the problem via `diagnose-auth`, (b) the "restart Cursor" workaround prominently surfaced in error messages, and (c) a foundation for adding more diagnostics as the Omni team provides region information.