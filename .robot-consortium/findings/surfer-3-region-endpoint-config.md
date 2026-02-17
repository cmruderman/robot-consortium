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