import { spawn } from 'child_process';
import { AgentConfig, AgentRole, AGENT_MODELS, Model } from './types.js';
import { PhaseDisplay, formatElapsed } from './display.js';
import chalk from 'chalk';

const extractSummary = (output: string): string => {
  // Try to find a meaningful first line from the output for a completion summary
  const lines = output.trim().split('\n');
  for (const line of lines) {
    // Skip pure markdown headers (e.g. "# Findings"), separators, and code fences
    if (/^#+\s*\S+$/.test(line.trim())) continue;
    if (line.trim().startsWith('---') || line.trim().startsWith('```')) continue;

    const cleaned = line.replace(/^#+\s*/, '').trim();
    if (cleaned && cleaned.length > 10) {
      return cleaned.length > 80 ? cleaned.slice(0, 77) + '...' : cleaned;
    }
  }
  return '';
};

export interface AgentResult {
  success: boolean;
  output: string;
  error?: string;
  tokensUsed?: number;
}

export interface AgentOptions {
  workingDir: string;
  prompt: string;
  systemPrompt?: string;
  allowedTools?: string[];
  outputFile?: string;
  verbose?: boolean;
  quiet?: boolean;
  display?: PhaseDisplay;
}

const MODEL_MAP: Record<Model, string> = {
  opus: 'opus',
  sonnet: 'sonnet',
  haiku: 'haiku',
};

export const createAgentConfig = (role: AgentRole, index: number, focus?: string): AgentConfig => {
  return {
    role,
    model: AGENT_MODELS[role],
    id: `${role}-${index}`,
    focus,
  };
};

export const runAgent = async (
  agent: AgentConfig,
  options: AgentOptions
): Promise<AgentResult> => {
  const { workingDir, prompt, systemPrompt, allowedTools, verbose, quiet, display } = options;

  const args: string[] = [
    '--print',
    '--model', MODEL_MAP[agent.model],
    '--output-format', 'text',
    '--dangerously-skip-permissions',
  ];

  if (systemPrompt) {
    args.push('--system-prompt', systemPrompt);
  }

  if (allowedTools && allowedTools.length > 0) {
    args.push('--allowedTools', allowedTools.join(','));
  }

  const startTime = Date.now();
  const focusLabel = agent.focus ? ` (${agent.focus.split(':')[0].trim()})` : '';

  // When using a display, the display handles all status rendering.
  // When not using a display (solo agent like Robot King), use console.log.
  if (!display && !quiet) {
    console.log(chalk.dim(`  [${agent.id}]${focusLabel} Starting (${agent.model})...`));
  }

  return new Promise((resolve) => {
    let output = '';
    let errorOutput = '';
    let lastProgressUpdate = Date.now();
    const PROGRESS_INTERVAL = 15000;

    const proc = spawn('claude', args, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Progress update interval — only for solo agents (display handles its own timing)
    const progressInterval = !display && !quiet
      ? setInterval(() => {
          const elapsed = Date.now() - startTime;
          const now = Date.now();
          if (now - lastProgressUpdate >= PROGRESS_INTERVAL) {
            console.log(chalk.dim(`  [${agent.id}]${focusLabel} Still working... (${formatElapsed(elapsed)})`));
            lastProgressUpdate = now;
          }
        }, PROGRESS_INTERVAL)
      : null;

    // Write prompt to stdin and close it
    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;

      if (verbose && !display && !quiet) {
        const lines = text.split('\n');
        lines.forEach((line: string, i: number) => {
          if (i === lines.length - 1 && line === '') return;
          console.log(chalk.dim(`  [${agent.id}] `) + line);
        });
        lastProgressUpdate = Date.now();
      }
    });

    proc.stderr.on('data', (data) => {
      errorOutput += data.toString();
      if (verbose && !display && !quiet) {
        console.log(chalk.yellow(`  [${agent.id}] `) + data.toString().trim());
      }
    });

    proc.on('close', (code) => {
      if (progressInterval) clearInterval(progressInterval);
      const elapsed = Date.now() - startTime;

      if (code === 0) {
        const summary = extractSummary(output);
        if (display) {
          display.markDone(agent.id, summary);
        } else if (!quiet) {
          const summaryText = summary ? ` — ${summary}` : '';
          console.log(chalk.green(`  [${agent.id}]${focusLabel} Completed (${formatElapsed(elapsed)})${summaryText}`));
        }
        resolve({
          success: true,
          output: output.trim(),
        });
      } else {
        if (display) {
          display.markFailed(agent.id, errorOutput || `exit code ${code}`);
        } else if (!quiet) {
          console.log(chalk.red(`  [${agent.id}]${focusLabel} Failed (exit code ${code}, ${formatElapsed(elapsed)})`));
        }
        resolve({
          success: false,
          output: output.trim(),
          error: errorOutput || `Process exited with code ${code}`,
        });
      }
    });

    proc.on('error', (err) => {
      if (progressInterval) clearInterval(progressInterval);
      if (display) {
        display.markFailed(agent.id, err.message);
      } else if (!quiet) {
        console.log(chalk.red(`  [${agent.id}] Error: ${err.message}`));
      }
      resolve({
        success: false,
        output: '',
        error: err.message,
      });
    });
  });
};

export interface ParallelOptions {
  verbose?: boolean;
  phaseName?: string;
  phaseIcon?: string;
}

export const runAgentsInParallel = async (
  agents: AgentConfig[],
  optionsPerAgent: AgentOptions[],
  parallelOpts: ParallelOptions = {}
): Promise<AgentResult[]> => {
  if (agents.length !== optionsPerAgent.length) {
    throw new Error('Agents and options arrays must have the same length');
  }

  const { verbose, phaseName, phaseIcon } = parallelOpts;

  // Create a display if we have a phase name (otherwise fall back to plain logging)
  const display = phaseName
    ? new PhaseDisplay(phaseName, phaseIcon ?? '>', verbose)
    : null;

  if (display) {
    // Register all agents before starting
    for (const agent of agents) {
      const focus = agent.focus ?? agent.role;
      display.registerAgent(agent.id, focus, agent.model);
    }
    display.start();
  }

  const optionsWithContext = optionsPerAgent.map((opt) => ({
    ...opt,
    verbose: verbose ?? opt.verbose,
    display: display ?? undefined,
  }));

  const promises = agents.map((agent, i) => runAgent(agent, optionsWithContext[i]));
  const results = await Promise.all(promises);

  if (display) {
    display.stop();
  }

  return results;
};

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

OUTPUT FORMAT:
Use this exact structure for each finding:

### Pattern: [descriptive name]
**File**: \`path/to/file.ts\` (lines X-Y)
**Purpose**: [1-line description of what this pattern does]
\`\`\`typescript
// paste the actual code here, verbatim
\`\`\`
**Relevance**: [1 line explaining why this matters for the task]

---

RULES:
- Every finding MUST include a code block with the actual source code
- Every code block MUST have a file path and line number range
- Do NOT write prose paragraphs — if you can't show code, skip the finding
- Focus on patterns that the implementation should follow or reuse
- Include at least 3 concrete code examples per focus area
- If you find test patterns, include the test code too

Be thorough but structured. Each finding must be copy-pasteable as a reference.`;
};

