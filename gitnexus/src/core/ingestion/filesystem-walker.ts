import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { glob } from 'glob';
import { DEFAULT_IGNORE_PATH_SEGMENTS, shouldIgnorePath } from '../../config/ignore-service.js';

export interface FileEntry {
  path: string;
  content: string;
}

const READ_CONCURRENCY = 32;

const ALLOWED_DOT_PATH_SEGMENTS = new Set([
  // Monorepo-local agent docs + skills that we want indexed for template/pattern lamination.
  '.agents',
  '.claude',
]);

const hasDisallowedDotPathSegment = (relativePath: string): boolean => {
  return relativePath
    .split('/')
    .some(part => {
      if (!part.startsWith('.')) return false;
      if (part === '.' || part === '..') return false;
      return !ALLOWED_DOT_PATH_SEGMENTS.has(part);
    });
};

const normalizeRelativePath = (relativePath: string): string => {
  return relativePath.replace(/\\/g, '/');
};

const listRepositoryFilesViaGit = async (repoPath: string): Promise<string[] | null> => {
  return new Promise(resolve => {
    const child = spawn(
      'git',
      ['-C', repoPath, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );

    const files: string[] = [];
    const decoder = new StringDecoder('utf8');
    let remainder = '';

    child.stdout.on('data', (chunk: Buffer) => {
      const text = remainder + decoder.write(chunk);
      const parts = text.split('\0');
      remainder = parts.pop() ?? '';
      for (const entry of parts) {
        if (entry) files.push(entry);
      }
    });

    child.on('error', () => resolve(null));
    child.on('close', code => {
      if (code !== 0) return resolve(null);
      const tail = remainder + decoder.end();
      if (tail) {
        for (const entry of tail.split('\0')) {
          if (entry) files.push(entry);
        }
      }
      resolve(files);
    });
  });
};

export const listRepositoryFiles = async (repoPath: string): Promise<string[]> => {
  const filesFromGit = await listRepositoryFilesViaGit(repoPath);

  const baseFiles = filesFromGit ?? await glob('**/*', {
    cwd: repoPath,
    nodir: true,
    dot: false,
    ignore: DEFAULT_IGNORE_PATH_SEGMENTS.map(segment => `**/${segment}/**`),
  });

  const allowlistedDotFiles = (await Promise.all(
    Array.from(ALLOWED_DOT_PATH_SEGMENTS).map(dotSegment =>
      glob(`${dotSegment}/**/*`, {
        cwd: repoPath,
        nodir: true,
        dot: true,
        ignore: DEFAULT_IGNORE_PATH_SEGMENTS.map(segment => `**/${segment}/**`),
      })
    )
  )).flat();

  const files = Array.from(new Set([...baseFiles, ...allowlistedDotFiles].map(normalizeRelativePath)));

  return files
    .filter(Boolean)
    .filter(file => !hasDisallowedDotPathSegment(file))
    .filter(file => !shouldIgnorePath(file));
};

export const readRepositoryFiles = async (
  repoPath: string,
  relativePaths: string[],
  onProgress?: (current: number, total: number, filePath: string) => void,
): Promise<FileEntry[]> => {
  const unique = Array.from(new Set(relativePaths.map(p => p.replace(/\\/g, '/')).filter(Boolean)));
  const filtered = unique.filter(file => !shouldIgnorePath(file));

  const entries: FileEntry[] = [];
  let processed = 0;

  for (let start = 0; start < filtered.length; start += READ_CONCURRENCY) {
    const batch = filtered.slice(start, start + READ_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(relativePath =>
        fs.readFile(path.join(repoPath, relativePath), 'utf-8')
          .then(content => ({ path: relativePath.replace(/\\/g, '/'), content }))
      )
    );

    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      processed++;
      if (result.status === 'fulfilled') {
        entries.push(result.value);
        onProgress?.(processed, filtered.length, result.value.path);
      } else {
        onProgress?.(processed, filtered.length, batch[index]);
      }
    }
  }

  return entries;
};

export const walkRepository = async (
  repoPath: string,
  onProgress?: (current: number, total: number, filePath: string) => void
): Promise<FileEntry[]> => {
  const filtered = await listRepositoryFiles(repoPath);
  return readRepositoryFiles(repoPath, filtered, onProgress);
};
