import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { PhaseOptions } from '../types.js';
import { loadState, updatePhase, addPlan, addCritique, setFinalPlan, getStateDir, setPlannerPerspectives, setRatFocuses } from '../state.js';
import { createAgentConfig, runAgentsInParallel, runAgent, buildCityPlannerPrompt, buildPlannerAnalysisPrompt, buildRatPrompt, buildRatAnalysisPrompt } from '../agents.js';
import { getSurfFindings } from './surf.js';

const DEFAULT_PERSPECTIVES = [
  'conservative - minimize risk, prefer incremental changes, prioritize stability',
  'ambitious - aim for the best solution, accept more complexity if justified',
  'minimal - do the least amount of work that solves the problem correctly',
];

export const runPlanPhase = async (workingDir: string, phaseOptions: PhaseOptions = {}): Promise<{ success: boolean; questions?: string[] }> => {
  console.log(chalk.cyan('\n📋 PHASE 2: PLAN'));

  const state = loadState(workingDir);
  if (!state) {
    throw new Error('No consortium state found');
  }

  updatePhase(workingDir, 'PLAN');

  // Get findings from surf phase
  const findings = getSurfFindings(workingDir);

  // Have Robot King analyze findings and determine planner perspectives
  console.log(chalk.dim('  Robot King analyzing findings to determine planner perspectives...\n'));
  const perspectives = await analyzePlannerNeeds(workingDir, state.description, findings, phaseOptions.verbose);

  // Store perspectives in state for reference
  setPlannerPerspectives(workingDir, perspectives);

  console.log(chalk.green(`  ✓ Robot King determined ${perspectives.length} planner(s) needed:`));
  perspectives.forEach((p) => {
    const [name, desc] = p.split(':').map((s) => s.trim());
    console.log(chalk.dim(`    - ${name}: ${desc || 'no description'}`));
  });

  console.log(chalk.dim(`\n  Deploying ${perspectives.length} City Planner(s)...\n`));

  // Create planner agents with dynamic perspectives
  const planners = perspectives.map((perspective, i) =>
    createAgentConfig('city-planner', i + 1, perspective)
  );

  // Build prompts for each planner
  const options = planners.map((planner) => ({
    workingDir,
    prompt: buildCityPlannerPrompt(state.description, findings, planner.focus!),
    allowedTools: ['Read', 'Glob', 'Grep'],
  }));

  // Run planners in parallel
  const results = await runAgentsInParallel(planners, options, {
    verbose: phaseOptions.verbose,
    phaseName: `PLANNERS [${perspectives.length} agents]`,
    phaseIcon: '📋',
  });

  // Process results
  const failedPlanners: string[] = [];
  const questions: string[] = [];

  results.forEach((result, i) => {
    const planner = planners[i];
    const perspectiveName = perspectives[i].split(':')[0].trim();

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

  // --- RAT PHASE: Challenge the plans ---
  const allPlans = getPlans(workingDir);
  let critiquesText = '';

  if (phaseOptions.skipRats) {
    console.log(chalk.yellow('\n  ⏭️  Skipping Rat phase (--skip-rats)'));
  } else {
    const ratResult = await runRatPhase(workingDir, state.description, findings, allPlans, phaseOptions.verbose);
    if (ratResult.success) {
      critiquesText = ratResult.critiques;
    }
    // Rat failures are non-fatal — we proceed with synthesis regardless
  }

  // Have Robot King synthesize the plans (with critiques if available)
  console.log(chalk.dim('\n  Robot King synthesizing final plan...'));

  const synthesisResult = await synthesizePlans(workingDir, state.description, allPlans, perspectives.length, critiquesText, phaseOptions.verbose);

  if (!synthesisResult.success) {
    console.log(chalk.red('  ✗ Failed to synthesize plans'));
    return { success: false };
  }

  setFinalPlan(workingDir, synthesisResult.output);
  console.log(chalk.green('  ✓ Final plan synthesized'));

  const stateDir = getStateDir(workingDir);
  console.log(chalk.dim(`\n  Plans written to: ${stateDir}/plans/`));
  if (critiquesText) {
    console.log(chalk.dim(`  Critiques written to: ${stateDir}/critiques/`));
  }
  console.log(chalk.dim(`  Final plan: ${stateDir}/final-plan.md`));

  return { success: true, questions: questions.length > 0 ? questions : undefined };
};

const analyzePlannerNeeds = async (
  workingDir: string,
  description: string,
  findings: string,
  verbose?: boolean
): Promise<string[]> => {
  const robotKing = createAgentConfig('robot-king', 0);

  const result = await runAgent(robotKing, {
    workingDir,
    prompt: buildPlannerAnalysisPrompt(description, findings),
    allowedTools: ['Read'],
    verbose,
  });

  if (!result.success) {
    console.log(chalk.yellow('  ⚠ Robot King analysis failed, using default perspectives'));
    return DEFAULT_PERSPECTIVES;
  }

  // Parse the perspectives from Robot King's output
  const perspectives = parsePerspectives(result.output);

  if (perspectives.length === 0) {
    console.log(chalk.yellow('  ⚠ Could not parse perspectives, using defaults'));
    return DEFAULT_PERSPECTIVES;
  }

  return perspectives;
};

const parsePerspectives = (output: string): string[] => {
  const perspectives: string[] = [];

  // Look for the PLANNER_PERSPECTIVES block
  const match = output.match(/PLANNER_PERSPECTIVES:\s*([\s\S]*?)END_PERSPECTIVES/);
  if (!match) {
    return [];
  }

  const block = match[1];
  const lines = block.split('\n');

  for (const line of lines) {
    // Match lines like "1. api-design: Focus on clean REST API design"
    const lineMatch = line.match(/^\d+\.\s*(.+)$/);
    if (lineMatch) {
      const perspective = lineMatch[1].trim();
      if (perspective) {
        perspectives.push(perspective);
      }
    }
  }

  // Enforce limits: 1-5 planners
  if (perspectives.length > 5) {
    return perspectives.slice(0, 5);
  }

  return perspectives;
};

const DEFAULT_RAT_FOCUSES = [
  'technical-flaws: Find edge cases, race conditions, breaking changes, and backwards compatibility issues',
  'overengineering: Identify unnecessary complexity, scope creep, and premature abstractions',
  'missing-requirements: Find gaps in coverage, untested paths, and security holes',
];

const runRatPhase = async (
  workingDir: string,
  description: string,
  findings: string,
  plans: string,
  verbose?: boolean
): Promise<{ success: boolean; critiques: string }> => {
  console.log(chalk.cyan('\n  🐀 RAT PHASE: Challenging the plans'));

  // Have Robot King determine rat focuses
  console.log(chalk.dim('  Robot King determining critique angles...\n'));
  const focuses = await analyzeRatNeeds(workingDir, description, plans, verbose);

  setRatFocuses(workingDir, focuses);

  console.log(chalk.green(`  ✓ Robot King determined ${focuses.length} rat(s) needed:`));
  focuses.forEach((f) => {
    const [name, desc] = f.split(':').map((s) => s.trim());
    console.log(chalk.dim(`    - ${name}: ${desc || 'no description'}`));
  });

  console.log(chalk.dim(`\n  Deploying ${focuses.length} Rat(s)...\n`));

  // Create rat agents
  const rats = focuses.map((focus, i) => createAgentConfig('rat', i + 1, focus));

  // Build prompts
  const options = rats.map((rat) => ({
    workingDir,
    prompt: buildRatPrompt(description, findings, plans, rat.focus!),
    allowedTools: ['Read', 'Glob', 'Grep'],
  }));

  // Run rats in parallel
  const results = await runAgentsInParallel(rats, options, {
    verbose,
    phaseName: `RATS [${focuses.length} agents]`,
    phaseIcon: '🐀',
  });

  // Process results
  let allCritiques = '';
  const failedRats: string[] = [];

  results.forEach((result, i) => {
    const rat = rats[i];
    const focusName = focuses[i].split(':')[0].trim();

    if (result.success) {
      const filename = `${rat.id}-${focusName}.md`;
      addCritique(workingDir, filename, result.output);
      allCritiques += `## ${rat.id} (${focusName})\n\n${result.output}\n\n---\n\n`;
      console.log(chalk.green(`  ✓ ${rat.id} (${focusName}) critique saved`));
    } else {
      failedRats.push(rat.id);
      console.log(chalk.red(`  ✗ ${rat.id} failed: ${result.error}`));
    }
  });

  if (failedRats.length > 0) {
    console.log(chalk.yellow(`\n  ⚠ ${failedRats.length} rat(s) failed, proceeding with available critiques`));
  }

  return { success: true, critiques: allCritiques };
};

const analyzeRatNeeds = async (
  workingDir: string,
  description: string,
  plans: string,
  verbose?: boolean
): Promise<string[]> => {
  const robotKing = createAgentConfig('robot-king', 0);

  const result = await runAgent(robotKing, {
    workingDir,
    prompt: buildRatAnalysisPrompt(description, plans),
    allowedTools: ['Read'],
    verbose,
  });

  if (!result.success) {
    console.log(chalk.yellow('  ⚠ Robot King analysis failed, using default rat focuses'));
    return DEFAULT_RAT_FOCUSES;
  }

  const focuses = parseRatFocuses(result.output);

  if (focuses.length === 0) {
    console.log(chalk.yellow('  ⚠ Could not parse rat focuses, using defaults'));
    return DEFAULT_RAT_FOCUSES;
  }

  return focuses;
};

const parseRatFocuses = (output: string): string[] => {
  const focuses: string[] = [];

  const match = output.match(/RAT_FOCUSES:\s*([\s\S]*?)END_RAT_FOCUSES/);
  if (!match) {
    return [];
  }

  const block = match[1];
  const lines = block.split('\n');

  for (const line of lines) {
    const lineMatch = line.match(/^\d+\.\s*(.+)$/);
    if (lineMatch) {
      const focus = lineMatch[1].trim();
      if (focus) {
        focuses.push(focus);
      }
    }
  }

  // Enforce limits: 2-3 rats
  if (focuses.length > 3) {
    return focuses.slice(0, 3);
  }
  if (focuses.length < 2) {
    return DEFAULT_RAT_FOCUSES;
  }

  return focuses;
};

const synthesizePlans = async (
  workingDir: string,
  description: string,
  plans: string,
  plannerCount: number,
  critiques: string,
  verbose?: boolean
) => {
  const robotKing = createAgentConfig('robot-king', 0);

  const critiquesSection = critiques
    ? `

RAT CRITIQUES:
The following critiques were raised against the proposed plans by adversarial Rat agents. Address the valid critiques in your final plan and note which ones you addressed and which you dismissed (with reasoning).

${critiques}`
    : '';

  const prompt = `You are the Robot King. ${plannerCount} City Planner(s) have proposed implementation approaches for this task:

TASK: ${description}

PROPOSED PLANS:
${plans}${critiquesSection}

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
${critiques ? `
## Critiques Addressed
[List each valid critique and how the plan addresses it]

## Critiques Dismissed
[List any dismissed critiques with reasoning]
` : ''}
## Notes
[Any important considerations]

Be specific and actionable. This plan will be handed to implementation agents.`;

  return runAgent(robotKing, {
    workingDir,
    prompt,
    allowedTools: ['Read'],
    verbose,
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
