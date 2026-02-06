import { spawn } from 'child_process';
import { AgentConfig, AgentRole, AGENT_MODELS, Model } from './types.js';
import { PhaseDisplay } from './display.js';
import chalk from 'chalk';

const formatElapsed = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
};

const extractSummary = (output: string): string => {
  // Try to find a meaningful first line from the output for a completion summary
  const lines = output.trim().split('\n');
  for (const line of lines) {
    const cleaned = line.replace(/^#+\s*/, '').trim();
    // Skip empty lines, markdown separators, and very short lines
    if (cleaned && cleaned.length > 10 && !cleaned.startsWith('---') && !cleaned.startsWith('```')) {
      // Truncate to a reasonable length
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
  const { workingDir, prompt, systemPrompt, allowedTools, verbose, display } = options;

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
  if (!display) {
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
    const progressInterval = !display
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

      if (verbose && !display) {
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
      if (verbose && !display) {
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
        } else {
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
        } else {
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
      } else {
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
  return `You are a Surfer agent in the robot-consortium system. Your job is to explore the codebase and find relevant information.

TASK DESCRIPTION:
${description}

YOUR FOCUS AREA: ${focus}

INSTRUCTIONS:
1. Search the codebase thoroughly for information relevant to your focus area
2. Look for existing patterns, similar implementations, relevant tests
3. Document your findings clearly

OUTPUT FORMAT:
Write a markdown report with:
- What you found
- Relevant file paths with line numbers
- Code patterns observed
- Recommendations based on findings

Be thorough but concise. Focus only on your assigned area.`;
};

export const buildSurferAnalysisPrompt = (description: string): string => {
  return `You are the Robot King. Analyze this task and determine what exploration focuses are needed.

TASK DESCRIPTION:
${description}

INSTRUCTIONS:
1. Analyze the task to understand what areas of the codebase need exploration
2. Determine what exploration focuses would be most valuable
3. Consider areas like: existing patterns, similar features, test infrastructure, dependencies, error handling, API boundaries, configuration, security patterns, database/data layer, etc.
4. Choose 2-5 exploration focuses based on the task needs

GUIDELINES:
- Simple tasks (UI tweak, small fix): 2 surfers
- Medium tasks (new feature, refactor): 3 surfers
- Complex tasks (cross-cutting, architectural): 4-5 surfers
- Each focus should explore a DISTINCT area relevant to THIS task
- Don't include focuses that aren't relevant to the task

OUTPUT FORMAT (use exactly this format):
SURFER_FOCUSES:
1. [kebab-case-name]: [one-line description of what to explore]
2. [kebab-case-name]: [one-line description]
... (up to 5 max)
END_FOCUSES

Example for "Add user authentication":
SURFER_FOCUSES:
1. existing-auth-patterns: Look for any existing authentication or session handling code
2. api-endpoints: Explore how API routes are structured and protected
3. user-data-model: Find user-related database models and schemas
4. security-patterns: Identify input validation, sanitization, and security practices
END_FOCUSES

Choose focuses that will help planners understand what exists and how to implement THIS specific task.`;
};

export const buildCityPlannerPrompt = (
  description: string,
  findings: string,
  perspective: string
): string => {
  return `You are a City Planner agent in the robot-consortium system. Your job is to propose an implementation approach.

TASK DESCRIPTION:
${description}

FINDINGS FROM EXPLORATION:
${findings}

YOUR PERSPECTIVE: ${perspective}

INSTRUCTIONS:
1. Analyze the findings
2. Propose a concrete implementation plan
3. Consider tradeoffs and risks
4. Be specific about files to modify/create

OUTPUT FORMAT:
Write a markdown plan with:
- Summary of approach
- Step-by-step implementation tasks
- Files to modify (with specific changes)
- Files to create
- Testing strategy
- Risks and mitigations

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

OUTPUT FORMAT:
Write a markdown critique with:
- Critical flaws found (things that will break or cause serious issues)
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
  taskDescription: string
): string => {
  return `You are a Dawg agent in the robot-consortium system. Your job is to implement code changes.

OVERALL TASK:
${description}

APPROVED PLAN:
${plan}

YOUR SPECIFIC TASK:
${taskDescription}

INSTRUCTIONS:
1. Implement the changes described in your task
2. Follow existing code patterns in the codebase
3. Write clean, maintainable code
4. Add appropriate tests if specified in the plan

Do the implementation now. Write the code.`;
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
- Run the test suite
- Check for test failures
- Verify new tests were added if required
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
