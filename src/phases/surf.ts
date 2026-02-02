import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { PhaseOptions } from '../types.js';
import { loadState, updatePhase, addFinding, getStateDir } from '../state.js';
import { createAgentConfig, runAgentsInParallel, buildSurferPrompt } from '../agents.js';

const SURFER_FOCUSES = [
  'existing patterns and conventions in the codebase',
  'similar features or implementations that already exist',
  'test patterns and testing infrastructure',
];

export const runSurfPhase = async (workingDir: string, phaseOptions: PhaseOptions = {}): Promise<{ success: boolean; questions?: string[] }> => {
  console.log(chalk.cyan('\n🏄 PHASE 1: SURF'));
  console.log(chalk.dim('  Deploying 3 Surfers to explore the codebase...\n'));

  const state = loadState(workingDir);
  if (!state) {
    throw new Error('No consortium state found');
  }

  updatePhase(workingDir, 'SURF');

  // Create surfer agents
  const surfers = SURFER_FOCUSES.map((focus, i) => createAgentConfig('surfer', i + 1, focus));

  // Build prompts for each surfer
  const options = surfers.map((surfer) => ({
    workingDir,
    prompt: buildSurferPrompt(state.description, surfer.focus!),
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash(git log*)', 'Bash(git show*)'],
  }));

  // Run surfers in parallel
  const results = await runAgentsInParallel(surfers, options, phaseOptions.verbose);

  // Process results
  const failedSurfers: string[] = [];
  const questions: string[] = [];

  results.forEach((result, i) => {
    const surfer = surfers[i];

    if (result.success) {
      const filename = `${surfer.id}-${surfer.focus?.replace(/\s+/g, '-').toLowerCase().slice(0, 30)}.md`;
      addFinding(workingDir, filename, result.output);
      console.log(chalk.green(`  ✓ ${surfer.id} findings saved to ${filename}`));

      // Check for questions in output (simple heuristic)
      if (result.output.includes('QUESTION:') || result.output.includes('Need clarification:')) {
        const questionMatch = result.output.match(/(?:QUESTION:|Need clarification:)\s*(.+?)(?:\n|$)/i);
        if (questionMatch) {
          questions.push(`[${surfer.id}] ${questionMatch[1]}`);
        }
      }
    } else {
      failedSurfers.push(surfer.id);
      console.log(chalk.red(`  ✗ ${surfer.id} failed: ${result.error}`));
    }
  });

  if (failedSurfers.length > 0) {
    console.log(chalk.red(`\n  ${failedSurfers.length} surfer(s) failed. Surface to user.`));
    return { success: false };
  }

  console.log(chalk.green('\n  All surfers completed successfully.'));

  // List findings
  const stateDir = getStateDir(workingDir);
  const findingsDir = path.join(stateDir, 'findings');
  console.log(chalk.dim(`\n  Findings written to: ${findingsDir}/`));

  return { success: true, questions: questions.length > 0 ? questions : undefined };
};

export const getSurfFindings = (workingDir: string): string => {
  const state = loadState(workingDir);
  if (!state) throw new Error('No consortium state found');

  const stateDir = getStateDir(workingDir);
  const findingsDir = path.join(stateDir, 'findings');

  let combined = '# Exploration Findings\n\n';

  for (const filename of state.findings) {
    const content = fs.readFileSync(path.join(findingsDir, filename), 'utf-8');
    combined += `## ${filename}\n\n${content}\n\n---\n\n`;
  }

  return combined;
};
