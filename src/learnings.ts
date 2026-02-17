import * as fs from 'fs';
import * as path from 'path';

const LEARNINGS_FILE = '.robot-consortium-learnings.md';
const MAX_LEARNINGS_SECTIONS = 50;

export const LEARNINGS_START_MARKER = 'ROBOT_KING_LEARNINGS_START';
export const LEARNINGS_END_MARKER = 'ROBOT_KING_LEARNINGS_END';

export const getLearningsPath = (workingDir: string): string => {
  return path.join(workingDir, LEARNINGS_FILE);
};

export const readLearnings = (workingDir: string): string => {
  const learningsPath = getLearningsPath(workingDir);
  if (!fs.existsSync(learningsPath)) {
    return '';
  }
  return fs.readFileSync(learningsPath, 'utf-8');
};

export const appendLearnings = (workingDir: string, newEntries: string): void => {
  if (!newEntries.trim()) return;

  const learningsPath = getLearningsPath(workingDir);
  const timestamp = new Date().toISOString().split('T')[0];

  let existing = '';
  if (fs.existsSync(learningsPath)) {
    existing = fs.readFileSync(learningsPath, 'utf-8');
  }

  const entry = `\n## ${timestamp}\n${newEntries.trim()}\n`;
  const updated = existing + entry;

  // Keep only the last N sections to prevent unbounded growth
  const sections = updated.split(/(?=\n## )/);
  const trimmed = sections.length > MAX_LEARNINGS_SECTIONS
    ? sections.slice(sections.length - MAX_LEARNINGS_SECTIONS).join('')
    : updated;

  fs.writeFileSync(learningsPath, trimmed);
};

export const extractLearningsFromOutput = (output: string): { cleanOutput: string; learnings: string } => {
  const regex = new RegExp(
    `${LEARNINGS_START_MARKER}\\s*([\\s\\S]*?)\\s*${LEARNINGS_END_MARKER}`
  );
  const match = output.match(regex);

  if (!match) {
    return { cleanOutput: output, learnings: '' };
  }

  const cleanOutput = output.replace(regex, '').trim();
  const learnings = match[1].trim();

  return { cleanOutput, learnings };
};

export const buildLearningsSystemPrompt = (workingDir: string): string => {
  const learnings = readLearnings(workingDir);

  let prompt = 'You are the Robot King, coordinator of the robot-consortium system.';

  if (learnings) {
    prompt += `

ACCUMULATED LEARNINGS FROM PREVIOUS RUNS ON THIS CODEBASE:
These are observations you made in prior executions. Use them to make better decisions.
${learnings}`;
  }

  prompt += `

IMPORTANT: At the END of your response, after all other output, include a brief learnings section using EXACTLY this format:

${LEARNINGS_START_MARKER}
- [One concise bullet per learning — codebase patterns, gotchas, architecture insights, naming conventions, test patterns, build quirks]
- [Do NOT repeat learnings already listed above — only add NEW observations]
- [Keep each bullet under 100 characters]
- [Maximum 5 bullets per invocation]
${LEARNINGS_END_MARKER}

If you have no new learnings, still include the markers with: "- No new learnings this invocation."`;

  return prompt;
};
