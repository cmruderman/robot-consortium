import { execSync } from 'child_process';
import chalk from 'chalk';
import { PhaseOptions } from '../types.js';
import { loadState, saveState, updatePhase } from '../state.js';
import { createAgentConfig, runAgent, buildCIFixPrompt } from '../agents.js';

const CI_WAIT_MINUTES = 15;
const MAX_CI_ATTEMPTS = 3;

export interface CICheckResult {
  success: boolean;
  ciPassed: boolean;
  needsRetry: boolean;
  error?: string;
}

export const runCICheckPhase = async (workingDir: string, phaseOptions: PhaseOptions = {}): Promise<CICheckResult> => {
  console.log(chalk.cyan('\n🔍 PHASE 6: CI_CHECK'));

  const state = loadState(workingDir);
  if (!state) {
    throw new Error('No consortium state found');
  }

  if (!state.prNumber) {
    console.log(chalk.red('  ✗ No PR found. Run PR phase first.'));
    return { success: false, ciPassed: false, needsRetry: false, error: 'No PR found' };
  }

  updatePhase(workingDir, 'CI_CHECK');

  const attempts = state.ciCheckAttempts || 0;
  console.log(chalk.dim(`  CI check attempt: ${attempts + 1}/${MAX_CI_ATTEMPTS}`));

  if (attempts >= MAX_CI_ATTEMPTS) {
    console.log(chalk.yellow(`  ⚠️  Max CI fix attempts (${MAX_CI_ATTEMPTS}) reached.`));
    console.log(chalk.dim('  Proceeding to DONE - manual intervention may be needed.'));
    return { success: true, ciPassed: false, needsRetry: false };
  }

  // Wait for CI to run
  console.log(chalk.dim(`  Waiting ${CI_WAIT_MINUTES} minutes for CI to complete...`));
  await waitMinutes(CI_WAIT_MINUTES);

  // Check CI status
  console.log(chalk.dim('  Checking CI status...'));
  const ciStatus = await checkCIStatus(workingDir, state.prNumber);

  if (ciStatus.status === 'success') {
    console.log(chalk.green('  ✓ CI passed!'));
    return { success: true, ciPassed: true, needsRetry: false };
  }

  if (ciStatus.status === 'pending') {
    console.log(chalk.yellow('  ⏳ CI still running, waiting another 5 minutes...'));
    await waitMinutes(5);

    const retryStatus = await checkCIStatus(workingDir, state.prNumber);
    if (retryStatus.status === 'success') {
      console.log(chalk.green('  ✓ CI passed!'));
      return { success: true, ciPassed: true, needsRetry: false };
    }

    if (retryStatus.status === 'pending') {
      console.log(chalk.yellow('  ⏳ CI still running. Will check again on resume.'));
      return { success: true, ciPassed: false, needsRetry: true };
    }

    ciStatus.status = retryStatus.status;
    ciStatus.details = retryStatus.details;
  }

  // CI failed - analyze and fix
  console.log(chalk.red('  ✗ CI failed. Analyzing failures...'));
  console.log(chalk.dim(`  Failed checks: ${ciStatus.details}`));

  // Get detailed failure logs
  const failureLogs = await getFailureLogs(workingDir, state.prNumber);

  // Have Robot King analyze and create fix plan
  const robotKing = createAgentConfig('robot-king', 0, 'ci-fix');
  const fixPrompt = buildCIFixPrompt(ciStatus.details, failureLogs);

  console.log(chalk.dim('  Robot King analyzing CI failures...'));
  const result = await runAgent(robotKing, {
    workingDir,
    prompt: fixPrompt,
    allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Bash(yarn*)', 'Bash(npm*)', 'Bash(git*)'],
    verbose: phaseOptions.verbose,
  });

  if (!result.success) {
    console.log(chalk.red(`  ✗ Robot King failed to analyze: ${result.error}`));
    return { success: false, ciPassed: false, needsRetry: false, error: result.error };
  }

  // Commit the fixes
  try {
    const status = execSync('git status --porcelain', { cwd: workingDir, encoding: 'utf-8' });
    if (status.trim()) {
      execSync('git add -A', { cwd: workingDir });
      execSync(`git commit -m "fix: CI fixes (attempt ${attempts + 1})"`, { cwd: workingDir });
      execSync('git push', { cwd: workingDir });
      console.log(chalk.green('  ✓ CI fixes committed and pushed'));

      // Increment attempt counter
      state.ciCheckAttempts = attempts + 1;
      saveState(workingDir, state);

      return { success: true, ciPassed: false, needsRetry: true };
    } else {
      console.log(chalk.yellow('  ⚠️  No changes made by Robot King'));
      state.ciCheckAttempts = attempts + 1;
      saveState(workingDir, state);
      return { success: true, ciPassed: false, needsRetry: true };
    }
  } catch (error) {
    console.log(chalk.red(`  ✗ Failed to commit fixes: ${(error as Error).message}`));
    return { success: false, ciPassed: false, needsRetry: false, error: (error as Error).message };
  }
};

