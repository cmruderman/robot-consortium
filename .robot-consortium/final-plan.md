The plan is ready for review. Here's the summary:

**The rats were mostly right.** All three city planner proposals over-engineered solutions for the wrong layer. The Cursor MCP OAuth bug lives in the Omni MCP server, not in `robot-consortium`. JWT inspection, `OMNI_BASE_URL`/`OMNI_REGION` env vars, `diagnose-auth` commands, and test infrastructure bootstrapping were all rejected as addressing the wrong system with speculative/invented configuration.

**The plan proposes a minimal, honest change (~15 lines across 2 files):**

1. **`src/container.ts`** — Add one `chalk.dim` hint line to the auth error block: "If using Cursor MCP, restart Cursor after completing OAuth authorization."

2. **`README.md`** — Add a "Known Issues: Cursor MCP OAuth" section documenting the restart requirement, the EU tenant limitation (upstream bug), and the OAuth window behavior.

No new files, no new dependencies, no test infrastructure, no exported private functions. The highest-ROI action is filing an upstream bug against the Omni MCP server — documented as an open question, not a code change here.