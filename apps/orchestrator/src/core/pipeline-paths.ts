import path from 'node:path';

export interface StepArtifactPaths {
  promptPath: string;
  outputPath: string;
  stdoutPath: string;
  stderrPath: string;
}

export function pipelineBranchName(taskId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `forgeroom/${taskId}${slug.length === 0 ? '' : `-${slug}`}`;
}

export function pipelineWorktreePath(taskId: string): string {
  return path.join('/tmp/forgeroom/worktrees', taskId);
}

export function pipelineStepArtifactPaths(worktreeRoot: string, index: number, stepId: string): StepArtifactPaths {
  const artifactName = `${String(index).padStart(2, '0')}_${stepId}`;
  return {
    promptPath: path.join(worktreeRoot, '.forgeroom', 'prompts', `${artifactName}.md`),
    outputPath: path.join(worktreeRoot, '.forgeroom', 'outputs', `${artifactName}.md`),
    stdoutPath: path.join(worktreeRoot, '.forgeroom', 'logs', `${artifactName}.stdout`),
    stderrPath: path.join(worktreeRoot, '.forgeroom', 'logs', `${artifactName}.stderr`),
  };
}
