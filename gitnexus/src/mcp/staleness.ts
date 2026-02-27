/**
 * Staleness Check
 * 
 * Checks if the GitNexus index is behind the current git HEAD.
 * Returns a hint for the LLM to call analyze if stale.
 */

import { execSync } from 'child_process';
import path from 'path';

export interface StalenessInfo {
  isStale: boolean;
  commitsBehind: number;
  indexedCommit?: string;
  headCommit?: string;
  hint?: string;
}

/**
 * Check how many commits the index is behind HEAD
 */
export function checkStaleness(repoPath: string, lastCommit: string): StalenessInfo {
  try {
    const normalizedRepoPath = path.resolve(repoPath);
    const indexedCommit = (lastCommit || '').trim();
    if (!indexedCommit || indexedCommit.toUpperCase() === 'HEAD') {
      return { isStale: false, commitsBehind: 0 };
    }

    // HEAD commit (fast)
    const headCommit = execSync(
      'git rev-parse HEAD',
      { cwd: normalizedRepoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (!headCommit) {
      return { isStale: false, commitsBehind: 0, indexedCommit, headCommit };
    }

    // Commits behind (best-effort; rev-list can fail if indexedCommit isn't in history)
    let commitsBehind = 0;
    try {
      const result = execSync(
        `git rev-list --count ${indexedCommit}..${headCommit}`,
        { cwd: normalizedRepoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      commitsBehind = parseInt(result, 10) || 0;
    } catch {
      commitsBehind = 0;
    }

    const shortIndexed = indexedCommit.slice(0, 7);
    const shortHead = headCommit.slice(0, 7);

    // If HEAD moved but we can't count commits, still mark stale.
    const commitMismatch = headCommit !== indexedCommit;
    const isStale = commitsBehind > 0 || commitMismatch;
    if (!isStale) {
      return { isStale: false, commitsBehind: 0, indexedCommit, headCommit };
    }

    const hint = commitsBehind > 0
      ? `⚠️ Index is ${commitsBehind} commit${commitsBehind > 1 ? 's' : ''} behind HEAD (indexed ${shortIndexed}, HEAD ${shortHead}). Run analyze tool to update.`
      : `⚠️ Index commit does not match HEAD (indexed ${shortIndexed}, HEAD ${shortHead}). Run analyze tool to update.`;

    return { isStale: true, commitsBehind, indexedCommit, headCommit, hint };
  } catch {
    // If git command fails, assume not stale (fail open)
    return { isStale: false, commitsBehind: 0 };
  }
}
