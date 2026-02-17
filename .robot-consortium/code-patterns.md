Based on my thorough exploration of the codebase, here are the structured findings for the MCP OAuth focus area:

---

## MCP OAuth Implementation Findings

> **Note**: This repository (`robot-consortium`) is a CLI orchestration tool for Claude Code agents. It does **not** contain an MCP server implementation — it is a *consumer* of Claude/Anthropic auth. No MCP server endpoints, OAuth callback handlers, or redirect URI logic exist in this codebase. The issue described (Cursor MCP OAuth failing for non-US tenants) would live upstream in the Omni/Anthropic MCP server infrastructure.

The patterns below are what *does* exist related to OAuth and auth:

---

### Pattern: OAuth Token Resolution with API Key Fallback
**File**: `src/container.ts` (lines 74–89)
**Purpose**: Resolves Claude auth credentials, preferring OAuth token over API key
```typescript
interface ClaudeAuth {
  envVar: 'CLAUDE_CODE_OAUTH_TOKEN' | 'ANTHROPIC_API_KEY';
  value: string;
}

const resolveClaudeAuth = (envVars: Record<string, string>): ClaudeAuth | undefined => {
  // Prefer OAuth token (Max/Pro plan — no API billing)
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || envVars.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauthToken) return { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', value: oauthToken };

  // Fall back to API key (pay-per-use)
  const apiKey = process.env.ANTHROPIC_API_KEY || envVars.ANTHROPIC_API_KEY;
  if (apiKey) return { envVar: 'ANTHROPIC_API_KEY', value: apiKey };

  return undefined;
};
```
**Relevance**: Shows the auth credential resolution pattern used when launching agents — this is the same `CLAUDE_CODE_OAUTH_TOKEN` that Cursor MCP OAuth would produce.

---

### Pattern: Credential Validation with User-Facing Error Messages
**File**: `src/container.ts` (lines 168–182)
**Purpose**: Validates auth credentials before execution and surfaces actionable error messages
```typescript
  const claudeAuth = resolveClaudeAuth(envVars);
  if (!claudeAuth) {
    console.log(chalk.red('  ✗ Claude authentication not found'));
    console.log(chalk.dim('  Set CLAUDE_CODE_OAUTH_TOKEN (Max/Pro plan) or ANTHROPIC_API_KEY (API billing)'));
    console.log(chalk.dim('  in your environment or .env file. Run "claude setup-token" to generate an OAuth token.'));
    return 1;
  }

  const ghToken = resolveGhToken(envVars);
  if (!ghToken) {
    console.log(chalk.red('  ✗ GitHub token not found'));
    console.log(chalk.dim('  Run "gh auth login" or set GH_TOKEN in your environment / .env file'));
    return 1;
  }
```
**Relevance**: Pattern for surfacing auth failures clearly — relevant if adding region-aware error messages for EU tenant OAuth failures.

---

### Pattern: Secure Credential Passing via Temp File (not CLI args)
**File**: `src/container.ts` (lines 234–259)
**Purpose**: Writes credentials to a `0o600` temp file and passes via `--env-file` to avoid process table exposure
```typescript
  const tmpId = `${Date.now()}-${process.pid}`;
  const envFile = path.join(os.tmpdir(), `rc-container-${tmpId}.env`);
  const descFile = path.join(os.tmpdir(), `rc-description-${tmpId}.md`);

  const envLines = [
    `${claudeAuth.envVar}=${claudeAuth.value}`,
    `GH_TOKEN=${ghToken}`,
    'CLAUDE_CODE_ACCEPT_TOS=yes',
    `REPO_URL=${repoUrl}`,
  ];
  if (baseBranch) envLines.push(`CLONE_BRANCH=${baseBranch}`);

  fs.writeFileSync(envFile, envLines.join('\n'), { mode: 0o600 });
  fs.writeFileSync(descFile, description, { mode: 0o644 });

  const dockerArgs: string[] = [
    'run',
    '--rm',
    '--env-file', envFile,
    '-v', `${descFile}:/work/description.md:ro`,
    '--entrypoint', '/bin/bash',
    imageName,
    '-c', innerScript,
  ];
```
**Relevance**: Established security pattern for token handling — any OAuth token from Cursor MCP should follow this same approach when passed into container contexts.

---