export const buildSurferAnalysisPrompt = (description: string): string => {
  return `You are the Robot King. Analyze this task and determine what exploration focuses are needed.

TASK DESCRIPTION:
${description}

INSTRUCTIONS:
1. Analyze the task to understand what areas of the codebase need exploration
2. Determine what exploration focuses would be most valuable
3. Consider areas like: existing patterns, similar features, test infrastructure, dependencies, error handling, API boundaries, configuration, security patterns, database/data layer, etc.
4. Choose 2-4 exploration focuses based on the task needs

IMPORTANT: A "project-conventions" surfer is ALWAYS added automatically to read CLAUDE.md, .claude/commands/, and config files.
Do NOT include it in your list. Your focuses are IN ADDITION to the mandatory conventions surfer.

GUIDELINES:
- Simple tasks (UI tweak, small fix): 2 surfers (+ conventions = 3 total)
- Medium tasks (new feature, refactor): 3 surfers (+ conventions = 4 total)
- Complex tasks (cross-cutting, architectural): 4 surfers (+ conventions = 5 total)
- Each focus should explore a DISTINCT area relevant to THIS task
- Don't include focuses that aren't relevant to the task

OUTPUT FORMAT (use exactly this format):
SURFER_FOCUSES:
1. [kebab-case-name]: [one-line description of what to explore]
2. [kebab-case-name]: [one-line description]
... (up to 4 max, since conventions is automatic)
END_FOCUSES

Example for "Add user authentication":
SURFER_FOCUSES:
1. existing-auth-patterns: Look for any existing authentication or session handling code
2. api-endpoints: Explore how API routes are structured and protected
3. test-patterns: Find how tests are structured and what test utilities exist
END_FOCUSES

Choose focuses that will help planners understand what exists and how to implement THIS specific task.`;
};

