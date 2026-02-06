import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { PhaseOptions } from '../types.js';
import { loadState, updatePhase, addReview, getStateDir } from '../state.js';
import { createAgentConfig, runAgentsInParallel, runAgent, buildPigPrompt, buildPigLintPrompt } from '../agents.js';
import { getFinalPlan } from './plan.js';

const PIG_CHECK_TYPES = ['tests', 'code-review', 'spec-compliance'];

export interface OinkResult {
  success: boolean;
  passed: boolean;
  feedback?: string;
}

export const runOinkPhase = async (workingDir: string, phaseOptions: PhaseOptions = {}): Promise<OinkResult> => {
  console.log(chalk.cyan('\n🐷 PHASE 4: OINK'));
  console.log(chalk.dim('  Deploying Pigs to verify the implementation...\n'));

  const state = loadState(workingDir);
  if (!state) {
    throw new Error('No consortium state found');
  }

  updatePhase(workingDir, 'OINK');

  const finalPlan = getFinalPlan(workingDir);

  // First, run the lint-fixing pig
  console.log(chalk.dim('  Running lint checks first...\n'));
  const lintPig = createAgentConfig('pig', 0, 'lint');
  const lintResult = await runAgent(lintPig, {
    workingDir,
    prompt: buildPigLintPrompt(state.description, finalPlan),
    allowedTools: [
      'Read', 'Glob', 'Grep', 'Edit',
      'Bash(yarn lint*)', 'Bash(yarn fix*)',
      'Bash(npm run lint*)', 'Bash(npm run fix*)',
      'Bash(git add*)', 'Bash(git status*)',
    ],
    verbose: phaseOptions.verbose,
  });

  if (lintResult.success) {
    addReview(workingDir, 'pig-0-lint.md', lintResult.output);
    const lintPassed = parseVerdict(lintResult.output);
    if (!lintPassed) {
      console.log(chalk.yellow('  ⚠️  Lint pig found issues that need manual review'));
    } else {
      console.log(chalk.green('  ✓ Lint checks passed'));
    }
  } else {
    console.log(chalk.red(`  ✗ Lint pig failed: ${lintResult.error}`));
  }

  // Then run the verification pigs in parallel
  console.log(chalk.dim('\n  Running verification checks...\n'));

  // Create pig agents
  const pigs = PIG_CHECK_TYPES.map((checkType, i) =>
    createAgentConfig('pig', i + 1, checkType)
  );

  // Build prompts for each pig
  const options = pigs.map((pig) => ({
    workingDir,
    prompt: buildPigPrompt(state.description, finalPlan, pig.focus!),
    allowedTools: pig.focus === 'tests'
      ? ['Read', 'Glob', 'Grep', 'Bash(yarn test*)', 'Bash(npm test*)', 'Bash(yarn lint*)', 'Bash(npm run lint*)']
      : ['Read', 'Glob', 'Grep', 'Bash(git diff*)'],
  }));

  // Run pigs in parallel
  const results = await runAgentsInParallel(pigs, options, {
    verbose: phaseOptions.verbose,
    phaseName: `PIGS [${pigs.length} checks]`,
    phaseIcon: '🐷',
  });

  // Process results
  const failedPigs: string[] = [];
  const verdicts: { pig: string; passed: boolean; feedback: string }[] = [];

  results.forEach((result, i) => {
    const pig = pigs[i];
    const checkType = PIG_CHECK_TYPES[i];

    if (result.success) {
      const filename = `${pig.id}-${checkType}.md`;
      addReview(workingDir, filename, result.output);

      // Parse verdict from output
      const passed = parseVerdict(result.output);
      verdicts.push({
        pig: pig.id,
        passed,
        feedback: result.output,
      });

      const icon = passed ? '✓' : '✗';
      const color = passed ? chalk.green : chalk.red;
      console.log(color(`  ${icon} ${pig.id} (${checkType}): ${passed ? 'PASS' : 'FAIL'}`));
    } else {
      failedPigs.push(pig.id);
      console.log(chalk.red(`  ✗ ${pig.id} error: ${result.error}`));
    }
  });

  if (failedPigs.length > 0) {
    console.log(chalk.red(`\n  ${failedPigs.length} pig(s) failed to run. Surface to user.`));
    return { success: false, passed: false };
  }

  const stateDir = getStateDir(workingDir);
  console.log(chalk.dim(`\n  Reviews written to: ${stateDir}/reviews/`));

  // Check overall result
  const allPassed = verdicts.every(v => v.passed);

  if (allPassed) {
    console.log(chalk.green('\n  ✓ All verification checks passed!'));
    updatePhase(workingDir, 'DONE');
    return { success: true, passed: true };
  } else {
    const failures = verdicts.filter(v => !v.passed);
    console.log(chalk.red(`\n  ✗ ${failures.length} verification check(s) failed.`));

    // Compile feedback for return to BUILD phase
    const feedback = failures
      .map(f => `## ${f.pig}\n\n${f.feedback}`)
      .join('\n\n---\n\n');

    return { success: true, passed: false, feedback };
  }
};

const parseVerdict = (output: string): boolean => {
  const upperOutput = output.toUpperCase();

  // Look for explicit PASS/FAIL at the start or in a verdict line
  if (upperOutput.includes('VERDICT: PASS') || upperOutput.includes('# PASS')) {
    return true;
  }
  if (upperOutput.includes('VERDICT: FAIL') || upperOutput.includes('# FAIL')) {
    return false;
  }

  // Look for PASS/FAIL as standalone words near the top
  const firstLines = output.split('\n').slice(0, 10).join('\n').toUpperCase();
  if (firstLines.includes('PASS') && !firstLines.includes('FAIL')) {
    return true;
  }
  if (firstLines.includes('FAIL')) {
    return false;
  }

  // Default to pass if unclear (optimistic)
  return true;
};

export const getReviews = (workingDir: string): string => {
  const state = loadState(workingDir);
  if (!state) throw new Error('No consortium state found');

  const stateDir = getStateDir(workingDir);
  const reviewsDir = path.join(stateDir, 'reviews');

  let combined = '# Verification Reviews\n\n';

  for (const filename of state.reviews) {
    const content = fs.readFileSync(path.join(reviewsDir, filename), 'utf-8');
    combined += `## ${filename}\n\n${content}\n\n---\n\n`;
  }

  return combined;
};
