# Implementation Plan: Multi-Region OAuth Support for Token Resolution

## Summary of Approach

The core issue is twofold:

1. **Primary (external):** The Omni MCP server hardcodes US-region OAuth endpoints, breaking non-US tenants. This repo cannot fix that directly.
2. **What this repo CAN do:** Make `robot-consortium`'s token resolution region-aware so it can (a) detect region-specific OAuth failures gracefully, (b) propagate region configuration to containers, and (c) surface actionable diagnostics when EU/EMEA tokens fail.

The approach adds an optional `OMNI_REGION` / `OMNI_BASE_URL` environment variable that flows through the existing credential resolution and container propagation patterns, with region-aware error messaging. This is a defensive, forward-compatible change — it doesn't break existing US-only workflows but prepares the tooling for when the upstream MCP server fix lands.

---

## Test Tasks (Write FIRST)

> **Note:** This project has no test framework configured. The first test task establishes a minimal test harness.

### Test Task 1: Set up minimal test infrastructure

- **Create** `src/__tests__/setup.ts` — a lightweight test runner using Node's built-in `node:test` and `node:assert` (no new dependencies, follows the project's zero-external-test-dependency convention from `package.json`)
- **Add** `"test": "node --import tsx --test src/__tests__/**/*.test.ts"` to `package.json` scripts (follows the existing script pattern in `package.json` where `build`, `dev`, `start`, `lint` are defined)
- Since `tsx` is a devDependency concern and the project uses `tsc` for build, alternatively use `"test": "tsc && node --test dist/__tests__/**/*.test.js"` to stay consistent with the `npm run build → tsc` pattern from `package.json`

### Test Task 2: Test region resolution from environment

- **Create** `src/__tests__/region.test.ts`
- Test a new `resolveRegionConfig()` function that mirrors the pattern from `resolveClaudeAuth` (`src/container.ts:74-89`) and `resolveGhToken` (`src/container.ts:91-112`):
  - Returns `undefined` when no region env vars are set (default/US behavior)
  - Returns `{ region: 'eu', baseUrl: 'https://eu.omni.co' }` when `OMNI_REGION=eu` is set via process env
  - Returns base URL from `OMNI_BASE_URL` env var when explicitly provided (overrides region-derived URL)
  - Reads from `.env` file vars when process env is not set (follows the `process.env.X || envVars.X` fallback pattern from `resolveClaudeAuth` at `src/container.ts:82-83`)

### Test Task 3: Test region-aware error messaging

- **Create** `src/__tests__/region-errors.test.ts`
- Test a new `formatAuthError()` function that:
  - When region config is `undefined`, produces the existing error message (matching the exact strings from `src/container.ts:170-175`)
  - When region config is `{ region: 'eu', baseUrl: '...' }`, appends region diagnostic info (e.g., "Detected region: eu — ensure your MCP server supports this region")
  - Follows the `chalk.red` / `chalk.dim` messaging pattern from `src/container.ts:170-182`

### Test Task 4: Test region propagation to container env lines

- **Create** `src/__tests__/container-env.test.ts`
- Test that when region config is present, `OMNI_REGION` and/or `OMNI_BASE_URL` are appended to the env lines array
- Follows the `envLines.push()` pattern from `src/container.ts:239-245`, specifically the conditional push pattern used for `baseBranch` at line 245: `if (baseBranch) envLines.push(...)`

---

## Implementation Tasks (Make tests pass)

### Implementation Task 1: Add `resolveRegionConfig()` to `src/container.ts`

- **File to modify:** `src/container.ts`
- **Pattern to follow:** `resolveClaudeAuth` at lines 74-89 and `resolveGhToken` at lines 91-112 — same structure of checking `process.env.X` then falling back to `envVars.X`
- **Specific changes:**
  - Add a new interface after `ClaudeAuth` (line 78):
    ```typescript
    interface RegionConfig {
      region: string;
      baseUrl: string;
    }
    ```
  - Add a new function after `resolveGhToken` (after line 112):
    ```typescript
    const REGION_BASE_URLS: Record<string, string> = {
      us: 'https://app.omni.co',
      eu: 'https://eu.omni.co',
      apac: 'https://apac.omni.co',
    };

    export const resolveRegionConfig = (envVars: Record<string, string>): RegionConfig | undefined => {
      // Explicit base URL takes priority (follows pattern from resolveClaudeAuth preferring specific over general)
      const baseUrl = process.env.OMNI_BASE_URL || envVars.OMNI_BASE_URL;
      if (baseUrl) {
        const region = process.env.OMNI_REGION || envVars.OMNI_REGION || 'custom';
        return { region, baseUrl };
      }

      // Region shorthand resolves to known base URL
      const region = process.env.OMNI_REGION || envVars.OMNI_REGION;
      if (region) {
        const resolvedUrl = REGION_BASE_URLS[region.toLowerCase()];
        if (!resolvedUrl) return undefined; // Unknown region — let caller handle
        return { region: region.toLowerCase(), baseUrl: resolvedUrl };
      }

      return undefined; // No region config — default (US) behavior
    };
    ```
  - **Export** the function for testability (consistent with `convertToHttpsUrl` export at line 114)