export const buildConventionsSurferPrompt = (description: string): string => {
  return `You are a Surfer agent responsible for extracting PROJECT CONVENTIONS. This is a mandatory exploration that runs for every task.

TASK DESCRIPTION:
${description}

YOUR JOB: Find and extract all project-level conventions, rules, and configuration that implementation agents must follow.

FILES TO CHECK (read ALL that exist):
1. CLAUDE.md (project root)
2. .claude/CLAUDE.md
3. .claude/commands/*.md (all command files — list them first with Glob)
4. ~/.claude/CLAUDE.md (user-level, if accessible)
5. ~/.claude/commands/*.md (user-level commands)
6. .editorconfig, .prettierrc, .eslintrc, tsconfig.json (style configs)
7. package.json (scripts section, dependencies)

INSTRUCTIONS:
1. Read each file listed above (skip if it doesn't exist)
2. Extract ALL rules, conventions, and instructions that affect how code should be written
3. Pay special attention to:
   - Testing commands and patterns (how to run tests, what framework)
   - Linting commands and rules
   - Code style preferences (arrow functions, naming conventions, etc.)
   - Build and compilation commands
   - Git workflow rules
   - Any explicit "do" and "don't" instructions
   - Language-specific preferences

OUTPUT FORMAT:
# Project Conventions

## Testing
[How to run tests, test frameworks used, test file naming, test patterns]

## Linting & Formatting
[Lint commands, formatters, auto-fix commands]

## Code Style
[Language preferences, naming conventions, import style, etc.]

## Build & Compilation
[Build commands, compilation requirements]

## Git Workflow
[Branch naming, commit style, PR conventions]

## Project-Specific Rules
[Any other rules from CLAUDE.md or project config]

## Slash Commands / Skills
[List any .claude/commands/ files found and summarize what each does]

For each section, include the EXACT commands or rules found. Quote directly from the source files.
If a section has no findings, write "No conventions found for this area."`;
};

