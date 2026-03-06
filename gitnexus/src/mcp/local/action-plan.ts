import fs from 'fs/promises';
import { extractUiContractCard } from '../../core/derived/ui-contract.js';

export interface ActionPlanRepoHandle {
  id: string;
  name: string;
  repoPath: string;
  storagePath: string;
}

export interface ActionPlanParams {
  query: string;
  task_context?: string;
  goal?: string;
  path_prefixes?: string[];
  limit_files?: number;
  limit_checks?: number;
  __skip_precedents?: boolean;
}

type ActionPlanDeps = {
  query: (repo: ActionPlanRepoHandle, params: any) => Promise<any>;
  precedents: (repo: ActionPlanRepoHandle, params: any) => Promise<any>;
  executeQuery: (repoId: string, query: string) => Promise<any[]>;
  loadClosureTemplateSnapshot: (storagePath: string) => Promise<any>;
  parsePathPrefixes: (repoPath: string, param: unknown) => string[];
  filePathTouchesPrefixes: (filePath: string, pathPrefixes: string[]) => boolean;
  clampInteger: (value: unknown, fallback: number, min?: number, max?: number) => number;
  toOptionalNonNegativeInteger: (value: unknown) => number | undefined;
  toFiniteNumber: (value: unknown, fallback?: number) => number;
  toOptionalLineNumber: (value: unknown) => number | undefined;
  normalizeConfidence: (value: unknown, fallback?: number) => number;
  parseStringList: (value: unknown) => string[];
  normalizeSliceStencilTokens: (values: unknown) => string[];
  round3: (value: unknown) => number;
  normalizeRepoRelativePath: (value: string) => string;
  resolvePathInsideRepo: (
    repoPath: string,
    rawPath: string,
  ) => { relativePath: string; absolutePath: string } | null;
};

type DirectActionPlanPrecedentSurface = {
  kind: string;
  title: string;
  signature: string;
  filePath: string;
  source: string;
  score: number;
};

const DIRECT_ACTION_PLAN_PRECEDENT_KINDS = new Set([
  'ui-behavior',
  'backend-behavior',
  'backend-handoff',
  'pattern-catalog',
  'slice',
  'hop',
  'process',
]);
const STRONG_ACTION_PLAN_PRECEDENT_KINDS = new Set([
  'ui-behavior',
  'backend-behavior',
  'backend-handoff',
  'pattern-catalog',
]);
const DIRECT_ACTION_PLAN_PRECEDENT_BASE_SCORES: Record<string, number> = {
  'ui-behavior': 1.08,
  'backend-handoff': 1.04,
  'backend-behavior': 1.02,
  'pattern-catalog': 0.95,
  slice: 0.9,
  hop: 0.88,
  process: 0.86,
};
const GENERIC_ACTION_PLAN_TARGET_PATTERNS = [
  /^pattern-catalog:/i,
  /\bpermission\b/i,
  /\bendpoint\b/i,
  /\bcontroller\b/i,
  /\broute\b/i,
  /\bapi\b/i,
];

const buildDirectActionPlanPrecedentSurfaces = (
  precedents: any[],
  normalizeRepoRelativePath: (value: string) => string,
): DirectActionPlanPrecedentSurface[] => {
  const byFilePath = new Map<string, DirectActionPlanPrecedentSurface>();

  const basename = (filePath: string): string => {
    const parts = String(filePath || '').split('/').filter(Boolean);
    return parts[parts.length - 1] || filePath;
  };

  const pushNode = (precedent: any, node: any, source: string, scoreOffset = 0): void => {
    const kind = String(precedent?.kind || '').trim();
    if (!DIRECT_ACTION_PLAN_PRECEDENT_KINDS.has(kind)) return;

    const filePath = normalizeRepoRelativePath(String(node?.filePath || ''));
    if (!filePath) return;

    const baseScore = DIRECT_ACTION_PLAN_PRECEDENT_BASE_SCORES[kind] ?? 0.84;
    const score = Math.round(Math.max(0, baseScore + scoreOffset) * 1000) / 1000;
    const title = String(
      node?.title
      || node?.name
      || precedent?.anchor?.title
      || precedent?.anchor?.name
      || precedent?.signature
      || basename(filePath),
    ).trim() || basename(filePath);
    const signature = String(precedent?.signature || '').trim();
    const existing = byFilePath.get(filePath);
    if (existing && existing.score >= score) return;

    byFilePath.set(filePath, {
      kind,
      title,
      signature,
      filePath,
      source,
      score,
    });
  };

  for (const precedent of Array.isArray(precedents) ? precedents : []) {
    pushNode(precedent, precedent?.anchor, 'anchor', 0.04);
    pushNode(precedent, precedent?.anchor?.ui, 'anchor-ui', 0.03);
    pushNode(precedent, precedent?.anchor?.endpoint, 'anchor-endpoint', 0.02);
    pushNode(precedent, precedent?.anchor?.controller, 'anchor-controller', 0.01);

    const examples = Array.isArray(precedent?.examples) ? precedent.examples : [];
    for (const example of examples.slice(0, 4)) {
      pushNode(precedent, example, 'example', -0.04);
      pushNode(precedent, example?.ui, 'example-ui', -0.05);
      pushNode(precedent, example?.endpoint, 'example-endpoint', -0.05);
      pushNode(precedent, example?.controller, 'example-controller', -0.05);
    }

    const memberFiles = Array.isArray(precedent?.member_files) ? precedent.member_files : [];
    for (const memberFilePath of memberFiles.slice(0, 6)) {
      pushNode(precedent, { filePath: memberFilePath }, 'member-file', -0.06);
    }
  }

  return Array.from(byFilePath.values())
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.kind !== right.kind) {
        const leftPriority = DIRECT_ACTION_PLAN_PRECEDENT_BASE_SCORES[left.kind] ?? 0;
        const rightPriority = DIRECT_ACTION_PLAN_PRECEDENT_BASE_SCORES[right.kind] ?? 0;
        if (rightPriority !== leftPriority) return rightPriority - leftPriority;
      }
      if (left.title !== right.title) return left.title.localeCompare(right.title);
      return left.filePath.localeCompare(right.filePath);
    });
};

