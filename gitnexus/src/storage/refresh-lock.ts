import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export type RefreshLockLease = {
  lockPath: string;
  owner: string;
  release: () => Promise<void>;
};

const normalizeRepoPath = (repoPath: string): string => {
  return path.resolve(repoPath).replace(/\\/g, '/');
};

const readOwner = async (lockPath: string): Promise<string> => {
  try {
    return String(await fs.readFile(path.join(lockPath, 'owner'), 'utf-8')).trim();
  } catch {
    return '';
  }
};

const parseOwnerPid = (owner: string): number | null => {
  const pidRaw = String(owner || '').trim().split('.')[0] || '';
  const pid = Number(pidRaw);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return pid;
};

const isOwnerAlive = (owner: string): boolean => {
  const pid = parseOwnerPid(owner);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const ensureStaleLockCleared = async (lockPath: string): Promise<void> => {
  let stat: any;
  try {
    stat = await fs.stat(lockPath);
  } catch {
    return;
  }
  if (!stat?.isDirectory?.()) {
    try { await fs.rm(lockPath, { recursive: true, force: true }); } catch {}
    return;
  }

  const owner = await readOwner(lockPath);
  if (!owner || !isOwnerAlive(owner)) {
    try { await fs.rm(lockPath, { recursive: true, force: true }); } catch {}
  }
};

export const getRefreshLockPath = (repoPath: string): string => {
  const key = crypto.createHash('sha1').update(normalizeRepoPath(repoPath)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `gitnexus-refresh-lock-${key}`);
};

export const isRefreshLockActive = async (repoPath: string): Promise<boolean> => {
  const lockPath = getRefreshLockPath(repoPath);
  await ensureStaleLockCleared(lockPath);
  try {
    const stat = await fs.stat(lockPath);
    return !!stat?.isDirectory?.();
  } catch {
    return false;
  }
};

export const waitForRefreshLockRelease = async (
  repoPath: string,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<void> => {
  const timeoutMs = Math.max(1_000, Number(opts?.timeoutMs ?? 180_000));
  const pollMs = Math.max(100, Number(opts?.pollMs ?? 1_000));
  const lockPath = getRefreshLockPath(repoPath);
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    await ensureStaleLockCleared(lockPath);
    try {
      const stat = await fs.stat(lockPath);
      if (!stat?.isDirectory?.()) return;
    } catch {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  const owner = await readOwner(lockPath);
  throw new Error(
    `Timed out waiting for GitNexus refresh lock (${lockPath}${owner ? ` owner=${owner}` : ''})`,
  );
};

export const acquireRefreshLock = async (
  repoPath: string,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<RefreshLockLease> => {
  const timeoutMs = Math.max(1_000, Number(opts?.timeoutMs ?? 180_000));
  const pollMs = Math.max(100, Number(opts?.pollMs ?? 1_000));
  const lockPath = getRefreshLockPath(repoPath);
  const owner = `${process.pid}.${Date.now()}`;
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    await ensureStaleLockCleared(lockPath);
    try {
      await fs.mkdir(lockPath);
      await fs.writeFile(path.join(lockPath, 'owner'), owner, 'utf-8');
      const release = async () => {
        let currentOwner = '';
        try {
          currentOwner = String(await fs.readFile(path.join(lockPath, 'owner'), 'utf-8')).trim();
        } catch {}
        if (currentOwner && currentOwner !== owner) return;
        try { await fs.rm(lockPath, { recursive: true, force: true }); } catch {}
      };
      return { lockPath, owner, release };
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
    }

    await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  const activeOwner = await readOwner(lockPath);
  throw new Error(
    `Unable to acquire GitNexus refresh lock (${lockPath}${activeOwner ? ` owner=${activeOwner}` : ''})`,
  );
};
