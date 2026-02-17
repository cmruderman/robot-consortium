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