import { spawn } from 'child_process';
import { AgentConfig, AgentRole, AGENT_MODELS, Model } from './types.js';
import chalk from 'chalk';

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
  const { workingDir, prompt, systemPrompt, allowedTools, outputFile } = options;

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

  // Don't pass prompt as argument - we'll write it to stdin
  console.log(chalk.dim(`  [${agent.id}] Starting (${agent.model})...`));

  return new Promise((resolve) => {
    let output = '';
    let errorOutput = '';

    const proc = spawn('claude', args, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Write prompt to stdin and close it
    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
    });

    proc.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log(chalk.green(`  [${agent.id}] Completed`));
        resolve({
          success: true,
          output: output.trim(),
        });
      } else {
        console.log(chalk.red(`  [${agent.id}] Failed (exit code ${code})`));
        resolve({
          success: false,
          output: output.trim(),
          error: errorOutput || `Process exited with code ${code}`,
        });
      }
    });

    proc.on('error', (err) => {
      console.log(chalk.red(`  [${agent.id}] Error: ${err.message}`));
      resolve({
        success: false,
        output: '',
        error: err.message,
      });
    });
  });
};

export const runAgentsInParallel = async (
  agents: AgentConfig[],
  optionsPerAgent: AgentOptions[]
): Promise<AgentResult[]> => {
  if (agents.length !== optionsPerAgent.length) {
    throw new Error('Agents and options arrays must have the same length');
  }

  const promises = agents.map((agent, i) => runAgent(agent, optionsPerAgent[i]));
  return Promise.all(promises);
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
