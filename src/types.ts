export type Phase = 'INIT' | 'SURF' | 'PLAN' | 'BUILD' | 'OINK' | 'PR' | 'CI_CHECK' | 'DONE' | 'FAILED';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked';

export type AgentRole = 'robot-king' | 'surfer' | 'city-planner' | 'rat' | 'dawg' | 'pig';

export type Model = 'opus' | 'sonnet' | 'haiku';

export interface Task {
  id: string;
  description: string;
  status: TaskStatus;
  assignedTo?: string;
  blockedBy?: string[];
  output?: string;
  error?: string;
}

export interface Question {
  id: string;
  from: string;
  phase: Phase;
  question: string;
  options?: string[];
  answer?: string;
  answeredAt?: string;
}

export interface CostEntry {
  phase: Phase;
  agent: string;
  tokens: number;
  costUsd: number;
  timestamp: string;
}

export interface AgentConfig {
  role: AgentRole;
  model: Model;
  id: string;
  focus?: string;
}

export interface ConsortiumState {
  id: string;
  description: string;
  phase: Phase;
  createdAt: string;
  updatedAt: string;
  workingDirectory: string;
  tasks: Task[];
  questions: {
    pending: Question[];
    answered: Question[];
  };
  costs: CostEntry[];
  findings: string[];
  plans: string[];
  critiques: string[];
  reviews: string[];
  finalPlan?: string;
  prUrl?: string;
  prNumber?: number;
  ciCheckAttempts?: number;
  branchName?: string;
  surferFocuses?: string[];
  plannerPerspectives?: string[];
  ratFocuses?: string[];
}

export const AGENT_MODELS: Record<AgentRole, Model> = {
  'robot-king': 'opus',
  'surfer': 'sonnet',
  'city-planner': 'opus',
  'rat': 'sonnet',
  'dawg': 'opus',
  'pig': 'sonnet',
};

export const PHASE_ORDER: Phase[] = ['INIT', 'SURF', 'PLAN', 'BUILD', 'OINK', 'PR', 'CI_CHECK', 'DONE'];

export interface PhaseOptions {
  verbose?: boolean;
  skipRats?: boolean;
}
