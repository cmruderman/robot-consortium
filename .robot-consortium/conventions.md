---

# Project Conventions

## Testing

No test framework or test files found in the repository. There is no `test` script in `package.json`. The project has no dedicated test suite.

- No `test` script in `package.json`
- No test files found (no `*.test.ts`, `*.spec.ts`, or `__tests__/` directories)

**Note:** The pipeline itself (Robot Consortium) references per-task verification using the relevant tests after implementation, but the repo itself has no tests.

## Linting & Formatting

- **Lint command:** `npm run lint` → runs `tsc --noEmit` (TypeScript type-checking only)
- No ESLint config found (`.eslintrc` does not exist)
- No Prettier config found (`.prettierrc` does not exist)
- No `.editorconfig` found

Type-checking via TypeScript is the only linting mechanism.

## Code Style

From `tsconfig.json`:
- **Target:** `ES2022`
- **Module system:** `NodeNext` (ESM — `"type": "module"` in `package.json`)
- **Module resolution:** `NodeNext`
- **Strict mode:** `true` (all strict TypeScript checks enabled)
- **`esModuleInterop`:** `true`
- **`forceConsistentCasingInFileNames`:** `true`
- **`declaration`:** `true` (generates `.d.ts` files)
- **`resolveJsonModule`:** `true`
- Source files in `src/`, compiled output in `dist/`
- File imports must use `.js` extensions (NodeNext ESM requirement)

Language: **TypeScript** throughout. No JavaScript files in `src/`.

## Build & Compilation

```bash
npm run build    # tsc — compile TypeScript to dist/
npm run dev      # tsc --watch — watch mode
npm run start    # node dist/cli.js — run compiled output
npm run lint     # tsc --noEmit — type-check only
```

Build prerequisites:
```bash
npm install
npm run build
npm link
```

Requires **Node.js >= 20.0.0**.

## Git Workflow

No explicit git workflow conventions found in config files. From README context:
- The tool itself creates branches and PRs via `gh` CLI
- Default branch: `main`

Current branch naming convention observed: `feat/fix-mcp-oauth-for-non-us-tenants-only-us-robot-consortium`

## Project-Specific Rules

- **Package name:** `robot-consortium` (also aliased as `rc`)
- **Dependencies:** `chalk` (terminal color), `commander` (CLI parsing), `log-update` (live terminal updates)
- **Dev dependencies:** `@types/node`, `typescript`
- **No CLAUDE.md** exists at any level — no project-specific agent instructions
- **No `.claude/commands/`** directory exists
- State is stored in `.robot-consortium/` in the working directory
- The project is a **multi-agent orchestration CLI** — it invokes Claude Code subagents

## Slash Commands / Skills

No `.claude/commands/` directory found. No custom slash commands defined.

---

**Summary for implementers:** This is a TypeScript ESM project with strict mode. Use `.js` extensions in imports, target ES2022 APIs, and run `npm run build` to compile. The only automated check is `npm run lint` (TypeScript type-checking). No test suite exists to run. No formatter is configured.