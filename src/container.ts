import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

export interface ContainerOptions {
  description: string;
  workingDir: string;
  repo?: string;
  baseBranch?: string;
  imageName?: string;
  verbose?: boolean;
  skipOink?: boolean;
  skipCi?: boolean;
  skipRats?: boolean;
  planOnly?: boolean;
}

const DEFAULT_IMAGE_NAME = 'robot-consortium';

const loadEnvFile = (workingDir: string): Record<string, string> => {
  const envPath = path.join(workingDir, '.env');
  if (!fs.existsSync(envPath)) return {};

  const vars: Record<string, string> = {};
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    // Strip optional quotes from value
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
};

const resolveAnthropicKey = (envVars: Record<string, string>): string | undefined => {
  return process.env.ANTHROPIC_API_KEY || envVars.ANTHROPIC_API_KEY || undefined;
};

const resolveGhToken = (envVars: Record<string, string> = {}): string | undefined => {
  // 1. Environment variables
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

  // 2. .env file
  if (envVars.GH_TOKEN) return envVars.GH_TOKEN;
  if (envVars.GITHUB_TOKEN) return envVars.GITHUB_TOKEN;

  // 3. gh CLI auth
  try {
    const token = execSync('gh auth token', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (token) return token;
  } catch {
    // gh not authenticated
  }

  return undefined;
};

export const convertToHttpsUrl = (url: string): string => {
  // git@github.com:owner/repo.git -> https://github.com/owner/repo.git
  const sshMatch = url.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    const [, host, pathPart] = sshMatch;
    return `https://${host}/${pathPart}`;
  }
  return url;
};

const getRcProjectRoot = (): string => {
  // The RC project root is where the Dockerfile lives.
  // This file is at src/container.ts -> compiled to dist/container.js
  // So project root is one level up from dist/
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
};

export const ensureImage = (imageName: string): void => {
  const rcRoot = getRcProjectRoot();

  try {
    const result = execSync(`docker images -q ${imageName}`, {
      encoding: 'utf-8',
    }).trim();

    if (result) {
      console.log(chalk.dim(`  Using existing Docker image: ${imageName}`));
      return;
    }
  } catch {
    // docker command failed, try to build anyway
  }

  console.log(chalk.dim(`  Building Docker image: ${imageName}...`));
  execSync(`docker build -t ${imageName} .`, {
    cwd: rcRoot,
    stdio: 'inherit',
  });
  console.log(chalk.green(`  ✓ Docker image built: ${imageName}`));
};

export const runInContainer = async (options: ContainerOptions): Promise<number> => {
  const {
    description,
    workingDir,
    repo,
    baseBranch,
    verbose,
    skipOink,
    skipCi,
    skipRats,
    planOnly,
  } = options;
  const imageName = options.imageName || DEFAULT_IMAGE_NAME;

  console.log(chalk.bold.cyan('\n🐳 ROBOT CONSORTIUM — CONTAINER MODE\n'));

  // Load .env file from working directory
  const envVars = loadEnvFile(workingDir);

  // Resolve credentials
  const anthropicKey = resolveAnthropicKey(envVars);
  if (!anthropicKey) {
    console.log(chalk.red('  ✗ ANTHROPIC_API_KEY not found'));
    console.log(chalk.dim('  Set it via environment variable or in a .env file in your working directory'));
    return 1;
  }

  const ghToken = resolveGhToken(envVars);
  if (!ghToken) {
    console.log(chalk.red('  ✗ GitHub token not found'));
    console.log(chalk.dim('  Run "gh auth login" or set GH_TOKEN in your environment / .env file'));
    return 1;
  }

  // Resolve repo URL: --repo flag > .env REPO_URL (required)
  const rawRepoUrl = repo || envVars.REPO_URL;
  if (!rawRepoUrl) {
    console.log(chalk.red('  ✗ REPO_URL not found'));
    console.log(chalk.dim('  Set it via --repo flag or REPO_URL in your .env file'));
    return 1;
  }
  const repoUrl = convertToHttpsUrl(rawRepoUrl);

  console.log(chalk.dim(`  Repo: ${repoUrl}`));
  console.log(chalk.dim(`  Base branch: ${baseBranch || 'default'}`));
  console.log(chalk.dim(`  Image: ${imageName}`));

  // Ensure Docker image exists
  try {
    ensureImage(imageName);
  } catch (error) {
    console.log(chalk.red(`  ✗ Failed to build Docker image: ${(error as Error).message}`));
    return 1;
  }

  // Build the shell script that runs inside the container
  const cloneBranch = baseBranch ? `--branch ${baseBranch} ` : '';
  const escapedDescription = description.replace(/'/g, "'\\''");

  // Build RC flags
  const rcFlags: string[] = ['--yes'];
  if (verbose) rcFlags.push('--verbose');
  if (skipOink) rcFlags.push('--skip-oink');
  if (skipCi) rcFlags.push('--skip-ci');
  if (skipRats) rcFlags.push('--skip-rats');
  if (planOnly) rcFlags.push('--plan-only');

  const innerScript = [
    // Configure git to use GH_TOKEN for HTTPS auth
    'git config --global credential.helper "!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f"',
    // Clone the repo
    `git clone ${cloneBranch}${repoUrl} /work/repo`,
    'cd /work/repo',
    // Run RC
    `rc start '${escapedDescription}' ${rcFlags.join(' ')}`,
  ].join(' && ');

  // Build docker run args
  const dockerArgs: string[] = [
    'run',
    '--rm',
    '-e', `ANTHROPIC_API_KEY=${anthropicKey}`,
    '-e', `GH_TOKEN=${ghToken}`,
    '-e', 'CLAUDE_CODE_ACCEPT_TOS=yes',
    '--entrypoint', '/bin/bash',
    imageName,
    '-c', innerScript,
  ];

  console.log(chalk.dim('  Launching container...\n'));

  // Spawn docker and stream output
  return new Promise((resolve) => {
    const proc = spawn('docker', dockerArgs, {
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    proc.on('close', (code) => {
      const exitCode = code ?? 1;
      if (exitCode === 0) {
        console.log(chalk.green('\n  ✓ Container completed successfully'));
      } else {
        console.log(chalk.red(`\n  ✗ Container exited with code ${exitCode}`));
      }
      resolve(exitCode);
    });

    proc.on('error', (err) => {
      console.log(chalk.red(`  ✗ Failed to launch Docker: ${err.message}`));
      console.log(chalk.dim('  Is Docker installed and running?'));
      resolve(1);
    });
  });
};