const waitMinutes = (minutes: number): Promise<void> => {
  return new Promise((resolve) => {
    const totalSeconds = minutes * 60;
    let elapsed = 0;

    const interval = setInterval(() => {
      elapsed += 30;
      const remaining = totalSeconds - elapsed;
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      process.stdout.write(`\r  ⏱️  ${mins}m ${secs}s remaining...`);

      if (elapsed >= totalSeconds) {
        clearInterval(interval);
        process.stdout.write('\n');
        resolve();
      }
    }, 30000); // Update every 30 seconds
  });
};

interface CIStatus {
  status: 'success' | 'failure' | 'pending';
  details: string;
}

const checkCIStatus = async (workingDir: string, prNumber: number): Promise<CIStatus> => {
  try {
    const result = execSync(
      `gh pr checks ${prNumber} --json name,state`,
      { cwd: workingDir, encoding: 'utf-8' }
    );

    const checks = JSON.parse(result) as Array<{
      name: string;
      state: string;
    }>;

    const failures = checks.filter(c => c.state === 'FAILURE');
    const pending = checks.filter(c => c.state === 'PENDING' || c.state === 'IN_PROGRESS' || c.state === 'QUEUED');

    if (failures.length > 0) {
      return {
        status: 'failure',
        details: failures.map(f => f.name).join(', '),
      };
    }

    if (pending.length > 0) {
      return {
        status: 'pending',
        details: pending.map(p => p.name).join(', '),
      };
    }

    return { status: 'success', details: 'All checks passed' };
  } catch (error) {
    return {
      status: 'pending',
      details: `Unable to check status: ${(error as Error).message}`,
    };
  }
};

const getFailureLogs = async (workingDir: string, prNumber: number): Promise<string> => {
  try {
    // Get the check run logs
    const result = execSync(
      `gh pr checks ${prNumber} --json name,state,link`,
      { cwd: workingDir, encoding: 'utf-8' }
    );

    const checks = JSON.parse(result) as Array<{
      name: string;
      state: string;
      link: string;
    }>;

    const failures = checks.filter(c => c.state === 'FAILURE');

    let logs = '# CI Failure Details\n\n';
    for (const failure of failures) {
      logs += `## ${failure.name}\n`;
      logs += `URL: ${failure.link}\n\n`;

      // Try to get logs via gh run view if possible
      try {
        const runIdMatch = failure.link?.match(/runs\/(\d+)/);
        if (runIdMatch) {
          const runLogs = execSync(
            `gh run view ${runIdMatch[1]} --log-failed 2>/dev/null | tail -200`,
            { cwd: workingDir, encoding: 'utf-8', timeout: 30000 }
          );
          logs += '```\n' + runLogs + '\n```\n\n';
        }
      } catch {
        logs += 'Unable to fetch detailed logs.\n\n';
      }
    }

    return logs;
  } catch (error) {
    return `Unable to get failure logs: ${(error as Error).message}`;
  }
};