### Pattern: Credential Cleanup on Exit/Signal
**File**: `src/container.ts` (lines 269–278)
**Purpose**: Ensures temp credential files are deleted after use or on SIGINT/SIGTERM
```typescript
    const cleanup = () => {
      try { fs.unlinkSync(envFile); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error(chalk.yellow(`  ⚠ Could not delete credentials file: ${envFile}`));
        }
      }
      try { fs.unlinkSync(descFile); } catch {}
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    };
```
**Relevance**: Any OAuth token handling added for MCP should follow this cleanup pattern.

---

### Pattern: GitHub Token Resolution with gh CLI Fallback
**File**: `src/container.ts` (lines 91–112)
**Purpose**: Multi-source token resolution: env var → .env file → gh CLI
```typescript
const resolveGhToken = (envVars: Record<string, string>): string | undefined => {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (envVars.GH_TOKEN) return envVars.GH_TOKEN;
  if (envVars.GITHUB_TOKEN) return envVars.GITHUB_TOKEN;

  try {
    const token = execSync('gh auth token', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (token) return token;
  } catch {
    // gh CLI not installed or not authenticated
  }

  return undefined;
};
```
**Relevance**: Reusable resolution pattern — if MCP OAuth tokens need a fallback chain (e.g., env var → stored token file → OAuth prompt), this is the model to follow.

---

### Pattern: Container CLI Options
**File**: `src/cli.ts` (lines 118–121)
**Purpose**: Exposes container-mode flags including repo URL and base branch
```typescript
  .option('--container', 'Run the entire pipeline inside a Docker container with a fresh repo clone')
  .option('--repo <url>', 'Repository URL to clone inside the container (also settable as REPO_URL in .env)')
  .option('--base-branch <branch>', 'Branch to checkout before starting inside the container')
  .option('--container-image <name>', 'Docker image name (default: robot-consortium)')
```
**Relevance**: If adding a `--region` or `--tenant` flag to route OAuth to the correct endpoint for EU customers, this is where it would be added.

---

## Key Gap: No MCP Server Code in This Repo

The Cursor MCP OAuth issue (especially the EU/non-US tenant routing failure) **cannot be fixed in this repository**. This repo:
- Has no MCP server endpoints
- Has no OAuth callback handler or redirect URI logic
- Has no region/tenant routing

The fix needs to happen in the Omni MCP server infrastructure — specifically, ensuring the OAuth authorization server correctly handles redirect callbacks for EU-hosted tenants, and that the `authorization_endpoint` / `token_endpoint` URLs returned in the OAuth metadata are region-correct.

---

Based on the thorough exploration of the codebase, here are my structured findings for the **multi-tenant-region-config** focus area:

---

## Surfer Findings: multi-tenant-region-config

**Critical Context**: This Robot Consortium repository is a CLI orchestration tool — it does NOT contain the MCP OAuth server or tenant configuration being investigated. The issue lives in an external Omni/exploreomni service.

---

### Pattern: OAuth Token Environment Variable Resolution

**File**: `/work/repo/src/container.ts` (lines 74-89)
**Purpose**: Resolves Claude OAuth token from environment or `.env` file, with no region awareness.

```typescript
interface ClaudeAuth {
  envVar: 'CLAUDE_CODE_OAUTH_TOKEN' | 'ANTHROPIC_API_KEY';
  value: string;
}

const resolveClaudeAuth = (envVars: Record<string, string>): ClaudeAuth | undefined => {
  // Prefer OAuth token (Max/Pro plan — no API billing)
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || envVars.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauthToken) return { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', value: oauthToken };

  // Fall back to API key (pay-per-use)
  const apiKey = process.env.ANTHROPIC_API_KEY || envVars.ANTHROPIC_API_KEY;
  if (apiKey) return { envVar: 'ANTHROPIC_API_KEY', value: apiKey };

  return undefined;
};
```

**Relevance**: This is the only auth resolution in the repo — it has no tenant/region parameter, meaning the same token is used regardless of region. If the external MCP server issues region-scoped tokens, this pattern would need a region discriminator.

---

### Pattern: `.env` File Loading (No Region Key Handling)

**File**: `/work/repo/src/container.ts` (lines 45-72)
**Purpose**: Loads key-value pairs from a `.env` file; region-specific keys (e.g., `OMNI_REGION`, `TENANT_REGION`) are not defined or parsed here.

```typescript
const loadEnvFile = (workingDir: string): Record<string, string> => {
  let content: string;
  try {
    content = fs.readFileSync(path.join(workingDir, '.env'), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.log(chalk.yellow(`  ⚠ Found .env but could not read it: ${(err as Error).message}`));
    }
    return {};
  }

  const vars: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
};
```

