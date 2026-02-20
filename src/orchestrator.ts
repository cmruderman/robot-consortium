import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { loadState, updatePhase, getTotalCost, getStateDir, saveState } from './state.js';
import { runSurfPhase, runPlanPhase, runBuildPhase, runOinkPhase, runPRPhase, runCICheckPhase, runSimpleMode } from './phases/index.js';
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
  verbose?: boolean;
  skipOink?: boolean;
  skipCi?: boolean;
  skipRats?: boolean;
  planOnly?: boolean;
  simple?: boolean;
}

let verboseMode = false;
let skipOink = false;
let skipCi = false;
let skipRats = false;
let planOnly = false;
let simpleMode = false;

export const runConsortium = async (workingDir: string, options: RunOptions = {}): Promise<void> => {
  autoYes = options.yes ?? false;
  verboseMode = options.verbose ?? false;
  skipOink = options.skipOink ?? false;
  skipCi = options.skipCi ?? false;
  skipRats = options.skipRats ?? false;
  planOnly = options.planOnly ?? false;
  simpleMode = options.simple ?? false;

  const state = loadState(workingDir);
  if (!state) {
    throw new Error('No consortium state found. Run "robot-consortium start" first.');
  }

  if (planOnly && ['BUILD', 'OINK', 'PR', 'CI_CHECK'].includes(state.phase)) {
    console.log(chalk.yellow(`\n⚠️  --plan-only has no effect when resuming from ${state.phase} (already past PLAN phase)\n`));
    planOnly = false;
  }

  console.log(chalk.bold.cyan('\n👑 ROBOT CONSORTIUM'));
  console.log(chalk.dim(`   Task: ${state.description}`));
  console.log(chalk.dim(`   Phase: ${state.phase}`));
  console.log(chalk.dim(`   Working dir: ${state.workingDirectory}\n`));

  if (autoYes) {
    console.log(chalk.yellow('   Mode: Auto-proceed (--yes)'));
  }
  if (verboseMode) {
    console.log(chalk.yellow('   Mode: Verbose (--verbose)'));
  }
  if (skipOink) {
    console.log(chalk.yellow('   Mode: Skip OINK (--skip-oink)'));
  }
  if (skipCi) {
    console.log(chalk.yellow('   Mode: Skip CI (--skip-ci)'));
  }
  if (skipRats) {
    console.log(chalk.yellow('   Mode: Skip Rats (--skip-rats)'));
  }
  if (planOnly) {
    console.log(chalk.yellow('   Mode: Plan Only (--plan-only)'));
  }
  if (simpleMode) {
    console.log(chalk.yellow('   Mode: Simple / One-Shot (--simple)'));
  }
  if (autoYes || verboseMode || skipOink || skipCi || skipRats || planOnly || simpleMode) {
    console.log('');
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
  // Simple/one-shot mode: skip SURF and PLAN entirely, single Dawg → OINK → PR
  if (simpleMode && (startPhase === 'INIT' || startPhase === 'SURF' || startPhase === 'PLAN')) {
    const state = loadState(workingDir);
    if (!state) throw new Error('No consortium state found');

    const simpleResult = await runSimpleMode(workingDir, { verbose: verboseMode });
    if (!simpleResult.success) {
      console.log(chalk.red('\n❌ Simple mode failed. Check .robot-consortium/failure-report.md for details.'));
      return;
    }

    // Jump directly to OINK (skip SURF/PLAN/BUILD, those were all done by the single Dawg)
    await runFromPhase(workingDir, skipOink ? 'PR' : 'OINK');
    return;
  }

  const phases: Phase[] = ['INIT', 'SURF', 'PLAN', 'BUILD', 'OINK', 'PR', 'CI_CHECK'];
  const startIndex = phases.indexOf(startPhase);

  for (let i = startIndex; i < phases.length; i++) {
    const phase = phases[i];

    switch (phase) {
      case 'INIT':
        // Just move to SURF
        break;

      case 'SURF': {
        const surfResult = await runSurfPhase(workingDir, { verbose: verboseMode });

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
        const planResult = await runPlanPhase(workingDir, { verbose: verboseMode, skipRats, planOnly });

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

        if (planOnly) {
          // Plan-only mode: commit plan files, push branch, open PR
          const stateDir = getStateDir(workingDir);
          const state = loadState(workingDir)!;

          // Read the final plan for the PR body
          const finalPlanPath = path.join(stateDir, 'final-plan.md');
          const finalPlan = fs.existsSync(finalPlanPath)
            ? fs.readFileSync(finalPlanPath, 'utf-8')
            : 'No plan document generated.';

          // Commit plan files
          try {
            execSync('git add -f .robot-consortium/', { cwd: workingDir });
            const commitDesc = state.description.split('\n')[0].slice(0, 60);
            execSync(`git commit -m "docs: robot-consortium plan for ${commitDesc.replace(/"/g, '\\"')}"`, { cwd: workingDir });
            console.log(chalk.green('  ✓ Plan files committed'));
          } catch {
            // Nothing to commit or not a git repo
          }

          // Push the branch
          let pushed = false;
          try {
            const branchName = execSync('git branch --show-current', { cwd: workingDir, encoding: 'utf-8' }).trim();
            execSync(`git push -u origin ${branchName}`, { cwd: workingDir, stdio: 'inherit' });
            console.log(chalk.green('  ✓ Branch pushed'));
            pushed = true;
          } catch (error) {
            console.log(chalk.yellow(`  ⚠ Could not push branch: ${error instanceof Error ? error.message : String(error)}`));
          }

          // Create PR
          let prUrl: string | undefined;
          if (pushed) {
            try {
              const titleDesc = state.description.split('\n')[0].slice(0, 60);
              const prTitle = `[RC Plan] ${titleDesc}`;
              const prBody = `> **Plan-only run** — no code changes. This PR contains the implementation plan for review.\n\n${finalPlan}`;
              const bodyFile = path.join(stateDir, 'pr-body.md');
              fs.writeFileSync(bodyFile, prBody);

              const prResult = execSync(
                `gh pr create --title "${prTitle.replace(/"/g, '\\"')}" --body-file "${bodyFile}"`,
                { cwd: workingDir, encoding: 'utf-8' }
              );
              prUrl = prResult.trim();
              state.prUrl = prUrl;
              saveState(workingDir, state);
              console.log(chalk.green(`  ✓ PR created: ${prUrl}`));
            } catch (error) {
              console.log(chalk.yellow(`  ⚠ Could not create PR: ${error instanceof Error ? error.message : String(error)}`));
            }
          }

          console.log(chalk.green('\n' + '═'.repeat(60)));
          console.log(chalk.bold.green('  ✓ PLAN COMPLETE'));
          if (prUrl) {
            console.log(chalk.bold(`    PR: ${prUrl}`));
          }
          console.log(chalk.dim(`    Plan document: ${stateDir}/final-plan.md`));
          console.log(chalk.dim(`    Individual plans: ${stateDir}/plans/`));
          console.log(chalk.dim(`    Findings: ${stateDir}/findings/`));
          const totalCost = getTotalCost(workingDir);
          console.log(chalk.dim(`    Total estimated cost: $${totalCost.toFixed(2)}`));
          console.log(chalk.green('═'.repeat(60) + '\n'));
          updatePhase(workingDir, 'DONE');
          return;
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
        const buildResult = await runBuildPhase(workingDir, { verbose: verboseMode });

        if (!buildResult.success) {
          const failState = loadState(workingDir);
          console.log(chalk.red('\n❌ BUILD phase failed. Check .robot-consortium/failure-report.md for details.'));
          if (failState?.preBuildSha) {
            console.log(chalk.dim(`   To revert: git reset --hard ${failState.preBuildSha}`));
          }
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
        if (skipOink) {
          console.log(chalk.yellow('\n⏭️  Skipping OINK phase (--skip-oink)'));
          break;
        }

        const oinkResult = await runOinkPhase(workingDir, { verbose: verboseMode });

        if (!oinkResult.success) {
          console.log(chalk.red('\n❌ OINK phase failed. Please review and retry.'));
          return;
        }

        if (!oinkResult.passed) {
          console.log(chalk.yellow('\n⚠️  Final verification failed (per-task checks passed but integration issues found). Feedback:'));
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

        // Proceed to PR phase
        break;
      }

      case 'PR': {
        const prResult = await runPRPhase(workingDir, { verbose: verboseMode });

        if (!prResult.success) {
          console.log(chalk.red('\n❌ PR phase failed. Please review and retry.'));
          return;
        }

        console.log(chalk.green(`\n  PR created: ${prResult.prUrl}`));
        // Proceed to CI check
        break;
      }

      case 'CI_CHECK': {
        if (skipCi || skipOink) {
          console.log(chalk.yellow(`\n⏭️  Skipping CI_CHECK phase (${skipOink ? '--skip-oink' : '--skip-ci'})`));
          updatePhase(workingDir, 'DONE');
          break;
        }

        const ciResult = await runCICheckPhase(workingDir, { verbose: verboseMode });

        if (!ciResult.success) {
          console.log(chalk.red('\n❌ CI_CHECK phase failed. Please review and retry.'));
          return;
        }

        if (ciResult.ciPassed) {
          // Success - move to DONE
          updatePhase(workingDir, 'DONE');
        } else if (ciResult.needsRetry) {
          // Loop back to CI_CHECK after fixes
          console.log(chalk.yellow('\n  CI fixes pushed. Checking again...'));
          await runFromPhase(workingDir, 'CI_CHECK');
          return;
        } else {
          // Max attempts reached or other issue
          console.log(chalk.yellow('\n  Moving to DONE despite CI issues. Manual review may be needed.'));
          updatePhase(workingDir, 'DONE');
        }
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
  console.log(`  Task:        ${state.description.slice(0, 60)}${state.description.length > 60 ? '...' : ''}`);
  console.log(`  Phase:       ${chalk.bold(state.phase)}`);
  console.log(`  Branch:      ${state.branchName || 'N/A'}`);
  console.log(`  Created:     ${state.createdAt}`);
  console.log(`  Updated:     ${state.updatedAt}`);
  console.log(`  Findings:    ${state.findings.length}`);
  console.log(`  Plans:       ${state.plans.length}`);
  console.log(`  Reviews:     ${state.reviews.length}`);
  console.log(`  Tasks:       ${state.tasks.length}`);
  console.log(`  Total Cost:  $${getTotalCost(workingDir).toFixed(2)}`);

  if (state.prUrl) {
    console.log(`  PR:          ${state.prUrl}`);
    console.log(`  CI Attempts: ${state.ciCheckAttempts || 0}`);
  }

  if (state.questions.pending.length > 0) {
    console.log(chalk.yellow(`\n  ⚠️  ${state.questions.pending.length} pending question(s)`));
  }

  console.log('');
};
