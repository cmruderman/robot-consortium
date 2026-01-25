import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { loadState, updatePhase, addPlan, setFinalPlan, getStateDir } from '../state.js';
import { createAgentConfig, runAgentsInParallel, runAgent, buildCityPlannerPrompt, buildRobotKingPrompt } from '../agents.js';
import { getSurfFindings } from './surf.js';

const PLANNER_PERSPECTIVES = [
  'conservative - minimize risk, prefer incremental changes, prioritize stability',
  'ambitious - aim for the best solution, accept more complexity if justified',
  'minimal - do the least amount of work that solves the problem correctly',
];

export const runPlanPhase = async (workingDir: string): Promise<{ success: boolean; questions?: string[] }> => {
  console.log(chalk.cyan('\n📋 PHASE 2: PLAN'));
  console.log(chalk.dim('  Deploying 3 City Planners to propose approaches...\n'));

  const state = loadState(workingDir);
  if (!state) {
    throw new Error('No consortium state found');
  }

  updatePhase(workingDir, 'PLAN');

  // Get findings from surf phase
  const findings = getSurfFindings(workingDir);

  // Create planner agents
  const planners = PLANNER_PERSPECTIVES.map((perspective, i) =>
    createAgentConfig('city-planner', i + 1, perspective)
  );

  // Build prompts for each planner
  const options = planners.map((planner) => ({
    workingDir,
    prompt: buildCityPlannerPrompt(state.description, findings, planner.focus!),
    allowedTools: ['Read', 'Glob', 'Grep'],
  }));

  // Run planners in parallel
  const results = await runAgentsInParallel(planners, options);

  // Process results
  const failedPlanners: string[] = [];
  const questions: string[] = [];

  results.forEach((result, i) => {
    const planner = planners[i];
    const perspectiveName = PLANNER_PERSPECTIVES[i].split(' - ')[0];

    if (result.success) {
      const filename = `${planner.id}-${perspectiveName}.md`;
      addPlan(workingDir, filename, result.output);
      console.log(chalk.green(`  ✓ ${planner.id} (${perspectiveName}) plan saved`));

      // Check for questions
      if (result.output.includes('QUESTION:') || result.output.includes('Need clarification:')) {
        const questionMatch = result.output.match(/(?:QUESTION:|Need clarification:)\s*(.+?)(?:\n|$)/i);
        if (questionMatch) {
          questions.push(`[${planner.id}] ${questionMatch[1]}`);
        }
      }
    } else {
      failedPlanners.push(planner.id);
      console.log(chalk.red(`  ✗ ${planner.id} failed: ${result.error}`));
    }
  });

  if (failedPlanners.length > 0) {
    console.log(chalk.red(`\n  ${failedPlanners.length} planner(s) failed. Surface to user.`));
    return { success: false };
  }

  // Have Robot King synthesize the plans
  console.log(chalk.dim('\n  Robot King synthesizing final plan...'));

  const allPlans = getPlans(workingDir);
  const synthesisResult = await synthesizePlans(workingDir, state.description, allPlans);

  if (!synthesisResult.success) {
    console.log(chalk.red('  ✗ Failed to synthesize plans'));
    return { success: false };
  }

  setFinalPlan(workingDir, synthesisResult.output);
  console.log(chalk.green('  ✓ Final plan synthesized'));

  const stateDir = getStateDir(workingDir);
  console.log(chalk.dim(`\n  Plans written to: ${stateDir}/plans/`));
  console.log(chalk.dim(`  Final plan: ${stateDir}/final-plan.md`));

  return { success: true, questions: questions.length > 0 ? questions : undefined };
};

const synthesizePlans = async (
  workingDir: string,
  description: string,
  plans: string
) => {
  const robotKing = createAgentConfig('robot-king', 0);

  const prompt = `You are the Robot King. Three City Planners have proposed implementation approaches for this task:

TASK: ${description}

PROPOSED PLANS:
${plans}

Your job: Synthesize these into ONE final implementation plan. Take the best ideas from each.

OUTPUT FORMAT:
# Final Implementation Plan

## Summary
[Brief overview of the chosen approach]

## Tasks
[Numbered list of specific implementation tasks, in order]

## Files to Modify
[List each file with what changes are needed]

## Files to Create
[List any new files needed]

## Testing Requirements
[What tests need to be added/modified]

## Notes
[Any important considerations]

Be specific and actionable. This plan will be handed to implementation agents.`;

  return runAgent(robotKing, {
    workingDir,
    prompt,
    allowedTools: ['Read'],
  });
};

export const getPlans = (workingDir: string): string => {
  const state = loadState(workingDir);
  if (!state) throw new Error('No consortium state found');

  const stateDir = getStateDir(workingDir);
  const plansDir = path.join(stateDir, 'plans');

  let combined = '';

  for (const filename of state.plans) {
    const content = fs.readFileSync(path.join(plansDir, filename), 'utf-8');
    combined += `## ${filename}\n\n${content}\n\n---\n\n`;
  }

  return combined;
};

export const getFinalPlan = (workingDir: string): string => {
  const state = loadState(workingDir);
  if (!state || !state.finalPlan) throw new Error('No final plan found');

  const stateDir = getStateDir(workingDir);
  return fs.readFileSync(path.join(stateDir, state.finalPlan), 'utf-8');
};
