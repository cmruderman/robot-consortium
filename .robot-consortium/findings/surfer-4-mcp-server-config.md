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