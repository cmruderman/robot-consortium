import chalk from 'chalk';
import { loadState, updatePhase, addTask, updateTask } from '../state.js';
import { createAgentConfig, runAgent, runAgentsInParallel, buildDawgPrompt } from '../agents.js';
import { getFinalPlan } from './plan.js';
import { Task } from '../types.js';

interface BuildTask {
  id: string;
  description: string;
  dependencies: string[];
}

export const runBuildPhase = async (workingDir: string): Promise<{ success: boolean; questions?: string[] }> => {
  console.log(chalk.cyan('\n🔨 PHASE 3: BUILD'));
  console.log(chalk.dim('  Analyzing plan for implementation tasks...\n'));

  const state = loadState(workingDir);
  if (!state) {
    throw new Error('No consortium state found');
  }

  updatePhase(workingDir, 'BUILD');

  const finalPlan = getFinalPlan(workingDir);

  // First, have Robot King break down the plan into tasks
  const tasks = await extractTasksFromPlan(workingDir, state.description, finalPlan);

  if (tasks.length === 0) {
    console.log(chalk.yellow('  No implementation tasks extracted. Treating as single task.'));
    tasks.push({
      id: 'task-1',
      description: 'Implement the full plan',
      dependencies: [],
    });
  }

  console.log(chalk.dim(`  Found ${tasks.length} implementation task(s)\n`));

  // Create task records
  for (const task of tasks) {
    addTask(workingDir, {
      description: task.description,
      status: 'pending',
      blockedBy: task.dependencies,
    });
  }

  // Determine which tasks can run in parallel (no dependencies)
  const independentTasks = tasks.filter(t => t.dependencies.length === 0);
  const dependentTasks = tasks.filter(t => t.dependencies.length > 0);

  const questions: string[] = [];
  const failedTasks: string[] = [];

  // Run independent tasks in parallel
  if (independentTasks.length > 0) {
    console.log(chalk.dim(`  Running ${independentTasks.length} independent task(s) in parallel...`));

    const dawgs = independentTasks.map((_, i) => createAgentConfig('dawg', i + 1));
    const options = independentTasks.map((task) => ({
      workingDir,
      prompt: buildDawgPrompt(state.description, finalPlan, task.description),
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(yarn*)', 'Bash(npm*)', 'Bash(git diff*)'],
    }));

    const results = await runAgentsInParallel(dawgs, options);

    results.forEach((result, i) => {
      const task = independentTasks[i];
      const dawg = dawgs[i];

      if (result.success) {
        updateTask(workingDir, task.id, { status: 'completed', output: result.output });
        console.log(chalk.green(`  ✓ ${dawg.id} completed: ${task.description.slice(0, 50)}...`));

        if (result.output.includes('QUESTION:')) {
          const match = result.output.match(/QUESTION:\s*(.+?)(?:\n|$)/i);
          if (match) questions.push(`[${dawg.id}] ${match[1]}`);
        }
      } else {
        updateTask(workingDir, task.id, { status: 'failed', error: result.error });
        failedTasks.push(task.id);
        console.log(chalk.red(`  ✗ ${dawg.id} failed: ${result.error}`));
      }
    });
  }

  // Run dependent tasks sequentially
  for (const task of dependentTasks) {
    // Check if dependencies are met
    const updatedState = loadState(workingDir);
    const deps = updatedState?.tasks.filter(t => task.dependencies.includes(t.id));
    const allDepsMet = deps?.every(d => d.status === 'completed');

    if (!allDepsMet) {
      console.log(chalk.yellow(`  ⏭ Skipping ${task.id} - dependencies not met`));
      updateTask(workingDir, task.id, { status: 'blocked' });
      continue;
    }

    const dawg = createAgentConfig('dawg', dependentTasks.indexOf(task) + independentTasks.length + 1);
    console.log(chalk.dim(`  Running ${dawg.id} for: ${task.description.slice(0, 50)}...`));

    const result = await runAgent(dawg, {
      workingDir,
      prompt: buildDawgPrompt(state.description, finalPlan, task.description),
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(yarn*)', 'Bash(npm*)', 'Bash(git diff*)'],
    });

    if (result.success) {
      updateTask(workingDir, task.id, { status: 'completed', output: result.output });
      console.log(chalk.green(`  ✓ ${dawg.id} completed`));

      if (result.output.includes('QUESTION:')) {
        const match = result.output.match(/QUESTION:\s*(.+?)(?:\n|$)/i);
        if (match) questions.push(`[${dawg.id}] ${match[1]}`);
      }
    } else {
      updateTask(workingDir, task.id, { status: 'failed', error: result.error });
      failedTasks.push(task.id);
      console.log(chalk.red(`  ✗ ${dawg.id} failed: ${result.error}`));
    }
  }

  if (failedTasks.length > 0) {
    console.log(chalk.red(`\n  ${failedTasks.length} task(s) failed. Surface to user.`));
    return { success: false };
  }

  console.log(chalk.green('\n  All implementation tasks completed.'));
  return { success: true, questions: questions.length > 0 ? questions : undefined };
};

const extractTasksFromPlan = async (
  workingDir: string,
  description: string,
  plan: string
): Promise<BuildTask[]> => {
  const robotKing = createAgentConfig('robot-king', 0);

  const prompt = `Extract implementation tasks from this plan.

TASK: ${description}

PLAN:
${plan}

Return a JSON array of tasks. Each task should have:
- id: string (e.g., "task-1")
- description: string (what to implement)
- dependencies: string[] (IDs of tasks that must complete first)

Tasks that can run in parallel should have empty dependencies.
Tasks that depend on others should list those task IDs.

RESPOND WITH ONLY THE JSON ARRAY, NO OTHER TEXT.

Example:
[
  {"id": "task-1", "description": "Create the new component file", "dependencies": []},
  {"id": "task-2", "description": "Add the API endpoint", "dependencies": []},
  {"id": "task-3", "description": "Wire up the component to the API", "dependencies": ["task-1", "task-2"]}
]`;

  const result = await runAgent(robotKing, {
    workingDir,
    prompt,
    allowedTools: [],
  });

  if (!result.success) {
    return [];
  }

  try {
    // Try to extract JSON from the response
    const jsonMatch = result.output.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return [];
  } catch {
    console.log(chalk.yellow('  Could not parse tasks from plan, treating as single task'));
    return [];
  }
};