export async function runActionPlan(
  deps: ActionPlanDeps,
  repo: ActionPlanRepoHandle,
  params: ActionPlanParams,
): Promise<any> {
  const {
    query,
    precedents,
    executeQuery,
    loadClosureTemplateSnapshot,
    parsePathPrefixes,
    filePathTouchesPrefixes,
    clampInteger,
    toOptionalNonNegativeInteger,
    toFiniteNumber,
    toOptionalLineNumber,
    normalizeConfidence,
    parseStringList,
    normalizeSliceStencilTokens,
    round3,
    normalizeRepoRelativePath,
    resolvePathInsideRepo,
  } = deps;
    const limitFiles = clampInteger(params.limit_files, 10, 1, 50);
    const limitChecks = clampInteger(params.limit_checks, 10, 1, 20);
    const skipPrecedents = params.__skip_precedents === true;
    const pathPrefixes = parsePathPrefixes(repo.repoPath, (params as any).path_prefixes);
    const isInScope = (filePath: string): boolean => filePathTouchesPrefixes(filePath, pathPrefixes);
    const toPrimaryLabel = (value: any): string => {
      if (Array.isArray(value)) return String(value[0] || '').trim();
      return String(value || '').trim();
    };

    const result = await query(repo, {
      query: params.query,
      task_context: params.task_context,
      goal: params.goal,
      path_prefixes: pathPrefixes,
      limit: 5,
      max_symbols: 12,
      include_content: false,
    });

    const symbols: any[] = Array.isArray(result?.process_symbols) ? result.process_symbols : [];
    const definitions: any[] = Array.isArray(result?.definitions) ? result.definitions : [];

    const fileAgg = new Map<string, { score: number; anchors: Array<{ w: number; a: any }> }>();

    const addAnchor = (sym: any, weight: number) => {
      const filePath = String(sym?.filePath || '').trim();
      if (!filePath) return;

      let agg = fileAgg.get(filePath);
      if (!agg) {
        agg = { score: 0, anchors: [] };
        fileAgg.set(filePath, agg);
      }
      agg.score += weight;

      agg.anchors.push({
        w: weight,
        a: {
          id: sym?.id,
          name: sym?.name,
          type: sym?.type,
          startLine: sym?.startLine,
          endLine: sym?.endLine,
        }
      });
    };

    for (const sym of symbols) {
      const stepIndexRaw = sym?.step_index;
      const stepIndex = toOptionalNonNegativeInteger(stepIndexRaw) ?? Number.POSITIVE_INFINITY;
      const stepWeight = Number.isFinite(stepIndex) && stepIndex >= 0 ? (1 / (1 + stepIndex)) : 0.1;

      const hitRankRaw = sym?.hit_rank;
      const hitRank = toFiniteNumber(hitRankRaw, Number.POSITIVE_INFINITY);
      const hitWeight = Number.isFinite(hitRank) && hitRank > 0 ? (1 / hitRank) : 0;

      addAnchor(sym, 1.0 + stepWeight + (hitWeight * 2));
    }

    for (const def of definitions) {
      addAnchor(def, 0.25);
    }

    const rankedFiles = Array.from(fileAgg.entries())
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, limitFiles)
      .map(([filePath, agg]) => {
        const anchors = agg.anchors
          .sort((a, b) => b.w - a.w)
          .map(x => x.a);

        // Dedup anchors by id/name (keep highest-weight)
        const seen = new Set<string>();
        const deduped: any[] = [];
        for (const a of anchors) {
          const key = a.id || `${a.type}:${a.name}:${a.startLine}`;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          deduped.push(a);
          if (deduped.length >= 3) break;
        }

        return {
          filePath,
          score: Math.round(agg.score * 1000) / 1000,
          anchors: deduped,
        };
      });

    const filePaths = rankedFiles.map(f => f.filePath.toLowerCase());
    const hasPhp = filePaths.some(p => p.endsWith('.php'));
    const hasTs = filePaths.some(p => p.endsWith('.ts') || p.endsWith('.tsx') || p.endsWith('.js') || p.endsWith('.jsx'));
    const hasBlade = filePaths.some(p => p.endsWith('.blade.php'));
    const hasSvelte = filePaths.some(p => p.endsWith('.svelte'));

    const checks: string[] = [];
    checks.push('Use context() on the top anchors, then impact() on the change point.');
    checks.push('Run the smallest targeted tests that exercise the top-ranked process.');

    if (hasTs) {
      checks.push('Frontend: run TypeScript typecheck + lint for the affected workspace.');
    }
    if (hasPhp) {
      checks.push('Backend: run relevant PHPUnit tests for the impacted handlers/services.');
    }
    if (hasBlade) {
      checks.push('Templates: verify Blade output renders as expected (emails/views).');
    }
    if (hasSvelte) {
      checks.push('Svelte: verify build/compile + integration points for the touched components.');
    }

    const isTsLikeFilePath = (filePath: string): boolean => {
      const p = filePath.toLowerCase();
      return p.endsWith('.ts') || p.endsWith('.tsx') || p.endsWith('.js') || p.endsWith('.jsx');
    };

    const symById = new Map<string, any>();
    for (const sym of [...symbols, ...definitions]) {
      const id = sym?.id;
      if (typeof id !== 'string' || !id) continue;
      symById.set(id, sym);
    }

    const nodeCache = new Map<string, any>();
    const loadNode = async (uid: string): Promise<any | null> => {
      const cached = nodeCache.get(uid) || symById.get(uid);
      if (cached) {
        nodeCache.set(uid, cached);
        return cached;
      }

      const escaped = uid.replace(/'/g, "''");
      let rows: any[] = [];
      try {
        rows = await executeQuery(repo.id, `
          MATCH (n {id: '${escaped}'})
          RETURN n.id AS id, n.name AS name, labels(n) AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
          LIMIT 1
        `);
      } catch {
        return null;
      }

      if (rows.length === 0) return null;
      const r = rows[0];
      const loaded = {
        id: r.id || r[0],
        name: r.name || r[1],
        type: toPrimaryLabel(r.type || r[2]),
        filePath: r.filePath || r[3],
        startLine: r.startLine ?? r[4],
        endLine: r.endLine ?? r[5],
      };
      nodeCache.set(uid, loaded);
      return loaded;
    };

    const enclosingTypeCache = new Map<string, string | null>();
    const getEnclosingTypeName = async (methodUid: string): Promise<string | null> => {
      if (enclosingTypeCache.has(methodUid)) return enclosingTypeCache.get(methodUid) ?? null;

      const escaped = methodUid.replace(/'/g, "''");
      let rows: any[] = [];
      try {
        rows = await executeQuery(repo.id, `
          MATCH (m {id: '${escaped}'})-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Class)
          RETURN c.name AS name
          LIMIT 1
        `);
      } catch {
        enclosingTypeCache.set(methodUid, null);
        return null;
      }

      const name = (rows[0]?.name || rows[0]?.[0] || null) as string | null;
      enclosingTypeCache.set(methodUid, name);
      return name;
    };

    const normalizeNode = async (uid: string, fallback?: Partial<any>): Promise<any | null> => {
      const base = (await loadNode(uid)) || null;
      const merged = { ...(base || {}), ...(fallback || {}) };
      const id = merged.id || uid;
      const name = String(merged.name || '').trim();
      const type = String(merged.type || '').trim();
      const filePath = String(merged.filePath || '').trim();
      if (!id || !type || !filePath) return base;

      if (type === 'Method') {
        const enclosing = await getEnclosingTypeName(id);
        if (enclosing) {
          return { ...merged, display_name: `${enclosing}::${name}` };
        }
      }

      return merged;
    };

    const buildPermissionGrantsForController = async (controllerUid: string): Promise<any[]> => {
      const escaped = controllerUid.replace(/'/g, "''");
      let authRows: any[] = [];
      try {
        authRows = await executeQuery(repo.id, `
          MATCH (c {id: '${escaped}'})-[r:CodeRelation {type: 'CALLS'}]->(t)
          WHERE r.confidence >= 0.9
            AND (
              r.reason STARTS WITH 'laravel-authorize:'
              OR r.reason STARTS WITH 'laravel-gate:'
              OR r.reason STARTS WITH 'laravel-can:'
            )
          RETURN t.id AS uid, t.name AS name, labels(t) AS type, t.filePath AS filePath,
                 r.reason AS reason, r.confidence AS confidence
          ORDER BY r.confidence DESC
          LIMIT 15
        `);
      } catch {
        return [];
      }

      type PermissionCandidate = {
        kind: 'enum_case' | 'policy_method' | 'permission_slug';
        uid: string;
        name: string;
        type: string;
        filePath: string;
        edge: { reason: string; confidence: number };
      };

      const candidates: PermissionCandidate[] = [];
      const seenCandidates = new Set<string>();
      for (const row of authRows) {
        const uid = row.uid || row[0];
        if (!uid || typeof uid !== 'string') continue;
        const type = toPrimaryLabel(row.type || row[2] || '');
        const edgeReason = String(row.reason || row[4] || '');
        const edgeConfidence = normalizeConfidence(row.confidence ?? row[5], 1.0);
        const candidateKey = `${uid}|${type}|${edgeReason}`;
        if (seenCandidates.has(candidateKey)) continue;
        seenCandidates.add(candidateKey);
        if (uid.startsWith('CodeElement:permission:')) {
          candidates.push({
            kind: 'permission_slug',
            uid,
            name: row.name || row[1] || '',
            type: 'CodeElement',
            filePath: row.filePath || row[3] || '',
            edge: {
              reason: edgeReason,
              confidence: edgeConfidence,
            },
          });
          continue;
        }
        if (type === 'Const') {
          candidates.push({
            kind: 'enum_case',
            uid,
            name: row.name || row[1] || '',
            type,
            filePath: row.filePath || row[3] || '',
            edge: {
              reason: edgeReason,
              confidence: edgeConfidence,
            },
          });
          continue;
        }

        if (type === 'Method') {
          candidates.push({
            kind: 'policy_method',
            uid,
            name: row.name || row[1] || '',
            type,
            filePath: row.filePath || row[3] || '',
            edge: {
              reason: edgeReason,
              confidence: edgeConfidence,
            },
          });
        }
      }

      const grants: any[] = [];
      const seen = new Set<string>();
      const roleRowsBySlugUid = new Map<string, any[]>();
      const slugRowsByConstUid = new Map<string, any[]>();
      const cypherStringList = (values: string[]): string => {
        if (values.length === 0) return '[]';
        return `[${values.map(value => `'${String(value || '').replace(/'/g, "''")}'`).join(', ')}]`;
      };

      const expandSlugToGrant = async (
        slugUid: string,
        evidence: { controller_edge: { reason: string; confidence: number }; via_policy?: any; },
        fallback?: { name?: string; filePath?: string },
      ): Promise<void> => {
        const slugEsc = slugUid.replace(/'/g, "''");
        let slug = String(fallback?.name || '').trim();
        let slugFilePath = String(fallback?.filePath || '').trim();
        if (!slug) {
          let slugRows: any[] = [];
          try {
            slugRows = await executeQuery(repo.id, `
              MATCH (s:CodeElement {id: '${slugEsc}'})
              RETURN s.id AS uid, s.name AS name, s.filePath AS filePath
              LIMIT 1
            `);
          } catch {
            return;
          }

          const slugRow = slugRows[0] || null;
          slug = String(slugRow?.name || '').trim();
          slugFilePath = String(slugRow?.filePath || '').trim();
          if (!slug) return;
        }

        const key = `${slugUid}:${slug}`;
        if (seen.has(key)) return;
        seen.add(key);

        const slugNode = await normalizeNode(slugUid, {
          id: slugUid,
          name: slug,
          type: 'CodeElement',
          filePath: slugFilePath,
        });

        let roleRows = roleRowsBySlugUid.get(slugUid);
        if (!roleRows) {
          roleRows = [];
          try {
            roleRows = await executeQuery(repo.id, `
              MATCH (role:CodeElement)-[r:CodeRelation {type: 'CALLS'}]->(s {id: '${slugEsc}'})
              WHERE r.confidence >= 0.9 AND r.reason STARTS WITH 'laravel-role-permission-slug:'
              RETURN role.id AS uid, role.name AS name, role.filePath AS filePath, r.reason AS reason, r.confidence AS confidence
              ORDER BY role.name
              LIMIT 25
            `);
          } catch {
            roleRows = [];
          }
          roleRowsBySlugUid.set(slugUid, roleRows);
        }

        const roles: any[] = [];
        const roleSeen = new Set<string>();
        for (const roleRow of roleRows) {
          const roleUid = roleRow.uid || roleRow[0];
          if (!roleUid || typeof roleUid !== 'string') continue;
          if (roleSeen.has(roleUid)) continue;
          roleSeen.add(roleUid);
          roles.push({
            uid: roleUid,
            name: roleRow.name || roleRow[1] || '',
            filePath: roleRow.filePath || roleRow[2] || '',
            reason: roleRow.reason || roleRow[3] || '',
            confidence: normalizeConfidence(roleRow.confidence ?? roleRow[4], 1.0),
          });
        }

        grants.push({
          permission: slugNode ? {
            uid: slugNode.id,
            slug: slugNode.name,
            filePath: slugNode.filePath,
          } : {
            uid: slugUid,
            slug,
            filePath: slugFilePath,
          },
          roles,
          evidence,
        });
      };

      const expandConstToGrant = async (
        constUid: string,
        evidence: { controller_edge: { reason: string; confidence: number }; via_policy?: any; }
      ): Promise<void> => {
        const constEscaped = constUid.replace(/'/g, "''");
        let slugRows = slugRowsByConstUid.get(constUid);
        if (!slugRows) {
          slugRows = [];
          try {
            slugRows = await executeQuery(repo.id, `
              MATCH (c {id: '${constEscaped}'})-[r:CodeRelation {type: 'CALLS'}]->(s:CodeElement)
              WHERE r.reason STARTS WITH 'laravel-permission-slug:'
              RETURN s.id AS uid, s.name AS name, s.filePath AS filePath, r.reason AS reason, r.confidence AS confidence
              ORDER BY r.confidence DESC
              LIMIT 2
            `);
          } catch {
            slugRows = [];
          }
          slugRowsByConstUid.set(constUid, slugRows);
        }

        for (const slugRow of slugRows) {
          const slugUid = slugRow.uid || slugRow[0];
          if (!slugUid || typeof slugUid !== 'string') continue;
          const slug = String(slugRow.name || slugRow[1] || '').trim();
          if (!slug) continue;

          const key = `${slugUid}:${slug}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const slugNode = await normalizeNode(slugUid, {
            id: slugUid,
            name: slug,
            type: 'CodeElement',
            filePath: slugRow.filePath || slugRow[2] || '',
          });

          const slugEdge = {
            reason: String(slugRow.reason || slugRow[3] || ''),
            confidence: normalizeConfidence(slugRow.confidence ?? slugRow[4], 1.0),
          };

          let roleRows = roleRowsBySlugUid.get(slugUid);
          if (!roleRows) {
            roleRows = [];
            try {
              const slugEsc = slugUid.replace(/'/g, "''");
              roleRows = await executeQuery(repo.id, `
                MATCH (role:CodeElement)-[r:CodeRelation {type: 'CALLS'}]->(s {id: '${slugEsc}'})
                WHERE r.confidence >= 0.9 AND r.reason STARTS WITH 'laravel-role-permission-slug:'
                RETURN role.id AS uid, role.name AS name, role.filePath AS filePath, r.reason AS reason, r.confidence AS confidence
                ORDER BY role.name
                LIMIT 25
              `);
            } catch {
              roleRows = [];
            }
            roleRowsBySlugUid.set(slugUid, roleRows);
          }

          const roles: any[] = [];
          const roleSeen = new Set<string>();
          for (const roleRow of roleRows) {
            const roleUid = roleRow.uid || roleRow[0];
            if (!roleUid || typeof roleUid !== 'string') continue;
            if (roleSeen.has(roleUid)) continue;
            roleSeen.add(roleUid);
            roles.push({
              uid: roleUid,
              name: roleRow.name || roleRow[1] || '',
              filePath: roleRow.filePath || roleRow[2] || '',
              reason: roleRow.reason || roleRow[3] || '',
              confidence: normalizeConfidence(roleRow.confidence ?? roleRow[4], 1.0),
            });
          }

          grants.push({
            permission: slugNode ? {
              uid: slugNode.id,
              slug: slugNode.name,
              filePath: slugNode.filePath,
            } : {
              uid: slugUid,
              slug,
              filePath: slugRow.filePath || slugRow[2] || '',
            },
            roles,
            evidence: {
              ...evidence,
              slug_edge: slugEdge,
            },
          });
        }
      };

      const constRowsByPolicyUid = new Map<string, any[]>();
      const policyCandidates = candidates.filter(candidate => candidate.kind === 'policy_method');
      if (policyCandidates.length > 0) {
        try {
          const policyIds = Array.from(new Set(policyCandidates.map(candidate => String(candidate.uid || '').trim()).filter(Boolean)));
          const policyRows = await executeQuery(repo.id, `
            MATCH (p)-[r:CodeRelation {type: 'CALLS'}]->(c:Const)
            WHERE p.id IN ${cypherStringList(policyIds)}
              AND r.confidence >= 0.9
              AND r.reason STARTS WITH 'php-match-return:'
            RETURN p.id AS policyUid, c.id AS uid, c.name AS name, c.filePath AS filePath, r.reason AS reason, r.confidence AS confidence
            ORDER BY r.confidence DESC
            LIMIT ${Math.max(80, Math.min(4000, policyIds.length * 20))}
          `);
          for (const row of policyRows) {
            const policyUid = String(row.policyUid || row[0] || '').trim();
            if (!policyUid) continue;
            const list = constRowsByPolicyUid.get(policyUid) || [];
            list.push({
              uid: row.uid || row[1],
              name: row.name || row[2],
              filePath: row.filePath || row[3],
              reason: row.reason || row[4],
              confidence: normalizeConfidence(row.confidence ?? row[5], 1.0),
            });
            constRowsByPolicyUid.set(policyUid, list);
          }
        } catch {
          // best-effort policy expansion
        }
      }

      for (const candidate of candidates) {
        if (candidate.kind === 'permission_slug') {
          await expandSlugToGrant(candidate.uid, {
            controller_edge: candidate.edge,
          }, {
            name: candidate.name,
            filePath: candidate.filePath,
          });
          continue;
        }

        if (candidate.kind === 'enum_case') {
          await expandConstToGrant(candidate.uid, { controller_edge: candidate.edge });
          continue;
        }

        // Policy method: attempt to derive permission enum cases deterministically via match-return edges.
        const constRows = constRowsByPolicyUid.get(candidate.uid) || [];

        for (const row of constRows) {
          const constUid = row.uid || row[0];
          if (!constUid || typeof constUid !== 'string') continue;
          const matchEdge = {
            reason: String(row.reason || row[3] || ''),
            confidence: normalizeConfidence(row.confidence ?? row[4], 1.0),
          };
          await expandConstToGrant(constUid, {
            controller_edge: candidate.edge,
            via_policy: {
              uid: candidate.uid,
              name: candidate.name,
              filePath: candidate.filePath,
              match_edge: matchEdge,
            },
          });
        }
      }

      return grants;
    };

    const hops: any[] = [];
    const hopLimit = Math.max(1, Math.min(25, limitFiles * 2));
    const seenHopKey = new Set<string>();
    const endpointWiringCache = new Map<string, { reason: string; confidence: number } | null>();
    const controllerGrantCache = new Map<string, any[]>();

    const controllerCandidates = [...symbols, ...definitions]
      .filter(s => s?.type === 'Method' && String(s?.filePath || '').includes('/Http/Controllers/'))
      .map(s => s.id)
      .filter((id: any): id is string => typeof id === 'string' && id.length > 0)
      .slice(0, hopLimit);

    const endpointCandidates = [...symbols, ...definitions]
      .filter(s => s?.type === 'CodeElement' && String(s?.name || '').startsWith('endpoint:'))
      .map(s => s.id)
      .filter((id: any): id is string => typeof id === 'string' && id.length > 0)
      .slice(0, hopLimit);

    const uiCandidates = [...symbols, ...definitions]
      .filter(s => (s?.type === 'Function' || s?.type === 'Method') && isTsLikeFilePath(String(s?.filePath || '')))
      .map(s => s.id)
      .filter((id: any): id is string => typeof id === 'string' && id.length > 0)
      .slice(0, hopLimit);

    const tryAddHop = async (opts: {
      uiUid: string;
      endpointUid: string;
      controllerUid: string;
      http: { reason: string; confidence: number };
    }): Promise<void> => {
      if (hops.length >= hopLimit) return;

      const key = `${opts.uiUid}|${opts.endpointUid}|${opts.controllerUid}|${opts.http.reason}`;
      if (seenHopKey.has(key)) return;
      seenHopKey.add(key);

      const [uiNode, endpointNode, controllerNode] = await Promise.all([
        normalizeNode(opts.uiUid),
        normalizeNode(opts.endpointUid),
        normalizeNode(opts.controllerUid),
      ]);
      if (!uiNode || !endpointNode || !controllerNode) return;

      const endpointEdgeKey = `${opts.endpointUid}|${opts.controllerUid}`;
      let endpointEdge = endpointWiringCache.get(endpointEdgeKey);
      if (endpointEdge === undefined) {
        const endpointEsc = opts.endpointUid.replace(/'/g, "''");
        const controllerEsc = opts.controllerUid.replace(/'/g, "''");
        let resolved: { reason: string; confidence: number } | null = null;
        try {
          const rows = await executeQuery(repo.id, `
            MATCH (e {id: '${endpointEsc}'})-[r:CodeRelation {type: 'CALLS'}]->(c {id: '${controllerEsc}'})
            WHERE r.reason STARTS WITH 'laravel-endpoint:'
            RETURN r.reason AS reason, r.confidence AS confidence
            ORDER BY r.confidence DESC
            LIMIT 1
          `);
          if (rows.length > 0) {
            resolved = {
              reason: rows[0].reason || rows[0][0] || '',
              confidence: normalizeConfidence(rows[0].confidence ?? rows[0][1], 1.0),
            };
          }
        } catch { /* ignore */ }
        endpointWiringCache.set(endpointEdgeKey, resolved);
        endpointEdge = resolved;
      }

      if (!controllerGrantCache.has(opts.controllerUid)) {
        controllerGrantCache.set(opts.controllerUid, await buildPermissionGrantsForController(opts.controllerUid));
      }
      const grants = controllerGrantCache.get(opts.controllerUid) || [];

      hops.push({
        http: opts.http,
        endpoint_wiring: endpointEdge,
        ui: {
          uid: uiNode.id,
          name: uiNode.display_name || uiNode.name,
          kind: uiNode.type,
          filePath: uiNode.filePath,
          startLine: uiNode.startLine,
        },
        endpoint: {
          uid: endpointNode.id,
          name: endpointNode.name,
          kind: endpointNode.type,
          filePath: endpointNode.filePath,
          startLine: endpointNode.startLine,
        },
        controller: {
          uid: controllerNode.id,
          name: controllerNode.display_name || controllerNode.name,
          kind: controllerNode.type,
          filePath: controllerNode.filePath,
          startLine: controllerNode.startLine,
        },
        permissions: grants,
      });
    };

    const hopWork: Array<() => Promise<void>> = [];

    const preloadControllerGrants = async (controllerIds: string[]): Promise<void> => {
      const uniqueControllerIds = Array.from(new Set(
        controllerIds
          .map(uid => String(uid || '').trim())
          .filter(Boolean),
      ));
      if (uniqueControllerIds.length === 0) return;
      await Promise.all(uniqueControllerIds.map(async (controllerUid) => {
        if (controllerGrantCache.has(controllerUid)) return;
        controllerGrantCache.set(controllerUid, await buildPermissionGrantsForController(controllerUid));
      }));
    };

    const buildFromController = async (controllerUid: string): Promise<void> => {
      const escaped = controllerUid.replace(/'/g, "''");
      let rows: any[] = [];
      try {
        rows = await executeQuery(repo.id, `
          MATCH (ui)-[rHttp:CodeRelation {type: 'CALLS'}]->(c {id: '${escaped}'})
          WHERE rHttp.confidence >= 0.9 AND rHttp.reason STARTS WITH 'http-'
          MATCH (ui)-[rEndpoint:CodeRelation {type: 'CALLS'}]->(e:CodeElement)
          WHERE rEndpoint.confidence >= 0.9
            AND rEndpoint.reason = rHttp.reason
            AND e.name STARTS WITH 'endpoint:'
          RETURN ui.id AS uiUid,
                 e.id AS endpointUid,
                 rHttp.reason AS reason,
                 CASE WHEN rHttp.confidence >= rEndpoint.confidence THEN rHttp.confidence ELSE rEndpoint.confidence END AS confidence
          ORDER BY confidence DESC
          LIMIT 10
        `);
      } catch {
        return;
      }

      for (const row of rows) {
        if (hops.length >= hopLimit) return;
        const uiUid = row.uiUid || row[0];
        const endpointUid = row.endpointUid || row[1];
        const reason = row.reason || row[2];
        const confidence = normalizeConfidence(row.confidence ?? row[3], 1.0);
        if (!uiUid || typeof uiUid !== 'string') continue;
        if (!endpointUid || typeof endpointUid !== 'string') continue;
        if (!reason || typeof reason !== 'string') continue;

        await tryAddHop({
          uiUid,
          endpointUid,
          controllerUid,
          http: { reason, confidence },
        });
      }
    };

    const buildFromEndpoint = async (endpointUid: string): Promise<void> => {
      const escaped = endpointUid.replace(/'/g, "''");
      let rows: any[] = [];
      try {
        rows = await executeQuery(repo.id, `
          MATCH (ui)-[rHttp:CodeRelation {type: 'CALLS'}]->(e {id: '${escaped}'})
          WHERE rHttp.confidence >= 0.9 AND rHttp.reason STARTS WITH 'http-'
          MATCH (e)-[rEndpoint:CodeRelation {type: 'CALLS'}]->(c:Method)
          WHERE rEndpoint.reason STARTS WITH 'laravel-endpoint:' AND rEndpoint.confidence >= 0.9
          RETURN ui.id AS uiUid,
                 c.id AS controllerUid,
                 rHttp.reason AS reason,
                 CASE WHEN rHttp.confidence >= rEndpoint.confidence THEN rHttp.confidence ELSE rEndpoint.confidence END AS confidence
          ORDER BY confidence DESC
          LIMIT 20
        `);
      } catch {
        return;
      }

      for (const row of rows) {
        if (hops.length >= hopLimit) return;
        const uiUid = row.uiUid || row[0];
        const controllerUid = row.controllerUid || row[1];
        const reason = row.reason || row[2];
        const confidence = normalizeConfidence(row.confidence ?? row[3], 1.0);
        if (!uiUid || typeof uiUid !== 'string') continue;
        if (!controllerUid || typeof controllerUid !== 'string') continue;
        if (!reason || typeof reason !== 'string') continue;

        await tryAddHop({
          uiUid,
          endpointUid,
          controllerUid,
          http: { reason, confidence },
        });
      }
    };

    const buildFromUi = async (uiUid: string): Promise<void> => {
      const escaped = uiUid.replace(/'/g, "''");
      let rows: any[] = [];
      try {
        rows = await executeQuery(repo.id, `
          MATCH (ui {id: '${escaped}'})-[rHttp:CodeRelation {type: 'CALLS'}]->(e:CodeElement)
          WHERE rHttp.confidence >= 0.9 AND rHttp.reason STARTS WITH 'http-' AND e.name STARTS WITH 'endpoint:'
          MATCH (e)-[rEndpoint:CodeRelation {type: 'CALLS'}]->(c:Method)
          WHERE rEndpoint.reason STARTS WITH 'laravel-endpoint:' AND rEndpoint.confidence >= 0.9
          RETURN e.id AS endpointUid,
                 c.id AS controllerUid,
                 rHttp.reason AS reason,
                 CASE WHEN rHttp.confidence >= rEndpoint.confidence THEN rHttp.confidence ELSE rEndpoint.confidence END AS confidence
          ORDER BY confidence DESC
          LIMIT 20
        `);
      } catch {
        return;
      }

      for (const row of rows) {
        if (hops.length >= hopLimit) return;
        const endpointUid = row.endpointUid || row[0];
        const controllerUid = row.controllerUid || row[1];
        const reason = row.reason || row[2];
        const confidence = normalizeConfidence(row.confidence ?? row[3], 1.0);
        if (!endpointUid || typeof endpointUid !== 'string') continue;
        if (!controllerUid || typeof controllerUid !== 'string') continue;
        if (!reason || typeof reason !== 'string') continue;

        await tryAddHop({
          uiUid,
          endpointUid,
          controllerUid,
          http: { reason, confidence },
        });
      }
    };

    if (controllerCandidates.length > 0) {
      await preloadControllerGrants(controllerCandidates);
      for (const controllerUid of controllerCandidates) {
        if (hops.length >= hopLimit) break;
        hopWork.push(() => buildFromController(controllerUid));
      }
    } else if (endpointCandidates.length > 0) {
      for (const endpointUid of endpointCandidates) {
        if (hops.length >= hopLimit) break;
        hopWork.push(() => buildFromEndpoint(endpointUid));
      }
    } else {
      for (const uiUid of uiCandidates) {
        if (hops.length >= hopLimit) break;
        hopWork.push(() => buildFromUi(uiUid));
      }
    }

    try {
      for (const work of hopWork) {
        if (hops.length >= hopLimit) break;
        await work();
      }
    } catch { /* ignore */ }

    const cache_effects: any[] = [];
    try {
      const tsLikeFiles = rankedFiles
        .map(f => String(f?.filePath || '').trim())
        .filter(Boolean)
        .filter(isTsLikeFilePath)
        .slice(0, 3);

      for (const filePath of tsLikeFiles) {
        const resolved = resolvePathInsideRepo(repo.repoPath, filePath);
        if (!resolved) continue;
        let content: string;
        try {
          content = await fs.readFile(resolved.absolutePath, 'utf-8');
        } catch {
          continue;
        }

        const card = await extractUiContractCard(resolved.relativePath, content);
        const cacheLinks = Array.isArray((card as any)?.cacheLinks) ? (card as any).cacheLinks : [];
        const queries = Array.isArray((card as any)?.queries) ? (card as any).queries : [];
        const cacheCoverage = Array.isArray((card as any)?.cacheCoverage) ? (card as any).cacheCoverage : [];
        if (cacheLinks.length === 0 && queries.length === 0) continue;

        const linkSummaries = cacheLinks
          .map((l: any) => ({
            operation: l?.operation || null,
            matches: Array.isArray(l?.matches) ? l.matches : [],
          }))
          .filter((l: any) => l.operation && l.operation.method && l.operation.queryKey)
          .map((l: any) => ({
            operation: {
              kind: l.operation.kind,
              method: l.operation.method,
              queryKey: l.operation.queryKey,
              line: l.operation.line,
              confidence: l.operation.confidence,
            },
            matches: l.matches.map((m: any) => ({
              hook: m.hook,
              queryKey: m.queryKey,
              match: m.match,
              line: m.line,
              confidence: m.confidence,
            })),
          }));

        const matched = linkSummaries.filter((l: any) => l.matches.length > 0);
        const refetchCount = linkSummaries.filter((l: any) => l.operation.kind === 'refetch').length;
        const writeCount = linkSummaries.filter((l: any) => l.operation.kind === 'write').length;
        const removeCount = linkSummaries.filter((l: any) => l.operation.kind === 'remove').length;

        const coverageGaps = cacheCoverage
          .filter((c: any) => Array.isArray(c?.missing_queries) && c.missing_queries.length > 0)
          .map((c: any) => ({
            interaction: c?.interaction || null,
            mutations: Array.isArray(c?.mutations) ? c.mutations.slice(0, 5) : [],
            operations: Array.isArray(c?.operations) ? c.operations.slice(0, 8) : [],
            missing_queries: Array.isArray(c?.missing_queries) ? c.missing_queries.slice(0, 8) : [],
            confidence: normalizeConfidence(c?.confidence, 0.35),
          }))
          .slice(0, 10);

        cache_effects.push({
          filePath,
          summary: {
            queries: queries.length,
            operations: linkSummaries.length,
            matched_operations: matched.length,
            unmatched_operations: linkSummaries.length - matched.length,
            refetch_triggers: refetchCount,
            cache_writes: writeCount,
            cache_removes: removeCount,
            coverage_gaps: coverageGaps.length,
          },
          links: matched.slice(0, 25),
          coverage_gaps: coverageGaps,
        });
      }
    } catch { /* ignore */ }

    const parseSliceRole = (reason: string): string => {
      const raw = String(reason || '').trim();
      if (!raw) return '';
      if (!raw.startsWith('feature-slice:')) return raw;
      return raw.slice('feature-slice:'.length).trim();
    };

    const roleWritePriority = (role: string): number => {
      const normalized = String(role || '').trim().toLowerCase();
      if (normalized === 'anchor') return 0;
      if (normalized === 'entrypoint') return 1;
      if (normalized === 'handler') return 2;
      if (normalized === 'authorization') return 3;
      if (normalized === 'authorization_consumer') return 4;
      if (normalized === 'query_consumer') return 5;
      if (normalized === 'supporting') return 6;
      return 10;
    };

    const sliceCards: any[] = Array.isArray(result?.slice_cards) ? result.slice_cards : [];
    const targetSlice = sliceCards[0] || null;
    const queryIntent = String(result?.query_plan?.intent || '').trim() || undefined;
    const topProcesses = Array.isArray(result?.processes) ? result.processes : [];

    let precedentPack: any = null;
    let precedentRetrievalMode: 'query' | 'top-slice-fallback' | null = null;
    if (!skipPrecedents) {
      try {
        precedentPack = await precedents(repo, {
          query: params.query,
          limit: 2,
          examples: 3,
          path_prefixes: pathPrefixes,
        });
        precedentRetrievalMode = 'query';
        const matchedPrecedents = Array.isArray(precedentPack?.precedents) ? precedentPack.precedents : [];
        const hasDirectPrecedent = matchedPrecedents.some((precedent: any) => DIRECT_ACTION_PLAN_PRECEDENT_KINDS.has(String(precedent?.kind || '').trim()));
        if (!hasDirectPrecedent && targetSlice?.anchor_id) {
          precedentPack = await precedents(repo, {
            query: params.query,
            anchor_uid: String(targetSlice.anchor_id),
            limit: 2,
            examples: 3,
            path_prefixes: pathPrefixes,
          });
          precedentRetrievalMode = 'top-slice-fallback';
        }
      } catch {
        precedentPack = null;
        precedentRetrievalMode = null;
      }
    }

    const precedentItems: any[] = Array.isArray(precedentPack?.precedents) ? precedentPack.precedents : [];
    const docGuidanceKinds = new Set(['anti-pattern', 'agent-guideline']);
    const docGuidanceItems = precedentItems.filter(item => docGuidanceKinds.has(String(item?.kind || '').trim()));
    const precedentCandidates = precedentItems.filter(item => !docGuidanceKinds.has(String(item?.kind || '').trim()));
    const implementPrecedents = precedentCandidates.slice(0, 3).map((item: any) => ({
      kind: item?.kind,
      signature: item?.signature,
      anchor: item?.anchor,
      examples: Array.isArray(item?.examples) ? item.examples.slice(0, 3) : [],
    }));
    const docGuidance = docGuidanceItems.slice(0, 3).map((item: any) => ({
      kind: item?.kind,
      signature: item?.signature,
      anchor: item?.anchor,
      examples: Array.isArray(item?.examples) ? item.examples.slice(0, 5) : [],
    }));
    const directPrecedentSurfaces = buildDirectActionPlanPrecedentSurfaces(
      precedentCandidates,
      normalizeRepoRelativePath,
    );
    const directTargetPrecedent = directPrecedentSurfaces.find(surface => STRONG_ACTION_PLAN_PRECEDENT_KINDS.has(surface.kind))
      || directPrecedentSurfaces[0]
      || null;
    const targetSliceText = [
      String(targetSlice?.label || ''),
      String(targetSlice?.slice_type || ''),
      String(targetSlice?.anchor_name || ''),
      String(targetSlice?.uid || ''),
    ]
      .map(value => value.trim().toLowerCase())
      .filter(Boolean)
      .join(' ');
    const targetSliceLooksGeneric = GENERIC_ACTION_PLAN_TARGET_PATTERNS.some(pattern => pattern.test(targetSliceText));
    const targetSliceFiles = new Set<string>(
      (Array.isArray(targetSlice?.matched_members) ? targetSlice.matched_members : [])
        .map((member: any) => normalizeRepoRelativePath(String(member?.filePath || '')))
        .filter(Boolean),
    );
    const directPrecedentOverlapsTargetSlice = directPrecedentSurfaces.some(surface => targetSliceFiles.has(surface.filePath));
    const targetCalibratedFromDirectPrecedents = Boolean(
      directTargetPrecedent
      && (
        !targetSlice
        || targetSliceLooksGeneric
        || !directPrecedentOverlapsTargetSlice
      ),
    );

    const companionSignals = new Map<string, {
      filePath: string;
      score: number;
      reasons: Set<string>;
      anchors: Array<{ id?: string; name?: string; type?: string; startLine?: number; endLine?: number }>;
    }>();
    const companionSources = {
      seed_files: 0,
      slice_members: 0,
      cochange_edges: 0,
      shape_edges: 0,
    };

    const addCompanionSignal = (
      filePathRaw: string,
      score: number,
      reason: string,
      anchor?: { id?: string; name?: string; type?: string; startLine?: number; endLine?: number },
    ) => {
      const filePath = normalizeRepoRelativePath(String(filePathRaw || ''));
      if (!filePath) return;
      if (!isInScope(filePath)) return;

      const nextScore = toFiniteNumber(score, 0);
      if (nextScore <= 0) return;

      let entry = companionSignals.get(filePath);
      if (!entry) {
        entry = { filePath, score: 0, reasons: new Set<string>(), anchors: [] };
        companionSignals.set(filePath, entry);
      }
      entry.score += nextScore;
      if (reason) entry.reasons.add(reason);
      if (anchor) entry.anchors.push(anchor);
    };

    const filesByPath = new Map<string, {
      filePath: string;
      score: number;
      reasons: string[];
      anchors: any[];
    }>();
    const mergePlanFile = (
      filePathRaw: string,
      score: number,
      reason: string,
      anchors: any[] = [],
    ): void => {
      const filePath = normalizeRepoRelativePath(String(filePathRaw || ''));
      if (!filePath || !isInScope(filePath)) return;

      const nextScore = toFiniteNumber(score, 0);
      if (nextScore <= 0) return;

      const existing = filesByPath.get(filePath);
      if (!existing) {
        filesByPath.set(filePath, {
          filePath,
          score: nextScore,
          reasons: reason ? [reason] : [],
          anchors: anchors.slice(0, 4),
        });
        return;
      }

      existing.score = Math.max(existing.score, nextScore);
      if (reason && !existing.reasons.includes(reason)) existing.reasons.push(reason);
      for (const anchor of anchors) {
        existing.anchors.push(anchor);
        if (existing.anchors.length >= 4) break;
      }
    };

    for (const file of rankedFiles) {
      mergePlanFile(
        String(file?.filePath || ''),
        toFiniteNumber(file?.score, 0),
        'ranked-file',
        Array.isArray(file?.anchors) ? file.anchors.slice(0, 3) : [],
      );
    }
    if (targetCalibratedFromDirectPrecedents) {
      for (const surface of directPrecedentSurfaces.slice(0, Math.max(limitFiles, 4))) {
        mergePlanFile(
          surface.filePath,
          Math.max(6, surface.score * 10),
          `direct-precedent:${surface.kind || 'precedent'}`,
          [{
            name: surface.title,
            type: `precedent:${surface.kind || 'file'}`,
          }],
        );
      }
    }
    const files = Array.from(filesByPath.values())
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return left.filePath.localeCompare(right.filePath);
      })
      .slice(0, limitFiles)
      .map(file => ({
        filePath: file.filePath,
        score: round3(file.score),
        reasons: file.reasons.slice(0, 4),
        anchors: file.anchors.slice(0, 4),
      }));

    for (const file of rankedFiles.slice(0, 10)) {
      addCompanionSignal(
        String(file?.filePath || ''),
        toFiniteNumber(file?.score, 0) + 0.1,
        'ranked-file',
      );
      companionSources.seed_files += 1;
    }
    if (targetCalibratedFromDirectPrecedents) {
      for (const surface of directPrecedentSurfaces.slice(0, Math.max(limitFiles, 4))) {
        addCompanionSignal(
          surface.filePath,
          Math.max(4.5, surface.score * 5),
          `direct-precedent:${surface.kind || 'precedent'}`,
          {
            name: surface.title,
            type: `precedent:${surface.kind || 'file'}`,
          },
        );
      }
    }

    let targetTemplate: any = null;
    const writeOrder: any[] = [];
    let targetSliceGapSummary = {
      total: 0,
      deterministic: 0,
      pattern: 0,
      heuristic: 0,
      high: 0,
      medium: 0,
      low: 0,
    };

    if (targetSlice?.uid || targetSlice?.anchor_id) {
      const targetSliceId = String(targetSlice.uid || '').trim();
      if (targetSliceId) {
        const escapedSliceId = targetSliceId.replace(/'/g, "''");
        let memberRows: any[] = [];
        try {
          memberRows = await executeQuery(repo.id, `
            MATCH (n)-[r:CodeRelation {type: 'MEMBER_OF'}]->(s:FeatureSlice {id: '${escapedSliceId}'})
            WHERE r.reason STARTS WITH 'feature-slice:'
            RETURN n.id AS uid, n.name AS name, labels(n) AS kind, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, r.reason AS roleReason
            LIMIT 5000
          `);
        } catch {
          memberRows = [];
        }

        const memberIds: string[] = [];
        const memberFiles = new Set<string>();
        const seenWrite = new Set<string>();

        for (const row of memberRows) {
          const uid = String(row.uid ?? row[0] ?? '').trim();
          const name = String(row.name ?? row[1] ?? '').trim();
          const kindValue = row.kind ?? row[2];
          const kind = Array.isArray(kindValue) ? String(kindValue[0] || '').trim() : String(kindValue || '').trim();
          const filePath = normalizeRepoRelativePath(String(row.filePath ?? row[3] ?? ''));
          const role = parseSliceRole(String(row.roleReason ?? row[6] ?? '').trim());
          const startLine = toOptionalLineNumber(row.startLine ?? row[4]);
          const endLine = toOptionalLineNumber(row.endLine ?? row[5]);

          if (!uid || !filePath) continue;
          if (!isInScope(filePath)) continue;

          memberIds.push(uid);
          memberFiles.add(filePath);

          const key = `${uid}|${role}`;
          if (!seenWrite.has(key)) {
            seenWrite.add(key);
            writeOrder.push({
              uid,
              name,
              kind,
              filePath,
              role,
              role_priority: roleWritePriority(role),
              ...(startLine !== undefined ? { startLine } : {}),
              ...(endLine !== undefined ? { endLine } : {}),
            });
          }

          addCompanionSignal(filePath, 2.5, `slice-member:${role || 'supporting'}`, {
            id: uid,
            name,
            type: kind,
            ...(Number.isFinite(startLine) ? { startLine } : {}),
            ...(Number.isFinite(endLine) ? { endLine } : {}),
          });
          companionSources.slice_members += 1;
        }

        if (memberFiles.size > 0) {
          const fileList = Array.from(memberFiles).slice(0, 80);
          const fileListCypher = `[${fileList.map(filePath => `'${filePath.replace(/'/g, "''")}'`).join(', ')}]`;

          let cochangeRows: any[] = [];
          try {
            cochangeRows = await executeQuery(repo.id, `
              MATCH (a:File)-[r:CodeRelation {type: 'CO_CHANGES_WITH'}]->(b:File)
              WHERE a.filePath IN ${fileListCypher}
              RETURN b.filePath AS filePath, MAX(r.confidence) AS confidence
              ORDER BY confidence DESC
              LIMIT 120
            `);
          } catch {
            cochangeRows = [];
          }

          for (const row of cochangeRows) {
            const filePath = String(row.filePath ?? row[0] ?? '').trim();
            const confidence = toFiniteNumber(row.confidence ?? row[1], 0);
            if (!filePath) continue;
            if (fileList.includes(filePath)) continue;
            addCompanionSignal(filePath, Math.max(0.05, confidence), 'cochange-neighbor');
            companionSources.cochange_edges += 1;
          }
        }

        if (memberIds.length > 0) {
          const memberIdsCypher = `[${memberIds.slice(0, 150).map(uid => `'${uid.replace(/'/g, "''")}'`).join(', ')}]`;
          let shapeRows: any[] = [];
          try {
            shapeRows = await executeQuery(repo.id, `
              MATCH (n)-[r:CodeRelation]->(m)
              WHERE n.id IN ${memberIdsCypher}
                AND r.type IN ['VALIDATES_FIELD', 'SERIALIZES_FIELD', 'READS_FIELD', 'WRITES_FIELD', 'INVALIDATES_KEY', 'TESTS_SHAPE', 'DERIVES_FROM_COLUMN']
                AND m.filePath IS NOT NULL
              RETURN m.filePath AS filePath, r.type AS relType, COUNT(*) AS count
              ORDER BY count DESC
              LIMIT 200
            `);
          } catch {
            shapeRows = [];
          }

          for (const row of shapeRows) {
            const filePath = String(row.filePath ?? row[0] ?? '').trim();
            const relType = String(row.relType ?? row[1] ?? '').trim();
            const count = toFiniteNumber(row.count ?? row[2], 0);
            if (!filePath || !relType || count <= 0) continue;
            addCompanionSignal(filePath, Math.min(3, 0.3 + (count * 0.2)), `shape-link:${relType.toLowerCase()}`);
            companionSources.shape_edges += count;
          }
        }

        try {
          const gapRows = await executeQuery(repo.id, `
            MATCH (g:Gap)-[:CodeRelation {type: 'MEMBER_OF'}]->(s:FeatureSlice {id: '${escapedSliceId}'})
            RETURN g.absenceTier AS absenceTier, g.severity AS severity
            LIMIT 500
          `);
          for (const row of gapRows) {
            const absenceTier = String(row.absenceTier ?? row[0] ?? '').trim();
            const severity = String(row.severity ?? row[1] ?? '').trim();
            targetSliceGapSummary.total += 1;
            if (absenceTier === 'deterministic_missing') targetSliceGapSummary.deterministic += 1;
            else if (absenceTier === 'pattern_missing') targetSliceGapSummary.pattern += 1;
            else if (absenceTier === 'heuristic_suspicion') targetSliceGapSummary.heuristic += 1;

            if (severity === 'high') targetSliceGapSummary.high += 1;
            else if (severity === 'medium') targetSliceGapSummary.medium += 1;
            else if (severity === 'low') targetSliceGapSummary.low += 1;
          }
        } catch { /* ignore */ }

        try {
          const closureSnapshot = await loadClosureTemplateSnapshot(repo.storagePath);
          const templates = (Array.isArray(closureSnapshot.templates) ? closureSnapshot.templates : [])
            .filter(template => String(template?.sliceType || '').trim() === String(targetSlice.slice_type || '').trim());

          if (templates.length > 0) {
            const closedSlots = new Set(
              (Array.isArray(targetSlice.closed_slots) ? targetSlice.closed_slots : [])
                .map((slot: any) => String(slot || '').trim())
                .filter(Boolean),
            );
            const targetRoles = new Set(
              (Array.isArray(targetSlice.roles) ? targetSlice.roles : [])
                .map((role: any) => String(role || '').trim())
                .filter(Boolean),
            );

            let best: any = null;
            let bestScore = -1;
            for (const template of templates) {
              const requiredSlots = normalizeSliceStencilTokens(parseStringList(template.requiredSlots));
              const templateRoles = Array.isArray(template.roleCoverage)
                ? template.roleCoverage.map((item: any) => String(item?.role || '').trim()).filter(Boolean)
                : [];
              const requiredHits = requiredSlots.filter((slot: string) => closedSlots.has(slot)).length;
              const roleHits = templateRoles.filter((role: string) => targetRoles.has(role)).length;
              const requiredScore = requiredSlots.length > 0 ? (requiredHits / requiredSlots.length) : 1;
              const roleScore = templateRoles.length > 0 ? (roleHits / templateRoles.length) : 1;
              const score = (requiredScore * 0.7) + (roleScore * 0.3);
              if (score > bestScore) {
                bestScore = score;
                best = template;
              }
            }

            if (best) {
              const requiredSlots = normalizeSliceStencilTokens(parseStringList(best.requiredSlots));
              const roleExpectations = Array.isArray(best.roleCoverage)
                ? best.roleCoverage
                  .map((item: any) => ({
                    role: String(item?.role || '').trim(),
                    coverage: toFiniteNumber(item?.coverage, 0),
                    count: toFiniteNumber(item?.count, 0),
                  }))
                  .filter((item: any) => item.role)
                : [];

              targetTemplate = {
                id: String(best.id || '').trim(),
                template_key: String(best.templateKey || '').trim(),
                slice_type: String(best.sliceType || '').trim(),
                required_slots: requiredSlots,
                optional_slots: normalizeSliceStencilTokens(parseStringList(best.optionalSlots)),
                role_expectations: roleExpectations,
                avg_closure_score: toFiniteNumber(best.avgClosureScore, 0),
                slice_count: toFiniteNumber(best.sliceCount, 0),
                exemplar_slice_ids: Array.isArray(best.exemplarSliceIds) ? best.exemplarSliceIds.map((item: any) => String(item || '').trim()).filter(Boolean) : [],
              };
            }
          }
        } catch { /* ignore */ }
      }
    }

    const companionFiles = Array.from(companionSignals.values())
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return left.filePath.localeCompare(right.filePath);
      })
      .slice(0, Math.min(limitFiles + 5, 15))
      .map(entry => ({
        filePath: entry.filePath,
        score: round3(entry.score),
        reasons: Array.from(entry.reasons).slice(0, 6),
        anchors: entry.anchors.slice(0, 4),
      }));
    const prioritizedCompanionFiles = targetCalibratedFromDirectPrecedents
      ? (() => {
          const byFilePath = new Map(companionFiles.map(file => [String(file.filePath || ''), file]));
          const prioritized: any[] = [];
          const seen = new Set<string>();
          for (const surface of directPrecedentSurfaces) {
            const filePath = String(surface.filePath || '').trim();
            const existing = byFilePath.get(filePath);
            if (!existing || seen.has(filePath)) continue;
            seen.add(filePath);
            prioritized.push(existing);
          }
          for (const file of companionFiles) {
            const filePath = String(file?.filePath || '').trim();
            if (!filePath || seen.has(filePath)) continue;
            seen.add(filePath);
            prioritized.push(file);
          }
          return prioritized.slice(0, Math.min(limitFiles + 5, 15));
        })()
      : companionFiles;

    const orderedWriteSteps = writeOrder
      .sort((left, right) => {
        if (left.role_priority !== right.role_priority) return left.role_priority - right.role_priority;
        const leftStart = toFiniteNumber(left.startLine, Number.MAX_SAFE_INTEGER);
        const rightStart = toFiniteNumber(right.startLine, Number.MAX_SAFE_INTEGER);
        if (leftStart !== rightStart) return leftStart - rightStart;
        if (left.filePath !== right.filePath) return String(left.filePath).localeCompare(String(right.filePath));
        return String(left.uid).localeCompare(String(right.uid));
      })
      .slice(0, 16)
      .map(step => ({
        uid: step.uid,
        name: step.name,
        kind: step.kind,
        filePath: step.filePath,
        role: step.role,
        ...(step.startLine !== undefined ? { startLine: step.startLine } : {}),
        ...(step.endLine !== undefined ? { endLine: step.endLine } : {}),
      }));
    const calibratedWriteSteps = targetCalibratedFromDirectPrecedents
      ? [
          ...directPrecedentSurfaces.slice(0, 4).map(surface => ({
            uid: `precedent:${surface.kind}:${surface.filePath}`,
            name: surface.title,
            kind: `precedent:${surface.kind || 'file'}`,
            filePath: surface.filePath,
            role: 'precedent_anchor',
          })),
          ...orderedWriteSteps,
        ]
      : orderedWriteSteps;
    const dedupedWriteSteps: any[] = [];
    const seenWriteSteps = new Set<string>();
    for (const step of calibratedWriteSteps) {
      const key = `${String(step?.filePath || '')}|${String(step?.role || '')}|${String(step?.uid || '')}`;
      if (!key || seenWriteSteps.has(key)) continue;
      seenWriteSteps.add(key);
      dedupedWriteSteps.push(step);
      if (dedupedWriteSteps.length >= 16) break;
    }

    const targetArchetype = String(
      (targetCalibratedFromDirectPrecedents && directTargetPrecedent)
        ? `direct-precedent:${directTargetPrecedent.kind}:${directTargetPrecedent.title}`
        : implementPrecedents[0]?.signature
      || topProcesses[0]?.process_type
      || topProcesses[0]?.summary
      || '',
    ).trim() || null;

    const implement_plan = {
      target: {
        query_intent: queryIntent || null,
        archetype: targetArchetype,
        slice: targetSlice
          ? {
            uid: targetSlice.uid,
            label: targetSlice.label,
            slice_type: targetSlice.slice_type,
            anchor_id: targetSlice.anchor_id,
            anchor_name: targetSlice.anchor_name,
            closure_score: targetSlice.closure_score,
            closure_slots: Array.isArray(targetSlice.closure_slots) ? targetSlice.closure_slots : [],
            closed_slots: Array.isArray(targetSlice.closed_slots) ? targetSlice.closed_slots : [],
            roles: Array.isArray(targetSlice.roles) ? targetSlice.roles : [],
          }
          : null,
        direct_precedent_anchor: directTargetPrecedent
          ? {
              kind: directTargetPrecedent.kind,
              title: directTargetPrecedent.title,
              signature: directTargetPrecedent.signature || null,
              filePath: directTargetPrecedent.filePath,
              source: directTargetPrecedent.source,
              score: directTargetPrecedent.score,
            }
          : null,
        target_calibrated_from_precedents: targetCalibratedFromDirectPrecedents,
      },
      precedents: implementPrecedents,
      doc_guidance: docGuidance,
      closure_template: targetTemplate,
      companion_set: {
        files: prioritizedCompanionFiles,
        summary: {
          total_files: prioritizedCompanionFiles.length,
          seed_files: companionSources.seed_files,
          slice_members: companionSources.slice_members,
          cochange_edges: companionSources.cochange_edges,
          shape_edges: companionSources.shape_edges,
        },
      },
      write_order: dedupedWriteSteps,
      gap_signals: targetSliceGapSummary,
      post_edit_review: {
        tool: 'review_mode',
        params: {
          scope: 'unstaged',
          ...(pathPrefixes.length > 0 ? { path_prefixes: pathPrefixes } : {}),
          include_slice_stencil: true,
          include_evidence_spans: true,
        },
      },
    };

    return {
      status: 'ok',
      repo: repo.name,
      query: params.query,
      files,
      checks: checks.slice(0, limitChecks),
      top_processes: Array.isArray(result?.processes) ? result.processes.slice(0, 3) : [],
      hops,
      cache_effects,
      implement_plan,
      _action_plan: {
        direct_precedent_recovery: {
          enabled: directPrecedentSurfaces.length > 0,
          retrieval_mode: precedentRetrievalMode,
          precedents_found: directPrecedentSurfaces.length,
          target_slice_looks_generic: targetSliceLooksGeneric,
          target_slice_overlaps_direct_precedents: directPrecedentOverlapsTargetSlice,
          target_calibrated: targetCalibratedFromDirectPrecedents,
          top_precedent: directTargetPrecedent
            ? {
                kind: directTargetPrecedent.kind,
                title: directTargetPrecedent.title,
                signature: directTargetPrecedent.signature || null,
                filePath: directTargetPrecedent.filePath,
                source: directTargetPrecedent.source,
                score: directTargetPrecedent.score,
              }
            : null,
        },
      },
    };
}