### Implementation Task 2: Add region-aware auth error messaging

- **File to modify:** `src/container.ts`
- **Pattern to follow:** Auth validation block at lines 168-182 using `chalk.red` and `chalk.dim`
- **Specific changes:** After the existing auth validation block (line 182), add region diagnostic output:
  ```typescript
  const regionConfig = resolveRegionConfig(envVars);
  if (regionConfig) {
    console.log(chalk.dim(`  Region: ${regionConfig.region} (${regionConfig.baseUrl})`));
  }
  ```
- If auth succeeds but we want to warn about potential region issues, add after the successful resolution:
  ```typescript
  if (regionConfig && regionConfig.region !== 'us') {
    console.log(chalk.yellow(`  ⚠ Non-US region detected: ${regionConfig.region}`));
    console.log(chalk.dim(`    If OAuth fails, verify MCP server supports region: ${regionConfig.baseUrl}`));
  }
  ```

### Implementation Task 3: Propagate region config to container environment

- **File to modify:** `src/container.ts`
- **Pattern to follow:** The conditional `envLines.push` pattern at lines 239-245, specifically `if (baseBranch) envLines.push(`CLONE_BRANCH=${baseBranch}`)`
- **Specific changes:** After the `baseBranch` push (line 245), add:
  ```typescript
  const regionConfig = resolveRegionConfig(envVars);
  if (regionConfig) {
    envLines.push(`OMNI_REGION=${regionConfig.region}`);
    envLines.push(`OMNI_BASE_URL=${regionConfig.baseUrl}`);
  }
  ```

### Implementation Task 4: Add `--region` CLI option

- **File to modify:** `src/cli.ts`
- **Pattern to follow:** Container CLI options at lines 118-121, specifically `.option('--base-branch <branch>', '...')`
- **Specific changes:** After line 121, add:
  ```typescript
  .option('--region <region>', 'Omni tenant region (us, eu, apac) for OAuth endpoint routing')
  ```
- Pass the value through to container execution as `OMNI_REGION` env var, following how `baseBranch` is passed through from CLI to container env.

### Implementation Task 5: Update README with region configuration

- **File to modify:** `README.md`
- **Pattern to follow:** Existing README documentation style (the container mode section added in commit `cfcad27`)
- **Specific changes:** Add a "Region Configuration" section documenting `OMNI_REGION`, `OMNI_BASE_URL` env vars and `--region` flag

---

## Files to Modify

| File | Changes | Pattern Reference |
|------|---------|-------------------|
| `src/container.ts` | Add `RegionConfig` interface, `resolveRegionConfig()`, region-aware error messages, env propagation | `resolveClaudeAuth` (lines 74-89), `resolveGhToken` (lines 91-112), auth errors (lines 168-182), `envLines` push (lines 239-245) |
| `src/cli.ts` | Add `--region` CLI option | Container options (lines 118-121) |
| `package.json` | Add `test` script | Existing scripts section |
| `README.md` | Document region configuration | Existing container mode section |

## Files to Create

| File | Purpose |
|------|---------|
| `src/__tests__/region.test.ts` | Tests for `resolveRegionConfig()` |
| `src/__tests__/region-errors.test.ts` | Tests for region-aware error formatting |
| `src/__tests__/container-env.test.ts` | Tests for region env propagation |

---

## Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Region base URLs are speculative** — we don't know the actual Omni region URLs | Medium | Use `OMNI_BASE_URL` as the primary override, making `OMNI_REGION` shorthand optional. The URL map is easily updated without breaking the interface. |
| **No test framework exists** — adding one introduces maintenance burden | Low | Use Node.js built-in `node:test` (available since Node 18, project requires Node 20+). Zero new dependencies. |
| **This doesn't fix the actual upstream bug** — Omni's MCP server still needs fixing | High | This is explicitly a **defensive/diagnostic** change. It surfaces region info so users and support can identify region-related failures faster. The `--region` flag and `OMNI_BASE_URL` are ready for the upstream fix to consume. Document this clearly in the README. |
| **Breaking change if region config is required** | Low | Region config is entirely optional — `undefined` means default (US) behavior, preserving backward compatibility. Follows the same optionality pattern as `baseBranch` in `src/container.ts:245`. |
| **OAuth token may encode region** — region in env var may conflict with token's embedded region | Low | `OMNI_BASE_URL` is for endpoint routing only, not token validation. If a token carries region info, the upstream server validates it. We just ensure the right endpoint is called. |