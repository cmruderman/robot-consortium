# City Planner Proposal: Developer Experience for Cursor MCP OAuth Issues

## Perspective: Developer Experience

Focus on documenting known Cursor MCP OAuth issues, workarounds (restart requirement), and improving the setup guidance for non-US tenants.

## Summary of Approach

The core bug — non-US tenants failing MCP OAuth — lives **upstream in the Omni MCP server**, not in this repository. This repo cannot fix the OAuth region-routing issue. However, this repo **can** improve the developer experience by:

1. **Adding region-aware diagnostic messaging** when OAuth tokens are resolved, so users on non-US tenants get actionable guidance instead of opaque failures
2. **Documenting the known Cursor restart requirement** directly in CLI output and README
3. **Supporting an `OMNI_BASE_URL` environment variable** that gets propagated to container execution, enabling non-US tenants to specify their region endpoint explicitly as a workaround

This approach is deliberately minimal — it doesn't try to fix the upstream bug but makes the failure mode visible and provides a manual workaround.

---

## Test Tasks (Write FIRST)

### Test 1: Region-aware auth error messaging

**No test framework exists** in this project (per conventions: "No test framework, test scripts, or test file patterns are configured"). Before writing tests, we need to bootstrap a minimal test setup.

- **Create** `package.json` test script: `"test": "node --test dist/**/*.test.js"` (Node.js 20+ built-in test runner, matching the `engines.node >= 20.0.0` requirement)
- **Create** `src/container.test.ts` with tests for:
  - `resolveClaudeAuth` returns `undefined` when no env vars set (validates the pattern at `src/container.ts:74-89`)
  - `resolveClaudeAuth` prefers `CLAUDE_CODE_OAUTH_TOKEN` over `ANTHROPIC_API_KEY` (validates existing priority at `src/container.ts:80-84`)
  - New: `resolveOmniBaseUrl` returns `undefined` when not set (following `resolveGhToken` fallback pattern at `src/container.ts:91-112`)
  - New: `resolveOmniBaseUrl` reads from process env, then .env file (following same fallback chain pattern)

### Test 2: OMNI_BASE_URL propagation to container env file

- **Add to** `src/container.test.ts`:
  - When `OMNI_BASE_URL` is set, it appears in the `envLines` array (validates against the env propagation pattern at `src/container.ts:239-245`)
  - When `OMNI_BASE_URL` is not set, it does not appear in `envLines`

### Test 3: Export of auth resolution functions

- Currently `resolveClaudeAuth` and `resolveGhToken` are module-private. Tests require them to be exported. Verify the exports compile cleanly after extraction.
- **Add to** `src/container.test.ts`: import test that `resolveClaudeAuth`, `resolveGhToken`, and `resolveOmniBaseUrl` are importable

---

## Implementation Tasks

### Task 1: Export auth resolution functions for testability

**File to modify:** `src/container.ts`
**Pattern reference:** Functions at lines 74-89 (`resolveClaudeAuth`) and 91-112 (`resolveGhToken`)
**Change:** Add `export` keyword to `resolveClaudeAuth` and `resolveGhToken`. These are currently `const` arrow functions — add `export` prefix.

### Task 2: Add `resolveOmniBaseUrl` function

**File to modify:** `src/container.ts`
**Pattern reference:** `resolveGhToken` at lines 91-112 (multi-source fallback chain: process env → .env file)
**Change:** Add new function immediately after `resolveGhToken`:

```typescript
export const resolveOmniBaseUrl = (envVars: Record<string, string>): string | undefined => {
  if (process.env.OMNI_BASE_URL) return process.env.OMNI_BASE_URL;
  if (envVars.OMNI_BASE_URL) return envVars.OMNI_BASE_URL;
  return undefined;
};
```

This follows the exact same resolution pattern as `resolveGhToken` (process env first, then `.env` file) but without a CLI fallback since there's no `omni auth token` equivalent.

### Task 3: Propagate `OMNI_BASE_URL` into container env file

**File to modify:** `src/container.ts`
**Pattern reference:** Environment variable propagation at lines 239-245 and conditional push at line 246 (`if (baseBranch) envLines.push(...)`)
**Change:** After the `baseBranch` conditional push, add:

```typescript
const omniBaseUrl = resolveOmniBaseUrl(envVars);
if (omniBaseUrl) envLines.push(`OMNI_BASE_URL=${omniBaseUrl}`);
```

