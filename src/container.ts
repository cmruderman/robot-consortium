import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
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

// Input validation to prevent shell injection
const SAFE_BRANCH_RE = /^[a-zA-Z0-9._\/-]+$/;
const SAFE_IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\/-]*$/;

const validateBranchName = (branch: string): void => {
  if (!SAFE_BRANCH_RE.test(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
};

const validateImageName = (name: string): void => {
  if (!SAFE_IMAGE_RE.test(name)) {
    throw new Error(`Invalid Docker image name: ${name}`);
  }
};

const validateRepoUrl = (url: string): void => {
  if (!/^https?:\/\//.test(url)) {
    throw new Error(`Repository URL must use HTTPS: ${url}`);
  }
};

const loadEnvFile = (workingDir: string): Record<string, string> => {
  const envPath = path.join(workingDir, '.env');
  if (!fs.existsSync(envPath)) return {};

  let content: string;
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    return {};
  }

  const vars: Record<string, string> = {};
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

interface ClaudeAuth {
  envVar: 'CLAUDE_CODE_OAUTH_TOKEN' | 'ANTHROPIC_API_KEY';
  value: string;
}

const resolveClaudeAuth = (envVars: Record<string, string>): ClaudeAuth | undefined => {
  // Prefer OAuth token (Max/Pro plan — no API billing)
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || envVars.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauthToken) return { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', value: oauthToken };

  // Fall back to API key (pay-per-use)
  const apiKey = process.env.ANTHROPIC_API_KEY || envVars.ANTHROPIC_API_KEY;
  if (apiKey) return { envVar: 'ANTHROPIC_API_KEY', value: apiKey };

  return undefined;
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
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
};

export const ensureImage = (imageName: string): void => {
  validateImageName(imageName);
  const rcRoot = getRcProjectRoot();

  try {
    const result = execSync(`docker images -q '${imageName}'`, {
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
  execSync(`docker build -t '${imageName}' .`, {
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
  const claudeAuth = resolveClaudeAuth(envVars);
  if (!claudeAuth) {
    console.log(chalk.red('  ✗ Claude authentication not found'));
    console.log(chalk.dim('  Set CLAUDE_CODE_OAUTH_TOKEN (Max/Pro plan) or ANTHROPIC_API_KEY (API billing)'));
    console.log(chalk.dim('  in your environment or .env file. Run "claude setup-token" to generate an OAuth token.'));
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

  // Validate inputs before proceeding
  try {
    validateRepoUrl(repoUrl);
    if (baseBranch) validateBranchName(baseBranch);
    validateImageName(imageName);
  } catch (error) {
    console.log(chalk.red(`  ✗ ${error instanceof Error ? error.message : String(error)}`));
    return 1;
  }

  console.log(chalk.dim(`  Repo: ${repoUrl}`));
  console.log(chalk.dim(`  Base branch: ${baseBranch || 'default'}`));
  console.log(chalk.dim(`  Image: ${imageName}`));

  // Ensure Docker image exists
  try {
    ensureImage(imageName);
  } catch (error) {
    console.log(chalk.red(`  ✗ Failed to build Docker image: ${error instanceof Error ? error.message : String(error)}`));
    return 1;
  }

  // Build the shell script that runs inside the container
  // baseBranch and repoUrl are validated above — safe to interpolate with quotes
  const cloneBranch = baseBranch ? `--branch '${baseBranch}' ` : '';
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
    `git clone ${cloneBranch}'${repoUrl}' /work/repo`,
    'cd /work/repo',
    // Run RC
    `rc start '${escapedDescription}' ${rcFlags.join(' ')}`,
  ].join(' && ');

  // Write credentials to temp file for --env-file (avoids exposure in process table)
  const envFile = path.join(os.tmpdir(), `rc-container-${Date.now()}.env`);
  fs.writeFileSync(envFile, [
    `${claudeAuth.envVar}=${claudeAuth.value}`,
    `GH_TOKEN=${ghToken}`,
    'CLAUDE_CODE_ACCEPT_TOS=yes',
  ].join('\n'), { mode: 0o600 });

  // Build docker run args
  const dockerArgs: string[] = [
    'run',
    '--rm',
    '--env-file', envFile,
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

    const cleanup = () => {
      try { fs.unlinkSync(envFile); } catch {}
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    };

    // Forward signals to the Docker process so Ctrl+C stops the container
    const onSignal = (signal: NodeJS.Signals) => {
      proc.kill(signal);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    proc.on('close', (code) => {
      cleanup();
      const exitCode = code ?? 1;
      if (exitCode === 0) {
        console.log(chalk.green('\n  ✓ Container completed successfully'));
      } else {
        console.log(chalk.red(`\n  ✗ Container exited with code ${exitCode}`));
      }
      resolve(exitCode);
    });

    proc.on('error', (err) => {
      cleanup();
      console.log(chalk.red(`  ✗ Failed to launch Docker: ${err.message}`));
      console.log(chalk.dim('  Is Docker installed and running?'));
      resolve(1);
    });
  });
};
