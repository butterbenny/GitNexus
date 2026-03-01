export interface DetectChangesRepoHandle {
  id: string;
  repoPath: string;
}

export interface DetectChangesParams {
  scope?: string;
  base_ref?: string;
}

type DetectChangesDeps = {
  ensureInitialized: (repoId: string) => Promise<void>;
  executeQuery: (repoId: string, query: string) => Promise<any[]>;
  normalizeRepoRelativePath: (value: string) => string;
  toNonNegativeInteger: (value: unknown, fallback?: number) => number;
  primaryNodeLabel: (value: unknown) => string;
  isTestFilePath: (filePath: string) => boolean;
  GIT_NAME_LIST_MAX_BUFFER: number;
};

export async function runDetectChanges(
  deps: DetectChangesDeps,
  repo: DetectChangesRepoHandle,
  params: DetectChangesParams,
): Promise<any> {
  const {
    ensureInitialized,
    executeQuery,
    normalizeRepoRelativePath,
    toNonNegativeInteger,
    primaryNodeLabel,
    isTestFilePath,
    GIT_NAME_LIST_MAX_BUFFER,
  } = deps;
    await ensureInitialized(repo.id);
    
    const scopeRaw = String(params.scope || 'unstaged').trim();
    const scope = scopeRaw.toLowerCase();
    const allowedScopes = new Set(['unstaged', 'staged', 'all', 'compare']);
    if (!allowedScopes.has(scope)) {
      return { error: `scope must be one of unstaged|staged|all|compare (received "${scopeRaw}")` };
    }
    const baseRef = String(params.base_ref || '').trim();
    const { execFileSync } = await import('child_process');

    const normalizePath = (value: string): string => normalizeRepoRelativePath(value);
    const parseLines = (output: string): string[] => (
      String(output || '')
        .split('\n')
        .map(line => normalizePath(line))
        .filter(Boolean)
    );

    const buildDiffArgs = (): string[] => {
      const args = ['diff', '--name-only'];
      switch (scope) {
        case 'staged':
          args.push('--staged');
          break;
        case 'all':
          args.push('HEAD');
          break;
        case 'compare':
          if (!baseRef) throw new Error('base_ref is required for "compare" scope');
          args.push(`${baseRef}...HEAD`);
          break;
        case 'unstaged':
        default:
          break;
      }
      return args;
    };

    const changedFileStatus = new Map<string, 'Modified' | 'Untracked'>();
    try {
      const output = execFileSync('git', buildDiffArgs(), {
        cwd: repo.repoPath,
        encoding: 'utf-8',
        maxBuffer: GIT_NAME_LIST_MAX_BUFFER,
      });
      for (const filePath of parseLines(output)) {
        changedFileStatus.set(filePath, 'Modified');
      }
    } catch (err: any) {
      return { error: `Git diff failed: ${err?.message || 'unknown error'}` };
    }

    // Include untracked files for non-staged scopes so detect_changes matches review behavior.
    if (scope !== 'staged') {
      try {
        const statusOutput = execFileSync('git', ['status', '--porcelain'], {
          cwd: repo.repoPath,
          encoding: 'utf-8',
          maxBuffer: GIT_NAME_LIST_MAX_BUFFER,
        });
        for (const line of String(statusOutput || '').split('\n')) {
          if (!line.startsWith('?? ')) continue;
          const filePath = normalizePath(line.slice(3));
          if (!filePath) continue;
          if (!changedFileStatus.has(filePath)) changedFileStatus.set(filePath, 'Untracked');
        }
      } catch {
        // best-effort only
      }
    }

    const changedFiles = Array.from(changedFileStatus.entries()).map(([filePath, status]) => ({ filePath, status }));

    if (changedFiles.length === 0) {
      return {
        summary: {
          changed_count: 0,
          affected_count: 0,
          changed_files: 0,
          untracked_files: 0,
          risk_level: 'none',
          message: 'No changes detected.',
        },
        changed_files: [],
        changed_symbols: [],
        affected_processes: [],
      };
    }

    const changedFilePaths = changedFiles.map(file => file.filePath);
    const changedFilesCypher = `[${changedFilePaths.map(filePath => `'${filePath.replace(/'/g, "''")}'`).join(', ')}]`;

    // Map changed files to indexed symbols (exact path match for accuracy).
    const changedSymbolsById = new Map<string, {
      id: string;
      name: string;
      type: string;
      filePath: string;
      change_type: 'Modified' | 'Untracked';
    }>();

    try {
      const symbolRows = await executeQuery(repo.id, `
        MATCH (n)
        WHERE n.filePath IN ${changedFilesCypher}
        RETURN n.id AS id, n.name AS name, labels(n) AS type, n.filePath AS filePath
        LIMIT ${Math.max(200, Math.min(5000, changedFilePaths.length * 50))}
      `);

      for (const row of symbolRows) {
        const id = String(row.id || row[0] || '').trim();
        const filePath = normalizePath(String(row.filePath || row[3] || ''));
        if (!id || !filePath) continue;
        if (changedSymbolsById.has(id)) continue;

        changedSymbolsById.set(id, {
          id,
          name: String(row.name || row[1] || '').trim(),
          type: primaryNodeLabel(row.type ?? row[2]),
          filePath,
          change_type: changedFileStatus.get(filePath) || 'Modified',
        });
      }
    } catch {
      // best-effort only
    }

    const changedSymbols = Array.from(changedSymbolsById.values());
    const changedSymbolIds = changedSymbols.map(symbol => symbol.id).filter(Boolean);

    // Find affected processes in one batched query.
    const affectedProcesses = new Map<string, {
      id: string;
      name: string;
      process_type: string;
      step_count: number;
      changed_steps: Array<{ symbol: string; step: number }>;
    }>();

    if (changedSymbolIds.length > 0) {
      try {
        const changedSymbolIdsCypher = `[${changedSymbolIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ')}]`;
        const processRows = await executeQuery(repo.id, `
          MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          WHERE n.id IN ${changedSymbolIdsCypher}
          RETURN n.id AS symbolId, n.name AS symbolName, p.id AS pid, p.heuristicLabel AS label, p.processType AS processType, p.stepCount AS stepCount, r.step AS step
          LIMIT ${Math.max(500, Math.min(15000, changedSymbolIds.length * 80))}
        `);

        for (const row of processRows) {
          const pid = String(row.pid || row[2] || '').trim();
          if (!pid) continue;
          if (!affectedProcesses.has(pid)) {
            affectedProcesses.set(pid, {
              id: pid,
              name: String(row.label || row[3] || '').trim(),
              process_type: String(row.processType || row[4] || '').trim(),
              step_count: toNonNegativeInteger(row.stepCount ?? row[5], 0),
              changed_steps: [],
            });
          }

          affectedProcesses.get(pid)!.changed_steps.push({
            symbol: String(row.symbolName || row[1] || '').trim(),
            step: toNonNegativeInteger(row.step ?? row[6], 0),
          });
        }
      } catch {
        // best-effort only
      }
    }

    const processCount = affectedProcesses.size;
    const risk = processCount === 0
      ? (changedSymbols.length === 0 ? 'low' : 'medium')
      : processCount <= 5
        ? 'medium'
        : processCount <= 15
          ? 'high'
          : 'critical';

    return {
      summary: {
        changed_count: changedSymbols.length,
        affected_count: processCount,
        changed_files: changedFiles.length,
        untracked_files: changedFiles.filter(file => file.status === 'Untracked').length,
        risk_level: risk,
      },
      changed_files: changedFiles,
      changed_symbols: changedSymbols,
      affected_processes: Array.from(affectedProcesses.values()),
    };
  }
