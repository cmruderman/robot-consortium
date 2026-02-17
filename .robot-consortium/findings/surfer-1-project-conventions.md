# Project Conventions

## Testing
No conventions found for this area. No test framework, test scripts, or test file patterns are configured in `package.json` or any config files.

## Linting & Formatting
- **Lint command:** `npm run lint` → runs `tsc --noEmit` (TypeScript type-checking only, no dedicated linter like ESLint or Prettier configured)
- No `.eslintrc`, `.prettierrc`, or `.editorconfig` found

## Code Style
From `tsconfig.json`:
- **Target:** `ES2022`
- **Module system:** `NodeNext` (ESM with `.js` extensions required in imports)
- **Module resolution:** `NodeNext`
- **Strict mode:** `true` (all strict TypeScript checks enabled)
- **esModuleInterop:** `true`
- **forceConsistentCasingInFileNames:** `true`
- **resolveJsonModule:** `true`
- Source files must live under `src/`
- Output goes to `dist/`

From `package.json`:
- **`"type": "module"`** — project uses ES Modules throughout
- Node.js >= 20.0.0 required

## Build & Compilation
- **Build command:** `npm run build` → `tsc`
- **Watch mode:** `npm run dev` → `tsc --watch`
- **Run after build:** `npm run start` → `node dist/cli.js`
- CLI is exposed as `robot-consortium` and `rc` binaries pointing to `./dist/cli.js`

## Git Workflow
No conventions found for this area. No CLAUDE.md or git workflow rules present.

## Project-Specific Rules
- No `CLAUDE.md` exists at project root, `.claude/`, or user-level
- Project is a **multi-agent orchestration CLI for Claude Code** named `robot-consortium`
- Dependencies: `chalk` (terminal colors), `commander` (CLI framework), `log-update` (live terminal updates)

## Slash Commands / Skills
No `.claude/commands/` files found at project or user level.