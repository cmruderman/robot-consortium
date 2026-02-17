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

---

The repository *is* the robot-consortium tool itself — there's no separate target application with MCP OAuth. The task description is the task *given to* this agent system, not a description of what's in the repo. Here are my structured findings based on the actual codebase:

---

## Surfer Findings: `region-endpoint-config`

**Focus Area**: Hardcoded US-specific URLs, regional endpoint configuration, tenant region detection, base URL construction

---

### Pattern: No regional URL configuration found
**File**: `/work/repo/src/container.ts` (lines 1–308)
**Purpose**: Container orchestration module — the only module that constructs external URLs
```typescript
// No regional/tenant URL logic exists anywhere in this file.
// The only URLs constructed are:
// 1. Repository clone URLs (GitHub)
// 2. Docker image names (local)
// There are NO references to: .us., .eu., emea, region, tenant, baseUrl, or MCP endpoints.
```
**Relevance**: This is the primary entry point for external service calls; absence of regional config here confirms the issue is not in robot-consortium itself.

---

### Pattern: OAuth token is a raw credential — no endpoint involved
**File**: `/work/repo/src/container.ts` (lines 74–89)
**Purpose**: Resolves Claude OAuth token from environment — treats it as a credential string only, with no associated endpoint logic
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
**Relevance**: OAuth token resolution here is credential-only; there's no token exchange, no callback URL, no regional endpoint — any MCP OAuth endpoint issue would be in a different system.

---

### Pattern: Environment variable propagation into container — where regional config would live
**File**: `/work/repo/src/container.ts` (lines 239–245)
**Purpose**: Constructs the env file passed into the Docker container — the mechanism by which configuration reaches the inner agent
```typescript
const envLines = [
    `${claudeAuth.envVar}=${claudeAuth.value}`,
    `GH_TOKEN=${ghToken}`,
    'CLAUDE_CODE_ACCEPT_TOS=yes',
    `REPO_URL=${repoUrl}`,
];
if (baseBranch) envLines.push(`CLONE_BRANCH=${baseBranch}`);
```
**Relevance**: If a regional endpoint needed to be injected (e.g. `ANTHROPIC_BASE_URL`, `MCP_OAUTH_ENDPOINT`), this is the pattern to follow — add a new env var line here.

---

### Pattern: URL validation — HTTPS-only, no regional awareness
**File**: `/work/repo/src/container.ts` (lines 39–43, 114–122)
**Purpose**: URL validation and SSH→HTTPS conversion — region-agnostic
```typescript
const validateRepoUrl = (url: string): void => {
  if (!/^https?:\/\//.test(url)) {
    throw new Error(`Repository URL must use HTTPS: ${url}`);
  }
};

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
**Relevance**: URL construction pattern — a regional base URL switch would follow a similar conditional-replacement approach.

---

### Pattern: GitHub URL pattern matching — only hardcoded domain is `github.com`
**File**: `/work/repo/src/cli.ts` (lines 57–68)
**Purpose**: Parses GitHub issue URLs — only `github.com` is hardcoded, not any service-specific region
```typescript
if (issueRef.includes('github.com')) {
  // Full URL: https://github.com/owner/repo/issues/123
  const match = issueRef.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (!match) {
    throw new Error(`Invalid GitHub issue URL: ${issueRef}`);
  }
  const [, owner, repo, number] = match;
  ghCommand = `gh issue view ${number} --repo ${owner}/${repo} --json title,body,labels,comments`;
} else {
  // Just an issue number - use current repo
  ghCommand = `gh issue view ${issueRef} --json title,body,labels,comments`;
}
```
**Relevance**: The only hardcoded domain in the entire codebase is `github.com` — no MCP or Anthropic regional URLs are present.

---

### Pattern: ConsortiumState type — no region/tenant field exists
**File**: `/work/repo/src/types.ts` (lines 49–76)
**Purpose**: Central state type — defines all fields tracked across the pipeline
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
**Relevance**: No `region`, `tenant`, `baseUrl`, or `endpoint` fields exist — adding tenant-aware routing would require new fields here.

---

## Summary Finding

**The robot-consortium repository contains NO hardcoded regional URLs, no MCP OAuth endpoint logic, no tenant detection, and no regional base URL construction.** The codebase is a CI orchestration tool that:

1. Passes a raw `CLAUDE_CODE_OAUTH_TOKEN` (already-exchanged credential) into a Docker container
2. Has no code that performs OAuth token exchange, callback handling, or redirect URI construction
3. Has no concept of US/EU/EMEA regions

**Implication for the task**: The MCP OAuth regional bug described in the task description lives in a **different system** — likely the MCP server implementation, the Anthropic OAuth service, or the Cursor/Claude client integration that this tool orchestrates work *against*. This robot-consortium codebase is the **agent runner**, not the **target application**.

If the intent is to add region-aware configuration to robot-consortium (so it can pass the correct regional endpoint to agents), the insertion points would be:
- `ContainerOptions` interface (`container.ts:8–19`) — add a `region?: string` field
- `envLines` array (`container.ts:239–245`) — inject `ANTHROPIC_BASE_URL` based on region
- `ConsortiumState` (`types.ts:49–76`) — add a `region?: string` field to persist it

---

Based on my thorough exploration of the codebase, here are the structured findings relevant to MCP server configuration in this repository:

---

### Pattern: Claude OAuth Token Resolution
**File**: `src/container.ts` (lines 74-89)
**Purpose**: Resolves Claude Code authentication credentials from environment variables, preferring OAuth token over API key.

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

**Relevance**: This is the only OAuth-related code in the repo — it handles Claude Code auth, not MCP server OAuth. Any MCP OAuth fix would need to follow this env-var-first pattern.

---

## Critical Finding: MCP Server Config Not Present

This repository (`/work/repo`) is the **robot-consortium agent orchestration CLI** — it does **not** contain MCP server configuration, OAuth callback URLs, SSE/streamable HTTP transport, or regional endpoint routing. Specifically absent:

| Expected Component | Present? |
|---|---|
| MCP server manifest / capability declarations | No |
| OAuth callback URL configuration | No |
| Token exchange endpoint | No |
| SSE or streamable HTTP transport | No |
| Region/tenant URL routing (US vs EU/EMEA) | No |
| Hardcoded `*.us.*` or regional endpoints | No |

The only URLs in the codebase are GitHub issue/repo references in `src/cli.ts:59` and `README.md`.

---

## Recommendation for the Task

The code implementing MCP OAuth and regional endpoints **is not in this repository**. To fix MCP OAuth for non-US tenants, the investigation needs to be pointed at the correct repository — likely:

1. The Claude Code server-side implementation
2. An MCP-specific backend service
3. A separate oauth/auth service repository

If there is a different repo path on this machine, I can search there instead. Alternatively, if this repo is expected to *configure* MCP connections (e.g., via a config file or manifest that gets deployed), please point me to the specific config files and I'll extract the patterns from those.