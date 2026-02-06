import logUpdate from 'log-update';
import chalk from 'chalk';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export type AgentStatus = 'running' | 'done' | 'failed';

interface AgentEntry {
  id: string;
  focus: string;
  model: string;
  status: AgentStatus;
  startTime: number;
  endTime?: number;
  summary?: string;
  error?: string;
}

const formatElapsed = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
};

export class PhaseDisplay {
  private agents: Map<string, AgentEntry> = new Map();
  private phaseName: string;
  private phaseIcon: string;
  private spinnerIndex = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private verbose: boolean;

  constructor(phaseName: string, phaseIcon: string, verbose = false) {
    this.phaseName = phaseName;
    this.phaseIcon = phaseIcon;
    this.verbose = verbose;
  }

  registerAgent(id: string, focus: string, model: string): void {
    this.agents.set(id, {
      id,
      focus,
      model,
      status: 'running',
      startTime: Date.now(),
    });
  }

  markDone(id: string, summary?: string): void {
    const agent = this.agents.get(id);
    if (agent) {
      agent.status = 'done';
      agent.endTime = Date.now();
      agent.summary = summary;
      this.render();
    }
  }

  markFailed(id: string, error?: string): void {
    const agent = this.agents.get(id);
    if (agent) {
      agent.status = 'failed';
      agent.endTime = Date.now();
      agent.error = error;
      this.render();
    }
  }

  start(): void {
    if (this.verbose) {
      // In verbose mode, don't use log-update (agent output would conflict)
      // Just print the initial roster
      this.printStaticHeader();
      return;
    }

    this.render();
    this.interval = setInterval(() => {
      this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER_FRAMES.length;
      this.render();
    }, 100);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (!this.verbose) {
      // Final render, then persist to console
      logUpdate(this.buildOutput());
      logUpdate.done();
    } else {
      this.printStaticSummary();
    }
  }

  private printStaticHeader(): void {
    const completed = [...this.agents.values()].filter(a => a.status === 'done').length;
    const total = this.agents.size;
    console.log(chalk.cyan(`\n  ${this.phaseIcon} ${this.phaseName} [0/${total}]`));
    for (const agent of this.agents.values()) {
      const focusName = agent.focus.split(':')[0].trim();
      console.log(chalk.dim(`    ${SPINNER_FRAMES[0]} ${agent.id} (${focusName})  running  ${agent.model}`));
    }
    console.log('');
  }

  private printStaticSummary(): void {
    const completed = [...this.agents.values()].filter(a => a.status === 'done').length;
    const failed = [...this.agents.values()].filter(a => a.status === 'failed').length;
    const total = this.agents.size;
    console.log(chalk.cyan(`\n  ${this.phaseIcon} ${this.phaseName} [${completed}/${total} complete${failed > 0 ? `, ${failed} failed` : ''}]`));
    for (const agent of this.agents.values()) {
      console.log(this.formatAgentLine(agent));
    }
  }

  private render(): void {
    logUpdate(this.buildOutput());
  }

  private buildOutput(): string {
    const lines: string[] = [];
    const completed = [...this.agents.values()].filter(a => a.status === 'done').length;
    const failed = [...this.agents.values()].filter(a => a.status === 'failed').length;
    const total = this.agents.size;

    const countLabel = failed > 0
      ? `${completed}/${total} complete, ${failed} failed`
      : `${completed}/${total} complete`;

    lines.push(chalk.cyan(`  ${this.phaseIcon} ${this.phaseName} [${countLabel}]`));

    for (const agent of this.agents.values()) {
      lines.push(this.formatAgentLine(agent));
    }

    return lines.join('\n');
  }

  private formatAgentLine(agent: AgentEntry): string {
    const focusName = agent.focus.split(':')[0].trim();
    const elapsed = formatElapsed((agent.endTime ?? Date.now()) - agent.startTime);

    switch (agent.status) {
      case 'running': {
        const spinner = chalk.cyan(SPINNER_FRAMES[this.spinnerIndex]);
        return `    ${spinner} ${agent.id} ${chalk.dim(`(${focusName})`)}  ${chalk.yellow('running')}  ${chalk.dim(elapsed)}`;
      }
      case 'done': {
        const summary = agent.summary ? chalk.dim(` — ${agent.summary}`) : '';
        return `    ${chalk.green('✓')} ${agent.id} ${chalk.dim(`(${focusName})`)}  ${chalk.green('done')}     ${chalk.dim(elapsed)}${summary}`;
      }
      case 'failed': {
        const error = agent.error ? chalk.dim(` — ${agent.error.slice(0, 60)}`) : '';
        return `    ${chalk.red('✗')} ${agent.id} ${chalk.dim(`(${focusName})`)}  ${chalk.red('failed')}   ${chalk.dim(elapsed)}${error}`;
      }
    }
  }
}