export const buildCityPlannerPrompt = (
  description: string,
  findings: string,
  perspective: string,
  conventions?: string,
  codePatterns?: string
): string => {
  const conventionsSection = conventions
    ? `\n\nPROJECT CONVENTIONS (MUST FOLLOW):\n${conventions}`
    : '';

  const patternsSection = codePatterns
    ? `\n\nCODE PATTERNS FROM CODEBASE (reference these in your plan):\n${codePatterns}`
    : '';

  return `You are a City Planner agent in the robot-consortium system. Your job is to propose an implementation approach.

TASK DESCRIPTION:
${description}

FINDINGS FROM EXPLORATION:
${findings}${conventionsSection}${patternsSection}

YOUR PERSPECTIVE: ${perspective}

INSTRUCTIONS:
1. Analyze the findings and project conventions
2. Propose a concrete implementation plan that FOLLOWS existing patterns
3. For each change, reference the SPECIFIC existing pattern to follow (e.g. "implement using the pattern from src/foo.ts lines 23-45")
4. Explicitly separate test tasks from implementation tasks
5. Consider tradeoffs and risks

OUTPUT FORMAT:
Write a markdown plan with:
- Summary of approach
- **Test tasks** (tests to write FIRST, before implementation)
  - Each test task should reference existing test patterns from the findings
- **Implementation tasks** (code to write that makes tests pass)
  - Each task should reference specific existing code patterns to follow
- Files to modify (with specific changes and pattern references)
- Files to create
- Risks and mitigations

CRITICAL RULES:
- Every task MUST reference at least one specific file/pattern from the findings
- Do NOT write vague instructions like "add tests" — specify WHICH test patterns to follow
- Do NOT write "follow existing patterns" without naming the specific pattern and file
- Test tasks come BEFORE implementation tasks

Think from your assigned perspective (${perspective}) but be practical.`;
};

export const buildRatPrompt = (
  description: string,
  findings: string,
  plans: string,
  focus: string
): string => {
  return `You are a Rat agent in the robot-consortium system. Your job is to find weaknesses, flaws, and gaps in the proposed implementation plans.

TASK DESCRIPTION:
${description}

EXPLORATION FINDINGS:
${findings}

PROPOSED PLANS:
${plans}

YOUR CRITIQUE FOCUS: ${focus}

INSTRUCTIONS:
1. Read ALL proposed plans carefully
2. Attack them from your assigned focus angle
3. Reference the actual codebase to back up your critiques — don't just speculate
4. Be specific: cite file paths, line numbers, and concrete scenarios
5. Distinguish between critical flaws (must fix) and minor concerns (nice to fix)
6. Check if the plans reference SPECIFIC existing code patterns with file paths and line numbers
   - If a plan says "follow existing patterns" without naming the file and lines, flag it as VAGUE
   - If a plan doesn't distinguish test tasks from implementation tasks, flag it as INCOMPLETE

OUTPUT FORMAT:
Write a markdown critique with:
- Critical flaws found (things that will break or cause serious issues)
- Vagueness issues (tasks that don't reference specific files or patterns)
- Concerns (things that could be problematic)
- Missing considerations (gaps nobody addressed)
- For each issue: which plan(s) it affects and why it matters

Be adversarial but constructive. Your job is to make the final plan better by finding what the planners missed.`;
};

export const buildRatAnalysisPrompt = (
  description: string,
  plans: string
): string => {
  return `You are the Robot King. The City Planners have proposed implementation plans. Determine what critique angles are needed to stress-test these plans.

TASK DESCRIPTION:
${description}

PROPOSED PLANS:
${plans}

INSTRUCTIONS:
1. Read the plans and identify their assumptions, risks, and potential blind spots
2. Determine 2-3 critique angles that would most effectively challenge these plans
3. Each angle should target a DIFFERENT type of weakness

COMMON ANGLES (choose what's relevant):
- technical-flaws: Race conditions, edge cases, breaking changes, backwards compatibility
- overengineering: Unnecessary complexity, scope creep, premature abstractions
- missing-requirements: Gaps in coverage, untested paths, security holes
- data-integrity: Migration safety, data loss risks, consistency issues
- performance: Scalability concerns, N+1 queries, memory issues

OUTPUT FORMAT (use exactly this format):
RAT_FOCUSES:
1. [kebab-case-name]: [one-line description of what to attack]
2. [kebab-case-name]: [one-line description]
3. [kebab-case-name]: [one-line description]
END_RAT_FOCUSES

Choose 2-3 focuses that will most effectively challenge THIS specific set of plans.`;
};

