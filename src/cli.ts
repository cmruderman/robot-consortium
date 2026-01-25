#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import { initializeState, loadState } from './state.js';
import { runConsortium, showStatus } from './orchestrator.js';

const program = new Command();

program
  .name('robot-consortium')
  .description('Multi-agent orchestration CLI for Claude Code')
  .version('0.1.0');

program
  .command('start')
  .description('Start a new consortium task')
  .argument('<description>', 'Description of the task to accomplish')
  .option('-d, --directory <path>', 'Working directory (defaults to current)')
  .action(async (description: string, options: { directory?: string }) => {
    const workingDir = options.directory || process.cwd();

    // Check if there's already an active consortium
    const existing = loadState(workingDir);
    if (existing && existing.phase !== 'DONE' && existing.phase !== 'FAILED') {
      console.log(chalk.yellow(`\n⚠️  Active consortium found (phase: ${existing.phase})`));
      console.log(chalk.dim(`   Use "robot-consortium resume" to continue`));
      console.log(chalk.dim(`   Or delete .robot-consortium/ to start fresh\n`));
      process.exit(1);
    }

    // Clean up old state if exists
    const stateDir = `${workingDir}/.robot-consortium`;
    if (fs.existsSync(stateDir)) {
      fs.rmSync(stateDir, { recursive: true });
    }

    console.log(chalk.bold.cyan('\n👑 ROBOT CONSORTIUM\n'));
    console.log(chalk.dim(`   Initializing new consortium...`));
    console.log(chalk.dim(`   Task: ${description}`));
    console.log(chalk.dim(`   Directory: ${workingDir}\n`));

    initializeState(workingDir, description);
    console.log(chalk.green('   ✓ Consortium initialized\n'));

    // Start running
    await runConsortium(workingDir);
  });

program
  .command('resume')
  .description('Resume an existing consortium')
  .option('-d, --directory <path>', 'Working directory (defaults to current)')
  .action(async (options: { directory?: string }) => {
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

    await runConsortium(workingDir);
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
