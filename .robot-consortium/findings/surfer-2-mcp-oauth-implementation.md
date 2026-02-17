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