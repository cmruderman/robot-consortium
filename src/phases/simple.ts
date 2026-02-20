import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { PhaseOptions } from '../types.js';
import { loadState, saveState, updatePhase, getStateDir, setFinalPlan, writeFailureReport } from '../state.js';
import { createAgentConfig, runAgent } from '../agents.js';

/**
 * Collect lightweight repo context deterministically.
 * Gives the solo Dawg orientation without tool-call overhead.
 */
const collectContext = (workingDir: string): string => {
  const parts: string[] = [];

  try {
    const log = execSync('git log --oneline -10', { cwd: workingDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    if (log) parts.push(`## Recent Commits\n\`\`\`\n${log}\n\`\`\``);
  } catch { /* ignore */ }

  try {
    const diff = execSync('git diff HEAD~3 --name-only', { cwd: workingDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    if (diff) parts.push(`## Recently Changed Files\n\`\`\`\n${diff}\n\`\`\``);
  } catch { /* ignore */ }

  try {
    const tsFiles = execSync(
      'find . -type f \\( -name "*.ts" -o -name "*.tsx" \\) -not -path "*/node_modules/*" -not -path "*/.robot-consortium/*" -not -path "*/dist/*" | sort | head -40',
      { cwd: workingDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
    ).trim();
    if (tsFiles) parts.push(`## Source Files\n\`\`\`\n${tsFiles}\n\`\`\``);
  } catch { /* ignore */ }

  try {
    const claudeMd = path.join(workingDir, 'CLAUDE.md');
    if (fs.existsSync(claudeMd)) {
      const content = fs.readFileSync(claudeMd, 'utf-8').slice(0, 2000);
      parts.push(`## CLAUDE.md (project conventions)\n${content}`);
    }
  } catch { /* ignore */ }

  return parts.length > 0 ? `# Repository Context\n\n${parts.join('\n\n')}\n\n---` : '';
};

const buildSimpleDawgPrompt = (description: string, context: string): string => {
  return `You are a senior engineer implementing a task autonomously. Think carefully, explore what you need, and implement correctly in one shot.

${context ? `${context}\n\n` : ''}TASK:
${description}

INSTRUCTIONS:
1. Read the relevant files to understand the existing code
2. Implement the changes needed to complete the task
3. Follow the existing code style and patterns precisely
4. Run any available tests to verify your work
5. If there's a TypeScript project, ensure there are no type errors

Be thorough but minimal — only make changes directly required by the task. No extras.`;
};

export interface SimpleModeResult {
  success: boolean;
  error?: string;
}

export const runSimpleMode = async (workingDir: string, phaseOptions: PhaseOptions = {}): Promise<SimpleModeResult> => {
  console.log(chalk.cyan('\n⚡ SIMPLE MODE: One-shot implementation'));
  console.log(chalk.dim('  Skipping SURF/PLAN — single agent implements directly\n'));

  const state = loadState(workingDir);
  if (!state) throw new Error('No consortium state found');

  updatePhase(workingDir, 'BUILD');

  // Capture pre-build SHA for rollback
  try {
    const sha = execSync('git rev-parse HEAD', { cwd: workingDir, encoding: 'utf-8' }).trim();
    state.preBuildSha = sha;
    saveState(workingDir, state);
  } catch { /* not a git repo */ }

  // Collect repo context deterministically
  const context = collectContext(workingDir);
  console.log(chalk.dim('  Context collected. Launching solo Dawg...\n'));

  const dawg = createAgentConfig('dawg', 1, 'solo-impl');
  const result = await runAgent(dawg, {
    workingDir,
    prompt: buildSimpleDawgPrompt(state.description, context),
    allowedTools: ['Read', 'Write', 'Edit', 'Grep', 'Bash(yarn*)', 'Bash(npm*)', 'Bash(git diff*)'],
    verbose: phaseOptions.verbose,
  });

  if (!result.success) {
    console.log(chalk.red(`  ✗ Solo Dawg failed: ${result.error}`));

    // Write failure report
    const stateDir = getStateDir(workingDir);
    const report = [
      '# Simple Mode Failure Report',
      '',
      `**Task**: ${state.description.slice(0, 100)}`,
      `**Error**: ${result.error ?? 'Unknown error'}`,
      '',
      state.preBuildSha ? `## Rollback\n\`git reset --hard ${state.preBuildSha}\`` : '',
    ].join('\n');
    writeFailureReport(workingDir, report);
    console.log(chalk.dim(`  Failure report: ${stateDir}/failure-report.md`));

    return { success: false, error: result.error };
  }

  console.log(chalk.green('  ✓ Solo Dawg completed'));

  // Store a minimal finalPlan so OINK has something to reference
  setFinalPlan(workingDir, `# Simple Mode Implementation\n\n## Task\n${state.description}\n\n## Implementation\n${result.output.slice(0, 2000)}`);

  return { success: true };
};
