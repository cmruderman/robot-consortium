import chalk from 'chalk';
import { PhaseOptions } from '../types.js';
import { loadState, updatePhase, addTask, updateTask } from '../state.js';
import { createAgentConfig, runAgent, runAgentsInParallel, runRobotKing, buildDawgPrompt, buildTestDawgPrompt, buildTaskVerificationPrompt } from '../agents.js';
import { PhaseDisplay } from '../display.js';
import { getFinalPlan } from './plan.js';
import { getSurfConventions, getSurfCodePatterns } from './surf.js';

interface BuildTask {
  id: string;
  description: string;
  dependencies: string[];
  taskType: 'test' | 'implementation';
  testTaskIds?: string[];
}

const MAX_VERIFICATION_ATTEMPTS = 2;

export const runBuildPhase = async (workingDir: string, phaseOptions: PhaseOptions = {}): Promise<{ success: boolean; questions?: string[] }> => {
  console.log(chalk.cyan('\n🔨 PHASE 3: BUILD'));
  console.log(chalk.dim('  Analyzing plan for test and implementation tasks...\n'));

  const state = loadState(workingDir);
  if (!state) {
    throw new Error('No consortium state found');
  }

  updatePhase(workingDir, 'BUILD');

  const finalPlan = getFinalPlan(workingDir);
  const conventions = getSurfConventions(workingDir) || undefined;
  const codePatterns = getSurfCodePatterns(workingDir) || undefined;

  // Extract tasks from plan — now categorized as test vs implementation
  const tasks = await extractTasksFromPlan(workingDir, state.description, finalPlan, phaseOptions.verbose);

  if (tasks.length === 0) {
    console.log(chalk.yellow('  No tasks extracted. Treating as single implementation task.'));
    tasks.push({
      id: 'task-1',
      description: 'Implement the full plan',
      dependencies: [],
      taskType: 'implementation',
    });
  }

  const testTasks = tasks.filter(t => t.taskType === 'test');
  const implTasks = tasks.filter(t => t.taskType === 'implementation');

  console.log(chalk.dim(`  Found ${testTasks.length} test task(s) and ${implTasks.length} implementation task(s)\n`));

  // Create task records in state — remap IDs to match state-generated IDs
  const idMap: Record<string, string> = {};
  for (const task of tasks) {
    const stateTask = addTask(workingDir, {
      description: task.description,
      status: 'pending',
      blockedBy: task.dependencies,
      taskType: task.taskType,
    });
    idMap[task.id] = stateTask.id;
  }
  // Remap all local IDs to match state
  for (const task of tasks) {
    task.id = idMap[task.id] || task.id;
    task.dependencies = task.dependencies.map(d => idMap[d] || d);
    if (task.testTaskIds) {
      task.testTaskIds = task.testTaskIds.map(id => idMap[id] || id);
    }
  }
  // Fix blockedBy in state (was stored with LLM IDs)
  for (const task of tasks) {
    if (task.dependencies.length > 0) {
      updateTask(workingDir, task.id, { blockedBy: task.dependencies });
    }
  }

  const questions: string[] = [];
  const failedTasks: string[] = [];

  // Track test file outputs from Stage 1 keyed by test task id
  const testFilesByTaskId: Record<string, string> = {};

  // ── STAGE 1: Test Dawgs write tests first ──
  if (testTasks.length > 0) {
    console.log(chalk.cyan('\n  ── Stage 1: Writing Tests ──'));
    console.log(chalk.dim(`  Deploying ${testTasks.length} Test Dawg(s)...\n`));

    const testDawgs = testTasks.map((_, i) => createAgentConfig('dawg', i + 1));
    const testOptions = testTasks.map((task) => ({
      workingDir,
      prompt: buildTestDawgPrompt(
        state.description,
        finalPlan,
        task.description,
        conventions,
        codePatterns
      ),
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(yarn*)', 'Bash(npm*)', 'Bash(git diff*)'],
    }));

    const testResults = await runAgentsInParallel(testDawgs, testOptions, {
      verbose: phaseOptions.verbose,
      phaseName: `TEST DAWGS [${testTasks.length} agents]`,
      phaseIcon: '🧪',
    });

    testResults.forEach((result, i) => {
      const task = testTasks[i];
      const dawg = testDawgs[i];

      if (result.success) {
        updateTask(workingDir, task.id, {
          status: 'completed',
          output: result.output,
          taskType: 'test',
        });
        // Store test output for impl dawgs to reference
        testFilesByTaskId[task.id] = result.output;
        console.log(chalk.green(`  ✓ ${dawg.id} tests written: ${task.description.slice(0, 50)}...`));
      } else {
        updateTask(workingDir, task.id, { status: 'failed', error: result.error, taskType: 'test' });
        failedTasks.push(task.id);
        console.log(chalk.red(`  ✗ ${dawg.id} failed: ${result.error}`));
      }
    });

    if (failedTasks.length > 0) {
      console.log(chalk.red(`\n  ${failedTasks.length} test task(s) failed. Cannot proceed to implementation.`));
      return { success: false };
    }

    console.log(chalk.green(`\n  ✓ Stage 1 complete — ${testTasks.length} test suite(s) written`));
  } else {
    console.log(chalk.yellow('\n  No test tasks in plan — proceeding directly to implementation'));
  }

  // ── STAGE 2: Implementation Dawgs write code to pass tests ──
  console.log(chalk.cyan('\n  ── Stage 2: Implementation ──'));

  const independentImpl = implTasks.filter(t => t.dependencies.length === 0);
  const dependentImpl = implTasks.filter(t => t.dependencies.length > 0);

  // Helper: collect test file content for an impl task
  const getTestFilesForTask = (task: BuildTask): string | undefined => {
    if (!task.testTaskIds || task.testTaskIds.length === 0) return undefined;
    const parts = task.testTaskIds
      .map(id => testFilesByTaskId[id])
      .filter(Boolean);
    return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined;
  };

  // Helper: run implementation + per-task verification
  const runImplWithVerification = async (
    task: BuildTask,
    dawgIndex: number,
    display?: PhaseDisplay
  ): Promise<{ success: boolean; output: string; error?: string; questions: string[] }> => {
    const taskQuestions: string[] = [];
    const testFiles = getTestFilesForTask(task);

    for (let attempt = 0; attempt <= MAX_VERIFICATION_ATTEMPTS; attempt++) {
      const dawg = createAgentConfig('dawg', dawgIndex);
      const isRetry = attempt > 0;

      if (isRetry) {
        if (display) {
          display.updateStatus(task.id, `retry ${attempt}/${MAX_VERIFICATION_ATTEMPTS}`);
        } else {
          console.log(chalk.yellow(`  ↻ ${dawg.id} retry ${attempt}/${MAX_VERIFICATION_ATTEMPTS} for: ${task.description.slice(0, 50)}...`));
        }
      } else if (display) {
        display.updateStatus(task.id, 'implementing');
      }

      const result = await runAgent(dawg, {
        workingDir,
        prompt: buildDawgPrompt(
          state.description,
          finalPlan,
          task.description,
          conventions,
          codePatterns,
          testFiles
        ),
        allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(yarn*)', 'Bash(npm*)', 'Bash(git diff*)'],
        verbose: phaseOptions.verbose,
        quiet: !!display,
      });

      if (!result.success) {
        if (display) {
          display.markFailed(task.id, result.error);
        }
        return { success: false, output: '', error: result.error, questions: taskQuestions };
      }

      if (result.output.includes('QUESTION:')) {
        const match = result.output.match(/QUESTION:\s*(.+?)(?:\n|$)/i);
        if (match) taskQuestions.push(`[${dawg.id}] ${match[1]}`);
      }

      // Per-task verification: only if we have test files
      if (!testFiles) {
        if (display) {
          display.markDone(task.id, 'done');
        }
        return { success: true, output: result.output, questions: taskQuestions };
      }

      if (display) {
        display.updateStatus(task.id, 'verifying');
      } else {
        console.log(chalk.dim(`  [${dawg.id}] Running per-task verification...`));
      }

      const verifyPig = createAgentConfig('pig', dawgIndex);
      const verifyResult = await runAgent(verifyPig, {
        workingDir,
        prompt: buildTaskVerificationPrompt(task.description, 'Run the relevant tests and report results.', testFiles),
        allowedTools: ['Bash(yarn*)', 'Bash(npm*)', 'Read', 'Glob', 'Grep'],
        verbose: phaseOptions.verbose,
        quiet: !!display,
      });

      if (!verifyResult.success) {
        if (display) {
          display.markDone(task.id, 'verify skipped');
        } else {
          console.log(chalk.yellow(`  [${dawg.id}] Verification pig failed to run — skipping verification`));
        }
        return { success: true, output: result.output, questions: taskQuestions };
      }

      const passed = verifyResult.output.includes('VERDICT: PASS');

      if (passed) {
        if (display) {
          display.markDone(task.id, 'verified');
        } else {
          console.log(chalk.green(`  [${dawg.id}] ✓ Per-task verification passed`));
        }
        return { success: true, output: result.output, questions: taskQuestions };
      }

      if (!display) {
        console.log(chalk.yellow(`  [${dawg.id}] ✗ Per-task verification failed`));
      }

      if (attempt < MAX_VERIFICATION_ATTEMPTS) {
        // Feed failure back to dawg — only keep the most recent failure to avoid ballooning prompts
        const baseDescription = task.description.split('\n\nPREVIOUS ATTEMPT FAILED')[0];
        task.description = `${baseDescription}\n\nPREVIOUS ATTEMPT FAILED. Verification feedback:\n${verifyResult.output}\n\nFix the issues and try again.`;
        updateTask(workingDir, task.id, { verificationAttempts: attempt + 1 });
      } else {
        if (display) {
          display.markFailed(task.id, `failed after ${MAX_VERIFICATION_ATTEMPTS} retries`);
        } else {
          console.log(chalk.red(`  [${dawg.id}] Exhausted ${MAX_VERIFICATION_ATTEMPTS} verification retries`));
        }
        return { success: false, output: result.output, error: `Per-task verification failed after ${MAX_VERIFICATION_ATTEMPTS} retries`, questions: taskQuestions };
      }
    }

    return { success: false, output: '', error: 'Unexpected end of verification loop', questions: taskQuestions };
  };

  // Run independent impl tasks in parallel
  if (independentImpl.length > 0) {
    console.log(chalk.dim(`  Running ${independentImpl.length} independent implementation task(s)...\n`));

    const implDisplay = new PhaseDisplay(
      `IMPL DAWGS [${independentImpl.length} tasks]`,
      '🔨',
      phaseOptions.verbose
    );

    // Register each task in the display
    independentImpl.forEach((task, i) => {
      const dawg = createAgentConfig('dawg', i + testTasks.length + 1);
      implDisplay.registerAgent(task.id, task.description.slice(0, 60), dawg.model);
    });

    implDisplay.start();

    // For parallel tasks, we run them concurrently but each includes its own verification loop
    const implPromises = independentImpl.map((task, i) => {
      const dawgIndex = i + testTasks.length + 1;
      updateTask(workingDir, task.id, { status: 'in_progress' });
      return runImplWithVerification(task, dawgIndex, implDisplay);
    });

    const implResults = await Promise.all(implPromises);

    implDisplay.stop();

    implResults.forEach((result, i) => {
      const task = independentImpl[i];
      questions.push(...result.questions);

      if (result.success) {
        updateTask(workingDir, task.id, { status: 'completed', output: result.output });
      } else {
        updateTask(workingDir, task.id, { status: 'failed', error: result.error });
        failedTasks.push(task.id);
      }
    });
  }

  // Run dependent impl tasks sequentially
  for (const task of dependentImpl) {
    const updatedState = loadState(workingDir);
    const deps = updatedState?.tasks.filter(t => task.dependencies.includes(t.id));
    const allDepsMet = deps?.every(d => d.status === 'completed');

    if (!allDepsMet) {
      console.log(chalk.yellow(`  ⏭ Skipping ${task.id} — dependencies not met`));
      updateTask(workingDir, task.id, { status: 'blocked' });
      continue;
    }

    const dawgIndex = tasks.indexOf(task) + 1;
    console.log(chalk.dim(`  Running ${task.id}: ${task.description.slice(0, 50)}...`));
    updateTask(workingDir, task.id, { status: 'in_progress' });

    const result = await runImplWithVerification(task, dawgIndex);
    questions.push(...result.questions);

    if (result.success) {
      updateTask(workingDir, task.id, { status: 'completed', output: result.output });
      console.log(chalk.green(`  ✓ ${task.id} completed`));
    } else {
      updateTask(workingDir, task.id, { status: 'failed', error: result.error });
      failedTasks.push(task.id);
      console.log(chalk.red(`  ✗ ${task.id} failed: ${result.error}`));
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
  plan: string,
  verbose?: boolean
): Promise<BuildTask[]> => {
  const prompt = `Extract implementation tasks from this plan. The plan should have test tasks and implementation tasks.

TASK: ${description}

PLAN:
${plan}

Return a JSON array of tasks. Each task should have:
- id: string (e.g., "test-1" for test tasks, "impl-1" for implementation tasks)
- description: string (what to implement/test)
- dependencies: string[] (IDs of tasks that must complete first — impl tasks may depend on test tasks)
- taskType: "test" or "implementation"
- testTaskIds: string[] (for implementation tasks only — which test task(s) this impl should make pass)

RULES:
1. Test tasks (taskType: "test") should have NO dependencies and run first
2. Implementation tasks (taskType: "implementation") should list their corresponding test tasks in testTaskIds
3. Implementation tasks with no cross-task dependencies can run in parallel
4. Implementation tasks that depend on other impl tasks should list those in dependencies

RESPOND WITH ONLY THE JSON ARRAY, NO OTHER TEXT.

Example:
[
  {"id": "test-1", "description": "Write tests for the new API endpoint", "dependencies": [], "taskType": "test"},
  {"id": "test-2", "description": "Write tests for the data validation", "dependencies": [], "taskType": "test"},
  {"id": "impl-1", "description": "Create the API endpoint handler", "dependencies": [], "taskType": "implementation", "testTaskIds": ["test-1"]},
  {"id": "impl-2", "description": "Add input validation", "dependencies": [], "taskType": "implementation", "testTaskIds": ["test-2"]},
  {"id": "impl-3", "description": "Wire up endpoint to router", "dependencies": ["impl-1", "impl-2"], "taskType": "implementation", "testTaskIds": ["test-1"]}
]`;

  const result = await runRobotKing({
    workingDir,
    prompt,
    allowedTools: [],
    verbose,
  });

  if (!result.success) {
    return [];
  }

  try {
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
