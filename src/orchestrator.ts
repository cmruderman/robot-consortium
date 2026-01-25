import * as readline from 'readline';
import chalk from 'chalk';
import { loadState, updatePhase, getTotalCost } from './state.js';
import { runSurfPhase, runPlanPhase, runBuildPhase, runOinkPhase } from './phases/index.js';
import { Phase } from './types.js';

let rl: readline.Interface | null = null;
let autoYes = false;

const getReadline = (): readline.Interface => {
  if (!rl) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }
  return rl;
};

const ask = (question: string): Promise<string> => {
  if (autoYes) {
    console.log(question + ' [auto: yes]');
    return Promise.resolve('y');
  }
  return new Promise((resolve) => {
    getReadline().question(question, (answer) => {
      resolve(answer.trim());
    });
  });
};

const askYesNo = async (question: string): Promise<boolean> => {
  if (autoYes) {
    console.log(`${question} (y/n): [auto: yes]`);
    return true;
  }
  const answer = await ask(`${question} (y/n): `);
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
};

export interface RunOptions {
  yes?: boolean;
}

export const runConsortium = async (workingDir: string, options: RunOptions = {}): Promise<void> => {
  autoYes = options.yes ?? false;

  const state = loadState(workingDir);
  if (!state) {
    throw new Error('No consortium state found. Run "robot-consortium start" first.');
  }

  console.log(chalk.bold.cyan('\n👑 ROBOT CONSORTIUM'));
  console.log(chalk.dim(`   Task: ${state.description}`));
  console.log(chalk.dim(`   Phase: ${state.phase}`));
  console.log(chalk.dim(`   Working dir: ${state.workingDirectory}\n`));

  if (autoYes) {
    console.log(chalk.yellow('   Mode: Auto-proceed (--yes)\n'));
  }

  try {
    await runFromPhase(workingDir, state.phase);
  } finally {
    if (rl) {
      rl.close();
      rl = null;
    }
  }
};

const runFromPhase = async (workingDir: string, startPhase: Phase): Promise<void> => {
  const phases: Phase[] = ['INIT', 'SURF', 'PLAN', 'BUILD', 'OINK'];
  const startIndex = phases.indexOf(startPhase);

  for (let i = startIndex; i < phases.length; i++) {
    const phase = phases[i];

    switch (phase) {
      case 'INIT':
        // Just move to SURF
        break;

      case 'SURF': {
        const surfResult = await runSurfPhase(workingDir);

        if (!surfResult.success) {
          console.log(chalk.red('\n❌ SURF phase failed. Please review and retry.'));
          return;
        }

        // Handle any questions
        if (surfResult.questions && surfResult.questions.length > 0) {
          console.log(chalk.yellow('\n📋 Agents have questions:'));
          surfResult.questions.forEach(q => console.log(`   ${q}`));
          await ask('\nPress Enter after addressing these questions to continue...');
        }

        // User checkpoint
        console.log(chalk.cyan('\n' + '─'.repeat(60)));
        console.log(chalk.bold('  USER CHECKPOINT: Review SURF findings'));
        console.log(chalk.dim('  Check .robot-consortium/findings/ for exploration results'));
        console.log(chalk.cyan('─'.repeat(60)));

        const continueToplan = await askYesNo('\nProceed to PLAN phase?');
        if (!continueToplan) {
          console.log(chalk.yellow('\nPaused. Run "robot-consortium resume" to continue.'));
          return;
        }
        break;
      }

      case 'PLAN': {
        const planResult = await runPlanPhase(workingDir);

        if (!planResult.success) {
          console.log(chalk.red('\n❌ PLAN phase failed. Please review and retry.'));
          return;
        }

        // Handle any questions
        if (planResult.questions && planResult.questions.length > 0) {
          console.log(chalk.yellow('\n📋 Agents have questions:'));
          planResult.questions.forEach(q => console.log(`   ${q}`));
          await ask('\nPress Enter after addressing these questions to continue...');
        }

        // User checkpoint
        console.log(chalk.cyan('\n' + '─'.repeat(60)));
        console.log(chalk.bold('  USER CHECKPOINT: Review implementation plan'));
        console.log(chalk.dim('  Check .robot-consortium/final-plan.md'));
        console.log(chalk.cyan('─'.repeat(60)));

        const continueToBuild = await askYesNo('\nProceed to BUILD phase?');
        if (!continueToBuild) {
          console.log(chalk.yellow('\nPaused. Run "robot-consortium resume" to continue.'));
          return;
        }
        break;
      }

      case 'BUILD': {
        const buildResult = await runBuildPhase(workingDir);

        if (!buildResult.success) {
          console.log(chalk.red('\n❌ BUILD phase failed. Please review errors and retry.'));
          return;
        }

        // Handle any questions
        if (buildResult.questions && buildResult.questions.length > 0) {
          console.log(chalk.yellow('\n📋 Agents have questions:'));
          buildResult.questions.forEach(q => console.log(`   ${q}`));
          await ask('\nPress Enter after addressing these questions to continue...');
        }

        // No checkpoint before OINK - go straight to verification
        break;
      }

      case 'OINK': {
        const oinkResult = await runOinkPhase(workingDir);

        if (!oinkResult.success) {
          console.log(chalk.red('\n❌ OINK phase failed. Please review and retry.'));
          return;
        }

        if (!oinkResult.passed) {
          console.log(chalk.yellow('\n⚠️  Verification failed. Feedback:'));
          console.log(chalk.dim(oinkResult.feedback?.slice(0, 500) + '...'));
          console.log(chalk.dim('\nFull feedback in .robot-consortium/reviews/'));

          const retry = await askYesNo('\nReturn to BUILD phase with feedback?');
          if (retry) {
            updatePhase(workingDir, 'BUILD');
            await runFromPhase(workingDir, 'BUILD');
            return;
          } else {
            console.log(chalk.yellow('\nPaused at OINK. Run "robot-consortium resume" to retry.'));
            return;
          }
        }

        // Success!
        updatePhase(workingDir, 'DONE');
        break;
      }
    }
  }

  // Final summary
  const totalCost = getTotalCost(workingDir);
  console.log(chalk.green('\n' + '═'.repeat(60)));
  console.log(chalk.bold.green('  ✓ ROBOT CONSORTIUM COMPLETE'));
  console.log(chalk.dim(`    Total estimated cost: $${totalCost.toFixed(2)}`));
  console.log(chalk.green('═'.repeat(60) + '\n'));
};

export const showStatus = (workingDir: string): void => {
  const state = loadState(workingDir);

  if (!state) {
    console.log(chalk.yellow('No active consortium in this directory.'));
    return;
  }

  console.log(chalk.bold.cyan('\n👑 ROBOT CONSORTIUM STATUS\n'));
  console.log(`  ID:          ${state.id}`);
  console.log(`  Task:        ${state.description}`);
  console.log(`  Phase:       ${chalk.bold(state.phase)}`);
  console.log(`  Created:     ${state.createdAt}`);
  console.log(`  Updated:     ${state.updatedAt}`);
  console.log(`  Findings:    ${state.findings.length}`);
  console.log(`  Plans:       ${state.plans.length}`);
  console.log(`  Reviews:     ${state.reviews.length}`);
  console.log(`  Tasks:       ${state.tasks.length}`);
  console.log(`  Total Cost:  $${getTotalCost(workingDir).toFixed(2)}`);

  if (state.questions.pending.length > 0) {
    console.log(chalk.yellow(`\n  ⚠️  ${state.questions.pending.length} pending question(s)`));
  }

  console.log('');
};