### Task 4: Add region diagnostic hint to auth error messaging

**File to modify:** `src/container.ts`
**Pattern reference:** Auth validation error messaging at lines 168-182
**Change:** After the existing Claude auth error block, add a hint about non-US tenants:

```typescript
const claudeAuth = resolveClaudeAuth(envVars);
if (!claudeAuth) {
  console.log(chalk.red('  ✗ Claude authentication not found'));
  console.log(chalk.dim('  Set CLAUDE_CODE_OAUTH_TOKEN (Max/Pro plan) or ANTHROPIC_API_KEY (API billing)'));
  console.log(chalk.dim('  in your environment or .env file. Run "claude setup-token" to generate an OAuth token.'));
  console.log(chalk.dim('  Note: Non-US Omni tenants may need to set OMNI_BASE_URL to their region endpoint.'));
  return 1;
}
```

Also log the detected `OMNI_BASE_URL` during the startup validation section (following the existing credential validation pattern at the same location):

```typescript
const omniBaseUrl = resolveOmniBaseUrl(envVars);
if (omniBaseUrl) {
  console.log(chalk.dim(`  Omni base URL: ${omniBaseUrl}`));
}
```

### Task 5: Document Cursor MCP OAuth workarounds in README

**File to modify:** `README.md`
**Pattern reference:** Existing README structure (read current content first)
**Change:** Add a "Troubleshooting: Cursor MCP OAuth" section covering:
- **Known issue:** Cursor requires a restart after completing MCP OAuth authorization before the MCP tools become available to the AI agent
- **Non-US tenants:** Set `OMNI_BASE_URL` in your `.env` file to your region's endpoint (e.g., `https://eu.omni.co`) — MCP OAuth currently only works reliably for US-hosted tenants without this
- **Symptoms:** OAuth window stays on "Authorizing", AI says "I don't have access to the MCP tools", browser console shows errors

### Task 6: Bootstrap test infrastructure

**File to modify:** `package.json`
**Pattern reference:** Existing build script convention (`"build": "tsc"`, `"dev": "tsc --watch"`)
**Change:** Add `"test": "node --test dist/**/*.test.js"` to scripts. This uses Node.js 20+'s built-in test runner, avoiding new dependencies.

**File to modify:** `tsconfig.json`
**Pattern reference:** Existing source/output configuration (`src/` → `dist/`)
**Change:** Ensure `src/**/*.test.ts` files are included in compilation (they should be by default since `src/` is the root).

---

## Files Summary

| File | Action | Changes |
|------|--------|---------|
| `src/container.ts` | Modify | Export auth functions, add `resolveOmniBaseUrl`, propagate to env file, add region hint to error messages |
| `src/container.test.ts` | Create | Tests for auth resolution, OMNI_BASE_URL resolution, env propagation |
| `package.json` | Modify | Add `test` script |
| `README.md` | Modify | Add Cursor MCP OAuth troubleshooting section |

---

## Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| `OMNI_BASE_URL` is a workaround, not a fix — upstream bug still exists | Medium | Document clearly that this is a temporary workaround; the real fix is in the Omni MCP server's region routing |
| Adding `export` to internal functions increases public API surface | Low | These are already well-defined interfaces (`ClaudeAuth`); exporting them doesn't change behavior and enables testing |
| No existing test framework means test infrastructure is untested itself | Medium | Use Node.js built-in test runner (zero dependencies, stable in Node 20+); keep tests simple and focused |
| The `OMNI_BASE_URL` variable name may not match what the upstream Omni service expects | Medium | Choose a generic name that downstream tools can map; document the variable clearly so it can be renamed later if needed |
| README docs may go stale if the upstream fix lands | Low | Add a note that this section applies to the current known issue and may be removed once upstream fixes are deployed |

---

## Tradeoffs

**What this plan does well:**
- Zero-dependency changes (no new npm packages)
- Follows every existing pattern in the codebase exactly
- Provides immediate value to non-US customers via `OMNI_BASE_URL` workaround
- Makes the "restart Cursor" requirement visible in both CLI output and docs
- Bootstraps test infrastructure that the project currently lacks

**What this plan does NOT do:**
- Fix the upstream Omni MCP OAuth region-routing bug (can't be done here)
- Add token refresh or hot-reload capability (would be over-engineering for a workaround)
- Add a `--region` CLI flag (premature — the env var approach is simpler and matches existing patterns)