import { execFileSync } from 'child_process';

// Git utilities for repository detection, commit tracking, and diff analysis
const GIT_NAME_LIST_MAX_BUFFER = 64 * 1024 * 1024; // 64MB for large change sets

export const isGitRepo = (repoPath: string): boolean => {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoPath, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

export const getCurrentCommit = (repoPath: string): string => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
};

/**
 * Find the git repository root from any path inside the repo
 */
export const getGitRoot = (fromPath: string): string | null => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: fromPath, encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
};

export type GitFileChanges = {
  /** Files that should be (re)indexed: added, modified, renamed-to, copied-to, etc. */
  changed: string[];
  /** Files that should be removed from the index: deleted, renamed-from, etc. */
  deleted: string[];
};

const normalizeGitPath = (value: string): string => value.trim().replace(/\\/g, '/');

const parseNameStatus = (output: string): GitFileChanges => {
  const changed = new Set<string>();
  const deleted = new Set<string>();

  const lines = output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const parts = line.split('\t').filter(Boolean);
    if (parts.length < 2) continue;

    const status = parts[0];
    const code = status[0];

    if (code === 'R' || code === 'C') {
      // R100\told\tnew
      const oldPath = normalizeGitPath(parts[1] || '');
      const newPath = normalizeGitPath(parts[2] || '');
      if (oldPath) deleted.add(oldPath);
      if (newPath) changed.add(newPath);
      continue;
    }

    const filePath = normalizeGitPath(parts[1] || '');
    if (!filePath) continue;

    if (code === 'D') {
      deleted.add(filePath);
      continue;
    }

    // A/M/T/U/etc -> treat as changed
    changed.add(filePath);
  }

  for (const d of deleted) changed.delete(d);
  return { changed: [...changed], deleted: [...deleted] };
};

export const getCommittedFileChanges = (
  repoPath: string,
  fromCommit: string,
  toCommit: string,
): GitFileChanges => {
  if (!fromCommit || !toCommit || fromCommit === toCommit) return { changed: [], deleted: [] };
  try {
    const output = execFileSync('git', ['diff', '--name-status', '-M', `${fromCommit}..${toCommit}`], {
      cwd: repoPath,
      encoding: 'utf-8',
      maxBuffer: GIT_NAME_LIST_MAX_BUFFER,
    }).trim();
    if (!output) return { changed: [], deleted: [] };
    return parseNameStatus(output);
  } catch {
    return { changed: [], deleted: [] };
  }
};

export const getWorkingTreeFileChanges = (repoPath: string): GitFileChanges => {
  try {
    const output = execFileSync('git', ['status', '--porcelain', '-z'], {
      cwd: repoPath,
      encoding: 'utf-8',
      maxBuffer: GIT_NAME_LIST_MAX_BUFFER,
    });
    if (!output) return { changed: [], deleted: [] };

    const changed = new Set<string>();
    const deleted = new Set<string>();

    // NUL-delimited entries. For renames/copies, porcelain -z emits: "R  old\0new\0"
    const entries = output.split('\0').filter(Boolean);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.length < 4) continue;

      const status = entry.slice(0, 2);
      const pathPart = normalizeGitPath(entry.slice(3));

      // Untracked
      if (status === '??') {
        if (pathPart) changed.add(pathPart);
        continue;
      }

      // Rename / copy (next entry is new path)
      if (status[0] === 'R' || status[0] === 'C') {
        const oldPath = pathPart;
        const newPath = normalizeGitPath(entries[i + 1] || '');
        i++;
        if (oldPath) deleted.add(oldPath);
        if (newPath) changed.add(newPath);
        continue;
      }

      const x = status[0];
      const y = status[1];

      if (!pathPart) continue;

      if (x === 'D' || y === 'D') {
        deleted.add(pathPart);
        continue;
      }

      if (x !== ' ' || y !== ' ') {
        changed.add(pathPart);
      }
    }

    for (const d of deleted) changed.delete(d);
    return { changed: [...changed], deleted: [...deleted] };
  } catch {
    return { changed: [], deleted: [] };
  }
};

export const mergeGitFileChanges = (...changes: GitFileChanges[]): GitFileChanges => {
  const changed = new Set<string>();
  const deleted = new Set<string>();

  for (const c of changes) {
    for (const fp of c.changed) changed.add(normalizeGitPath(fp));
    for (const fp of c.deleted) deleted.add(normalizeGitPath(fp));
  }

  for (const d of deleted) changed.delete(d);
  return { changed: [...changed], deleted: [...deleted] };
};