**Relevance**: This generic env loader would be the correct integration point to add a `OMNI_REGION` or `OMNI_BASE_URL` variable — the fix in the external system likely needs a similar loader that selects region-specific base URLs.

---

### Pattern: HTTPS URL Validation and SSH-to-HTTPS Conversion

**File**: `/work/repo/src/container.ts` (lines 39-43 and 114-122)
**Purpose**: Validates and normalizes repository URLs — demonstrates URL construction pattern used in this project.

```typescript
// URL validation (lines 39-43)
const validateRepoUrl = (url: string): void => {
  if (!/^https?:\/\//.test(url)) {
    throw new Error(`Repository URL must use HTTPS: ${url}`);
  }
};

// SSH to HTTPS conversion (lines 114-122)
export const convertToHttpsUrl = (url: string): string => {
  // git@github.com:owner/repo.git -> https://github.com/owner/repo.git
  const sshMatch = url.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    const [, host, pathPart] = sshMatch;
    return `https://${host}/${pathPart}`;
  }
  return url;
};
```

**Relevance**: Shows the convention for URL construction in this codebase — the MCP OAuth fix would follow a similar pattern to dynamically construct region-specific base URLs (e.g., `https://eu.omni.co` vs `https://app.omni.co`).

---

### Pattern: Environment Variable Propagation into Container

**File**: `/work/repo/src/container.ts` (lines 239-245)
**Purpose**: Builds the set of env vars passed into the Docker container — the region or tenant base URL would need to be included here for downstream tools to use.

```typescript
  const envLines = [
    `${claudeAuth.envVar}=${claudeAuth.value}`,
    `GH_TOKEN=${ghToken}`,
    'CLAUDE_CODE_ACCEPT_TOS=yes',
    `REPO_URL=${repoUrl}`,
  ];
  if (baseBranch) envLines.push(`CLONE_BRANCH=${baseBranch}`);
```

**Relevance**: This is the exact pattern to follow when propagating a new `OMNI_BASE_URL` or `OMNI_REGION` environment variable into execution context — append it to `envLines` after resolving it from `.env` or process env.

---

### Pattern: Auth Error Messaging (No Region Context)

**File**: `/work/repo/src/container.ts` (lines 170-175)
**Purpose**: Surfaces auth failure to the user with diagnostic instructions — currently region-unaware.

```typescript
  const claudeAuth = resolveClaudeAuth(envVars);
  if (!claudeAuth) {
    console.log(chalk.red('  ✗ Claude authentication not found'));
    console.log(chalk.dim('  Set CLAUDE_CODE_OAUTH_TOKEN (Max/Pro plan) or ANTHROPIC_API_KEY (API billing)'));
    console.log(chalk.dim('  in your environment or .env file. Run "claude setup-token" to generate an OAuth token.'));
    return 1;
  }
```

**Relevance**: If the external Omni MCP OAuth issue is that EU/EMEA tenants get a US-region token or redirect URI, error messages like this (on the Omni side) should tell users which region was detected, so they can identify misconfiguration.

---

### Negative Finding: No Tenant/Region Configuration Exists in This Repo

**File**: `/work/repo/` (entire repo)
**Purpose**: Documents absence of region-aware patterns.

```
Searched for: "region", "tenant", "baseUrl", "base_url", "EU", "EMEA", 
              "us.", ".us.", "host", "domain", "oauth", "OAuth", 
              "redirect_uri", "callback", "authorization_url",
              "mcp", "MCP", "mcpServer", "mcp_server"

Files searched:
  /work/repo/src/container.ts
  /work/repo/src/agents.ts
  /work/repo/src/cli.ts
  /work/repo/src/github.ts
  /work/repo/Dockerfile
  /work/repo/README.md
  /work/repo/.robot-consortium/state.json

Result: ZERO matches for region, tenant, EU/EMEA, base URL construction,
        OAuth callback URLs, or MCP server configuration.
```

**Relevance**: The actual MCP OAuth region bug lives in the **external Omni/exploreomni service** (referenced in the PR `https://github.com/exploreomni/mintlify-omni/pull/623`). The fix must be applied there — specifically wherever the OAuth `redirect_uri` or token exchange endpoint URL is hardcoded to a US-only domain instead of being derived from the tenant's configured region.

---

## Key Conclusion for Implementation

The Robot Consortium repo has no region/tenant code to fix. The bug reported — "only US hosted customers seem to work for MCP, the other regions are broken" — points to the **Omni MCP server** having a **hardcoded US base URL** for OAuth. The fix pattern (based on conventions found here) would be:

