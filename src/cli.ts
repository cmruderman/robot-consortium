#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { initializeState, loadState } from './state.js';
import { runConsortium, showStatus } from './orchestrator.js';

const program = new Command();

program
  .name('robot-consortium')
  .description('Multi-agent orchestration CLI for Claude Code')
  .version('0.1.0');

interface StartOptions {
  directory?: string;
  file?: string;
  issue?: string;
  yes?: boolean;
  verbose?: boolean;
  branch?: string;
  noBranch?: boolean;
  skipOink?: boolean;
  skipCi?: boolean;
  skipRats?: boolean;
}

const resolveDescription = async (
  inlineDescription: string | undefined,
  options: StartOptions
): Promise<{ description: string; source: string }> => {
  // Priority: --file > --issue > inline argument
  if (options.file) {
    const filePath = options.file.startsWith('/')
      ? options.file
      : `${process.cwd()}/${options.file}`;

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    return { description: content, source: `file: ${options.file}` };
  }

  if (options.issue) {
    const issueRef = options.issue;
    let ghCommand: string;

    // Check if it's a full URL or just an issue number
    if (issueRef.includes('github.com')) {
      // Full URL: https://github.com/owner/repo/issues/123
      const match = issueRef.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
      if (!match) {
        throw new Error(`Invalid GitHub issue URL: ${issueRef}`);
      }
      const [, owner, repo, number] = match;
      ghCommand = `gh issue view ${number} --repo ${owner}/${repo} --json title,body,labels,comments`;
    } else {
      // Just an issue number - use current repo
      ghCommand = `gh issue view ${issueRef} --json title,body,labels,comments`;
    }

    try {
      const result = execSync(ghCommand, { encoding: 'utf-8' });
      const issue = JSON.parse(result);

      let description = `# ${issue.title}\n\n`;
      description += issue.body || '';

      if (issue.labels && issue.labels.length > 0) {
        const labelNames = issue.labels.map((l: { name: string }) => l.name).join(', ');
        description += `\n\n**Labels:** ${labelNames}`;
      }

      if (issue.comments && issue.comments.length > 0) {
        description += '\n\n## Comments\n';
        for (const comment of issue.comments) {
          description += `\n### ${comment.author?.login || 'Unknown'}\n${comment.body}\n`;
        }
      }

      return { description, source: `GitHub issue: ${issueRef}` };
    } catch (error) {
      throw new Error(`Failed to fetch GitHub issue: ${(error as Error).message}`);
    }
  }

  if (inlineDescription) {
    return { description: inlineDescription, source: 'inline' };
  }

  throw new Error('Must provide a description, --file, or --issue');
};

