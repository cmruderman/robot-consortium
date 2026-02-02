import { execSync } from 'child_process';
import chalk from 'chalk';
import { PhaseOptions } from '../types.js';
import { loadState, saveState, updatePhase } from '../state.js';
import { createAgentConfig, runAgent, buildRobotKingPRPrompt } from '../agents.js';

export interface PRResult {
  success: boolean;
  prUrl?: string;
  prNumber?: number;
  error?: string;
}

export const runPRPhase = async (workingDir: string, phaseOptions: PhaseOptions = {}): Promise<PRResult> => {
  console.log(chalk.cyan('\n📝 PHASE 5: PR'));
  console.log(chalk.dim('  Robot King is generating PR title and description...\n'));

  const state = loadState(workingDir);
  if (!state) {
    throw new Error('No consortium state found');
  }

  updatePhase(workingDir, 'PR');

  // First, check if there are uncommitted changes and commit them
  try {
    const status = execSync('git status --porcelain', { cwd: workingDir, encoding: 'utf-8' });
    if (status.trim()) {
      console.log(chalk.dim('  Uncommitted changes detected, committing...'));
      execSync('git add -A', { cwd: workingDir });
      execSync('git commit -m "chore: robot-consortium final changes"', { cwd: workingDir });
      console.log(chalk.green('  ✓ Changes committed'));
    }
  } catch (error) {
    // Ignore commit errors (might be nothing to commit)
  }

  // Push the branch
  try {
    const branchName = execSync('git branch --show-current', { cwd: workingDir, encoding: 'utf-8' }).trim();
    console.log(chalk.dim(`  Pushing branch: ${branchName}`));
    execSync(`git push -u origin ${branchName}`, { cwd: workingDir, stdio: 'inherit' });
    console.log(chalk.green('  ✓ Branch pushed'));

    // Store branch name in state
    state.branchName = branchName;
    saveState(workingDir, state);
  } catch (error) {
    console.log(chalk.red(`  ✗ Failed to push branch: ${(error as Error).message}`));
    return { success: false, error: (error as Error).message };
  }

  // Get git diff for Robot King to analyze
  let diffSummary: string;
  try {
    diffSummary = execSync('git diff main --stat', { cwd: workingDir, encoding: 'utf-8' });
  } catch {
    diffSummary = 'Unable to get diff summary';
  }

  // Get commit messages
  let commits: string;
  try {
    commits = execSync('git log main..HEAD --oneline', { cwd: workingDir, encoding: 'utf-8' });
  } catch {
    commits = 'Unable to get commit log';
  }

  // Have Robot King generate PR title and description
  const robotKing = createAgentConfig('robot-king', 0, 'pr-generation');
  const prompt = buildRobotKingPRPrompt(state.description, diffSummary, commits, state.finalPlan || '');

  console.log(chalk.dim('  Robot King analyzing changes...'));
  const result = await runAgent(robotKing, {
    workingDir,
    prompt,
    allowedTools: ['Read', 'Glob', 'Grep'],
    verbose: phaseOptions.verbose,
  });

  if (!result.success) {
    console.log(chalk.red(`  ✗ Robot King failed: ${result.error}`));
    return { success: false, error: result.error };
  }

  // Parse the PR title and body from Robot King's output
  const { title, body } = parsePRContent(result.output);

  // Create the PR
  try {
    console.log(chalk.dim('  Creating pull request...'));

    // Write body to temp file to avoid shell escaping issues
    const tempBodyFile = `${workingDir}/.robot-consortium/pr-body.md`;
    const fs = await import('fs');
    fs.writeFileSync(tempBodyFile, body);

    const prResult = execSync(
      `gh pr create --title "${title.replace(/"/g, '\\"')}" --body-file "${tempBodyFile}"`,
      { cwd: workingDir, encoding: 'utf-8' }
    );

    const prUrl = prResult.trim();
    const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
    const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : undefined;

    console.log(chalk.green(`  ✓ PR created: ${prUrl}`));

    // Store PR info in state
    state.prUrl = prUrl;
    state.prNumber = prNumber;
    state.ciCheckAttempts = 0;
    saveState(workingDir, state);

    return { success: true, prUrl, prNumber };
  } catch (error) {
    console.log(chalk.red(`  ✗ Failed to create PR: ${(error as Error).message}`));
    return { success: false, error: (error as Error).message };
  }
};

const parsePRContent = (output: string): { title: string; body: string } => {
  // Look for structured output from Robot King
  const titleMatch = output.match(/PR_TITLE:\s*(.+?)(?:\n|$)/);
  const bodyMatch = output.match(/PR_BODY:\s*([\s\S]+?)(?:PR_END|$)/);

  if (titleMatch && bodyMatch) {
    return {
      title: titleMatch[1].trim(),
      body: bodyMatch[1].trim(),
    };
  }

  // Fallback: use first line as title, rest as body
  const lines = output.split('\n').filter(l => l.trim());
  const title = lines[0] || 'Robot Consortium: Implementation';
  const body = lines.slice(1).join('\n') || output;

  return { title, body };
};