export const buildDawgPrompt = (
  description: string,
  plan: string,
  taskDescription: string,
  conventions?: string,
  codePatterns?: string,
  testFiles?: string
): string => {
  const conventionsSection = conventions
    ? `\n\nPROJECT CONVENTIONS (MUST FOLLOW):\n${conventions}`
    : '';

  const patternsSection = codePatterns
    ? `\n\nCODE PATTERNS TO FOLLOW:\n${codePatterns}`
    : '';

  const testFilesSection = testFiles
    ? `\n\nTESTS YOU MUST MAKE PASS:\nThe following tests have been written for your task. Your implementation must make these tests pass.\n\n${testFiles}`
    : '';

  return `You are a Dawg agent in the robot-consortium system. Your job is to implement code changes.

OVERALL TASK:
${description}

APPROVED PLAN:
${plan}${conventionsSection}${patternsSection}

YOUR SPECIFIC TASK:
${taskDescription}${testFilesSection}

INSTRUCTIONS:
1. Implement the changes described in your task
2. Follow the project conventions listed above EXACTLY
3. Reuse existing patterns from the codebase — the code patterns section shows you what to follow
4. Write clean, maintainable code that matches the existing style
${testFiles ? '5. Run the tests listed above and ensure they pass\n6. If a test fails, fix your implementation (not the test) unless the test has an obvious bug' : '5. Add appropriate tests if specified in the plan'}

Do the implementation now. Write the code.`;
};

export const buildTestDawgPrompt = (
  description: string,
  plan: string,
  taskDescription: string,
  conventions?: string,
  codePatterns?: string
): string => {
  const conventionsSection = conventions
    ? `\n\nPROJECT CONVENTIONS (MUST FOLLOW):\n${conventions}`
    : '';

  const patternsSection = codePatterns
    ? `\n\nEXISTING TEST PATTERNS TO FOLLOW:\n${codePatterns}`
    : '';

  return `You are a Test Dawg agent in the robot-consortium system. Your job is to write TESTS FIRST, before implementation.

OVERALL TASK:
${description}

APPROVED PLAN:
${plan}${conventionsSection}${patternsSection}

YOUR SPECIFIC TASK (write tests for this):
${taskDescription}

INSTRUCTIONS:
1. Write tests that define the expected behavior for this task
2. Follow the existing test patterns shown in the code patterns above
3. Use the testing framework and conventions from the project conventions
4. Cover: happy path, edge cases, error cases
5. Tests should be specific enough that a separate implementation agent can write code to pass them
6. Do NOT write the implementation — only tests

TEST QUALITY CHECKLIST:
- Tests use the same framework/runner as existing tests in the project
- Test file naming matches the project convention
- Tests import from the correct paths (match existing import patterns)
- Tests cover the interface/behavior described in the task, not implementation details
- Each test has a clear, descriptive name

Write the tests now. The implementation will be done by a separate agent after you.`;
};

export const buildTaskVerificationPrompt = (
  taskDescription: string,
  testResults: string,
  testFiles?: string
): string => {
  return `You are a verification Pig agent. A Dawg just finished implementing a task. Check if it works.

TASK THAT WAS IMPLEMENTED:
${taskDescription}

TEST RESULTS:
${testResults}

${testFiles ? `RELEVANT TEST FILES:\n${testFiles}` : ''}

INSTRUCTIONS:
1. Analyze the test results
2. Determine if the implementation is working correctly
3. If tests are failing, identify exactly which tests fail and why

OUTPUT FORMAT:
VERDICT: PASS or FAIL

If FAIL:
## Failed Tests
[List each failing test with the error message]

## Likely Fix
[Brief description of what the implementation dawg should fix]

Be concise and specific. This output will be fed back to the implementation agent for a fix attempt.`;
};

