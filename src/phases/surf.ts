import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { PhaseOptions } from '../types.js';
import { loadState, updatePhase, addFinding, getStateDir, setSurferFocuses, setConventions, setCodePatterns, getConventions, getCodePatterns } from '../state.js';
import { createAgentConfig, runAgentsInParallel, runAgent, buildSurferPrompt, buildSurferAnalysisPrompt, buildConventionsSurferPrompt } from '../agents.js';

const CONVENTIONS_FOCUS = 'project-conventions: Extract project conventions from CLAUDE.md, .claude/commands/, config files';

const DEFAULT_FOCUSES = [
  'existing-patterns: existing patterns and conventions in the codebase',
  'similar-features: similar features or implementations that already exist',
  'test-infrastructure: test patterns and testing infrastructure',
];

export const runSurfPhase = async (workingDir: string, phaseOptions: PhaseOptions = {}): Promise<{ success: boolean; questions?: string[] }> => {
  console.log(chalk.cyan('\n🏄 PHASE 1: SURF'));

  const state = loadState(workingDir);
  if (!state) {
    throw new Error('No consortium state found');
  }

  updatePhase(workingDir, 'SURF');

  // Have Robot King analyze task and determine surfer focuses
  console.log(chalk.dim('  Robot King analyzing task to determine exploration focuses...\n'));
  const dynamicFocuses = await analyzeSurferNeeds(workingDir, state.description, phaseOptions.verbose);

  // Always prepend mandatory project-conventions surfer
  const allFocuses = [CONVENTIONS_FOCUS, ...dynamicFocuses];

  // Store focuses in state for reference
  setSurferFocuses(workingDir, allFocuses);

  console.log(chalk.green(`  ✓ Robot King determined ${allFocuses.length} surfer(s) needed:`));
  allFocuses.forEach((f) => {
    const [name, desc] = f.split(':').map((s) => s.trim());
    console.log(chalk.dim(`    - ${name}: ${desc || 'no description'}`));
  });

  console.log(chalk.dim(`\n  Deploying ${allFocuses.length} Surfer(s)...\n`));

  // Create surfer agents with dynamic focuses
  const surfers = allFocuses.map((focus, i) => createAgentConfig('surfer', i + 1, focus));

  // Build prompts — conventions surfer gets a special prompt, others get the structured prompt
  const options = surfers.map((surfer, i) => ({
    workingDir,
    prompt: i === 0
      ? buildConventionsSurferPrompt(state.description)
      : buildSurferPrompt(state.description, surfer.focus!),
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash(git log*)', 'Bash(git show*)'],
  }));

  // Run surfers in parallel
  const results = await runAgentsInParallel(surfers, options, {
    verbose: phaseOptions.verbose,
    phaseName: `SURFERS [${allFocuses.length} agents]`,
    phaseIcon: '🏄',
  });

  // Process results
  const failedSurfers: string[] = [];
  const questions: string[] = [];

  results.forEach((result, i) => {
    const surfer = surfers[i];
    const focusName = allFocuses[i].split(':')[0].trim();

    if (result.success) {
      const filename = `${surfer.id}-${focusName}.md`;
      addFinding(workingDir, filename, result.output);
      console.log(chalk.green(`  ✓ ${surfer.id} (${focusName}) findings saved`));

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

  // Separate conventions from code patterns
  const conventionsResult = results[0]; // First surfer is always conventions
  if (conventionsResult.success) {
    setConventions(workingDir, conventionsResult.output);
    console.log(chalk.green('  ✓ Project conventions extracted'));
  } else {
    console.log(chalk.yellow('  ⚠ Conventions surfer failed — proceeding without conventions'));
  }

  // Combine all non-conventions findings as structured code patterns
  const codePatternOutputs = results.slice(1)
    .filter(r => r.success)
    .map(r => r.output);
  if (codePatternOutputs.length > 0) {
    setCodePatterns(workingDir, codePatternOutputs.join('\n\n---\n\n'));
    console.log(chalk.green(`  ✓ Code patterns extracted from ${codePatternOutputs.length} surfer(s)`));
  }

  // Allow conventions surfer to fail without blocking the phase
  const nonConventionFailures = failedSurfers.filter(id => id !== surfers[0].id);
  if (nonConventionFailures.length > 0) {
    console.log(chalk.red(`\n  ${nonConventionFailures.length} surfer(s) failed. Surface to user.`));
    return { success: false };
  }

  console.log(chalk.green('\n  All surfers completed successfully.'));

  // List findings
  const stateDir = getStateDir(workingDir);
  const findingsDir = path.join(stateDir, 'findings');
  console.log(chalk.dim(`\n  Findings written to: ${findingsDir}/`));

  return { success: true, questions: questions.length > 0 ? questions : undefined };
};

const analyzeSurferNeeds = async (
  workingDir: string,
  description: string,
  verbose?: boolean
): Promise<string[]> => {
  const robotKing = createAgentConfig('robot-king', 0);

  const result = await runAgent(robotKing, {
    workingDir,
    prompt: buildSurferAnalysisPrompt(description),
    allowedTools: [],
    verbose,
  });

  if (!result.success) {
    console.log(chalk.yellow('  ⚠ Robot King analysis failed, using default focuses'));
    return DEFAULT_FOCUSES;
  }

  // Parse the focuses from Robot King's output
  const focuses = parseSurferFocuses(result.output);

  if (focuses.length === 0) {
    console.log(chalk.yellow('  ⚠ Could not parse focuses, using defaults'));
    return DEFAULT_FOCUSES;
  }

  return focuses;
};

const parseSurferFocuses = (output: string): string[] => {
  const focuses: string[] = [];

  // Look for the SURFER_FOCUSES block
  const match = output.match(/SURFER_FOCUSES:\s*([\s\S]*?)END_FOCUSES/);
  if (!match) {
    return [];
  }

  const block = match[1];
  const lines = block.split('\n');

  for (const line of lines) {
    // Match lines like "1. existing-patterns: Look for existing patterns"
    const lineMatch = line.match(/^\d+\.\s*(.+)$/);
    if (lineMatch) {
      const focus = lineMatch[1].trim();
      if (focus) {
        focuses.push(focus);
      }
    }
  }

  // Enforce limits: 2-4 dynamic surfers (conventions surfer is added separately)
  if (focuses.length > 4) {
    return focuses.slice(0, 4);
  }
  if (focuses.length < 2) {
    return DEFAULT_FOCUSES;
  }

  return focuses;
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

export const getSurfConventions = (workingDir: string): string => {
  return getConventions(workingDir);
};

export const getSurfCodePatterns = (workingDir: string): string => {
  return getCodePatterns(workingDir);
};
