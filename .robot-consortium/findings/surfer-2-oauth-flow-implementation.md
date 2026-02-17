Now I have a complete picture of the codebase. Here are the structured findings:

---

## Findings: OAuth Flow Implementation

**Summary**: The robot-consortium codebase does **not** implement an OAuth authorization code flow, token exchange endpoint, or regional routing. It is a meta-orchestration tool that launches Claude agents — it handles OAuth **tokens** (already-issued credentials) but not the OAuth **flow** itself. The real MCP OAuth issue described in the task lives in an external system. Here is every relevant code pattern found:

---

### Pattern: Claude OAuth Token Resolution

**File**: `src/container.ts` (lines 74–89)
**Purpose**: Resolves Claude auth from environment variables or `.env` file, preferring OAuth token over API key.

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

**Relevance**: This is the only OAuth-related logic in the repo — it only reads a pre-issued token; it performs no authorization code exchange, no callback URL handling, and no regional routing.

---

### Pattern: GitHub Token Multi-Tier Fallback

**File**: `src/container.ts` (lines 91–112)
**Purpose**: Resolves GitHub token via env var, `.env` file, then `gh auth token` CLI fallback.

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

**Relevance**: This is the pattern for tiered token resolution — if the fix needs to introduce a regional token source, this is the model to follow.

---

### Pattern: Credential Passing via Secure Env File

**File**: `src/container.ts` (lines 234–248)
**Purpose**: Writes resolved credentials to a `0o600` temp file passed to Docker via `--env-file`, never shell-interpolated.

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
```

**Relevance**: If a `REGION` or `MCP_ENDPOINT` env var needs to flow into the container, this is where to add it — matching the established secure-passing pattern.

---

### Pattern: URL Validation (HTTPS Enforcement)

**File**: `src/container.ts` (lines 39–43)
**Purpose**: Validates that repo URLs use HTTPS before proceeding.

```typescript
const validateRepoUrl = (url: string): void => {
  if (!/^https?:\/\//.test(url)) {
    throw new Error(`Repository URL must use HTTPS: ${url}`);
  }
};
```

**Relevance**: This is the only URL validation in the codebase — no regional URL construction or tenant-routing logic exists here.

---

### Pattern: SSH-to-HTTPS URL Conversion

**File**: `src/container.ts` (lines 114–122)
**Purpose**: Converts `git@github.com:owner/repo.git` SSH URLs to HTTPS format.

```typescript
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

**Relevance**: Shows the only URL transformation pattern in the codebase — there is no analogous function for regional API endpoint construction.

---

### Pattern: Surfer Prompt Template (the template that generated this output)

**File**: `src/agents.ts` (lines 226–264)
**Purpose**: Generates the structured prompt used to instruct Surfer agents to output concrete code patterns.

```typescript
export const buildSurferPrompt = (description: string, focus: string): string => {
  return `You are a Surfer agent in the robot-consortium system. Your job is to explore the codebase and extract CONCRETE CODE PATTERNS — not prose summaries.

TASK DESCRIPTION:
${description}

YOUR FOCUS AREA: ${focus}

INSTRUCTIONS:
1. Search the codebase thoroughly for information relevant to your focus area
2. Find ACTUAL CODE that demonstrates patterns, conventions, and implementations
3. For every pattern you find, include the EXACT code snippet with file path and line numbers
4. Identify how existing code handles: error cases, imports, exports, naming, structure

CRITICAL: You must output STRUCTURED findings, not prose descriptions.
...`;
};
```

**Relevance**: Establishes the output format contract this Surfer must follow.

---

### Pattern: Surfer Phase Orchestration

**File**: `src/phases/surf.ts` (lines 16–61)
**Purpose**: Runs surfer agents in parallel; first surfer always extracts conventions, others explore dynamic focus areas.

```typescript
export const runSurfPhase = async (workingDir: string, phaseOptions: PhaseOptions = {}): Promise<{ success: boolean; questions?: string[] }> => {
  const state = loadState(workingDir);
  updatePhase(workingDir, 'SURF');

  const dynamicFocuses = await analyzeSurferNeeds(workingDir, state.description, phaseOptions.verbose);
  const allFocuses = [CONVENTIONS_FOCUS, ...dynamicFocuses];
  setSurferFocuses(workingDir, allFocuses);

  const surfers = allFocuses.map((focus, i) => createAgentConfig('surfer', i + 1, focus));

  const options = surfers.map((surfer, i) => ({
    workingDir,
    prompt: i === 0
      ? buildConventionsSurferPrompt(state.description)
      : buildSurferPrompt(state.description, surfer.focus!),
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash(git log*)', 'Bash(git show*)'],
  }));

  const results = await runAgentsInParallel(surfers, options, {
    verbose: phaseOptions.verbose,
    phaseName: `SURFERS [${allFocuses.length} agents]`,
    phaseIcon: '🏄',
  });
  // ...
};
```

**Relevance**: Shows how surfer results are saved via `addFinding()` and how code patterns vs. conventions are separated — both feed into the planner phase.

---

## Critical Finding: No OAuth Flow Code Exists in This Repo

The task description references MCP OAuth callback URLs, token exchange endpoints, and regional routing. **None of these exist in `/work/repo`**. The codebase:

- Has no `redirect_uri` construction
- Has no authorization code exchange handler
- Has no tenant/region detection logic
- Has no hardcoded Anthropic endpoint URLs
- Has no MCP server implementation

The OAuth issue described must reside in:
1. The **Claude Code CLI** binary (invoked via `spawn('claude', ...)` at `src/agents.ts:91`)
2. An **MCP server** implementation in a separate repository
3. **Anthropic's backend** OAuth provider configuration

The fix for the described issue should be investigated in whichever external system implements the `/oauth/callback` handler and token exchange — not in this orchestration layer.