export const buildPigPrompt = (
  description: string,
  plan: string,
  checkType: string
): string => {
  return `You are a Pig agent in the robot-consortium system. Your job is to verify the implementation.

ORIGINAL TASK:
${description}

APPROVED PLAN:
${plan}

YOUR CHECK TYPE: ${checkType}

INSTRUCTIONS:
${checkType === 'tests' ? `
- Run the FULL test suite (not just new tests) as an integration check
- Per-task verification already ran individual tests — this is for catching cross-cutting regressions
- Check for test failures across the entire project
- Report any failures, even in pre-existing tests that may have been broken
` : checkType === 'code-review' ? `
- Review the code changes
- Check for bugs, security issues, code smells
- Verify adherence to codebase patterns
` : `
- Verify the implementation matches the spec
- Check all requirements are addressed
- Ensure nothing was missed
`}

OUTPUT FORMAT:
Write a markdown report with:
- PASS or FAIL verdict at the top
- Detailed findings
- Specific issues found (if any)
- Recommendations

Be strict but fair. The goal is quality.`;
};

export const buildRobotKingPrompt = (description: string, phase: string): string => {
  return `You are the Robot King, coordinator of the robot-consortium system.

TASK: ${description}
CURRENT PHASE: ${phase}

Your job is to coordinate the work. Based on the current phase, determine what needs to happen next.`;
};

export const buildPlannerAnalysisPrompt = (description: string, findings: string): string => {
  return `You are the Robot King. Based on the surfer findings, determine what planner perspectives are needed.

TASK DESCRIPTION:
${description}

SURFER FINDINGS:
${findings}

INSTRUCTIONS:
1. Analyze the findings to understand the task complexity
2. Determine what expertise/perspectives would be most valuable for planning
3. Consider areas like: architecture, testing, security, performance, UX, database, API design, migration safety, etc.
4. Choose 1-5 planner perspectives based on the task needs

GUIDELINES:
- Simple tasks (single file, minor change): 1-2 planners
- Medium tasks (multiple files, clear scope): 2-3 planners
- Complex tasks (cross-cutting, architectural): 3-5 planners
- Each perspective should offer a DISTINCT viewpoint

OUTPUT FORMAT (use exactly this format):
PLANNER_PERSPECTIVES:
1. [kebab-case-name]: [one-line description of what this planner should focus on]
2. [kebab-case-name]: [one-line description]
... (up to 5 max)
END_PERSPECTIVES

Example:
PLANNER_PERSPECTIVES:
1. api-design: Focus on clean REST API design and endpoint structure
2. database-safety: Ensure migrations are safe and reversible
3. testing-strategy: Plan comprehensive test coverage
END_PERSPECTIVES

Choose perspectives that will produce meaningfully different plans for THIS specific task.`;
};

export const buildRobotKingPRPrompt = (
  description: string,
  diffSummary: string,
  commits: string,
  plan: string
): string => {
  return `You are the Robot King. Generate a PR title and description for the completed work.

ORIGINAL TASK:
${description}

IMPLEMENTATION PLAN:
${plan}

DIFF SUMMARY:
${diffSummary}

COMMITS:
${commits}

INSTRUCTIONS:
1. Write a concise, descriptive PR title (max 72 chars) using conventional commit format (feat/fix/chore)
2. Write a clear PR description summarizing:
   - What was implemented
   - Key changes made
   - Any important notes

OUTPUT FORMAT (use exactly this format):
PR_TITLE: <your title here>

PR_BODY:
## Summary
<1-3 bullet points of key changes>

## Changes
<list of notable changes with file references>

## Test plan
<how to verify the changes work>

---
Generated by robot-consortium
PR_END

Be concise but complete. No fluff.`;
};

