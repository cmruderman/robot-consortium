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