1. Resolve region from a config key (e.g., `OMNI_REGION` env var)
2. Construct `baseUrl` dynamically: `https://${region}.omni.co` or similar
3. Use `baseUrl` in `redirect_uri` and token endpoint construction
4. Propagate via env vars following the `envLines` push pattern above

---

Based on my exploration of the codebase, here are the structured findings for the **auth-token-lifecycle** focus area:

---

### Pattern: OAuth Token Resolution with Fallback Priority
**File**: `src/container.ts` (lines 74-89)
**Purpose**: Resolves Claude auth by preferring OAuth token over API key, checking process env before .env file
```typescript
interface ClaudeAuth {
  envVar: 'CLAUDE_CODE_OAUTH_TOKEN' | 'ANTHROPIC_API_KEY';
  value: string;
}

const resolveClaudeAuth = (envVars: Record<string, string>): ClaudeAuth | undefined => {
  // Prefer OAuth token (Max/Pro plan — no API billing)
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || envVars.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauthToken) return { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', value: oauthToken };

  // Fall back to API key (pay-per-use)
  const apiKey = process.env.ANTHROPIC_API_KEY || envVars.ANTHROPIC_API_KEY;
  if (apiKey) return { envVar: 'ANTHROPIC_API_KEY', value: apiKey };

  return undefined;
};
```
**Relevance**: Token resolution happens at startup with no refresh — directly relevant to why a Cursor restart is needed to pick up a newly-granted OAuth token.

---

### Pattern: Multi-Source GitHub Token Fallback Chain
**File**: `src/container.ts` (lines 91-112)
**Purpose**: Resolves GH token via env vars, then .env file, then `gh auth token` CLI call
```typescript
const resolveGhToken = (envVars: Record<string, string>): string | undefined => {
  // 1. Environment variables
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

  // 2. .env file
  if (envVars.GH_TOKEN) return envVars.GH_TOKEN;
  if (envVars.GITHUB_TOKEN) return envVars.GITHUB_TOKEN;

  // 3. gh CLI auth
  try {
    const token = execSync('gh auth token', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (token) return token;
  } catch {
    // gh CLI not installed or not authenticated
  }

  return undefined;
};
```
**Relevance**: Pattern shows tokens are resolved once at process start — no live refresh, so any post-auth token storage requires restart to be picked up.

---

### Pattern: Temporary Credential File with Restricted Permissions
**File**: `src/container.ts` (lines 234-259)
**Purpose**: Writes OAuth token to a temp env file (mode 0o600) and injects it into Docker via `--env-file`
```typescript
const tmpId = `${Date.now()}-${process.pid}`;
const envFile = path.join(os.tmpdir(), `rc-container-${tmpId}.env`);
const descFile = path.join(os.tmpdir(), `rc-description-${tmpId}.md`);

const envLines = [
  `${claudeAuth.envVar}=${claudeAuth.value}`,
  `GH_TOKEN=${ghToken}`,
  'CLAUDE_CODE_ACCEPT_TOS=yes',
  `REPO_URL=${repoUrl}`,
];
if (baseBranch) envLines.push(`CLONE_BRANCH=${baseBranch}`);

fs.writeFileSync(envFile, envLines.join('\n'), { mode: 0o600 });
fs.writeFileSync(descFile, description, { mode: 0o644 });

// ...
const dockerArgs: string[] = [
  'run',
  '--rm',
  '--env-file', envFile,
  '-v', `${descFile}:/work/description.md:ro`,
  '--entrypoint', '/bin/bash',
  imageName,
  '-c', innerScript,
];
```
**Relevance**: Credentials are baked into a temp file at invocation time; there is no mechanism to update them mid-session after an OAuth callback completes.

---

### Pattern: Credential Cleanup on Process Exit
**File**: `src/container.ts` (lines 269-278)
**Purpose**: Deletes temp credential files on normal exit and on SIGINT/SIGTERM
```typescript
const cleanup = () => {
  try { fs.unlinkSync(envFile); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(chalk.yellow(`  ⚠ Could not delete credentials file: ${envFile}`));
    }
  }
  try { fs.unlinkSync(descFile); } catch {}
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
};
```
**Relevance**: Once cleaned up, there is no cached token state — next run starts fresh, which is consistent with the observed "restart fixes it" behavior.

---