export const buildCIFixPrompt = (failedChecks: string, failureLogs: string): string => {
  return `You are the Robot King. CI has failed and you need to fix the issues.

FAILED CHECKS:
${failedChecks}

FAILURE LOGS:
${failureLogs}

INSTRUCTIONS:
1. Analyze the failure logs to understand what went wrong
2. Identify the root cause(s)
3. Fix the issues by editing the necessary files
4. If it's a lint issue, run the appropriate fix command
5. If it's a test failure, fix the code or test

COMMON FIXES:
- Lint errors: Run 'yarn fix:prettier', 'yarn fix:es', or 'yarn fix:css'
- Type errors: Fix the TypeScript issues in the relevant files
- Test failures: Fix the broken tests or the code they're testing
- Import errors: Fix missing imports or circular dependencies

Make the minimal changes necessary to fix CI. Don't add unnecessary modifications.`;
};

export const buildPlanOnlySynthesisPrompt = (
  description: string,
  plans: string,
  plannerCount: number,
  critiques: string,
  conventions: string
): string => {
  const critiquesSection = critiques
    ? `

RAT CRITIQUES:
The following critiques were raised against the proposed plans by adversarial Rat agents. Address the valid critiques in your final plan and note which ones you addressed and which you dismissed (with reasoning).

${critiques}`
    : '';

  const conventionsSection = conventions
    ? `

PROJECT CONVENTIONS (the final plan MUST respect these):
${conventions}`
    : '';

  return `You are the Robot King. ${plannerCount} City Planner(s) have proposed implementation approaches for this task, and Rat agents have stress-tested them:

TASK: ${description}

PROPOSED PLANS:
${plans}${critiquesSection}${conventionsSection}

Your job: Synthesize these into ONE comprehensive implementation plan document. This is a PLAN-ONLY run — no code will be written. The output should be a clear, readable document that a developer can follow to implement the changes.

OUTPUT FORMAT:
# Implementation Plan

## Approach
[High-level summary of the chosen approach and why it was selected over alternatives]

## Key Decisions
[Important architectural and design decisions with rationale. For each decision, note what alternatives were considered and why this approach wins.]

## Changes Required
[Group changes by component/area. For each:]

### [Component/Area Name]
- **File**: \`path/to/file.ts\` (lines X-Y)
- **What to change**: [specific description]
- **Pattern to follow**: [reference existing code that demonstrates the approach]

## New Files
[Any new files to create, with their purpose and what existing files to use as templates]

## Testing Strategy
- **Test files to create/modify**: [specific paths]
- **Test patterns to follow**: [reference existing test files]
- **Coverage areas**: [what to test — happy path, edge cases, error cases]

## Risks & Mitigations
[Known risks with concrete mitigation strategies]
${critiques ? `
## Critiques Addressed
[List each valid critique from the Rats and how the plan addresses it]

## Critiques Dismissed
[List any dismissed critiques with reasoning]
` : ''}
## Open Questions
[Anything that needs clarification before implementation begins]

## Estimated Scope
[Rough complexity assessment: files touched, new files, test files]

Be specific and actionable. Every file reference should include paths and line numbers. Every pattern reference should point to concrete existing code.`;
};

export const buildPigLintPrompt = (
  description: string,
  plan: string
): string => {
  return `You are a Pig agent responsible for running and fixing lint issues.

ORIGINAL TASK:
${description}

APPROVED PLAN:
${plan}

INSTRUCTIONS:
1. Run the lint checks: yarn lint:dev:bi-app or yarn lint
2. If there are lint errors, FIX THEM:
   - For prettier issues: yarn fix:prettier
   - For eslint issues: yarn fix:es
   - For CSS issues: yarn fix:css
   - For TypeScript errors: edit the files to fix them
3. Re-run lint to verify all issues are fixed
4. If there are knip (unused exports) warnings, these are acceptable to ignore

OUTPUT FORMAT:
Write a report with:
- PASS or FAIL verdict
- Lint issues found and fixed
- Any remaining issues that couldn't be fixed

You MUST run lint and fix any issues before declaring PASS.`;
};