program
  .command('start')
  .description('Start a new consortium task')
  .argument('[description]', 'Description of the task to accomplish')
  .option('-d, --directory <path>', 'Working directory (defaults to current)')
  .option('-f, --file <path>', 'Read task description from a markdown file')
  .option('-i, --issue <ref>', 'Fetch task from GitHub issue (number or full URL)')
  .option('-y, --yes', 'Auto-proceed through all checkpoints without prompting')
  .option('-v, --verbose', 'Stream agent output in real-time')
  .option('-b, --branch <name>', 'Branch name to create (auto-generated if not provided)')
  .option('--no-branch', 'Skip branch creation (use current branch)')
  .option('--skip-oink', 'Skip the OINK verification phase')
  .option('--skip-ci', 'Skip the CI_CHECK phase')
  .option('--skip-rats', 'Skip the Rat challenge phase during planning')
  .action(async (inlineDescription: string | undefined, options: StartOptions) => {
    const workingDir = options.directory || process.cwd();

    // Resolve the description from various sources
    let description: string;
    let source: string;
    try {
      const resolved = await resolveDescription(inlineDescription, options);
      description = resolved.description;
      source = resolved.source;
    } catch (error) {
      console.log(chalk.red(`\n❌ ${(error as Error).message}\n`));
      process.exit(1);
    }

    // Check if there's already an active consortium
    const existing = loadState(workingDir);
    if (existing && existing.phase !== 'DONE' && existing.phase !== 'FAILED') {
      console.log(chalk.yellow(`\n⚠️  Active consortium found (phase: ${existing.phase})`));
      console.log(chalk.dim(`   Use "robot-consortium resume" to continue`));
      console.log(chalk.dim(`   Or delete .robot-consortium/ to start fresh\n`));
      process.exit(1);
    }

    // Handle git branch
    let currentBranch: string | undefined;
    try {
      // Check if we're in a git repo
      execSync('git rev-parse --git-dir', { cwd: workingDir, stdio: 'ignore' });
      currentBranch = execSync('git branch --show-current', { cwd: workingDir, encoding: 'utf-8' }).trim();

      if (options.noBranch === true) {
        // Use current branch
        console.log(chalk.dim(`   Using current branch: ${currentBranch}`));
      } else {
        // Create or switch to branch
        let branchName = options.branch;

        if (!branchName) {
          // Auto-generate branch name from issue or description
          if (options.issue) {
            const issueMatch = options.issue.match(/(\d+)$/);
            if (issueMatch) {
              branchName = `feat/issue-${issueMatch[1]}-robot-consortium`;
            }
          }
          if (!branchName) {
            // Generate from description
            const slug = description
              .split('\n')[0]
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-|-$/g, '')
              .slice(0, 40);
            branchName = `feat/${slug}-robot-consortium`;
          }
        }

        // Check if branch already exists
        try {
          execSync(`git rev-parse --verify ${branchName}`, { cwd: workingDir, stdio: 'ignore' });
          console.log(chalk.yellow(`\n⚠️  Branch '${branchName}' already exists`));
          console.log(chalk.dim(`   Checking out existing branch...\n`));
          execSync(`git checkout ${branchName}`, { cwd: workingDir, stdio: 'inherit' });
        } catch {
          // Branch doesn't exist, create it
          console.log(chalk.dim(`   Creating branch: ${branchName}`));
          execSync(`git checkout -b ${branchName}`, { cwd: workingDir, stdio: 'inherit' });
        }
        currentBranch = branchName;
        console.log(chalk.green(`   ✓ On branch: ${branchName}\n`));
      }
    } catch {
      console.log(chalk.yellow('\n⚠️  Not a git repository, skipping branch handling\n'));
    }

    // Clean up old state if exists
    const stateDir = `${workingDir}/.robot-consortium`;
    if (fs.existsSync(stateDir)) {
      fs.rmSync(stateDir, { recursive: true });
    }

    // Truncate description for display
    const displayDesc = description.length > 100
      ? description.slice(0, 100).replace(/\n/g, ' ') + '...'
      : description.replace(/\n/g, ' ');

    console.log(chalk.bold.cyan('\n👑 ROBOT CONSORTIUM\n'));
    console.log(chalk.dim(`   Initializing new consortium...`));
    console.log(chalk.dim(`   Source: ${source}`));
    console.log(chalk.dim(`   Task: ${displayDesc}`));
    console.log(chalk.dim(`   Directory: ${workingDir}\n`));

    initializeState(workingDir, description, currentBranch);
    console.log(chalk.green('   ✓ Consortium initialized\n'));

    // Start running
    await runConsortium(workingDir, {
      yes: options.yes,
      verbose: options.verbose,
      skipOink: options.skipOink,
      skipCi: options.skipCi,
      skipRats: options.skipRats,
    });
  });

program
  .command('resume')
  .description('Resume an existing consortium')
  .option('-d, --directory <path>', 'Working directory (defaults to current)')
  .option('-y, --yes', 'Auto-proceed through all checkpoints without prompting')
  .option('-v, --verbose', 'Stream agent output in real-time')
  .option('--skip-oink', 'Skip the OINK verification phase')
  .option('--skip-ci', 'Skip the CI_CHECK phase')
  .option('--skip-rats', 'Skip the Rat challenge phase during planning')
  .action(async (options: { directory?: string; yes?: boolean; verbose?: boolean; skipOink?: boolean; skipCi?: boolean; skipRats?: boolean }) => {
    const workingDir = options.directory || process.cwd();

    const state = loadState(workingDir);
    if (!state) {
      console.log(chalk.red('\n❌ No consortium found in this directory.'));
      console.log(chalk.dim('   Use "robot-consortium start <description>" to begin.\n'));
      process.exit(1);
    }

    if (state.phase === 'DONE') {
      console.log(chalk.green('\n✓ This consortium is already complete.\n'));
      process.exit(0);
    }

    if (state.phase === 'FAILED') {
      console.log(chalk.yellow('\n⚠️  This consortium is in FAILED state.'));
      console.log(chalk.dim('   Delete .robot-consortium/ and start fresh.\n'));
      process.exit(1);
    }

    await runConsortium(workingDir, {
      yes: options.yes,
      verbose: options.verbose,
      skipOink: options.skipOink,
      skipCi: options.skipCi,
      skipRats: options.skipRats,
    });
  });

program
  .command('status')
  .description('Show consortium status')
  .option('-d, --directory <path>', 'Working directory (defaults to current)')
  .action((options: { directory?: string }) => {
    const workingDir = options.directory || process.cwd();
    showStatus(workingDir);
  });

program
  .command('abort')
  .description('Abort and clean up the consortium')
  .option('-d, --directory <path>', 'Working directory (defaults to current)')
  .action((options: { directory?: string }) => {
    const workingDir = options.directory || process.cwd();
    const stateDir = `${workingDir}/.robot-consortium`;

    if (!fs.existsSync(stateDir)) {
      console.log(chalk.yellow('\nNo consortium found in this directory.\n'));
      process.exit(0);
    }

    fs.rmSync(stateDir, { recursive: true });
    console.log(chalk.green('\n✓ Consortium aborted and cleaned up.\n'));
  });

program.parse();