### Pattern: Session State Persistence to JSON
**File**: `src/state.ts` (lines 50-74)
**Purpose**: Loads and saves consortium execution state to `.robot-consortium/state.json` across CLI invocations
```typescript
export const loadState = (workingDir: string): ConsortiumState | null => {
  const statePath = getStatePath(workingDir);
  if (!fs.existsSync(statePath)) {
    return null;
  }
  const content = fs.readFileSync(statePath, 'utf-8');
  return JSON.parse(content) as ConsortiumState;
};

export const saveState = (workingDir: string, state: ConsortiumState): void => {
  const statePath = getStatePath(workingDir);
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
};
```
**Relevance**: Session state IS persisted between restarts, but OAuth token state is NOT part of this — so a restarted Cursor picks up newly-stored tokens while re-using the session state cleanly.

---

### Pattern: Auth Validation with User-Facing Error on Missing Token
**File**: `src/container.ts` (lines 169-182)
**Purpose**: Exits early with actionable error messages if Claude OAuth token or GH token cannot be resolved
```typescript
const claudeAuth = resolveClaudeAuth(envVars);
if (!claudeAuth) {
  console.log(chalk.red('  ✗ Claude authentication not found'));
  console.log(chalk.dim('  Set CLAUDE_CODE_OAUTH_TOKEN (Max/Pro plan) or ANTHROPIC_API_KEY (API billing)'));
  console.log(chalk.dim('  in your environment or .env file. Run "claude setup-token" to generate an OAuth token.'));
  return 1;
}

const ghToken = resolveGhToken(envVars);
if (!ghToken) {
  console.log(chalk.red('  ✗ GitHub token not found'));
  console.log(chalk.dim('  Run "gh auth login" or set GH_TOKEN in your environment / .env file'));
  return 1;
}
```
**Relevance**: No token caching or retry — resolution failure is terminal, which means any mid-session OAuth grant is invisible until the process restarts.

---

### Pattern: Session Phase Guard on Restart
**File**: `src/cli.ts` (lines 155-162)
**Purpose**: Detects existing active session on `start` command and blocks overwrite; directs to `resume`
```typescript
const existing = loadState(workingDir);
if (existing && existing.phase !== 'DONE' && existing.phase !== 'FAILED') {
  console.log(chalk.yellow(`\n⚠️  Active consortium found (phase: ${existing.phase})`));
  console.log(chalk.dim(`   Use "robot-consortium resume" to continue`));
  console.log(chalk.dim(`   Or delete .robot-consortium/ to start fresh\n`));
  process.exit(1);
}
```
**Relevance**: State is decoupled from token resolution — a restart cleanly re-reads both persisted session state and freshly-stored OAuth tokens, explaining why restart resolves the Cursor MCP auth issue.

---

### Pattern: ConsortiumState Schema — No Token Fields
**File**: `src/types.ts` (lines 49-76)
**Purpose**: Full state schema definition — notably absent any token/credential fields
```typescript
export interface ConsortiumState {
  id: string;
  description: string;
  phase: Phase;
  createdAt: string;
  updatedAt: string;
  workingDirectory: string;
  tasks: Task[];
  questions: {
    pending: Question[];
    answered: Question[];
  };
  costs: CostEntry[];
  findings: string[];
  plans: string[];
  critiques: string[];
  reviews: string[];
  finalPlan?: string;
  prUrl?: string;
  prNumber?: number;
  ciCheckAttempts?: number;
  branchName?: string;
  surferFocuses?: string[];
  plannerPerspectives?: string[];
  ratFocuses?: string[];
  conventions?: string;
  codePatterns?: string;
}
```
**Relevance**: Tokens are intentionally NOT persisted in state — they are resolved fresh from env/file on each startup. This is the architectural root of the "restart required" behavior: no in-memory token cache, no refresh hook, no callback-triggered re-resolution.

---

## Key Findings Summary

**Root cause of restart requirement**: Token resolution (`resolveClaudeAuth`, `resolveGhToken`) runs **once at process startup** from environment variables and `.env` file. There is **no mechanism** to re-read or refresh tokens after an OAuth callback completes mid-session. When Cursor's MCP OAuth flow grants a token and writes it to disk/env, the running Cursor process never sees it — only a fresh restart picks up the new value.

**No token refresh logic exists** in this codebase. No expiration handling, no refresh token exchange, no callback-triggered re-resolution.

**State persistence is decoupled from token storage** — `ConsortiumState` has no credential fields, so restarts cleanly re-read both the persisted workflow state and newly-available OAuth tokens simultaneously.