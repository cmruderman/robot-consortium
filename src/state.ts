import * as fs from 'fs';
import * as path from 'path';
import { ConsortiumState, Phase, Task, Question, CostEntry } from './types.js';

const STATE_DIR = '.robot-consortium';
const STATE_FILE = 'state.json';

export const getStateDir = (workingDir: string): string => {
  return path.join(workingDir, STATE_DIR);
};

export const getStatePath = (workingDir: string): string => {
  return path.join(getStateDir(workingDir), STATE_FILE);
};

export const initializeState = (workingDir: string, description: string, branchName?: string): ConsortiumState => {
  const stateDir = getStateDir(workingDir);

  // Create directories
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'findings'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'plans'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'reviews'), { recursive: true });

  const state: ConsortiumState = {
    id: generateId(),
    description,
    phase: 'INIT',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workingDirectory: workingDir,
    tasks: [],
    questions: {
      pending: [],
      answered: [],
    },
    costs: [],
    findings: [],
    plans: [],
    reviews: [],
    branchName,
  };

  saveState(workingDir, state);
  return state;
};

export const loadState = (workingDir: string): ConsortiumState | null => {
  const statePath = getStatePath(workingDir);

  if (!fs.existsSync(statePath)) {
    return null;
  }

  const content = fs.readFileSync(statePath, 'utf-8');
  return JSON.parse(content) as ConsortiumState;
};

export const saveState = (workingDir: string, state: ConsortiumState): void => {
  const statePath = getStatePath(workingDir);
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
};

export const updatePhase = (workingDir: string, phase: Phase): ConsortiumState => {
  const state = loadState(workingDir);
  if (!state) throw new Error('No active consortium found');

  state.phase = phase;
  saveState(workingDir, state);
  return state;
};

export const addTask = (workingDir: string, task: Omit<Task, 'id'>): Task => {
  const state = loadState(workingDir);
  if (!state) throw new Error('No active consortium found');

  const newTask: Task = {
    ...task,
    id: `task-${state.tasks.length + 1}`,
  };

  state.tasks.push(newTask);
  saveState(workingDir, state);
  return newTask;
};

export const updateTask = (workingDir: string, taskId: string, updates: Partial<Task>): Task => {
  const state = loadState(workingDir);
  if (!state) throw new Error('No active consortium found');

  const taskIndex = state.tasks.findIndex(t => t.id === taskId);
  if (taskIndex === -1) throw new Error(`Task ${taskId} not found`);

  state.tasks[taskIndex] = { ...state.tasks[taskIndex], ...updates };
  saveState(workingDir, state);
  return state.tasks[taskIndex];
};

export const addQuestion = (workingDir: string, question: Omit<Question, 'id'>): Question => {
  const state = loadState(workingDir);
  if (!state) throw new Error('No active consortium found');

  const newQuestion: Question = {
    ...question,
    id: `q-${state.questions.pending.length + state.questions.answered.length + 1}`,
  };

  state.questions.pending.push(newQuestion);
  saveState(workingDir, state);
  return newQuestion;
};

export const answerQuestion = (workingDir: string, questionId: string, answer: string): Question => {
  const state = loadState(workingDir);
  if (!state) throw new Error('No active consortium found');

  const questionIndex = state.questions.pending.findIndex(q => q.id === questionId);
  if (questionIndex === -1) throw new Error(`Question ${questionId} not found`);

  const question = state.questions.pending[questionIndex];
  question.answer = answer;
  question.answeredAt = new Date().toISOString();

  state.questions.pending.splice(questionIndex, 1);
  state.questions.answered.push(question);
  saveState(workingDir, state);
  return question;
};

export const addCost = (workingDir: string, cost: Omit<CostEntry, 'timestamp'>): void => {
  const state = loadState(workingDir);
  if (!state) throw new Error('No active consortium found');

  state.costs.push({
    ...cost,
    timestamp: new Date().toISOString(),
  });
  saveState(workingDir, state);
};

export const addFinding = (workingDir: string, filename: string, content: string): void => {
  const state = loadState(workingDir);
  if (!state) throw new Error('No active consortium found');

  const findingPath = path.join(getStateDir(workingDir), 'findings', filename);
  fs.writeFileSync(findingPath, content);
  state.findings.push(filename);
  saveState(workingDir, state);
};

export const addPlan = (workingDir: string, filename: string, content: string): void => {
  const state = loadState(workingDir);
  if (!state) throw new Error('No active consortium found');

  const planPath = path.join(getStateDir(workingDir), 'plans', filename);
  fs.writeFileSync(planPath, content);
  state.plans.push(filename);
  saveState(workingDir, state);
};

export const setFinalPlan = (workingDir: string, content: string): void => {
  const state = loadState(workingDir);
  if (!state) throw new Error('No active consortium found');

  const planPath = path.join(getStateDir(workingDir), 'final-plan.md');
  fs.writeFileSync(planPath, content);
  state.finalPlan = 'final-plan.md';
  saveState(workingDir, state);
};

export const setSurferFocuses = (workingDir: string, focuses: string[]): void => {
  const state = loadState(workingDir);
  if (!state) throw new Error('No active consortium found');

  state.surferFocuses = focuses;
  saveState(workingDir, state);
};

export const setPlannerPerspectives = (workingDir: string, perspectives: string[]): void => {
  const state = loadState(workingDir);
  if (!state) throw new Error('No active consortium found');

  state.plannerPerspectives = perspectives;
  saveState(workingDir, state);
};

export const addReview = (workingDir: string, filename: string, content: string): void => {
  const state = loadState(workingDir);
  if (!state) throw new Error('No active consortium found');

  const reviewPath = path.join(getStateDir(workingDir), 'reviews', filename);
  fs.writeFileSync(reviewPath, content);
  state.reviews.push(filename);
  saveState(workingDir, state);
};

export const getTotalCost = (workingDir: string): number => {
  const state = loadState(workingDir);
  if (!state) return 0;

  return state.costs.reduce((sum, c) => sum + c.costUsd, 0);
};

const generateId = (): string => {
  return `rc-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`;
};
