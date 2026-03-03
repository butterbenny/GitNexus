import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { loadClosureTemplateSnapshot } from '../../core/ingestion/closure-template-store.js';
import {
  loadEvidenceSpanSnapshot,
  getEvidenceSpanLookup,
} from '../../core/ingestion/evidence-span-store.js';

type ConvergenceMatrixCell = {
  cluster: string;
  signature: string;
  score: number;
  route: string;
  tokenSet: Set<string>;
  exemplarFilePaths: string[];
};

type ConvergenceMatrixSnapshot = {
  sourcePath: string;
  loadedAt: string;
  cells: ConvergenceMatrixCell[];
};

type ConvergenceSignal = {
  score: number;
  cluster: string;
  signature: string;
  route: string;
};

export interface ReviewModeRepoHandle {
  id: string;
  name: string;
  repoPath: string;
  storagePath: string;
}

export interface ReviewModeParams {
  scope?: 'unstaged' | 'staged' | 'all' | 'compare';
  base_ref?: string;
  path_prefixes?: string[];
  limit_symbols?: number;
  limit_callers?: number;
  limit_tests?: number;
  min_confidence?: number;
  include_ui_contracts?: boolean;
  max_ui_contract_files?: number;
  include_evidence_spans?: boolean;
  limit_evidence?: number;
  include_slice_stencil?: boolean;
  limit_slice_stencil?: number;
}

type ToolingArtifactClassification = {
  kind: 'cache' | 'local-state';
  reason: string;
  guidance: string;
};

type ReviewModeDeps = {
  ensureInitialized: (repoId: string) => Promise<void>;
  getIndexStatus: (repo: ReviewModeRepoHandle) => Promise<any>;
  uiContract: (repo: ReviewModeRepoHandle, params: {
    file_path: string;
    include_endpoints?: boolean;
    min_http_confidence?: number;
    path_prefixes?: string[];
    base_ref?: string;
  }) => Promise<any>;
  executeQuery: (repoId: string, query: string) => Promise<any[]>;
  parseWitnessPathIds: (value: string) => string[];
  loadRuntimeObservationSnapshot: (storagePath: string, options: { repoPath: string; extraPaths: string[] }) => Promise<any>;
  resolvePathInsideRepo: (repoPath: string, rawPath: string) => { relativePath: string; absolutePath: string } | null;
  isTestFilePath: (filePath: string) => boolean;
  classifyToolingArtifactPath: (filePath: string) => { kind: 'cache' | 'local-state'; reason: string; guidance: string } | null;
  clampInteger: (value: unknown, fallback: number, min?: number, max?: number) => number;
  toFiniteNumber: (value: unknown, fallback?: number) => number;
  toNonNegativeInteger: (value: unknown, fallback?: number) => number;
  toOptionalLineNumber: (value: unknown) => number | undefined;
  toOptionalNonNegativeInteger: (value: unknown) => number | undefined;
  parseStringList: (value: unknown) => string[];
  normalizeSliceStencilTokens: (value: unknown) => string[];
  missingRequiredSlotSeverity: (missingRequiredSlots: string[], deterministic?: boolean, pattern?: boolean) => 'low' | 'medium' | 'high';
  GIT_NAME_LIST_MAX_BUFFER: number;
  GIT_PATCH_MAX_BUFFER: number;
  loadConvergenceMatrix?: (repo: ReviewModeRepoHandle) => Promise<ConvergenceMatrixSnapshot | null>;
};

const round3 = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(3));
};

const normalizeConfidence = (value: unknown, fallback = 0): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.max(0, Math.min(1, fallback));
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
};

const REVIEW_CONVERGENCE_RANK_WEIGHTS = {
  suggested_tests: {
    base_score: 1,
    convergence_score: 1,
    reason_overlap: 0.22,
    changed_test_file_bonus: 0.18,
  },
  findings: {
    severity: 1,
    confidence: 0.2,
    convergence: 0.15,
  },
} as const;

const convergenceMatrixCache = new Map<string, { mtimeMs: number; snapshot: ConvergenceMatrixSnapshot | null }>();
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');

const tokenizeConvergence = (value: unknown): string[] => {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(token => token.length >= 2);
};

const overlapCount = (left: Set<string>, right: Set<string>): number => {
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return overlap;
};

const pathAffinity = (leftPath: string, rightPath: string): number => {
  const left = String(leftPath || '').split('/').filter(Boolean);
  const right = String(rightPath || '').split('/').filter(Boolean);
  if (left.length === 0 || right.length === 0) return 0;

  let common = 0;
  const upper = Math.min(left.length, right.length);
  while (common < upper && left[common] === right[common]) common += 1;
  if (common < 2) return 0;

  return common / Math.max(left.length, right.length);
};

const normalizeRepoRelativePath = (value: unknown, repoPath: string): string => {
  const normalized = String(value || '').trim().replace(/\\/g, '/');
  if (!normalized) return '';
  const root = String(repoPath || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (root && normalized.startsWith(`${root}/`)) {
    return normalized.slice(root.length + 1);
  }
  return normalized.replace(/^\.\/+/, '').replace(/^\/+/, '');
};

const resolveConvergenceMatrixPaths = (repo: ReviewModeRepoHandle): string[] => {
  const repoPattern = `${String(repo.name || '').trim() || 'repo'}-patterns`;
  const cwd = process.cwd();
  return Array.from(new Set([
    path.resolve(path.join(repo.repoPath, '.gitnexus', 'lamination_matrix.json')),
    path.resolve(path.join(repo.repoPath, '.gitnexus', 'brain', 'lamination_matrix.json')),
    path.resolve(path.join(MODULE_ROOT, 'reports', repoPattern, 'pass-2', 'lamination_matrix.json')),
    path.resolve(path.join(cwd, 'reports', repoPattern, 'pass-2', 'lamination_matrix.json')),
    path.resolve(path.join(cwd, '..', 'reports', repoPattern, 'pass-2', 'lamination_matrix.json')),
  ]));
};

const parseConvergenceMatrix = (raw: any, sourcePath: string, repoPath: string): ConvergenceMatrixSnapshot | null => {
  const rawCells = Array.isArray(raw?.topCells)
    ? raw.topCells
    : (Array.isArray(raw?.matrix) ? raw.matrix : []);
  if (rawCells.length === 0) return null;

  const cells: ConvergenceMatrixCell[] = [];
  for (const item of rawCells.slice(0, 120)) {
    const score = Number(item?.carbonCopyReadyScore ?? item?.score ?? 0);
    if (!Number.isFinite(score) || score <= 0) continue;

    const cluster = String(item?.cluster || '').trim();
    const signature = String(item?.signature || '').trim();
    const route = String(item?.signatureTopRoute || '').trim();
    const exemplarRows = Array.isArray(item?.exemplarSlices) ? item.exemplarSlices : [];
    const exemplarFilePaths: string[] = Array.from(
      new Set<string>(
        exemplarRows
          .flatMap((row: any) => [
            normalizeRepoRelativePath(row?.entryFile, repoPath),
            normalizeRepoRelativePath(row?.terminalFile, repoPath),
          ])
          .filter((value): value is string => typeof value === 'string' && value.length > 0),
      ),
    ).slice(0, 10);

    const tokenSet = new Set<string>([
      ...tokenizeConvergence(cluster),
      ...tokenizeConvergence(signature),
      ...tokenizeConvergence(route),
      ...exemplarRows.flatMap((row: any) => tokenizeConvergence(row?.label || '')),
      ...exemplarFilePaths.flatMap(filePath => tokenizeConvergence(filePath)),
    ]);

    cells.push({
      cluster,
      signature,
      score: Math.max(0, Math.min(100, score)),
      route,
      tokenSet,
      exemplarFilePaths,
    });
  }

  if (cells.length === 0) return null;
  return {
    sourcePath,
    loadedAt: new Date().toISOString(),
    cells,
  };
};

const loadConvergenceMatrixSnapshot = async (repo: ReviewModeRepoHandle): Promise<ConvergenceMatrixSnapshot | null> => {
  const candidates = resolveConvergenceMatrixPaths(repo);
  for (const sourcePath of candidates) {
    try {
      const stat = await fs.stat(sourcePath);
      if (!stat.isFile()) continue;

      const cached = convergenceMatrixCache.get(sourcePath);
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        return cached.snapshot;
      }

      const rawText = await fs.readFile(sourcePath, 'utf8');
      const parsed = parseConvergenceMatrix(JSON.parse(rawText), sourcePath, repo.repoPath);
      convergenceMatrixCache.set(sourcePath, { mtimeMs: stat.mtimeMs, snapshot: parsed });
      if (parsed) return parsed;
    } catch {
      continue;
    }
  }
  return null;
};

const computeConvergenceSignal = (
  matrix: ConvergenceMatrixSnapshot,
  reviewTokenSet: Set<string>,
  itemTokenSet: Set<string>,
  itemFilePaths: string[],
): ConvergenceSignal | null => {
  if (!matrix?.cells?.length) return null;
  if (itemTokenSet.size === 0 && itemFilePaths.length === 0) return null;

  let best: ConvergenceSignal | null = null;
  for (const cell of matrix.cells) {
    const normalizedCellScore = Math.max(0, Math.min(1, cell.score / 100));
    const tokenOverlap = overlapCount(itemTokenSet, cell.tokenSet);
    const tokenCoverage = tokenOverlap > 0
      ? tokenOverlap / Math.max(1, Math.min(itemTokenSet.size, 8))
      : 0;
    const reviewOverlap = overlapCount(reviewTokenSet, cell.tokenSet);
    const reviewFactor = reviewOverlap > 0 ? 1.1 : 1;
    const tokenSignal = tokenCoverage * normalizedCellScore * 0.55 * reviewFactor;

    let fileSignal = 0;
    if (itemFilePaths.length > 0 && cell.exemplarFilePaths.length > 0) {
      for (const itemFilePath of itemFilePaths) {
        for (const exemplarFilePath of cell.exemplarFilePaths) {
          const affinity = pathAffinity(itemFilePath, exemplarFilePath);
          if (affinity <= 0) continue;
          fileSignal = Math.max(fileSignal, affinity * normalizedCellScore * 0.9);
        }
      }
    }

    const combined = Math.max(tokenSignal, fileSignal);
    if (!best || combined > best.score) {
      best = {
        score: round3(combined),
        cluster: cell.cluster,
        signature: cell.signature,
        route: cell.route,
      };
    }
  }

  return best;
};

export async function runReviewMode(
  deps: ReviewModeDeps,
  repo: ReviewModeRepoHandle,
  params: ReviewModeParams,
): Promise<any> {
  const {
    ensureInitialized,
    getIndexStatus,
    uiContract,
    executeQuery,
    parseWitnessPathIds,
    loadRuntimeObservationSnapshot,
    resolvePathInsideRepo,
    isTestFilePath,
    classifyToolingArtifactPath,
    clampInteger,
    toFiniteNumber,
    toNonNegativeInteger,
    toOptionalLineNumber,
    toOptionalNonNegativeInteger,
    parseStringList,
    normalizeSliceStencilTokens,
    missingRequiredSlotSeverity,
    GIT_NAME_LIST_MAX_BUFFER,
    GIT_PATCH_MAX_BUFFER,
    loadConvergenceMatrix,
  } = deps;
    await ensureInitialized(repo.id);

    const scopeRaw = String(params.scope || 'unstaged').trim();
    const scope = scopeRaw.toLowerCase() as 'unstaged' | 'staged' | 'all' | 'compare';
    const allowedScopes = new Set(['unstaged', 'staged', 'all', 'compare']);
    if (!allowedScopes.has(scope)) {
      return { error: `scope must be one of unstaged|staged|all|compare (received "${scopeRaw}")` };
    }
    const baseRef = String(params.base_ref || '').trim();
    const limitSymbols = clampInteger(params.limit_symbols, 60, 1, 500);
    const limitCallers = clampInteger(params.limit_callers, 10, 1, 50);
    const limitTests = clampInteger(params.limit_tests, 10, 1, 50);
    const minConfidence = Math.max(0, Math.min(1, toFiniteNumber(params.min_confidence, 0.9)));
    const includeUiContracts = params.include_ui_contracts !== false;
    const maxUiContractFiles = clampInteger(params.max_ui_contract_files, 5, 0, 20);
    const includeEvidenceSpans = params.include_evidence_spans !== false;
    const limitEvidence = clampInteger(params.limit_evidence, 40, 1, 200);
    const includeSliceStencil = params.include_slice_stencil !== false;
    const limitSliceStencil = clampInteger(params.limit_slice_stencil, 8, 1, 25);
    const indexStatus = await getIndexStatus(repo);
    const runtimeObservationPaths = parseStringList(process.env.GITNEXUS_RUNTIME_OBSERVATIONS_FILE || '');
    const runtimeSnapshot = await loadRuntimeObservationSnapshot(repo.storagePath, {
      repoPath: repo.repoPath,
      extraPaths: runtimeObservationPaths,
    });
    const convergenceMatrix = loadConvergenceMatrix
      ? await loadConvergenceMatrix(repo)
      : await loadConvergenceMatrixSnapshot(repo);

    const normalizePath = (value: string): string => {
      return String(value || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\.\/+/, '')
        .replace(/^\/+/, '');
    };
    const toPrimaryLabel = (value: any): string => {
      if (Array.isArray(value)) return String(value[0] || '').trim();
      return String(value || '').trim();
    };

    const normalizePrefix = (value: string): string => {
      const raw = String(value || '').trim().replace(/\\/g, '/');
      if (!raw) return '';

      if (path.isAbsolute(raw)) {
        const rel = path.relative(repo.repoPath, raw).replace(/\\/g, '/');
        if (rel && !rel.startsWith('..')) return normalizePath(rel);
      }

      return normalizePath(raw);
    };

    const rawPrefixes = Array.isArray(params.path_prefixes)
      ? params.path_prefixes
      : typeof (params as any).path_prefixes === 'string'
        ? [(params as any).path_prefixes]
        : [];

    const pathPrefixes = Array.from(new Set(rawPrefixes.map(p => normalizePrefix(String(p || ''))).filter(Boolean)));
    const isInScope = (filePath: string): boolean => {
      if (pathPrefixes.length === 0) return true;
      const fp = normalizePath(filePath);
      if (!fp) return false;

      for (const prefixRaw of pathPrefixes) {
        const prefix = prefixRaw.endsWith('/') ? prefixRaw : `${prefixRaw}/`;
        if (fp === prefixRaw) return true;
        if (fp.startsWith(prefix)) return true;
      }
      return false;
    };

    type DiffHunk = { old_start: number; old_lines: number; new_start: number; new_lines: number };
    type DiffFile = {
      filePath: string;
      status: 'Modified' | 'Added' | 'Deleted' | 'Renamed' | 'Copied' | 'Untracked';
      fromPath?: string;
      hunks: DiffHunk[];
      binary?: boolean;
    };
    type SemanticFamily = 'auth' | 'shape' | 'cache' | 'test' | 'event' | 'template';
    type ReviewFindingSeverity = 'low' | 'medium' | 'high';
    type ReviewFinding = {
      code: string;
      severity: ReviewFindingSeverity;
      summary: string;
      reason: string;
      confidence: number;
      convergence?: {
        score: number;
        cluster?: string;
        signature?: string;
        route?: string;
      };
      evidence: {
        filePath: string;
        symbol?: {
          uid?: string;
          name?: string;
          kind?: string;
          startLine?: number;
        };
      };
    };

    const { execFileSync } = await import('child_process');

    const buildEmptySemanticDiffs = () => ({
      summary: {
        touched_edges: 0,
        family_count: 0,
        gap_signals: 0,
      },
      families: [] as Array<{
        family: SemanticFamily;
        edge_count: number;
        changed_symbols: number;
        incoming_edges: number;
        outgoing_edges: number;
        reasons: Array<{ reason: string; count: number }>;
        sample_edges: Array<{
          source: { uid: string; name: string; kind: string; filePath: string };
          target: { uid: string; name: string; kind: string; filePath: string };
          edge: { id: string; type: string; reason: string; confidence: number; witnessPathIds: string[] };
          direction: 'incoming' | 'outgoing' | 'internal';
        }>;
      }>,
      gap_signals: {
        total: 0,
        deterministic: 0,
        pattern: 0,
        heuristic: 0,
        high: 0,
        medium: 0,
        low: 0,
        gaps: [] as Array<{
          id: string;
          gapType: string;
          absenceTier: string;
          severity: string;
          sliceId: string;
          anchorId: string;
          missingSlots: string[];
          evidence: string[];
        }>,
      },
    });

    const buildEmptyProofPack = () => ({
      updated_at: '',
      summary: {
        symbol_spans: 0,
        edge_spans: 0,
        witness_spans: 0,
        proof_spans: 0,
      },
      symbols: [] as Array<{
        symbol: {
          uid: string;
          name: string;
          kind: string;
          filePath: string;
          startLine?: number;
          endLine?: number;
        };
        primary_span: any;
        witness_spans: any[];
        proof_spans: any[];
      }>,
      edges: [] as Array<{
        family: SemanticFamily;
        source: { uid: string; name: string; kind: string; filePath: string };
        target: { uid: string; name: string; kind: string; filePath: string };
        edge: { id: string; type: string; reason: string; confidence: number; witness_path_ids: string[] };
        witness_spans: any[];
        proof_spans: any[];
      }>,
    });

    const buildEmptySliceStencil = () => ({
      updated_at: '',
      summary: {
        changed_slices: 0,
        with_templates: 0,
        missing_required_slot_slices: 0,
        missing_role_slices: 0,
        sibling_candidates: 0,
      },
      slices: [] as Array<{
        slice: {
          id: string;
          label: string;
          heuristicLabel: string;
          sliceType: string;
          anchorId: string;
          anchorName: string;
          closureScore: number;
          closureSlots: string[];
          closedSlots: string[];
          roles: string[];
          changed_member_count: number;
        };
        changed_members: Array<{
          uid: string;
          name: string;
          kind: string;
          filePath: string;
          role: string;
          startLine?: number;
          endLine?: number;
        }>;
        template: null | {
          id: string;
          template_key: string;
          slice_type: string;
          required_slots: string[];
          optional_slots: string[];
          role_expectations: Array<{ role: string; coverage: number; count: number }>;
          avg_closure_score: number;
          slice_count: number;
        };
        stencil_delta: {
          missing_required_slots: string[];
          missing_roles: string[];
          closure_score_delta: number;
        };
        sibling_precedents: Array<{
          id: string;
          label: string;
          anchor_name: string;
          closure_score: number;
          shared_closed_slots: string[];
          shared_roles: string[];
        }>;
        gap_signals: {
          total: number;
          deterministic: number;
          pattern: number;
          heuristic: number;
          high: number;
          medium: number;
          low: number;
        };
      }>,
    });

    const buildReviewKernel = (input: {
      changed_files: number;
      untracked_files: number;
      untracked_artifacts: number;
      changed_symbols: number;
      suggested_tests: number;
      frontend_hygiene_findings: number;
      ui_contracts: number;
      route_files: number;
      authz_controllers: number;
      runtime_hotspots: number;
      runtime_evidence_routes: number;
      runtime_focus_routes: number;
      contract_parity_routes: number;
      contract_parity_low: number;
      perf_backend_findings: number;
      runtime_source: string;
      semantic_diffs: ReturnType<typeof buildEmptySemanticDiffs>;
      slice_stencil: ReturnType<typeof buildEmptySliceStencil>;
      scope: string;
      path_prefixes: string[];
    }) => {
      const semanticGap = input.semantic_diffs?.gap_signals || {
        total: 0,
        deterministic: 0,
        pattern: 0,
        heuristic: 0,
        high: 0,
        medium: 0,
        low: 0,
      };
      const authFamily = (Array.isArray(input.semantic_diffs?.families) ? input.semantic_diffs.families : [])
        .find((family: any) => String(family?.family || '') === 'auth');
      const missingRequiredSlotSlices = toFiniteNumber(input.slice_stencil?.summary?.missing_required_slot_slices, 0);
      const missingRoleSlices = toFiniteNumber(input.slice_stencil?.summary?.missing_role_slices, 0);
      const changedFiles = toFiniteNumber(input.changed_files, 0);
      const untrackedFiles = toFiniteNumber(input.untracked_files, 0);
      const untrackedArtifacts = toFiniteNumber(input.untracked_artifacts, 0);
      const changedSymbols = toFiniteNumber(input.changed_symbols, 0);
      const suggestedTests = toFiniteNumber(input.suggested_tests, 0);
      const frontendHygieneFindings = toFiniteNumber(input.frontend_hygiene_findings, 0);
      const uiContracts = toFiniteNumber(input.ui_contracts, 0);
      const routeFiles = toFiniteNumber(input.route_files, 0);
      const authzControllers = toFiniteNumber(input.authz_controllers, 0);
      const runtimeHotspots = toFiniteNumber(input.runtime_hotspots, 0);
      const runtimeEvidenceRoutes = toFiniteNumber(input.runtime_evidence_routes, 0);
      const runtimeFocusRoutes = toFiniteNumber(input.runtime_focus_routes, 0);
      const contractParityRoutes = toFiniteNumber(input.contract_parity_routes, 0);
      const contractParityLow = toFiniteNumber(input.contract_parity_low, 0);
      const perfBackendFindings = toFiniteNumber(input.perf_backend_findings, 0);
      const semanticTotal = toFiniteNumber(semanticGap.total, 0);
      const semanticHigh = toFiniteNumber(semanticGap.high, 0);
      const semanticDeterministic = toFiniteNumber(semanticGap.deterministic, 0);
      const authEdgeCount = toFiniteNumber(authFamily?.edge_count, 0);

      let riskScore = 0;
      riskScore += Math.min(4, Math.ceil(changedSymbols / 8));
      riskScore += Math.min(6, (semanticHigh * 2) + semanticDeterministic);
      riskScore += Math.min(4, (missingRequiredSlotSlices * 2) + missingRoleSlices);
      if (authEdgeCount > 0 && authzControllers === 0) riskScore += 2;
      if (suggestedTests === 0 && changedSymbols > 0) riskScore += 1;
      if (untrackedFiles > 0) riskScore += Math.min(2, untrackedFiles);
      if (runtimeHotspots > 0) riskScore += Math.min(3, Math.ceil(runtimeHotspots / 2));
      if (contractParityLow > 0) riskScore += Math.min(3, contractParityLow);
      if (perfBackendFindings > 0 && input.runtime_source === 'snapshot') {
        riskScore += Math.min(3, Math.ceil(perfBackendFindings / 2));
      }

      const risk_level = riskScore >= 10 ? 'high' : riskScore >= 5 ? 'medium' : 'low';

      const top_findings: string[] = [];
      if (semanticHigh > 0) {
        top_findings.push(`High-severity gap signals detected (${semanticHigh}).`);
      }
      if (semanticDeterministic > 0) {
        top_findings.push(`Deterministic missing links detected (${semanticDeterministic}).`);
      }
      if (missingRequiredSlotSlices > 0) {
        top_findings.push(`Slices missing required closure slots (${missingRequiredSlotSlices}).`);
      }
      if (missingRoleSlices > 0) {
        top_findings.push(`Slices missing expected role coverage (${missingRoleSlices}).`);
      }
      if (authEdgeCount > 0 && authzControllers === 0) {
        top_findings.push('Auth-related relation deltas detected without controller auth closure checks.');
      }
      if (routeFiles > 0) {
        top_findings.push(`Route files changed (${routeFiles}); validate controller wiring targets.`);
      }
      if (untrackedFiles > 0) {
        top_findings.push(`Untracked files present (${untrackedFiles}); symbol coverage may be partial until re-index.`);
      }
      if (untrackedArtifacts > 0) {
        top_findings.push(`Detected tooling/local artifacts (${untrackedArtifacts}); treat as non-product review noise.`);
      }
      if (uiContracts > 0) {
        top_findings.push(`UI contract diffs available (${uiContracts}).`);
      }
      if (frontendHygieneFindings > 0) {
        top_findings.push(`Frontend hygiene findings detected (${frontendHygieneFindings}).`);
      }
      if (runtimeHotspots > 0) {
        top_findings.push(`Runtime hotspots overlap changed surfaces (${runtimeHotspots}).`);
      }
      if (runtimeEvidenceRoutes > 0) {
        top_findings.push(`Runtime route evidence available for ${runtimeEvidenceRoutes} route(s).`);
      }
      if (runtimeFocusRoutes > 0) {
        top_findings.push(`Runtime evidence includes focused seating assign route metrics (${runtimeFocusRoutes}).`);
      }
      if (contractParityLow > 0) {
        top_findings.push(`Endpoint contract parity gaps detected (${contractParityLow}).`);
      }
      if (perfBackendFindings > 0 && input.runtime_source === 'snapshot') {
        top_findings.push(`Backend loop/perf risks detected with line-level evidence (${perfBackendFindings}).`);
      }
      if (top_findings.length === 0 && changedFiles === 0) {
        top_findings.push('No changed files detected for the selected review scope.');
      }

      const hypotheses: string[] = [];
      if (semanticHigh > 0 || semanticDeterministic > 0) {
        hypotheses.push('Primary risk is incomplete closure on changed feature slices.');
      }
      if (authEdgeCount > 0 && authzControllers === 0) {
        hypotheses.push('Auth drift may exist between permission signals and runtime controller checks.');
      }
      if (suggestedTests === 0 && changedSymbols > 0) {
        hypotheses.push('Changed symbols may lack direct test callers in current graph coverage.');
      }
      if (untrackedFiles > 0) {
        hypotheses.push('Untracked files may hide additional risk until they are indexed.');
      }
      if (contractParityLow > 0) {
        hypotheses.push('Endpoint request/response/status semantics likely drift from expected contracts.');
      }
      if (perfBackendFindings > 0 && input.runtime_source === 'snapshot') {
        hypotheses.push('Loop-level scans/writes in backend paths may amplify latency or write contention.');
      } else if (perfBackendFindings > 0 && input.runtime_source === 'none') {
        hypotheses.push('Static perf heuristics were detected, but runtime evidence is required to prioritize and validate them.');
      }
      if (runtimeHotspots > 0) {
        hypotheses.push('Runtime latency/lock signals align with changed surfaces and should be validated first.');
      } else if (input.runtime_source === 'none') {
        hypotheses.push('No runtime observation snapshot found; runtime risk assessment is static-only.');
      }
      if (hypotheses.length === 0 && changedFiles > 0) {
        hypotheses.push('Primary risk appears to be localized to changed files with bounded blast radius.');
      }

      const next_actions = [
        'Open top changed symbols with context() to confirm ownership and dependencies.',
        'Run impact() on the highest-risk changed symbol to validate direct dependents.',
      ];
      if (semanticTotal > 0 || missingRequiredSlotSlices > 0 || missingRoleSlices > 0) {
        next_actions.push('Review slice_stencil and semantic gap signals before applying follow-up edits.');
      }
      if (routeFiles > 0) {
        next_actions.push('Verify route_targets controller mappings for each changed route file.');
      }
      if (uiContracts > 0) {
        next_actions.push('Inspect ui_contract diffs to verify mutation side-effects and cache triggers.');
      }
      if (frontendHygieneFindings > 0) {
        next_actions.push('Review frontend hygiene findings (prop drilling, nested components, signature shape) before approving UI changes.');
      }
      if (suggestedTests > 0) {
        next_actions.push('Run suggested tests first, then expand coverage only if failures indicate wider drift.');
      }
      if (untrackedFiles > 0) {
        next_actions.push('Review untracked files explicitly and refresh index before finalizing high-risk decisions.');
      }
      if (runtimeHotspots > 0) {
        next_actions.push('Validate runtime hotspot entries before broad refactors to confirm symptom-fit ordering.');
      }
      if (runtimeEvidenceRoutes > 0) {
        next_actions.push('Inspect runtime_evidence route aggregates (latency/sql/lock) before deciding perf mitigations.');
      }
      if (contractParityRoutes > 0) {
        next_actions.push('Review contract_parity entries for touched routes and confirm status + shape semantics.');
      }
      if (perfBackendFindings > 0 && input.runtime_source === 'snapshot') {
        next_actions.push('Address perf_backend_findings at cited lines and re-run focused regression tests.');
      } else if (perfBackendFindings > 0 && input.runtime_source === 'none') {
        next_actions.push('Ingest a runtime observation snapshot and re-run review_mode before acting on perf_backend_findings.');
      }

      return {
        risk: {
          level: risk_level,
          score: riskScore,
          signals: {
            changed_files: changedFiles,
            untracked_files: untrackedFiles,
            changed_symbols: changedSymbols,
            semantic_gap_total: semanticTotal,
            semantic_gap_high: semanticHigh,
            missing_required_slot_slices: missingRequiredSlotSlices,
            missing_role_slices: missingRoleSlices,
            runtime_hotspots: runtimeHotspots,
            runtime_evidence_routes: runtimeEvidenceRoutes,
            runtime_focus_routes: runtimeFocusRoutes,
            contract_parity_low: contractParityLow,
            perf_backend_findings: perfBackendFindings,
            frontend_hygiene_findings: frontendHygieneFindings,
          },
        },
        top_findings: top_findings.slice(0, 8),
        hypotheses: Array.from(new Set(hypotheses)).slice(0, 6),
        next_actions: next_actions.slice(0, 8),
        review_scope: {
          scope: input.scope,
          path_prefixes: input.path_prefixes,
        },
      };
    };

    const buildDiffArgs = (
      withPatch: boolean,
      scopeOverride?: 'unstaged' | 'staged' | 'all' | 'compare',
      baseRefOverride?: string,
    ): string[] => {
      const args = ['diff', '--no-color'];
      if (withPatch) args.push('-U0', '--patch');
      else args.push('--name-only');

      const effectiveScope = scopeOverride || scope;
      const effectiveBaseRef = String(baseRefOverride ?? baseRef).trim();

      switch (effectiveScope) {
        case 'staged':
          args.push('--staged');
          break;
        case 'all':
          args.push('HEAD');
          break;
        case 'compare':
          if (!effectiveBaseRef) throw new Error('base_ref is required for "compare" scope');
          // PR-style diff: merge base vs HEAD
          args.push(`${effectiveBaseRef}...HEAD`);
          break;
        case 'unstaged':
        default:
          break;
      }

      return args;
    };

    const listUntrackedFiles = (): string[] => {
      if (scope === 'staged' || scope === 'compare') return [];
      try {
        const output = execFileSync('git', ['status', '--porcelain'], {
          cwd: repo.repoPath,
          encoding: 'utf-8',
          maxBuffer: GIT_NAME_LIST_MAX_BUFFER,
        });
        return String(output || '')
          .split('\n')
          .map(line => line.trimEnd())
          .filter(Boolean)
          .filter(line => line.startsWith('?? '))
          .map(line => normalizePath(line.slice(3)))
          .filter(Boolean)
          .filter(filePath => isInScope(filePath));
      } catch {
        return [];
      }
    };

    const buildCoverageBanner = (input: {
      changedFileCount: number;
      untrackedFileCount: number;
      untrackedArtifactCount?: number;
      changedSymbolCount: number;
      changedSymbolTotal?: number;
      changedSymbolCap?: number;
      suggestedTestCount: number;
      symbolizedFileCount?: number;
      runtimeHotspotCount?: number;
      runtimeSource?: string;
      runtimeGeneratedAt?: string;
      runtimeSourceFiles?: string[];
    }) => {
      const changedSymbolTotal = toFiniteNumber(input.changedSymbolTotal ?? input.changedSymbolCount, input.changedSymbolCount);
      const changedSymbolCap = toFiniteNumber(input.changedSymbolCap ?? input.changedSymbolCount, input.changedSymbolCount);
      const symbolizedFileCount = toFiniteNumber(input.symbolizedFileCount, 0);
      const runtimeHotspotCount = toFiniteNumber(input.runtimeHotspotCount, 0);
      const untrackedArtifactCount = toFiniteNumber(input.untrackedArtifactCount, 0);
      const runtimeSource = String(input.runtimeSource || 'none');
      const runtimeSourceFiles = Array.isArray(input.runtimeSourceFiles) ? input.runtimeSourceFiles : [];
      const symbolCoverageRatio = input.changedFileCount > 0
        ? toFiniteNumber((symbolizedFileCount / input.changedFileCount).toFixed(3), 0)
        : 1;
      const warnings: string[] = [];
      if (indexStatus.isStale) {
        warnings.push('Index is stale versus HEAD; refresh before trusting full blast-radius decisions.');
      }
      if (input.untrackedFileCount > 0) {
        warnings.push(`Detected ${input.untrackedFileCount} untracked file(s); index-backed symbol coverage may be incomplete.`);
      }
      if (untrackedArtifactCount > 0) {
        warnings.push(`Detected ${untrackedArtifactCount} known tooling/local artifact file(s); prefer local exclude/ignore flow.`);
      }
      if (input.changedFileCount > 0 && symbolCoverageRatio < 0.5) {
        warnings.push('Less than half of changed files mapped to symbols; review changed_files directly.');
      }
      if (input.changedSymbolCount > 0 && input.suggestedTestCount === 0) {
        warnings.push('No suggested tests were inferred for changed symbols; manual test selection required.');
      }
      if (changedSymbolTotal > changedSymbolCap) {
        warnings.push(`Changed symbols truncated for analysis (${changedSymbolCap}/${changedSymbolTotal}); widen limit_symbols for full coverage.`);
      }
      if (runtimeHotspotCount > 0) {
        warnings.push(`Runtime snapshot reports ${runtimeHotspotCount} hotspot(s) tied to changed surfaces.`);
      } else if (runtimeSource === 'none') {
        warnings.push('No runtime observation snapshot found; runtime risk checks are static-only.');
      }

      return {
        freshness: {
          is_stale: indexStatus.isStale,
          indexed_at: indexStatus.indexedAt,
          indexed_commit: indexStatus.indexedCommit || null,
          head_commit: indexStatus.headCommit || null,
          refresh_command: indexStatus.refreshCommandSandbox,
          refresh_command_force: indexStatus.refreshCommandSandboxForce,
        },
        coverage: {
          changed_files: input.changedFileCount,
          untracked_files: input.untrackedFileCount,
          untracked_artifacts: untrackedArtifactCount,
          changed_symbols: input.changedSymbolCount,
          changed_symbol_total: changedSymbolTotal,
          changed_symbol_cap: changedSymbolCap,
          symbolized_files: symbolizedFileCount,
          symbol_coverage_ratio: symbolCoverageRatio,
          suggested_tests: input.suggestedTestCount,
          runtime_hotspots: runtimeHotspotCount,
          runtime_source: runtimeSource,
          runtime_generated_at: String(input.runtimeGeneratedAt || ''),
          runtime_source_files: runtimeSourceFiles,
        },
        warnings,
      };
    };

    let changedFilesRaw: string[] = [];
    let effectiveScope: 'unstaged' | 'staged' | 'all' | 'compare' = scope;
    let diffSource = 'requested';
    try {
      const output = execFileSync('git', buildDiffArgs(false), {
        cwd: repo.repoPath,
        encoding: 'utf-8',
        maxBuffer: GIT_NAME_LIST_MAX_BUFFER,
      });
      changedFilesRaw = String(output || '').trim().split('\n').map(s => s.trim()).filter(Boolean);
    } catch (err: any) {
      return { error: `Git diff failed: ${err?.message || 'unknown error'}` };
    }

    // Compare scope may be empty in detached/local-only workflows while local working tree still has real changes.
    // Fallback to HEAD diff so review_mode remains useful instead of returning an empty review envelope.
    if (scope === 'compare' && changedFilesRaw.length === 0) {
      try {
        const output = execFileSync('git', buildDiffArgs(false, 'all'), {
          cwd: repo.repoPath,
          encoding: 'utf-8',
          maxBuffer: GIT_NAME_LIST_MAX_BUFFER,
        });
        const fallbackFiles = String(output || '').trim().split('\n').map(s => s.trim()).filter(Boolean);
        if (fallbackFiles.length > 0) {
          changedFilesRaw = fallbackFiles;
          effectiveScope = 'all';
          diffSource = 'compare-empty->all';
        }
      } catch {
        // keep original empty compare result if fallback also fails
      }
    }

    const trackedChangedFiles = changedFilesRaw
      .map(f => normalizePath(f))
      .filter(f => isInScope(f));
    const untrackedFiles = listUntrackedFiles();
    const toolingArtifactDetails = untrackedFiles
      .map(filePath => ({ filePath, artifact: classifyToolingArtifactPath(filePath) }))
      .filter((entry): entry is { filePath: string; artifact: ToolingArtifactClassification } => !!entry.artifact);
    const toolingArtifactFileSet = new Set(toolingArtifactDetails.map(entry => normalizePath(entry.filePath)));
    const productUntrackedFiles = untrackedFiles.filter(filePath => !toolingArtifactFileSet.has(normalizePath(filePath)));
    const changedFiles = Array.from(new Set([...trackedChangedFiles, ...productUntrackedFiles]));

    if (changedFiles.length === 0 && toolingArtifactDetails.length === 0) {
      const semantic_diffs = buildEmptySemanticDiffs();
      const proof_pack = buildEmptyProofPack();
      const slice_stencil = buildEmptySliceStencil();
      const review_kernel = buildReviewKernel({
        changed_files: 0,
        untracked_files: 0,
        untracked_artifacts: 0,
        changed_symbols: 0,
        suggested_tests: 0,
        frontend_hygiene_findings: 0,
        ui_contracts: 0,
        route_files: 0,
        authz_controllers: 0,
        runtime_hotspots: 0,
        runtime_evidence_routes: 0,
        runtime_focus_routes: 0,
        contract_parity_routes: 0,
        contract_parity_low: 0,
        perf_backend_findings: 0,
        runtime_source: (
          runtimeSnapshot.request_spans.length > 0
          || runtimeSnapshot.db_queries.length > 0
          || runtimeSnapshot.payload_shapes.length > 0
        ) ? 'snapshot' : 'none',
        semantic_diffs,
        slice_stencil,
        scope: effectiveScope,
        path_prefixes: pathPrefixes,
      });
      return {
        status: 'ok',
        repo: repo.name,
        scope,
        base_ref: baseRef || undefined,
        path_prefixes: pathPrefixes,
        summary: {
          changed_files: 0,
          untracked_files: 0,
          untracked_artifacts: 0,
          changed_symbols: 0,
          suggested_tests: 0,
          suggested_test_commands: 0,
          runtime_evidence_routes: 0,
          runtime_focus_routes: 0,
          contract_parity_routes: 0,
          contract_parity_low: 0,
          perf_backend_findings: 0,
          regression_failure_candidates: 0,
          preexisting_failure_candidates: 0,
          semantic_families: semantic_diffs.summary.family_count,
          semantic_gap_signals: semantic_diffs.summary.gap_signals,
          proof_symbols: proof_pack.summary.symbol_spans,
          proof_edges: proof_pack.summary.edge_spans,
          stencil_slices: slice_stencil.summary.changed_slices,
          stencil_templates: slice_stencil.summary.with_templates,
          runtime_hotspots: 0,
        },
        coverage_banner: buildCoverageBanner({
          changedFileCount: 0,
          untrackedFileCount: 0,
          untrackedArtifactCount: 0,
          changedSymbolCount: 0,
          changedSymbolTotal: 0,
          changedSymbolCap: 0,
          suggestedTestCount: 0,
          symbolizedFileCount: 0,
          runtimeHotspotCount: 0,
          runtimeSource: (
            runtimeSnapshot.request_spans.length > 0
            || runtimeSnapshot.db_queries.length > 0
            || runtimeSnapshot.payload_shapes.length > 0
          ) ? 'snapshot' : 'none',
          runtimeGeneratedAt: runtimeSnapshot.generatedAt || '',
          runtimeSourceFiles: runtimeSnapshot.source_files,
        }),
        untracked_files: [],
        untracked_artifacts: [],
        changed_files: [],
        changed_symbols: [],
        symbols: [],
        suggested_tests: [],
        test_commands: [],
        ui_contracts: [],
        route_targets: [],
        contract_parity: [],
        runtime_evidence: {
          focus_route: '/seating_groups/assign',
          routes: [],
          focus_routes: [],
        },
        perf_backend_findings: [],
        test_intelligence: {
          mode: 'changed-vs-baseline-heuristic',
          baseline_ref: scope === 'compare' ? (baseRef || 'merge-base') : 'HEAD',
          changed_test_files: [],
          regression_failure_candidates: [],
          preexisting_failure_candidates: [],
          notes: [],
        },
        authz: [],
        runtime_hotspots: [],
        semantic_diffs,
        proof_pack,
        slice_stencil,
        review_kernel,
        _review_mode: {
          diff: {
            requested_scope: scope,
            effective_scope: effectiveScope,
            fallback_applied: diffSource !== 'requested',
            source: diffSource,
          },
        },
      };
    }

    let patch = '';
    try {
      patch = execFileSync('git', buildDiffArgs(true, effectiveScope), {
        cwd: repo.repoPath,
        encoding: 'utf-8',
        maxBuffer: GIT_PATCH_MAX_BUFFER,
      });
    } catch (err: any) {
      return { error: `Git diff patch failed: ${err?.message || 'unknown error'}` };
    }

    const parsePatch = (text: string): DiffFile[] => {
      const files: DiffFile[] = [];
      let current: DiffFile | null = null;

      const pushCurrent = () => {
        if (!current) return;
        current.filePath = normalizePath(current.filePath);
        if (!current.filePath) return;
        if (!isInScope(current.filePath)) return;
        files.push(current);
      };

      for (const line of String(text || '').split('\n')) {
        if (line.startsWith('diff --git ')) {
          pushCurrent();

          const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
          if (!m) {
            current = null;
            continue;
          }

          const aPath = m[1];
          const bPath = m[2];
          const isAdded = aPath === '/dev/null';
          const isDeleted = bPath === '/dev/null';
          const filePath = isAdded ? bPath : (isDeleted ? aPath : bPath);

          let status: DiffFile['status'] = 'Modified';
          if (isAdded) status = 'Added';
          if (isDeleted) status = 'Deleted';
          if (!isAdded && !isDeleted && aPath !== bPath) status = 'Renamed';

          current = {
            filePath,
            status,
            ...(status === 'Renamed' ? { fromPath: aPath } : {}),
            hunks: [],
          };
          continue;
        }

        if (!current) continue;

        if (line.startsWith('new file mode ')) {
          current.status = 'Added';
          continue;
        }
        if (line.startsWith('deleted file mode ')) {
          current.status = 'Deleted';
          continue;
        }

        const renameFrom = /^rename from (.+)$/.exec(line);
        if (renameFrom) {
          current.status = 'Renamed';
          current.fromPath = normalizePath(renameFrom[1] || '');
          continue;
        }
        const renameTo = /^rename to (.+)$/.exec(line);
        if (renameTo) {
          current.status = 'Renamed';
          current.filePath = normalizePath(renameTo[1] || current.filePath);
          continue;
        }
        const copyFrom = /^copy from (.+)$/.exec(line);
        if (copyFrom) {
          current.status = 'Copied';
          current.fromPath = normalizePath(copyFrom[1] || '');
          continue;
        }
        const copyTo = /^copy to (.+)$/.exec(line);
        if (copyTo) {
          current.status = 'Copied';
          current.filePath = normalizePath(copyTo[1] || current.filePath);
          continue;
        }

        const oldFileLine = /^---\s+(.+)$/.exec(line);
        if (oldFileLine) {
          const oldPath = String(oldFileLine[1] || '').trim();
          if (oldPath === '/dev/null') current.status = 'Added';
          else if (oldPath.startsWith('a/')) current.fromPath = normalizePath(oldPath.slice(2));
          continue;
        }
        const newFileLine = /^\+\+\+\s+(.+)$/.exec(line);
        if (newFileLine) {
          const newPath = String(newFileLine[1] || '').trim();
          if (newPath === '/dev/null') {
            current.status = 'Deleted';
          } else if (newPath.startsWith('b/')) {
            current.filePath = normalizePath(newPath.slice(2));
          }
          continue;
        }

        if (line.startsWith('Binary files ')) {
          current.binary = true;
          continue;
        }

        const h = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
        if (h) {
          const oldStart = toFiniteNumber(h[1], 1);
          const oldLines = h[2] ? toFiniteNumber(h[2], 1) : 1;
          const newStart = toFiniteNumber(h[3], 1);
          const newLines = h[4] ? toFiniteNumber(h[4], 1) : 1;
          current.hunks.push({
            old_start: Number.isFinite(oldStart) ? oldStart : 0,
            old_lines: Number.isFinite(oldLines) ? oldLines : 0,
            new_start: Number.isFinite(newStart) ? newStart : 0,
            new_lines: Number.isFinite(newLines) ? newLines : 0,
          });
          continue;
        }
      }

      pushCurrent();
      return files;
    };

    const diffFiles = parsePatch(patch);

    // Fallback: if patch parsing failed (e.g., empty patch), still return tracked name-only list.
    const changedFileMap = new Map<string, DiffFile>();
    const baseChangedFileObjs: DiffFile[] = diffFiles.length > 0
      ? diffFiles
      : trackedChangedFiles.map(filePath => ({ filePath, status: 'Modified', hunks: [] }));

    for (const file of baseChangedFileObjs) {
      const normalizedPath = normalizePath(file.filePath);
      if (!normalizedPath || !isInScope(normalizedPath)) continue;
      changedFileMap.set(normalizedPath, {
        ...file,
        filePath: normalizedPath,
      });
    }

    for (const filePath of productUntrackedFiles) {
      const normalizedPath = normalizePath(filePath);
      if (!normalizedPath || !isInScope(normalizedPath)) continue;
      const existing = changedFileMap.get(normalizedPath);
      changedFileMap.set(normalizedPath, {
        ...(existing || { filePath: normalizedPath, hunks: [] }),
        filePath: normalizedPath,
        status: 'Untracked',
      });
    }

    const changedFileObjs: DiffFile[] = Array.from(changedFileMap.values());

    type ChangedSymbol = {
      uid: string;
      name: string;
      kind: string;
      filePath: string;
      startLine?: number;
      endLine?: number;
      evidence?: { hunks: Array<{ new_start: number; new_lines: number; old_start: number; old_lines: number }> };
    };

    const changedSymbolsById = new Map<string, ChangedSymbol>();
    const addChangedSymbol = (sym: ChangedSymbol) => {
      if (!sym.uid || !sym.filePath) return;
      if (!isInScope(sym.filePath)) return;

      const existing = changedSymbolsById.get(sym.uid);
      if (existing) {
        const existingHunks = existing.evidence?.hunks || [];
        const nextHunks = sym.evidence?.hunks || [];
        existing.evidence = { hunks: [...existingHunks, ...nextHunks] };
        return;
      }

      changedSymbolsById.set(sym.uid, sym);
    };

    const batchLoadFileNodes = async (filePaths: string[]): Promise<Map<string, ChangedSymbol>> => {
      const result = new Map<string, ChangedSymbol>();
      const normalized = Array.from(new Set(filePaths.map(filePath => normalizePath(filePath)).filter(Boolean)));
      if (normalized.length === 0) return result;

      const filesCypher = `[${normalized.map(filePath => `'${filePath.replace(/'/g, "''")}'`).join(', ')}]`;
      let rows: any[] = [];
      try {
        rows = await executeQuery(repo.id, `
          MATCH (f:File)
          WHERE f.filePath IN ${filesCypher}
          RETURN f.id AS id, f.name AS name, labels(f) AS type, f.filePath AS filePath
          LIMIT ${Math.max(200, Math.min(10000, normalized.length * 10))}
        `);
      } catch {
        rows = [];
      }

      for (const row of rows) {
        const filePath = normalizePath(String(row.filePath || row[3] || ''));
        const uid = String(row.id || row[0] || '').trim();
        if (!filePath || !uid) continue;
        if (result.has(filePath)) continue;
        result.set(filePath, {
          uid,
          name: String(row.name || row[1] || filePath),
          kind: toPrimaryLabel(row.type || row[2] || 'File') || 'File',
          filePath,
        });
      }

      return result;
    };

    const toRanges = (hunks: DiffHunk[]): Array<{ start: number; end: number }> => {
      return hunks
        .filter(h => Number.isFinite(h?.new_start) && Number.isFinite(h?.new_lines))
        .map(h => {
          const start = Math.max(1, toFiniteNumber(h.new_start, 1));
          // Deletion hunks report new_lines=0; use one-line anchor for overlap checks.
          const rawCount = toFiniteNumber(h.new_lines, 0);
          const count = rawCount > 0 ? rawCount : 1;
          return { start, end: start + count - 1 };
        });
    };

    const fileNodeCandidates: string[] = [];
    const rangedFiles: Array<{
      filePath: string;
      hunks: DiffHunk[];
      ranges: Array<{ start: number; end: number }>;
    }> = [];

    for (const file of changedFileObjs) {
      const filePath = normalizePath(file.filePath);
      if (!filePath) continue;
      if (!isInScope(filePath)) continue;
      if (file.status === 'Deleted') continue;

      const hunks = Array.isArray(file.hunks) ? file.hunks : [];
      if (hunks.length === 0) {
        if (file.binary || file.status === 'Untracked' || file.status === 'Added') {
          fileNodeCandidates.push(filePath);
        }
        continue;
      }

      const ranges = toRanges(hunks);
      if (ranges.length === 0) continue;
      rangedFiles.push({ filePath, hunks, ranges });
    }

    if (fileNodeCandidates.length > 0) {
      const fileNodes = await batchLoadFileNodes(fileNodeCandidates);
      for (const filePath of fileNodeCandidates) {
        const fileNode = fileNodes.get(normalizePath(filePath));
        if (fileNode) addChangedSymbol(fileNode);
      }
    }

    if (rangedFiles.length > 0) {
      const rangedFilePaths = Array.from(new Set(rangedFiles.map(item => item.filePath)));
      const rangedFilesCypher = `[${rangedFilePaths.map(filePath => `'${filePath.replace(/'/g, "''")}'`).join(', ')}]`;

      let symbolRows: any[] = [];
      const rangeWindows = rangedFiles
        .map(spec => {
          const starts = spec.ranges
            .map(range => toOptionalNonNegativeInteger(range?.start))
            .filter((value): value is number => value !== undefined);
          const ends = spec.ranges
            .map(range => toOptionalNonNegativeInteger(range?.end))
            .filter((value): value is number => value !== undefined);
          if (starts.length === 0 || ends.length === 0) return null;
          return {
            filePath: spec.filePath,
            minStart: Math.min(...starts),
            maxEnd: Math.max(...ends),
          };
        })
        .filter((item): item is { filePath: string; minStart: number; maxEnd: number } => !!item);

      let usedPreciseWindowQuery = false;
      if (rangeWindows.length > 0 && rangeWindows.length <= 120) {
        usedPreciseWindowQuery = true;
        const chunkSize = 30;
        try {
          for (let i = 0; i < rangeWindows.length; i += chunkSize) {
            const chunk = rangeWindows.slice(i, i + chunkSize);
            const whereClause = chunk
              .map(window => `(n.filePath = '${window.filePath.replace(/'/g, "''")}' AND n.startLine <= ${window.maxEnd} AND n.endLine >= ${window.minStart})`)
              .join(' OR ');
            if (!whereClause) continue;
            const rows = await executeQuery(repo.id, `
              MATCH (n)
              WHERE n.startLine IS NOT NULL
                AND n.endLine IS NOT NULL
                AND (${whereClause})
              RETURN n.id AS id, n.name AS name, labels(n) AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
              LIMIT ${Math.max(500, Math.min(50000, chunk.length * 1200))}
            `);
            symbolRows.push(...rows);
          }
        } catch {
          symbolRows = [];
          usedPreciseWindowQuery = false;
        }
      }

      if (!usedPreciseWindowQuery) {
        try {
          symbolRows = await executeQuery(repo.id, `
            MATCH (n)
            WHERE n.filePath IN ${rangedFilesCypher}
              AND n.startLine IS NOT NULL
              AND n.endLine IS NOT NULL
            RETURN n.id AS id, n.name AS name, labels(n) AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
            LIMIT ${Math.max(500, Math.min(100000, rangedFilePaths.length * 600))}
          `);
        } catch {
          symbolRows = [];
        }
      }

      const rowsByFile = new Map<string, any[]>();
      for (const row of symbolRows) {
        const filePath = normalizePath(String(row.filePath || row[3] || ''));
        if (!filePath) continue;
        const list = rowsByFile.get(filePath) || [];
        list.push(row);
        rowsByFile.set(filePath, list);
      }

      for (const spec of rangedFiles) {
        const fileRows = rowsByFile.get(spec.filePath) || [];
        for (const row of fileRows) {
          const uid = String(row.id || row[0] || '').trim();
          if (!uid) continue;
          const startLine = toOptionalNonNegativeInteger(row.startLine ?? row[4]);
          const endLine = toOptionalNonNegativeInteger(row.endLine ?? row[5]);
          const overlaps = spec.ranges.some(range => {
            if (startLine === undefined || endLine === undefined) return false;
            return startLine <= range.end && endLine >= range.start;
          });
          if (!overlaps) continue;

          addChangedSymbol({
            uid,
            name: row.name || row[1] || '',
            kind: toPrimaryLabel(row.type || row[2] || ''),
            filePath: row.filePath || row[3] || spec.filePath,
            startLine,
            endLine,
            evidence: { hunks: spec.hunks },
          });
        }
      }
    }

    const allChangedSymbols = Array.from(changedSymbolsById.values())
      .sort((left, right) => {
        const leftPath = normalizePath(String(left?.filePath || ''));
        const rightPath = normalizePath(String(right?.filePath || ''));
        if (leftPath !== rightPath) return leftPath.localeCompare(rightPath);
        const leftStart = toFiniteNumber(left?.startLine, Number.POSITIVE_INFINITY);
        const rightStart = toFiniteNumber(right?.startLine, Number.POSITIVE_INFINITY);
        if (leftStart !== rightStart) return leftStart - rightStart;
        return String(left?.uid || '').localeCompare(String(right?.uid || ''));
      });
    const changedSymbolCountTotal = allChangedSymbols.length;
    const analysisSymbolCap = Math.max(200, Math.min(5000, limitSymbols * 20));
    const analysisSymbols = allChangedSymbols.slice(0, analysisSymbolCap);
    const changedSymbols = analysisSymbols.slice(0, limitSymbols);
    const changedSymbolsTruncated = changedSymbolCountTotal > analysisSymbols.length;

    const callerFetchLimit = Math.min(200, Math.max(limitCallers, limitTests) * 6);
    const escapeCypherValue = (value: string): string => String(value || '').replace(/'/g, "''");
    const buildCypherStringList = (values: string[]): string => {
      if (values.length === 0) return '[]';
      return `[${values.map(value => `'${escapeCypherValue(value)}'`).join(', ')}]`;
    };
    const changedSymbolIds = Array.from(new Set(
      analysisSymbols
        .map(sym => String(sym?.uid || '').trim())
        .filter(Boolean)
    ));
    const changedSymbolIdSet = new Set(changedSymbolIds);
    const changedFilePathSet = new Set<string>();
    for (const sym of analysisSymbols) {
      const fp = normalizePath(String(sym?.filePath || ''));
      if (fp) changedFilePathSet.add(fp);
    }
    for (const file of changedFileObjs) {
      if (file.status === 'Deleted') continue;
      const fp = normalizePath(String(file?.filePath || ''));
      if (fp) changedFilePathSet.add(fp);
    }
    const reviewTokenSet = new Set<string>();
    for (const fp of changedFilePathSet) {
      for (const token of tokenizeConvergence(fp)) reviewTokenSet.add(token);
      const base = path.basename(fp, path.extname(fp));
      for (const token of tokenizeConvergence(base)) reviewTokenSet.add(token);
    }
    for (const sym of analysisSymbols) {
      for (const token of tokenizeConvergence(String(sym?.name || ''))) reviewTokenSet.add(token);
      for (const token of tokenizeConvergence(String(sym?.kind || ''))) reviewTokenSet.add(token);
    }

    const getConvergenceSignal = (filePath: string, context: Array<unknown> = []): ConvergenceSignal | null => {
      if (!convergenceMatrix) return null;
      const normalizedFilePath = normalizePath(String(filePath || ''));
      if (!normalizedFilePath) return null;
      const itemTokenSet = new Set<string>([
        ...tokenizeConvergence(normalizedFilePath),
        ...context.flatMap(value => tokenizeConvergence(value)),
      ]);
      return computeConvergenceSignal(convergenceMatrix, reviewTokenSet, itemTokenSet, [normalizedFilePath]);
    };

    const suggestedTestsAgg = new Map<string, { score: number; reasons: string[] }>();
    const isRunnableSuggestedTestFile = (filePath: string): boolean => {
      const fp = normalizePath(String(filePath || '')).toLowerCase();
      if (!fp) return false;
      if (/\.test\.[a-z0-9]+$/.test(fp) || /\.spec\.[a-z0-9]+$/.test(fp) || /_test\.[a-z0-9]+$/.test(fp)) {
        return true;
      }
      if (fp.endsWith('.php')) {
        return /(^|\/)tests?\//.test(fp) && /test\.php$/.test(fp);
      }
      return false;
    };
    const addSuggestedTest = (
      filePath: string,
      scoreDelta: number,
      reason: string,
      options: { allowOutOfScope?: boolean } = {},
    ): void => {
      const fp = normalizePath(filePath);
      if (!fp) return;
      if (!isTestFilePath(fp)) return;
      if (!isRunnableSuggestedTestFile(fp)) return;
      if (!options.allowOutOfScope && pathPrefixes.length > 0 && !isInScope(fp)) return;

      const current = suggestedTestsAgg.get(fp) || { score: 0, reasons: [] as string[] };
      const safeScore = Number.isFinite(scoreDelta) ? Math.max(0.05, scoreDelta) : 0.05;
      const reasonText = String(reason || '').trim();
      const reasons = reasonText && !current.reasons.includes(reasonText)
        ? [...current.reasons, reasonText].slice(0, 5)
        : current.reasons;
      suggestedTestsAgg.set(fp, { score: current.score + safeScore, reasons });
    };

    const callersByTargetId = new Map<string, any[]>();
    const pushCallerRows = (rows: any[], columnOffset = 0): void => {
      for (const row of rows) {
        const targetId = String(row.targetId || row[columnOffset + 0] || '').trim();
        if (!targetId) continue;
        const filePath = normalizePath(String(row.filePath || row[columnOffset + 4] || ''));
        if (!filePath) continue;
        const entry = {
          uid: row.uid || row[columnOffset + 1],
          name: row.name || row[columnOffset + 2],
          kind: toPrimaryLabel(row.kind || row[columnOffset + 3]),
          filePath,
          startLine: row.startLine ?? row[columnOffset + 5],
          edge: {
            confidence: normalizeConfidence(row.confidence ?? row[columnOffset + 6], 1.0),
            reason: String(row.reason ?? row[columnOffset + 7] ?? ''),
          },
        };
        const list = callersByTargetId.get(targetId) || [];
        list.push(entry);
        callersByTargetId.set(targetId, list);
      }
    };

    if (changedSymbolIds.length > 0) {
      try {
        const changedSymbolIdsCypher = buildCypherStringList(changedSymbolIds);
        const callerRows = await executeQuery(repo.id, `
          MATCH (caller)-[r:CodeRelation {type: 'CALLS'}]->(t)
          WHERE t.id IN ${changedSymbolIdsCypher}
            AND r.confidence >= ${minConfidence}
          RETURN
            t.id AS targetId,
            caller.id AS uid,
            caller.name AS name,
            labels(caller) AS kind,
            caller.filePath AS filePath,
            caller.startLine AS startLine,
            r.confidence AS confidence,
            r.reason AS reason
          ORDER BY r.confidence DESC
          LIMIT ${Math.max(200, Math.min(10000, callerFetchLimit * Math.max(1, changedSymbolIds.length)))}
        `);

        pushCallerRows(callerRows);
      } catch {
        // best-effort: fallback query below for missing targets.
      }
    }

    // Fallback: if some symbols did not receive callers in the primary batch (due cap/query sparsity),
    // run one additional grouped query instead of N per-symbol queries.
    const missingCallerTargets = changedSymbolIds.filter(id => {
      const rows = callersByTargetId.get(id);
      return !rows || rows.length === 0;
    });
    if (missingCallerTargets.length > 0) {
      try {
        const fallbackRows = await executeQuery(repo.id, `
          MATCH (caller)-[r:CodeRelation {type: 'CALLS'}]->(t)
          WHERE t.id IN ${buildCypherStringList(missingCallerTargets)}
            AND r.confidence >= ${minConfidence}
          RETURN
            t.id AS targetId,
            caller.id AS uid,
            caller.name AS name,
            labels(caller) AS kind,
            caller.filePath AS filePath,
            caller.startLine AS startLine,
            r.confidence AS confidence,
            r.reason AS reason
          ORDER BY r.confidence DESC
          LIMIT ${Math.max(200, Math.min(12000, callerFetchLimit * Math.max(1, missingCallerTargets.length)))}
        `);
        pushCallerRows(fallbackRows);
      } catch {
        // best-effort fallback
      }
    }

    const symbolReviews: any[] = [];
    for (const sym of analysisSymbols) {
      const targetId = String(sym?.uid || '').trim();
      let callersRaw: any[] = callersByTargetId.get(targetId) || [];

      const dedupedByCaller = new Map<string, any>();
      for (const caller of callersRaw) {
        const uid = String(caller?.uid || '').trim();
        const filePath = normalizePath(String(caller?.filePath || '').trim());
        const key = uid || filePath;
        if (!key) continue;
        const prev = dedupedByCaller.get(key);
        const nextConfidence = toFiniteNumber(caller?.edge?.confidence, 0);
        const prevConfidence = toFiniteNumber(prev?.edge?.confidence, -1);
        if (prev && prevConfidence >= nextConfidence) continue;
        dedupedByCaller.set(key, {
          ...caller,
          filePath,
        });
      }
      callersRaw = Array.from(dedupedByCaller.values());

      callersRaw.sort((left, right) => {
        const c = toFiniteNumber(right?.edge?.confidence, 0) - toFiniteNumber(left?.edge?.confidence, 0);
        if (c !== 0) return c;
        return String(left?.filePath || '').localeCompare(String(right?.filePath || ''));
      });

      const callers = (pathPrefixes.length > 0
        ? callersRaw.filter((c: any) => isInScope(String(c?.filePath || '')))
        : callersRaw)
        .slice(0, callerFetchLimit);

      const testCallers = callers
        .filter((c: any) => isTestFilePath(String(c?.filePath || '')))
        .slice(0, limitTests);

      for (const t of testCallers) {
        const fp = String(t?.filePath || '').trim();
        if (!fp) continue;
        const confidence = normalizeConfidence(t?.edge?.confidence, 1.0);
        const reason = sym?.name ? `${sym.name} direct caller` : 'direct caller of changed symbol';
        addSuggestedTest(fp, 3 + Math.max(0, confidence), reason);
      }

      symbolReviews.push({
        symbol: sym,
        callers: callers.slice(0, limitCallers),
        test_callers: testCallers,
      });
    }
    const symbols: any[] = symbolReviews.slice(0, limitSymbols);

    // Fallback tier 1: include lower-confidence test callers if no direct high-confidence hits were found.
    if (suggestedTestsAgg.size === 0 && changedSymbolIds.length > 0) {
      try {
        const changedSymbolIdsCypher = buildCypherStringList(changedSymbolIds);
        const fallbackRows = await executeQuery(repo.id, `
          MATCH (caller)-[r:CodeRelation {type: 'CALLS'}]->(t)
          WHERE t.id IN ${changedSymbolIdsCypher}
          RETURN caller.filePath AS callerFilePath, t.name AS targetName, r.confidence AS confidence, r.reason AS reason
          ORDER BY r.confidence DESC
          LIMIT ${Math.max(limitTests * 30, 120)}
        `);
        for (const row of fallbackRows) {
          const callerFilePath = String(row.callerFilePath || row[0] || '').trim();
          if (!callerFilePath) continue;
          if (pathPrefixes.length > 0 && !isInScope(callerFilePath)) continue;
          if (!isTestFilePath(callerFilePath)) continue;
          const targetName = String(row.targetName || row[1] || '').trim();
          const confidence = normalizeConfidence(row.confidence ?? row[2], 0);
          const reason = targetName
            ? `${targetName} low-confidence caller (confidence ${confidence.toFixed(2)})`
            : `low-confidence caller (confidence ${confidence.toFixed(2)})`;
          addSuggestedTest(callerFilePath, 1 + Math.max(0, confidence), reason);
        }
      } catch {
        // best-effort fallback
      }
    }

    // Fallback tier 2: suggest tests that import changed files, even when no CALLS edge exists.
    if (suggestedTestsAgg.size === 0 && changedFilePathSet.size > 0) {
      try {
        const changedFilesCypher = buildCypherStringList(Array.from(changedFilePathSet));
        const importRows = await executeQuery(repo.id, `
          MATCH (caller)-[r:CodeRelation {type: 'IMPORTS'}]->(target)
          WHERE target.filePath IN ${changedFilesCypher}
          RETURN caller.filePath AS callerFilePath, target.filePath AS targetFilePath, r.confidence AS confidence
          ORDER BY r.confidence DESC
          LIMIT ${Math.max(limitTests * 40, 200)}
        `);
        for (const row of importRows) {
          const callerFilePath = String(row.callerFilePath || row[0] || '').trim();
          if (!callerFilePath) continue;
          if (pathPrefixes.length > 0 && !isInScope(callerFilePath)) continue;
          if (!isTestFilePath(callerFilePath)) continue;
          const targetFilePath = normalizePath(String(row.targetFilePath || row[1] || ''));
          const confidence = normalizeConfidence(row.confidence ?? row[2], 0);
          const reason = targetFilePath
            ? `imports changed file ${targetFilePath}`
            : 'imports changed file';
          addSuggestedTest(callerFilePath, 0.8 + Math.max(0, confidence), reason);
        }
      } catch {
        // best-effort fallback
      }
    }

    // Fallback tier 3: lexical proximity from tracked tests as a last resort.
    if (suggestedTestsAgg.size === 0 && changedFilePathSet.size > 0) {
      const stopTokens = new Set([
        'apps', 'app', 'src', 'lib', 'utils', 'shared', 'common', 'components',
        'services', 'service', 'controllers', 'controller', 'index', 'test', 'tests',
        'spec', 'feature', 'unit', 'backend', 'dashboard', 'gitnexus', 'local',
        'domains', 'domain', 'php', 'http', 'api',
      ]);
      const tokenize = (value: string): string[] => {
        return String(value || '')
          .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
          .toLowerCase()
          .split(/[^a-z0-9]+/g)
          .map(token => token.trim())
          .filter(token => token.length >= 3 && !stopTokens.has(token));
      };

      const changedTokens = new Set<string>();
      for (const fp of changedFilePathSet) {
        for (const token of tokenize(fp)) changedTokens.add(token);
        const base = path.basename(fp, path.extname(fp));
        for (const token of tokenize(base)) changedTokens.add(token);
      }
      for (const sym of analysisSymbols) {
        for (const token of tokenize(String(sym?.name || ''))) changedTokens.add(token);
      }

      if (changedTokens.size > 0) {
        const matchesChangedToken = (token: string): boolean => {
          const hasSharedNgram = (left: string, right: string): boolean => {
            if (left.length < 8 || right.length < 8) return false;
            const n = 4;
            const grams = new Set<string>();
            for (let i = 0; i <= left.length - n; i += 1) grams.add(left.slice(i, i + n));
            let overlap = 0;
            for (let i = 0; i <= right.length - n; i += 1) {
              if (grams.has(right.slice(i, i + n))) {
                overlap += 1;
                if (overlap >= 3) return true;
              }
            }
            return false;
          };
          if (changedTokens.has(token)) return true;
          for (const changedToken of changedTokens) {
            if (token.length < 4 && changedToken.length < 4) continue;
            if (token.includes(changedToken) || changedToken.includes(token)) return true;
            if (hasSharedNgram(token, changedToken)) return true;
          }
          return false;
        };
        try {
          const fileRows = await executeQuery(repo.id, `
            MATCH (f:File)
            WHERE (
              lower(f.filePath) CONTAINS '/test/'
              OR lower(f.filePath) CONTAINS '/tests/'
              OR lower(f.filePath) CONTAINS '.test.'
              OR lower(f.filePath) CONTAINS '.spec.'
            )
            RETURN f.filePath AS filePath
            LIMIT 20000
          `);
          const candidates = fileRows
            .map((row: any) => normalizePath(String(row.filePath ?? row[0] ?? '')))
            .filter(Boolean)
            .filter(filePath => isTestFilePath(filePath))
            .filter(filePath => isRunnableSuggestedTestFile(filePath))
            .filter(filePath => pathPrefixes.length === 0 || isInScope(filePath));

          const ranked = candidates
            .map(filePath => {
              const overlap = Array.from(new Set(tokenize(filePath).filter(token => matchesChangedToken(token))));
              if (overlap.length === 0) return null;
              return {
                filePath,
                score: 0.3 * overlap.length,
                reason: `filename/token proximity: ${overlap.slice(0, 4).join(', ')}`,
              };
            })
            .filter((item): item is { filePath: string; score: number; reason: string } => item !== null)
            .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
            .slice(0, limitTests);

          for (const hit of ranked) {
            addSuggestedTest(hit.filePath, hit.score, hit.reason, { allowOutOfScope: true });
          }
        } catch {
          // best-effort fallback
        }
      }
    }

    // Fallback tier 4: if scoped prefixes are too narrow, suggest nearest global tests.
    if (suggestedTestsAgg.size === 0 && pathPrefixes.length > 0 && changedFilePathSet.size > 0) {
      const stopTokens = new Set([
        'apps', 'app', 'src', 'lib', 'utils', 'shared', 'common', 'components',
        'services', 'service', 'controllers', 'controller', 'index', 'test', 'tests',
        'spec', 'feature', 'unit', 'backend', 'dashboard', 'gitnexus', 'local',
        'domains', 'domain', 'php', 'http', 'api',
      ]);
      const tokenize = (value: string): string[] => {
        return String(value || '')
          .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
          .toLowerCase()
          .split(/[^a-z0-9]+/g)
          .map(token => token.trim())
          .filter(token => token.length >= 3 && !stopTokens.has(token));
      };

      const changedTokens = new Set<string>();
      for (const fp of changedFilePathSet) {
        for (const token of tokenize(fp)) changedTokens.add(token);
        const base = path.basename(fp, path.extname(fp));
        for (const token of tokenize(base)) changedTokens.add(token);
      }
      for (const sym of analysisSymbols) {
        for (const token of tokenize(String(sym?.name || ''))) changedTokens.add(token);
      }

      if (changedTokens.size > 0) {
        const matchesChangedToken = (token: string): boolean => {
          const hasSharedNgram = (left: string, right: string): boolean => {
            if (left.length < 8 || right.length < 8) return false;
            const n = 4;
            const grams = new Set<string>();
            for (let i = 0; i <= left.length - n; i += 1) grams.add(left.slice(i, i + n));
            let overlap = 0;
            for (let i = 0; i <= right.length - n; i += 1) {
              if (grams.has(right.slice(i, i + n))) {
                overlap += 1;
                if (overlap >= 3) return true;
              }
            }
            return false;
          };
          if (changedTokens.has(token)) return true;
          for (const changedToken of changedTokens) {
            if (token.length < 4 && changedToken.length < 4) continue;
            if (token.includes(changedToken) || changedToken.includes(token)) return true;
            if (hasSharedNgram(token, changedToken)) return true;
          }
          return false;
        };
        try {
          const fileRows = await executeQuery(repo.id, `
            MATCH (f:File)
            WHERE (
              lower(f.filePath) CONTAINS '/test/'
              OR lower(f.filePath) CONTAINS '/tests/'
              OR lower(f.filePath) CONTAINS '.test.'
              OR lower(f.filePath) CONTAINS '.spec.'
            )
            RETURN f.filePath AS filePath
            LIMIT 20000
          `);
          const candidates = fileRows
            .map((row: any) => normalizePath(String(row.filePath ?? row[0] ?? '')))
            .filter(Boolean)
            .filter(filePath => isTestFilePath(filePath))
            .filter(filePath => isRunnableSuggestedTestFile(filePath));

          const ranked = candidates
            .map(filePath => {
              const overlap = Array.from(new Set(tokenize(filePath).filter(token => matchesChangedToken(token))));
              if (overlap.length === 0) return null;
              return {
                filePath,
                score: 0.3 * overlap.length,
                reason: `scope fallback token proximity: ${overlap.slice(0, 4).join(', ')}`,
              };
            })
            .filter((item): item is { filePath: string; score: number; reason: string } => item !== null)
            .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
            .slice(0, limitTests);

          for (const hit of ranked) {
            addSuggestedTest(hit.filePath, hit.score, hit.reason, { allowOutOfScope: true });
          }
        } catch {
          // best-effort fallback
        }
      }
    }

    // NOTE: We intentionally do not emit a broad "no overlap" fallback list here.
    // In real-world reviews this produced low-relevance suggestions; prefer returning 0 tests.

    const shellQuote = (value: string): string => {
      const raw = String(value || '');
      return `'${raw.replace(/'/g, `'\\''`)}'`;
    };

    const buildSuggestedTestCommand = (filePath: string): {
      runner: string;
      cwd: string;
      command: string;
    } => {
      const fp = normalizePath(filePath);
      if (fp.startsWith('apps/backend/')) {
        const rel = normalizePath(path.relative('apps/backend', fp));
        return {
          runner: 'phpunit',
          cwd: 'apps/backend',
          command: `./vendor/bin/phpunit ${shellQuote(rel || fp)}`,
        };
      }

      if (fp.startsWith('apps/dashboard/')) {
        const rel = normalizePath(path.relative('apps/dashboard', fp));
        return {
          runner: 'vitest',
          cwd: 'apps/dashboard',
          command: `pnpm exec vitest run ${shellQuote(rel || fp)}`,
        };
      }

      if (fp.toLowerCase().endsWith('.php')) {
        return {
          runner: 'phpunit',
          cwd: '.',
          command: `./vendor/bin/phpunit ${shellQuote(fp)}`,
        };
      }

      if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(fp)) {
        return {
          runner: 'node-test',
          cwd: '.',
          command: `node --test ${shellQuote(fp)}`,
        };
      }

      return {
        runner: 'generic-test',
        cwd: '.',
        command: `node --test ${shellQuote(fp)}`,
      };
    };

    const changedTestFileSet = new Set(
      changedFileObjs
        .map(file => normalizePath(String(file?.filePath || '')))
        .filter(Boolean)
        .filter(filePath => isTestFilePath(filePath))
        .filter(filePath => !changedFileObjs.find(item => normalizePath(String(item?.filePath || '')) === filePath && item.status === 'Deleted')),
    );
    for (const changedTestFilePath of Array.from(changedTestFileSet)) {
      addSuggestedTest(changedTestFilePath, 1.05, 'changed test file in diff');
    }

    const suggestedTestsEntries = Array.from(suggestedTestsAgg.entries())
      .map(([filePath, meta], sourceIndex) => {
        const signal = getConvergenceSignal(filePath, meta.reasons);
        const convergenceScore = toFiniteNumber(signal?.score, 0);
        const reasonTokenSet = new Set<string>(meta.reasons.flatMap(reason => tokenizeConvergence(reason)));
        const reasonOverlapCount = reasonTokenSet.size > 0
          ? overlapCount(reviewTokenSet, reasonTokenSet)
          : 0;
        const reasonOverlapScore = reasonOverlapCount > 0
          ? reasonOverlapCount / Math.max(1, Math.min(reviewTokenSet.size, 8))
          : 0;
        const changedTestBonus = changedTestFileSet.has(filePath) ? 1 : 0;
        const rank = round3(
          (meta.score * REVIEW_CONVERGENCE_RANK_WEIGHTS.suggested_tests.base_score)
          + (convergenceScore * REVIEW_CONVERGENCE_RANK_WEIGHTS.suggested_tests.convergence_score)
          + (reasonOverlapScore * REVIEW_CONVERGENCE_RANK_WEIGHTS.suggested_tests.reason_overlap)
          + (changedTestBonus * REVIEW_CONVERGENCE_RANK_WEIGHTS.suggested_tests.changed_test_file_bonus),
        );
        return {
          filePath,
          meta,
          sourceIndex,
          signal,
          rank,
          rank_components: {
            base_score: round3(meta.score),
            convergence_score: round3(convergenceScore),
            reason_overlap: round3(reasonOverlapScore),
            changed_test_file_bonus: round3(changedTestBonus * REVIEW_CONVERGENCE_RANK_WEIGHTS.suggested_tests.changed_test_file_bonus),
          },
        };
      });
    const suggestedTestsBaseOrder = suggestedTestsEntries
      .slice()
      .sort((left, right) => {
        if (right.meta.score !== left.meta.score) return right.meta.score - left.meta.score;
        return left.sourceIndex - right.sourceIndex;
      })
      .map(item => item.filePath);
    const suggestedTestsRanked = suggestedTestsEntries
      .slice()
      .sort((left, right) => {
        if (right.rank !== left.rank) return right.rank - left.rank;
        if (right.meta.score !== left.meta.score) return right.meta.score - left.meta.score;
        return left.sourceIndex - right.sourceIndex;
      });
    const suggestedTestsRankedOrder = suggestedTestsRanked.map(item => item.filePath);
    const suggestedTestsBoosted = suggestedTestsEntries
      .filter(item => toFiniteNumber(item?.signal?.score, 0) > 0)
      .length;
    const suggestedTestsReordered = suggestedTestsBaseOrder.join('|') !== suggestedTestsRankedOrder.join('|');

    const SUGGESTED_TEST_MIN_RANK = 0.3;
    const SUGGESTED_TEST_MIN_AFFINITY = 0.2;
    const suggestedTestTargetPaths = Array.from(changedFilePathSet)
      .filter(Boolean)
      .slice(0, 160);
    const getDomainRoot = (filePath: string): string => {
      const fp = normalizePath(filePath);
      if (!fp) return '';
      const parts = fp.split('/').filter(Boolean);
      if (parts.length === 0) return '';
      if (parts[0] === 'apps' && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
      if (parts[0] === 'packages' && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
      return parts[0];
    };
    const changedDomainRoots = new Set<string>();
    for (const fp of suggestedTestTargetPaths) {
      const root = getDomainRoot(fp);
      if (root) changedDomainRoots.add(root);
    }
    const isDomainAffined = (filePath: string): boolean => {
      const root = getDomainRoot(filePath);
      if (!root) return false;
      if (changedDomainRoots.has(root)) return true;
      if (root === 'tests' && changedDomainRoots.has('app')) return true;
      if (root === 'app' && changedDomainRoots.has('tests')) return true;
      if (
        (root === 'tests' || root === 'test' || root === '__tests__')
        && (changedDomainRoots.has('src') || changedDomainRoots.has('lib'))
      ) return true;
      if (
        (root === 'src' || root === 'lib')
        && (changedDomainRoots.has('tests') || changedDomainRoots.has('test') || changedDomainRoots.has('__tests__'))
      ) return true;
      return false;
    };
    const getSuggestedTestAffinity = (filePath: string): number => {
      const fp = normalizePath(filePath);
      if (!fp) return 0;
      let best = 0;
      for (const targetPath of suggestedTestTargetPaths) {
        const affinity = pathAffinity(fp, targetPath);
        if (affinity > best) best = affinity;
      }
      return round3(best);
    };
    const isHighSignalSuggestedTest = (entry: any): boolean => {
      const filePath = normalizePath(String(entry?.filePath || ''));
      if (!filePath) return false;
      if (changedTestFileSet.has(filePath)) return true;
      const reasons = Array.isArray(entry?.meta?.reasons) ? entry.meta.reasons : [];
      return reasons.some((reason: string) => {
        const text = String(reason || '').toLowerCase();
        return text.includes('direct caller')
          || text.includes('imports changed file');
      });
    };

    let suggestedTestsSuppressedLowRank = 0;
    let suggestedTestsSuppressedLowAffinity = 0;
    const suggestedTestsFiltered = suggestedTestsRanked.filter(entry => {
      const filePath = normalizePath(String(entry?.filePath || ''));
      if (!filePath) return false;
      if (changedTestFileSet.has(filePath)) return true;

      const rank = toFiniteNumber(entry?.rank, 0);
      const highSignal = isHighSignalSuggestedTest(entry);

      if (!highSignal && rank < SUGGESTED_TEST_MIN_RANK) {
        suggestedTestsSuppressedLowRank += 1;
        return false;
      }

      if (!highSignal) {
        const domainMatch = isDomainAffined(filePath);
        const affinity = domainMatch ? 1 : getSuggestedTestAffinity(filePath);
        if (!domainMatch && affinity < SUGGESTED_TEST_MIN_AFFINITY) {
          suggestedTestsSuppressedLowAffinity += 1;
          return false;
        }
      }

      return true;
    });

    const suggested_tests = suggestedTestsFiltered
      .slice(0, limitTests)
      .map(entry => {
        const filePath = entry.filePath;
        const convergenceScore = toFiniteNumber(entry?.signal?.score, 0);
        return {
          filePath,
          score: round3(entry.rank),
          reasons: entry.meta.reasons,
          ranking: {
            score: round3(entry.rank),
            components: entry.rank_components,
          },
          ...(convergenceScore > 0
            ? {
                convergence: {
                  score: round3(convergenceScore),
                  cluster: String(entry?.signal?.cluster || '').trim(),
                  signature: String(entry?.signal?.signature || '').trim(),
                  route: String(entry?.signal?.route || '').trim(),
                },
              }
            : {}),
          ...buildSuggestedTestCommand(filePath),
        };
      });

    const test_commands = Array.from(new Map(
      suggested_tests.map(test => {
        const cwd = String(test?.cwd || '.').trim() || '.';
        const command = String(test?.command || '').trim();
        return [`${cwd}::${command}`, { cwd, command }];
      }),
    ).values());
    const scopeFallbackSuggestedTests = suggested_tests
      .filter(test => (Array.isArray(test?.reasons) ? test.reasons : []).some((reason: string) => String(reason).includes('scope fallback token proximity')))
      .length;
    const isRegressionCandidateTest = (test: any): boolean => {
      const filePath = normalizePath(String(test?.filePath || ''));
      if (changedTestFileSet.has(filePath)) return true;
      const reasons = Array.isArray(test?.reasons) ? test.reasons : [];
      return reasons.some(reason => {
        const text = String(reason || '').toLowerCase();
        return text.includes('direct caller')
          || text.includes('imports changed file');
      });
    };
    const regressionCandidateTests = suggested_tests
      .filter(test => isRegressionCandidateTest(test))
      .map(test => String(test?.filePath || ''))
      .filter(Boolean);
    const baselineWatchlistTests = suggested_tests
      .filter(test => !isRegressionCandidateTest(test))
      .map(test => String(test?.filePath || ''))
      .filter(Boolean);
    const test_intelligence = {
      mode: 'changed-vs-baseline-heuristic',
      baseline_ref: scope === 'compare' ? (baseRef || 'merge-base') : 'HEAD',
      changed_test_files: Array.from(changedTestFileSet).sort(),
      regression_failure_candidates: regressionCandidateTests,
      preexisting_failure_candidates: baselineWatchlistTests,
      notes: [
        'Candidates are ranked from diff-coupling (changed test files and change-adjacent caller/import signals).',
        'Treat failures in regression_failure_candidates as likely regressions first; baseline candidates are likely pre-existing unless proven otherwise.',
      ],
    };

    const semanticGapSliceIds = new Set<string>();
    const slice_stencil = buildEmptySliceStencil();
    if (includeSliceStencil && changedSymbolIds.length > 0) {
      try {
        const changedSymbolIdsCypher = `[${changedSymbolIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ')}]`;

        const sliceRows = await executeQuery(repo.id, `
          MATCH (n)-[r:CodeRelation {type: 'MEMBER_OF'}]->(s:FeatureSlice)
          WHERE n.id IN ${changedSymbolIdsCypher}
            AND r.reason STARTS WITH 'feature-slice:'
          RETURN
            s.id AS sliceId,
            s.label AS sliceLabel,
            s.heuristicLabel AS heuristicLabel,
            s.sliceType AS sliceType,
            s.anchorId AS anchorId,
            s.anchorName AS anchorName,
            s.closureScore AS closureScore,
            s.closureSlots AS closureSlots,
            s.closedSlots AS closedSlots,
            n.id AS memberId,
            n.name AS memberName,
            labels(n) AS memberKind,
            n.filePath AS memberFilePath,
            n.startLine AS memberStartLine,
            n.endLine AS memberEndLine,
            r.reason AS memberRoleReason
          LIMIT 4000
        `);

        const parseSliceRole = (reason: string): string => {
          const raw = String(reason || '').trim();
          if (!raw) return '';
          if (!raw.startsWith('feature-slice:')) return raw;
          return raw.slice('feature-slice:'.length).trim();
        };

        const toPrimaryLabel = (value: any): string => {
          if (Array.isArray(value)) return String(value[0] || '').trim();
          return String(value || '').trim();
        };

        const changedSliceMap = new Map<string, {
          id: string;
          label: string;
          heuristicLabel: string;
          sliceType: string;
          anchorId: string;
          anchorName: string;
          closureScore: number;
          closureSlots: string[];
          closedSlots: string[];
          roles: Set<string>;
          changedMembers: Array<{
            uid: string;
            name: string;
            kind: string;
            filePath: string;
            role: string;
            startLine?: number;
            endLine?: number;
          }>;
          gapSignals: {
            total: number;
            deterministic: number;
            pattern: number;
            heuristic: number;
            high: number;
            medium: number;
            low: number;
          };
          template: null | {
            id: string;
            template_key: string;
            slice_type: string;
            required_slots: string[];
            optional_slots: string[];
            role_expectations: Array<{ role: string; coverage: number; count: number }>;
            avg_closure_score: number;
            slice_count: number;
            exemplar_slice_ids: string[];
          };
          stencilDelta: {
            missing_required_slots: string[];
            missing_roles: string[];
            closure_score_delta: number;
          };
          siblingPrecedents: Array<{
            id: string;
            label: string;
            anchor_name: string;
            closure_score: number;
            shared_closed_slots: string[];
            shared_roles: string[];
          }>;
          memberSeen: Set<string>;
        }>();

        for (const row of sliceRows) {
          const sliceId = String(row.sliceId ?? row[0] ?? '').trim();
          if (!sliceId) continue;

          let entry = changedSliceMap.get(sliceId);
          if (!entry) {
            entry = {
              id: sliceId,
              label: String(row.sliceLabel ?? row[1] ?? '').trim(),
              heuristicLabel: String(row.heuristicLabel ?? row[2] ?? '').trim(),
              sliceType: String(row.sliceType ?? row[3] ?? '').trim(),
              anchorId: String(row.anchorId ?? row[4] ?? '').trim(),
              anchorName: String(row.anchorName ?? row[5] ?? '').trim(),
              closureScore: toFiniteNumber(row.closureScore ?? row[6], 0),
              closureSlots: normalizeSliceStencilTokens(parseStringList(row.closureSlots)),
              closedSlots: normalizeSliceStencilTokens(parseStringList(row.closedSlots)),
              roles: new Set<string>(),
              changedMembers: [],
              gapSignals: {
                total: 0,
                deterministic: 0,
                pattern: 0,
                heuristic: 0,
                high: 0,
                medium: 0,
                low: 0,
              },
              template: null,
              stencilDelta: {
                missing_required_slots: [],
                missing_roles: [],
                closure_score_delta: 0,
              },
              siblingPrecedents: [],
              memberSeen: new Set<string>(),
            };
            changedSliceMap.set(sliceId, entry);
          }

          const role = parseSliceRole(String(row.memberRoleReason ?? row[15] ?? '').trim());
          if (role) entry.roles.add(role);
          const memberId = String(row.memberId ?? row[9] ?? '').trim();
          if (!memberId) continue;
          const startLine = toOptionalLineNumber(row.memberStartLine ?? row[13]);
          const endLine = toOptionalLineNumber(row.memberEndLine ?? row[14]);
          const memberFilePath = String(row.memberFilePath ?? row[12] ?? '').trim();
          const memberKey = `${memberId}|${role}|${memberFilePath}`;
          if (entry.memberSeen.has(memberKey)) continue;
          entry.memberSeen.add(memberKey);

          entry.changedMembers.push({
            uid: memberId,
            name: String(row.memberName ?? row[10] ?? '').trim(),
            kind: toPrimaryLabel(row.memberKind ?? row[11]),
            filePath: memberFilePath,
            role,
            ...(startLine !== undefined ? { startLine } : {}),
            ...(endLine !== undefined ? { endLine } : {}),
          });
        }

        const allChangedSliceIds = Array.from(changedSliceMap.keys());
        for (const sliceId of allChangedSliceIds) semanticGapSliceIds.add(sliceId);
        const changedSliceIds = allChangedSliceIds.slice(0, limitSliceStencil);
        if (changedSliceIds.length > 0) {
          const changedSliceIdsCypher = `[${changedSliceIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ')}]`;

          const sliceRoleRows = await executeQuery(repo.id, `
            MATCH (n)-[r:CodeRelation {type: 'MEMBER_OF'}]->(s:FeatureSlice)
            WHERE s.id IN ${changedSliceIdsCypher}
              AND r.reason STARTS WITH 'feature-slice:'
            RETURN s.id AS sliceId,
                   COUNT(DISTINCT n.id) AS memberCount,
                   collect(DISTINCT r.reason) AS memberRoleReasons
            LIMIT 5000
          `);

          const memberCountBySlice = new Map<string, number>();
          for (const row of sliceRoleRows) {
            const sliceId = String(row.sliceId ?? row[0] ?? '').trim();
            if (!sliceId) continue;
            const entry = changedSliceMap.get(sliceId);
            if (!entry) continue;
            const memberCount = toFiniteNumber(row.memberCount ?? row[1], 0);
            if (memberCount > 0) memberCountBySlice.set(sliceId, memberCount);
            const reasons = Array.isArray(row.memberRoleReasons) ? row.memberRoleReasons : [];
            for (const reason of reasons) {
              const role = parseSliceRole(String(reason || '').trim());
              if (role) entry.roles.add(role);
            }
          }

          const gapRows = await executeQuery(repo.id, `
            MATCH (g:Gap)-[:CodeRelation {type: 'MEMBER_OF'}]->(s:FeatureSlice)
            WHERE s.id IN ${changedSliceIdsCypher}
            RETURN DISTINCT s.id AS sliceId, g.absenceTier AS absenceTier, g.severity AS severity
            LIMIT 2000
          `);

          for (const row of gapRows) {
            const sliceId = String(row.sliceId ?? row[0] ?? '').trim();
            const absenceTier = String(row.absenceTier ?? row[1] ?? '').trim();
            const severity = String(row.severity ?? row[2] ?? '').trim();
            const entry = changedSliceMap.get(sliceId);
            if (!entry) continue;

            entry.gapSignals.total += 1;
            if (absenceTier === 'deterministic_missing') entry.gapSignals.deterministic += 1;
            else if (absenceTier === 'pattern_missing') entry.gapSignals.pattern += 1;
            else if (absenceTier === 'heuristic_suspicion') entry.gapSignals.heuristic += 1;

            if (severity === 'high') entry.gapSignals.high += 1;
            else if (severity === 'medium') entry.gapSignals.medium += 1;
            else if (severity === 'low') entry.gapSignals.low += 1;
          }

          const closureSnapshot = await loadClosureTemplateSnapshot(repo.storagePath);
          const templatesBySliceType = new Map<string, Array<typeof closureSnapshot.templates[number]>>();
          for (const template of Array.isArray(closureSnapshot.templates) ? closureSnapshot.templates : []) {
            const key = String(template?.sliceType || '').trim();
            if (!key) continue;
            const list = templatesBySliceType.get(key) || [];
            list.push(template);
            templatesBySliceType.set(key, list);
          }

          const candidateSiblingIds = new Set<string>();
          for (const sliceId of changedSliceIds) {
            const entry = changedSliceMap.get(sliceId);
            if (!entry) continue;

            const templates = templatesBySliceType.get(entry.sliceType) || [];
            const closedSlotSet = new Set(entry.closedSlots);
            const roleSet = new Set(Array.from(entry.roles));

            let bestTemplate: any = null;
            let bestScore = -1;
            for (const template of templates) {
              const requiredSlots = normalizeSliceStencilTokens(parseStringList(template.requiredSlots));
              const roleExpectations = Array.isArray(template.roleCoverage) ? template.roleCoverage : [];
              const templateRoles = roleExpectations.map((role: any) => String(role?.role || '').trim()).filter(Boolean);
              const requiredHits = requiredSlots.filter(slot => closedSlotSet.has(slot)).length;
              const roleHits = templateRoles.filter(role => roleSet.has(role)).length;

              const requiredScore = requiredSlots.length > 0 ? (requiredHits / requiredSlots.length) : 1;
              const roleScore = templateRoles.length > 0 ? (roleHits / templateRoles.length) : 1;
              const score = (requiredScore * 0.7) + (roleScore * 0.3) + (toFiniteNumber(template.sliceCount, 0) * 0.0001);
              if (score > bestScore) {
                bestScore = score;
                bestTemplate = template;
              }
            }

            if (!bestTemplate) continue;

            const requiredSlots = normalizeSliceStencilTokens(parseStringList(bestTemplate.requiredSlots));
            const optionalSlots = normalizeSliceStencilTokens(parseStringList(bestTemplate.optionalSlots));
            const roleExpectations = Array.isArray(bestTemplate.roleCoverage)
              ? bestTemplate.roleCoverage
                .map((item: any) => ({
                  role: String(item?.role || '').trim(),
                  coverage: toFiniteNumber(item?.coverage, 0),
                  count: toFiniteNumber(item?.count, 0),
                }))
                .filter((item: any) => item.role)
              : [];
            const expectedRoles = roleExpectations
              .filter((item: any) => item.coverage >= 0.5)
              .map((item: any) => item.role);
            const exemplarSliceIds = Array.isArray(bestTemplate.exemplarSliceIds)
              ? bestTemplate.exemplarSliceIds.map((value: any) => String(value || '').trim()).filter(Boolean)
              : [];

            entry.template = {
              id: String(bestTemplate.id || '').trim(),
              template_key: String(bestTemplate.templateKey || '').trim(),
              slice_type: String(bestTemplate.sliceType || '').trim(),
              required_slots: requiredSlots,
              optional_slots: optionalSlots,
              role_expectations: roleExpectations,
              avg_closure_score: toFiniteNumber(bestTemplate.avgClosureScore, 0),
              slice_count: toFiniteNumber(bestTemplate.sliceCount, 0),
              exemplar_slice_ids: exemplarSliceIds,
            };

            entry.stencilDelta = {
              missing_required_slots: requiredSlots.filter(slot => !closedSlotSet.has(slot)),
              missing_roles: expectedRoles.filter(role => !roleSet.has(role)),
              closure_score_delta: round3(toFiniteNumber(bestTemplate.avgClosureScore, 0) - entry.closureScore),
            };

            for (const siblingId of exemplarSliceIds) {
              if (!siblingId || siblingId === entry.id) continue;
              candidateSiblingIds.add(siblingId);
            }
          }

          const siblingList = Array.from(candidateSiblingIds);
          const siblingDetailsById = new Map<string, {
            id: string;
            label: string;
            heuristicLabel: string;
            anchorName: string;
            closureScore: number;
            closedSlots: string[];
            roles: Set<string>;
          }>();

          if (siblingList.length > 0) {
            const siblingIdsCypher = `[${siblingList.map(id => `'${id.replace(/'/g, "''")}'`).join(', ')}]`;

            const siblingRows = await executeQuery(repo.id, `
              MATCH (s:FeatureSlice)
              WHERE s.id IN ${siblingIdsCypher}
              OPTIONAL MATCH (n)-[r:CodeRelation {type: 'MEMBER_OF'}]->(s)
              WHERE r.reason STARTS WITH 'feature-slice:'
              RETURN s.id AS id,
                     s.label AS label,
                     s.heuristicLabel AS heuristicLabel,
                     s.anchorName AS anchorName,
                     s.closureScore AS closureScore,
                     s.closedSlots AS closedSlots,
                     collect(DISTINCT r.reason) AS memberRoleReasons
              LIMIT 2000
            `);

            for (const row of siblingRows) {
              const siblingId = String(row.id ?? row[0] ?? '').trim();
              if (!siblingId) continue;
              siblingDetailsById.set(siblingId, {
                id: siblingId,
                label: String(row.label ?? row[1] ?? '').trim(),
                heuristicLabel: String(row.heuristicLabel ?? row[2] ?? '').trim(),
                anchorName: String(row.anchorName ?? row[3] ?? '').trim(),
                closureScore: toFiniteNumber(row.closureScore ?? row[4], 0),
                closedSlots: normalizeSliceStencilTokens(parseStringList(row.closedSlots)),
                roles: new Set<string>(),
              });
              const reasons = Array.isArray(row.memberRoleReasons) ? row.memberRoleReasons : [];
              const sibling = siblingDetailsById.get(siblingId);
              if (sibling) {
                for (const reason of reasons) {
                  const role = parseSliceRole(String(reason || '').trim());
                  if (role) sibling.roles.add(role);
                }
              }
            }
          }

          const rankedSlices = changedSliceIds
            .map(sliceId => changedSliceMap.get(sliceId))
            .filter((entry): entry is NonNullable<typeof entry> => !!entry)
            .sort((left, right) => {
              if (right.gapSignals.high !== left.gapSignals.high) return right.gapSignals.high - left.gapSignals.high;
              if (right.stencilDelta.missing_required_slots.length !== left.stencilDelta.missing_required_slots.length) {
                return right.stencilDelta.missing_required_slots.length - left.stencilDelta.missing_required_slots.length;
              }
              return left.id.localeCompare(right.id);
            })
            .slice(0, limitSliceStencil);

          for (const entry of rankedSlices) {
            const closedSlotSet = new Set(entry.closedSlots);
            const roleSet = new Set(Array.from(entry.roles));
            const siblingCandidates = entry.template
              ? entry.template.exemplar_slice_ids
              : [];

            const sibling_precedents = siblingCandidates
              .map((siblingId: string) => siblingDetailsById.get(String(siblingId || '').trim()))
              .filter((item): item is NonNullable<typeof item> => !!item)
              .map(sibling => {
                const sharedClosedSlots = sibling.closedSlots.filter(slot => closedSlotSet.has(slot));
                const siblingRoles = Array.from(sibling.roles);
                const sharedRoles = siblingRoles.filter(role => roleSet.has(role));
                return {
                  id: sibling.id,
                  label: sibling.label || sibling.heuristicLabel || sibling.id,
                  anchor_name: sibling.anchorName,
                  closure_score: round3(sibling.closureScore),
                  shared_closed_slots: sharedClosedSlots.slice(0, 8),
                  shared_roles: sharedRoles.slice(0, 8),
                  __rank: sharedClosedSlots.length + sharedRoles.length + sibling.closureScore,
                };
              })
              .sort((left, right) => right.__rank - left.__rank)
              .slice(0, 3)
              .map(({ __rank, ...rest }) => rest);

            entry.siblingPrecedents = sibling_precedents;

            slice_stencil.slices.push({
              slice: {
                id: entry.id,
                label: entry.label || entry.heuristicLabel || entry.id,
                heuristicLabel: entry.heuristicLabel,
                sliceType: entry.sliceType,
                anchorId: entry.anchorId,
                anchorName: entry.anchorName,
                closureScore: round3(entry.closureScore),
                closureSlots: entry.closureSlots,
                closedSlots: entry.closedSlots,
                roles: Array.from(entry.roles).sort(),
                changed_member_count: (memberCountBySlice.get(entry.id) || entry.changedMembers.length),
              },
              changed_members: entry.changedMembers.slice(0, 12),
              template: entry.template,
              stencil_delta: entry.stencilDelta,
              sibling_precedents,
              gap_signals: entry.gapSignals,
            });
          }

          slice_stencil.updated_at = String(closureSnapshot.generatedAt || '');
          slice_stencil.summary = {
            changed_slices: slice_stencil.slices.length,
            with_templates: slice_stencil.slices.filter(item => !!item.template).length,
            missing_required_slot_slices: slice_stencil.slices.filter(item => item.stencil_delta.missing_required_slots.length > 0).length,
            missing_role_slices: slice_stencil.slices.filter(item => item.stencil_delta.missing_roles.length > 0).length,
            sibling_candidates: slice_stencil.slices.reduce((sum, item) => sum + item.sibling_precedents.length, 0),
          };
        }
      } catch {
        // best-effort slice stencil enrichment
      }
    }

    const semanticFamilyOrder: SemanticFamily[] = ['auth', 'shape', 'cache', 'test', 'event', 'template'];
    const semantic_diffs = buildEmptySemanticDiffs();
    let proof_pack = buildEmptyProofPack();

    if (changedSymbolIds.length > 0) {
      const pickPrimaryLabel = (value: any): string => {
        if (Array.isArray(value)) return String(value[0] || '').trim();
        return String(value || '').trim();
      };

      const classifySemanticFamily = (edge: {
        type: string;
        reason: string;
        sourceName: string;
        targetName: string;
        sourceFilePath: string;
        targetFilePath: string;
      }): SemanticFamily | null => {
        const type = String(edge.type || '').trim().toUpperCase();
        const reason = String(edge.reason || '').trim().toLowerCase();
        const sourceName = String(edge.sourceName || '').trim().toLowerCase();
        const targetName = String(edge.targetName || '').trim().toLowerCase();
        const sourceFilePath = String(edge.sourceFilePath || '').trim();
        const targetFilePath = String(edge.targetFilePath || '').trim();

        if (type === 'TESTS_SHAPE') return 'test';
        if (type === 'VALIDATES_FIELD' || type === 'SERIALIZES_FIELD' || type === 'READS_FIELD' || type === 'WRITES_FIELD' || type === 'DERIVES_FROM_COLUMN') return 'shape';
        if (type === 'INVALIDATES_KEY' || reason.startsWith('react-query-key:') || reason.startsWith('micro-dataflow:query-invalidation')) return 'cache';

        const hasPermissionSignal = (
          sourceName.startsWith('permission:')
          || targetName.startsWith('permission:')
          || reason.includes('permission')
          || reason.startsWith('laravel-authorize:')
          || reason.startsWith('laravel-gate:')
          || reason.startsWith('laravel-can:')
          || reason.startsWith('laravel-route-middleware:can:')
        );
        if (hasPermissionSignal) return 'auth';

        if (
          reason.startsWith('laravel-event')
          || reason.startsWith('laravel-job-dispatch')
          || reason.startsWith('laravel-notify')
          || reason.startsWith('laravel-tactician-dispatch')
          || reason.startsWith('laravel-tactician-pipeline')
          || reason.startsWith('micro-dataflow:event-chain')
        ) {
          return 'event';
        }

        if (
          reason.startsWith('blade-')
          || reason.startsWith('mjml-')
          || reason.startsWith('laravel-view-mail')
          || reason.startsWith('template-method-call')
        ) {
          return 'template';
        }

        if (isTestFilePath(sourceFilePath) || isTestFilePath(targetFilePath)) return 'test';
        return null;
      };

      try {
        const semanticIdsCypher = buildCypherStringList(changedSymbolIds);
        const semanticTypeFilter = "['CALLS','IMPORTS','TESTS_SHAPE','VALIDATES_FIELD','SERIALIZES_FIELD','READS_FIELD','WRITES_FIELD','DERIVES_FROM_COLUMN','INVALIDATES_KEY']";
        const semanticLimit = Math.max(1200, Math.min(6000, changedSymbolIds.length * 40));
        const loadSemanticRows = async (restrictToHighSignalTypes: boolean): Promise<any[]> => {
          return executeQuery(repo.id, `
            MATCH (a)-[r:CodeRelation]->(b)
            WHERE r.confidence >= ${minConfidence}
              AND (a.id IN ${semanticIdsCypher} OR b.id IN ${semanticIdsCypher})
              ${restrictToHighSignalTypes ? `AND r.type IN ${semanticTypeFilter}` : ''}
            RETURN
              a.id AS sourceId,
              a.name AS sourceName,
              labels(a) AS sourceKind,
              a.filePath AS sourceFilePath,
              b.id AS targetId,
              b.name AS targetName,
              labels(b) AS targetKind,
              b.filePath AS targetFilePath,
              r.type AS relType,
              r.reason AS reason,
              r.confidence AS confidence,
              r.id AS edgeId,
              r.witnessPathIds AS witnessPathIds
            LIMIT ${semanticLimit}
          `);
        };

        let semanticRows: any[] = [];
        try {
          semanticRows = await loadSemanticRows(true);
        } catch {
          semanticRows = [];
        }
        if (semanticRows.length === 0) {
          try {
            semanticRows = await loadSemanticRows(false);
          } catch {
            semanticRows = [];
          }
        }

        const familyStats = new Map<SemanticFamily, {
        family: SemanticFamily;
        edge_count: number;
        incoming_edges: number;
        outgoing_edges: number;
        changed_symbol_ids: Set<string>;
        reasonCounts: Map<string, number>;
        sample_edges: Array<{
          source: { uid: string; name: string; kind: string; filePath: string };
          target: { uid: string; name: string; kind: string; filePath: string };
          edge: { id: string; type: string; reason: string; confidence: number; witnessPathIds: string[] };
          direction: 'incoming' | 'outgoing' | 'internal';
        }>;
      }>();

        for (const raw of semanticRows) {
        const sourceId = String(raw.sourceId ?? raw[0] ?? '').trim();
        const targetId = String(raw.targetId ?? raw[4] ?? '').trim();
        if (!sourceId || !targetId) continue;

        const relType = String(raw.relType ?? raw[8] ?? '').trim();
        const reason = String(raw.reason ?? raw[9] ?? '').trim();
        const sourceName = String(raw.sourceName ?? raw[1] ?? '').trim();
        const targetName = String(raw.targetName ?? raw[5] ?? '').trim();
        const sourceFilePath = String(raw.sourceFilePath ?? raw[3] ?? '').trim();
        const targetFilePath = String(raw.targetFilePath ?? raw[7] ?? '').trim();
        const confidence = normalizeConfidence(raw.confidence ?? raw[10], 1);
        const edgeId = String(raw.edgeId ?? raw[11] ?? '').trim();

        const family = classifySemanticFamily({
          type: relType,
          reason,
          sourceName,
          targetName,
          sourceFilePath,
          targetFilePath,
        });
        if (!family) continue;

        const sourceChanged = changedSymbolIdSet.has(sourceId);
        const targetChanged = changedSymbolIdSet.has(targetId);
        const direction: 'incoming' | 'outgoing' | 'internal' = sourceChanged && targetChanged
          ? 'internal'
          : sourceChanged
            ? 'outgoing'
            : 'incoming';

        const entry = familyStats.get(family) || {
          family,
          edge_count: 0,
          incoming_edges: 0,
          outgoing_edges: 0,
          changed_symbol_ids: new Set<string>(),
          reasonCounts: new Map<string, number>(),
          sample_edges: [],
        };

        entry.edge_count++;
        if (sourceChanged) {
          entry.outgoing_edges++;
          entry.changed_symbol_ids.add(sourceId);
        }
        if (targetChanged) {
          entry.incoming_edges++;
          entry.changed_symbol_ids.add(targetId);
        }

        const reasonKey = reason || relType || 'unknown';
        entry.reasonCounts.set(reasonKey, (entry.reasonCounts.get(reasonKey) || 0) + 1);

        if (entry.sample_edges.length < 5) {
          const witnessPathIds = parseWitnessPathIds(raw.witnessPathIds ?? raw[12]);
          entry.sample_edges.push({
            source: {
              uid: sourceId,
              name: sourceName,
              kind: pickPrimaryLabel(raw.sourceKind ?? raw[2]),
              filePath: sourceFilePath,
            },
            target: {
              uid: targetId,
              name: targetName,
              kind: pickPrimaryLabel(raw.targetKind ?? raw[6]),
              filePath: targetFilePath,
            },
            edge: {
              id: edgeId,
              type: relType,
              reason,
              confidence: Number.isFinite(confidence) ? confidence : 1,
              witnessPathIds,
            },
            direction,
          });
        }

          familyStats.set(family, entry);
        }

        const families = semanticFamilyOrder
          .map(family => familyStats.get(family))
          .filter((item): item is NonNullable<typeof item> => !!item)
          .map(item => ({
          family: item.family,
          edge_count: item.edge_count,
          changed_symbols: item.changed_symbol_ids.size,
          incoming_edges: item.incoming_edges,
          outgoing_edges: item.outgoing_edges,
          reasons: Array.from(item.reasonCounts.entries())
            .sort((left, right) => right[1] - left[1])
            .slice(0, 5)
            .map(([reasonValue, count]) => ({ reason: reasonValue, count })),
          sample_edges: item.sample_edges,
          }));

        const preferredSliceIds = Array.from(semanticGapSliceIds)
          .map(value => String(value || '').trim())
          .filter(Boolean)
          .slice(0, 300);
        const preferredSliceIdsCypher = buildCypherStringList(preferredSliceIds);

        let gapRows: any[] = [];
        if (preferredSliceIds.length > 0) {
          gapRows = await executeQuery(repo.id, `
            MATCH (g:Gap)-[:CodeRelation {type: 'MEMBER_OF'}]->(slice:FeatureSlice)
            WHERE slice.id IN ${preferredSliceIdsCypher}
            RETURN DISTINCT
              g.id AS id,
              g.gapType AS gapType,
              g.absenceTier AS absenceTier,
              g.severity AS severity,
              g.sliceId AS sliceId,
              g.anchorId AS anchorId,
              g.missingSlots AS missingSlots,
              g.evidence AS evidence
            LIMIT 100
          `);
        } else {
          gapRows = await executeQuery(repo.id, `
            MATCH (s)-[r:CodeRelation {type: 'MEMBER_OF'}]->(slice:FeatureSlice)
            WHERE s.id IN ${semanticIdsCypher}
              AND r.reason STARTS WITH 'feature-slice:'
            MATCH (g:Gap)-[:CodeRelation {type: 'MEMBER_OF'}]->(slice)
            RETURN DISTINCT
              g.id AS id,
              g.gapType AS gapType,
              g.absenceTier AS absenceTier,
              g.severity AS severity,
              g.sliceId AS sliceId,
              g.anchorId AS anchorId,
              g.missingSlots AS missingSlots,
              g.evidence AS evidence
            LIMIT 100
          `);
        }

        const gaps = gapRows.map((row: any) => ({
          id: String(row.id ?? row[0] ?? '').trim(),
          gapType: String(row.gapType ?? row[1] ?? '').trim(),
          absenceTier: String(row.absenceTier ?? row[2] ?? '').trim(),
          severity: String(row.severity ?? row[3] ?? '').trim(),
          sliceId: String(row.sliceId ?? row[4] ?? '').trim(),
          anchorId: String(row.anchorId ?? row[5] ?? '').trim(),
          missingSlots: Array.isArray(row.missingSlots) ? row.missingSlots.map((item: any) => String(item || '')).filter(Boolean) : [],
          evidence: Array.isArray(row.evidence) ? row.evidence.map((item: any) => String(item || '')).filter(Boolean) : [],
        })).filter(gap => gap.id && gap.gapType);

        semantic_diffs.summary.touched_edges = families.reduce((sum, family) => sum + family.edge_count, 0);
        semantic_diffs.summary.family_count = families.length;
        semantic_diffs.summary.gap_signals = gaps.length;
        semantic_diffs.families = families;
        semantic_diffs.gap_signals = {
          total: gaps.length,
          deterministic: gaps.filter(gap => gap.absenceTier === 'deterministic_missing').length,
          pattern: gaps.filter(gap => gap.absenceTier === 'pattern_missing').length,
          heuristic: gaps.filter(gap => gap.absenceTier === 'heuristic_suspicion').length,
          high: gaps.filter(gap => gap.severity === 'high').length,
          medium: gaps.filter(gap => gap.severity === 'medium').length,
          low: gaps.filter(gap => gap.severity === 'low').length,
          gaps: gaps.slice(0, 20),
        };
      } catch {
        // best-effort enrichment
      }
    }

    if (includeEvidenceSpans) {
      try {
        const snapshot = await loadEvidenceSpanSnapshot(repo.storagePath);
        const evidenceLookup = getEvidenceSpanLookup(snapshot);
        const nodeEvidenceById = evidenceLookup.nodesById;
        const edgeEvidenceById = evidenceLookup.edgesById;

        const symbols = changedSymbols
          .map(sym => {
            const uid = String(sym?.uid || '').trim();
            if (!uid) return null;
            const evidence = nodeEvidenceById.get(uid);
            if (!evidence) return null;
            return {
              symbol: {
                uid,
                name: String(sym?.name || ''),
                kind: String(sym?.kind || ''),
                filePath: String(sym?.filePath || ''),
                ...(toOptionalLineNumber(sym?.startLine) !== undefined ? { startLine: toOptionalLineNumber(sym?.startLine) } : {}),
                ...(toOptionalLineNumber(sym?.endLine) !== undefined ? { endLine: toOptionalLineNumber(sym?.endLine) } : {}),
              },
              primary_span: evidence.primarySpan || null,
              witness_spans: Array.isArray(evidence.witnessSpans) ? evidence.witnessSpans : [],
              proof_spans: Array.isArray(evidence.proofSpans) ? evidence.proofSpans : [],
            };
          })
          .filter((item): item is NonNullable<typeof item> => !!item)
          .slice(0, limitEvidence);

        const semanticEdgeRefs = semantic_diffs.families.flatMap(family => (
          family.sample_edges.map(sample => ({
            family: family.family,
            source: sample.source,
            target: sample.target,
            edge: sample.edge,
          }))
        ));

        const seenEdgeIds = new Set<string>();
        const edges: typeof proof_pack.edges = [];
        for (const ref of semanticEdgeRefs) {
          const edgeId = String(ref?.edge?.id || '').trim();
          if (!edgeId || seenEdgeIds.has(edgeId)) continue;
          seenEdgeIds.add(edgeId);
          const evidence = edgeEvidenceById.get(edgeId);
          if (!evidence) continue;

          edges.push({
            family: ref.family,
            source: ref.source,
            target: ref.target,
            edge: {
              id: edgeId,
              type: String(ref.edge?.type || ''),
              reason: String(ref.edge?.reason || ''),
              confidence: normalizeConfidence(ref.edge?.confidence, 1),
              witness_path_ids: Array.isArray(ref.edge?.witnessPathIds) ? ref.edge.witnessPathIds : [],
            },
            witness_spans: Array.isArray(evidence.witnessSpans) ? evidence.witnessSpans : [],
            proof_spans: Array.isArray(evidence.proofSpans) ? evidence.proofSpans : [],
          });

          if (edges.length >= limitEvidence) break;
        }

        const witnessSpans = symbols.reduce((sum, item) => sum + item.witness_spans.length, 0)
          + edges.reduce((sum, item) => sum + item.witness_spans.length, 0);
        const proofSpans = symbols.reduce((sum, item) => sum + item.proof_spans.length, 0)
          + edges.reduce((sum, item) => sum + item.proof_spans.length, 0);

        proof_pack = {
          updated_at: String(snapshot.generatedAt || ''),
          summary: {
            symbol_spans: symbols.length,
            edge_spans: edges.length,
            witness_spans: witnessSpans,
            proof_spans: proofSpans,
          },
          symbols,
          edges,
        };
      } catch {
        proof_pack = buildEmptyProofPack();
      }
    }

    const ui_contracts: any[] = [];
    if (includeUiContracts && maxUiContractFiles > 0) {
      const baseRefForUi = scope === 'compare' ? baseRef : 'HEAD';

      const isUiFile = (p: string): boolean => {
        const lower = p.toLowerCase();
        return lower.endsWith('.tsx') || lower.endsWith('.jsx') || lower.endsWith('.ts') || lower.endsWith('.js');
      };

      const rankUiFile = (p: string): number => {
        const lower = p.toLowerCase();
        if (lower.endsWith('.tsx') || lower.endsWith('.jsx')) return 2;
        if (lower.endsWith('.ts') || lower.endsWith('.js')) return 1;
        return 0;
      };

      const uiFiles = changedFileObjs
        .map(f => normalizePath(f.filePath))
        .filter(Boolean)
        .filter(fp => isInScope(fp))
        .filter(fp => isUiFile(fp))
        .sort((a, b) => rankUiFile(b) - rankUiFile(a))
        .slice(0, maxUiContractFiles);
      const uiResults = await Promise.all(
        uiFiles.map(async (filePath) => {
          const res = await uiContract(repo, {
            file_path: filePath,
            base_ref: baseRefForUi,
            include_endpoints: true,
            min_http_confidence: minConfidence,
          });

          if (res?.error) {
            return { filePath, error: res.error };
          }

          return {
            filePath: res.file_path || filePath,
            diff: res.diff || null,
            smells: Array.isArray(res?.contract?.smells) ? res.contract.smells : [],
            effects_summary: res?.contract?.effectsSummary || null,
            endpoints: Array.isArray(res?.endpoints) ? res.endpoints : [],
          };
        }),
      );
      ui_contracts.push(...uiResults);
    }

    const ROUTE_FILE_PATH_RE = /(^|\/)routes\/[^/]+\.php$/i;
    const route_targets: any[] = [];
    const routeFilesWithEndpointSurfaces = new Set<string>();
    const routeFiles = changedFileObjs
      .map(file => normalizePath(file.filePath))
      .filter(filePath => !!filePath)
      .filter(filePath => isInScope(filePath))
      .filter((filePath, index, arr) => arr.indexOf(filePath) === index)
      .filter(filePath => !changedFileObjs.find(file => normalizePath(file.filePath) === filePath && file.status === 'Deleted'))
      .filter(filePath => ROUTE_FILE_PATH_RE.test(filePath));

    if (routeFiles.length > 0) {
      const routeFilesCypher = `[${routeFiles.map(filePath => `'${filePath.replace(/'/g, "''")}'`).join(', ')}]`;
      let routeRows: any[] = [];
      try {
        routeRows = await executeQuery(repo.id, `
          MATCH (f)-[r:CodeRelation {type: 'CALLS'}]->(m:Method)
          WHERE f.filePath IN ${routeFilesCypher}
            AND r.reason CONTAINS 'laravel-route'
          OPTIONAL MATCH (m)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Class)
          RETURN f.filePath AS routeFilePath,
                 m.id AS uid, m.name AS name, m.filePath AS filePath, m.startLine AS startLine,
                 c.name AS className,
                 r.confidence AS confidence, r.reason AS reason
          ORDER BY f.filePath ASC, r.confidence DESC
          LIMIT ${Math.max(100, Math.min(10000, routeFiles.length * 120))}
        `);
      } catch {
        routeRows = [];
      }

      try {
        const routeEndpointRows = await executeQuery(repo.id, `
          MATCH (c:CodeElement)
          WHERE c.filePath IN ${routeFilesCypher}
            AND c.name STARTS WITH 'endpoint:'
          RETURN DISTINCT c.filePath AS routeFilePath
          LIMIT ${Math.max(40, Math.min(2000, routeFiles.length * 20))}
        `);
        for (const row of routeEndpointRows) {
          const routeFilePath = normalizePath(String(row.routeFilePath || row[0] || ''));
          if (routeFilePath) routeFilesWithEndpointSurfaces.add(routeFilePath);
        }
      } catch {
        // best-effort endpoint-surface hint
      }

      const rowsByRouteFile = new Map<string, any[]>();
      for (const row of routeRows) {
        const routeFilePath = normalizePath(String(row.routeFilePath || row[0] || ''));
        if (!routeFilePath) continue;
        const list = rowsByRouteFile.get(routeFilePath) || [];
        list.push(row);
        rowsByRouteFile.set(routeFilePath, list);
      }

      for (const routeFilePath of routeFiles) {
        const rows = rowsByRouteFile.get(routeFilePath) || [];
        const targetByKey = new Map<string, any>();
        for (const row of rows) {
          const uid = String(row.uid || row[1] || '').trim();
          const reason = String(row.reason ?? row[7] ?? '').trim();
          if (!uid || !reason) continue;
          const key = `${uid}|${reason}`;
          const currentConfidence = normalizeConfidence(row.confidence ?? row[6], 1.0);
          const existing = targetByKey.get(key);
          if (existing && toFiniteNumber(existing?.edge?.confidence, 0) >= currentConfidence) continue;
          targetByKey.set(key, {
            controller: {
              uid,
              name: (() => {
                const base = row.name || row[2] || '';
                const cls = row.className || row[5] || '';
                return cls && base ? `${cls}::${base}` : base;
              })(),
              filePath: row.filePath || row[3] || '',
              startLine: row.startLine ?? row[4] ?? undefined,
              kind: 'Method',
            },
            edge: {
              confidence: currentConfidence,
              reason,
            },
          });
        }
        const targets = Array.from(targetByKey.values());

        route_targets.push({
          route_file: routeFilePath,
          targets,
        });
      }
    }

    const normalizeObservedRoute = (value: string): string => {
      let raw = String(value || '').trim();
      if (!raw) return '';
      if (/^https?:\/\//i.test(raw)) {
        try {
          const parsed = new URL(raw);
          raw = parsed.pathname || raw;
        } catch {
          // keep original
        }
      }
      raw = raw.split('?')[0].split('#')[0];
      try {
        raw = decodeURIComponent(raw);
      } catch {
        // keep original
      }
      raw = raw.replace(/\/{2,}/g, '/');
      if (!raw.startsWith('/')) raw = `/${raw}`;
      return raw.replace(/\/+$/, '') || '/';
    };

    const routePatternToRegex = (pattern: string): RegExp | null => {
      const normalized = normalizeObservedRoute(pattern);
      if (!normalized) return null;

      if (normalized === '/') return /^\/$/;

      const escapeRegex = (value: string): string => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const segments = normalized.replace(/^\/+/, '').split('/').filter(Boolean);
      let patternSrc = '^';
      for (const segment of segments) {
        if (segment === '*') {
          patternSrc += '/[^/]+';
          continue;
        }

        const placeholderMatch = segment.match(/^\{(.+)\}$/);
        if (!placeholderMatch) {
          patternSrc += `/${escapeRegex(segment)}`;
          continue;
        }

        let inner = String(placeholderMatch[1] || '').trim();
        let optional = false;
        let wildcard = false;
        if (inner.endsWith('?')) {
          optional = true;
          inner = inner.slice(0, -1);
        }
        if (inner.endsWith('*')) {
          wildcard = true;
          inner = inner.slice(0, -1);
        }

        const colonIdx = inner.indexOf(':');
        const constraint = colonIdx >= 0 ? inner.slice(colonIdx + 1).trim() : '';
        let partPattern = '[^/]+';
        if (wildcard) partPattern = '.+';
        else if (constraint) partPattern = constraint;

        if (optional) patternSrc += `(?:/${partPattern})?`;
        else patternSrc += `/${partPattern}`;
      }
      patternSrc += '/?$';

      try {
        return new RegExp(patternSrc);
      } catch {
        return null;
      }
    };

    const routePatterns: Array<{
      method: string;
      pattern: string;
      matcher: RegExp;
      route_file: string;
      controller: any;
      confidence: number;
      reason: string;
    }> = [];
    const getRouteFirstSegment = (routeValue: string): string => {
      return normalizeObservedRoute(routeValue).replace(/^\/+/, '').split('/').find(Boolean) || '';
    };
    const routePatternSeen = new Set<string>();
    for (const routeEntry of route_targets) {
      const routeFilePath = String(routeEntry?.route_file || '').trim();
      for (const target of Array.isArray(routeEntry?.targets) ? routeEntry.targets : []) {
        const reason = String(target?.edge?.reason || '').trim();
        const match = reason.match(/^laravel-route:([a-z]+):(.+)$/i);
        if (!match) continue;
        const method = String(match[1] || '').trim().toUpperCase();
        const normalizedPattern = normalizeObservedRoute(String(match[2] || '').trim());
        const matcher = routePatternToRegex(normalizedPattern);
        const controllerUid = String(target?.controller?.uid || '').trim();
        if (!method || !normalizedPattern || !matcher) continue;
        const dedupeKey = `${method}|${normalizedPattern}|${routeFilePath}|${controllerUid}`;
        if (routePatternSeen.has(dedupeKey)) continue;
        routePatternSeen.add(dedupeKey);
        routePatterns.push({
          method,
          pattern: normalizedPattern,
          matcher,
          route_file: routeFilePath,
          controller: target?.controller || null,
          confidence: normalizeConfidence(target?.edge?.confidence, 0.9),
          reason,
        });
      }
    }
    const routePatternsByMethod = new Map<string, Array<(typeof routePatterns)[number]>>();
    const routePatternsByMethodAndSegment = new Map<string, Map<string, Array<(typeof routePatterns)[number]>>>();
    const routePatternsByMethodGeneric = new Map<string, Array<(typeof routePatterns)[number]>>();
    for (const routePattern of routePatterns) {
      const list = routePatternsByMethod.get(routePattern.method) || [];
      list.push(routePattern);
      routePatternsByMethod.set(routePattern.method, list);

      const firstSegment = getRouteFirstSegment(routePattern.pattern);
      if (!firstSegment) {
        const genericList = routePatternsByMethodGeneric.get(routePattern.method) || [];
        genericList.push(routePattern);
        routePatternsByMethodGeneric.set(routePattern.method, genericList);
        continue;
      }

      const methodSegments = routePatternsByMethodAndSegment.get(routePattern.method) || new Map<string, Array<(typeof routePatterns)[number]>>();
      const segmentList = methodSegments.get(firstSegment) || [];
      segmentList.push(routePattern);
      methodSegments.set(firstSegment, segmentList);
      routePatternsByMethodAndSegment.set(routePattern.method, methodSegments);
    }
    const routeMatchCache = new Map<string, any[]>();
    const collectRouteCandidates = (method: string, observedRoute: string): Array<(typeof routePatterns)[number]> => {
      const firstSegment = getRouteFirstSegment(observedRoute);
      const methodSegments = routePatternsByMethodAndSegment.get(method);
      const segmentCandidates = firstSegment && methodSegments
        ? (methodSegments.get(firstSegment) || [])
        : [];
      const genericCandidates = routePatternsByMethodGeneric.get(method) || [];
      const merged = [...segmentCandidates, ...genericCandidates];
      return merged.length > 0 ? merged : (routePatternsByMethod.get(method) || []);
    };
    const findMatchedRoutes = (methodHint: string, observedRoute: string): any[] => {
      const normalizedRoute = String(observedRoute || '').trim();
      if (!normalizedRoute) return [];
      const normalizedMethod = String(methodHint || '').trim().toUpperCase();
      const cacheKey = `${normalizedMethod || '*'}|${normalizedRoute}`;
      const cached = routeMatchCache.get(cacheKey);
      if (cached) return cached;
      const candidates = (() => {
        if (!normalizedMethod) return routePatterns;
        const byMethod = collectRouteCandidates(normalizedMethod, normalizedRoute);
        if (normalizedMethod !== 'HEAD') return byMethod;
        const getRoutes = collectRouteCandidates('GET', normalizedRoute);
        return [...byMethod, ...getRoutes];
      })();
      const matches = candidates
        .filter(routePattern => routePattern.matcher.test(normalizedRoute))
        .map(routePattern => ({
          method: routePattern.method,
          route_file: routePattern.route_file,
          pattern: routePattern.pattern,
          confidence: routePattern.confidence,
          controller: routePattern.controller,
          reason: routePattern.reason,
        }));
      const deduped = Array.from(new Map(
        matches.map(item => {
          const controllerUid = String(item?.controller?.uid || '').trim();
          const key = `${String(item?.method || '').trim().toUpperCase()}|${String(item?.pattern || '')}|${String(item?.route_file || '')}|${controllerUid}`;
          return [key, item];
        }),
      ).values());
      routeMatchCache.set(cacheKey, deduped);
      return deduped;
    };

    const runtimeSource = (
      runtimeSnapshot.request_spans.length > 0
      || runtimeSnapshot.db_queries.length > 0
      || runtimeSnapshot.payload_shapes.length > 0
    ) ? 'snapshot' : 'none';

    const runtimeChangedFilePathSet = new Set(
      [
        ...changedFileObjs.map(item => normalizePath(item.filePath)),
        ...productUntrackedFiles.map(item => normalizePath(item)),
      ].filter(Boolean),
    );

    const runtime_hotspots: any[] = [];
    const normalizeHotspotSqlSignature = (sql: string): string => {
      return String(sql || '')
        .toLowerCase()
        .replace(/'[^']*'/g, '?')
        .replace(/"[^"]*"/g, '?')
        .replace(/\b\d+\b/g, '?')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
    };
    const runtimeHotspotByKey = new Map<string, any>();
    const runtimeHotspotKey = (entry: any): string => {
      const kind = String(entry?.kind || '').trim();
      if (kind === 'request_span') {
        const span = entry?.evidence?.span || {};
        return `${kind}|${String(span.method || '').toUpperCase()}|${normalizeObservedRoute(String(span.route || ''))}`;
      }
      if (kind === 'db_query') {
        const query = entry?.evidence?.query || {};
        const route = normalizeObservedRoute(String(query.route || ''));
        const sql = normalizeHotspotSqlSignature(String(query.sql || ''));
        return `${kind}|${route}|${sql}`;
      }
      return `${kind}|${String(entry?.summary || '')}`;
    };
    const addRuntimeHotspot = (entry: any) => {
      if (!entry || !entry.summary) return;
      const key = runtimeHotspotKey(entry);
      const existing = runtimeHotspotByKey.get(key);
      const nextScore = toFiniteNumber(entry?.score, 0);
      const existingScore = toFiniteNumber(existing?.score, 0);
      if (!existing) {
        runtimeHotspotByKey.set(key, entry);
        return;
      }

      const mergedReasons = Array.from(new Set([
        ...(Array.isArray(existing?.reasons) ? existing.reasons : []),
        ...(Array.isArray(entry?.reasons) ? entry.reasons : []),
      ])).slice(0, 8);
      const winner = existingScore >= nextScore ? existing : entry;
      runtimeHotspotByKey.set(key, {
        ...winner,
        reasons: mergedReasons,
        score: Math.max(existingScore, nextScore),
      });
    };

    for (const span of runtimeSnapshot.request_spans.slice(0, 200)) {
      const method = String(span.method || '').trim().toUpperCase() || 'GET';
      const observedRoute = normalizeObservedRoute(String(span.route || ''));
      if (!observedRoute) continue;
      const reasons = new Set<string>();
      const matchedRoutes = findMatchedRoutes(method, observedRoute);
      const fileHints = Array.isArray(span.file_path_hints)
        ? span.file_path_hints.map(item => normalizePath(item)).filter(Boolean)
        : [];

      for (const fileHint of fileHints) {
        if (!isInScope(fileHint)) continue;
        if (runtimeChangedFilePathSet.has(fileHint)) reasons.add(`file-hint:${fileHint}`);
      }

      for (const matchedRoute of matchedRoutes) {
        reasons.add(`route-match:${matchedRoute.pattern}`);
      }

      if (reasons.size === 0) continue;
      const durationMs = toFiniteNumber(span.duration_ms, 0);
      const payloadBytes = toFiniteNumber(span.payload_bytes, 0);
      const severity = durationMs >= 1000 || payloadBytes >= 500_000 ? 'high' : durationMs >= 400 ? 'medium' : 'low';
      const score = Number((
        (durationMs / 300)
        + (payloadBytes > 0 ? Math.min(2, payloadBytes / 400_000) : 0)
        + (matchedRoutes.length > 0 ? 1 : 0)
      ).toFixed(3));

      addRuntimeHotspot({
        kind: 'request_span',
        severity,
        score,
        summary: `${method} ${observedRoute} observed ${durationMs}ms`,
        reasons: Array.from(reasons).sort().slice(0, 8),
        confidence: round3(normalizeConfidence(Math.min(0.95, 0.65 + (matchedRoutes.length > 0 ? 0.2 : 0.05)), 0.7)),
        evidence: {
          span,
          matched_routes: matchedRoutes,
        },
      });
    }

    for (const query of runtimeSnapshot.db_queries.slice(0, 300)) {
      const durationMs = toFiniteNumber(query.duration_ms, 0);
      const lockWaitMs = toFiniteNumber(query.lock_wait_ms, 0);
      const sql = String(query.sql || '').trim();
      const route = normalizeObservedRoute(String(query.route || ''));
      const queryMethod = String((query as any).method || '').trim().toUpperCase();
      const reasons = new Set<string>();
      const matchedRoutes = route ? findMatchedRoutes(queryMethod, route) : [];
      const fileHints = Array.isArray(query.file_path_hints)
        ? query.file_path_hints.map(item => normalizePath(item)).filter(Boolean)
        : [];
      for (const fileHint of fileHints) {
        if (!isInScope(fileHint)) continue;
        if (runtimeChangedFilePathSet.has(fileHint)) reasons.add(`file-hint:${fileHint}`);
      }
      for (const matchedRoute of matchedRoutes) {
        reasons.add(`route-match:${matchedRoute.pattern}`);
      }
      if (reasons.size === 0) continue;
      if (durationMs < 80 && lockWaitMs < 25) continue;

      const severity = lockWaitMs >= 100 || durationMs >= 600 ? 'high' : durationMs >= 200 ? 'medium' : 'low';
      const score = round3((durationMs / 250) + (lockWaitMs / 120));
      addRuntimeHotspot({
        kind: 'db_query',
        severity,
        score,
        summary: `DB query observed ${durationMs}ms${lockWaitMs > 0 ? ` (${lockWaitMs}ms lock wait)` : ''}`,
        reasons: Array.from(reasons).sort().slice(0, 8),
        confidence: round3(normalizeConfidence(Math.min(0.93, 0.6 + (lockWaitMs >= 50 ? 0.15 : 0.05) + (sql ? 0.05 : 0)), 0.65)),
        evidence: {
          query,
          matched_routes: matchedRoutes,
        },
      });
    }

    runtime_hotspots.push(...runtimeHotspotByKey.values());
    runtime_hotspots.sort((left, right) => {
      const severityRank = (value: string): number => (value === 'high' ? 3 : value === 'medium' ? 2 : 1);
      const leftRank = severityRank(String(left?.severity || 'low'));
      const rightRank = severityRank(String(right?.severity || 'low'));
      if (rightRank !== leftRank) return rightRank - leftRank;
      const rightScore = toFiniteNumber(right?.score, 0);
      const leftScore = toFiniteNumber(left?.score, 0);
      if (rightScore !== leftScore) return rightScore - leftScore;
      return String(left?.summary || '').localeCompare(String(right?.summary || ''));
    });

    const routeEvidenceKey = (method: string, pattern: string, routeFile: string, controllerUid: string): string => {
      return `${String(method || '').trim().toUpperCase()}|${normalizeObservedRoute(String(pattern || ''))}|${normalizePath(String(routeFile || ''))}|${String(controllerUid || '').trim()}`;
    };

    const runtimeRouteMetricsByKey = new Map<string, {
      method: string;
      route: string;
      pattern: string;
      route_file: string;
      controller: any;
      file_hints: Set<string>;
      request_durations: number[];
      statuses: Set<number>;
      payload_bytes_max: number;
      sql_count: number;
      sql_total_ms: number;
      sql_lock_wait_ms: number;
      rows_examined: number;
      reasons: Set<string>;
    }>();

    const getOrCreateRouteMetric = (input: {
      method: string;
      pattern: string;
      route_file: string;
      controller: any;
      route: string;
    }) => {
      const key = routeEvidenceKey(input.method, input.pattern, input.route_file, String(input?.controller?.uid || ''));
      const existing = runtimeRouteMetricsByKey.get(key);
      if (existing) return existing;
      const created = {
        method: String(input.method || '').trim().toUpperCase(),
        route: normalizeObservedRoute(String(input.route || input.pattern || '')),
        pattern: normalizeObservedRoute(String(input.pattern || input.route || '')),
        route_file: normalizePath(String(input.route_file || '')),
        controller: input.controller || null,
        file_hints: new Set<string>(),
        request_durations: [] as number[],
        statuses: new Set<number>(),
        payload_bytes_max: 0,
        sql_count: 0,
        sql_total_ms: 0,
        sql_lock_wait_ms: 0,
        rows_examined: 0,
        reasons: new Set<string>(),
      };
      runtimeRouteMetricsByKey.set(key, created);
      return created;
    };

    for (const span of runtimeSnapshot.request_spans.slice(0, 400)) {
      const method = String(span.method || '').trim().toUpperCase() || 'GET';
      const observedRoute = normalizeObservedRoute(String(span.route || ''));
      if (!observedRoute) continue;
      const durationMs = toFiniteNumber(span.duration_ms, 0);
      const payloadBytes = toFiniteNumber(span.payload_bytes, 0);
      const status = toOptionalNonNegativeInteger(span.status);
      const fileHints = Array.isArray((span as any).file_path_hints)
        ? (span as any).file_path_hints.map((item: any) => normalizePath(String(item || ''))).filter((item: string) => item && isInScope(item))
        : [];
      const matchedRoutes = findMatchedRoutes(method, observedRoute);
      if (matchedRoutes.length === 0) {
        const metric = getOrCreateRouteMetric({
          method,
          pattern: observedRoute,
          route_file: '',
          controller: null,
          route: observedRoute,
        });
        metric.request_durations.push(durationMs);
        metric.payload_bytes_max = Math.max(metric.payload_bytes_max, payloadBytes);
        if (status !== undefined) metric.statuses.add(status);
        for (const fileHint of fileHints) metric.file_hints.add(fileHint);
        metric.reasons.add('runtime-observed-route');
        continue;
      }

      for (const matchedRoute of matchedRoutes) {
        const metric = getOrCreateRouteMetric({
          method,
          pattern: String(matchedRoute.pattern || observedRoute),
          route_file: String(matchedRoute.route_file || ''),
          controller: matchedRoute.controller || null,
          route: observedRoute,
        });
        metric.request_durations.push(durationMs);
        metric.payload_bytes_max = Math.max(metric.payload_bytes_max, payloadBytes);
        if (status !== undefined) metric.statuses.add(status);
        for (const fileHint of fileHints) metric.file_hints.add(fileHint);
        metric.reasons.add(`route-match:${String(matchedRoute.pattern || '')}`);
      }
    }

    for (const query of runtimeSnapshot.db_queries.slice(0, 600)) {
      const route = normalizeObservedRoute(String(query.route || ''));
      if (!route) continue;
      const method = String((query as any).method || '').trim().toUpperCase() || '';
      const durationMs = toFiniteNumber(query.duration_ms, 0);
      const lockWaitMs = toFiniteNumber(query.lock_wait_ms, 0);
      const rowsExamined = toFiniteNumber(query.rows_examined, 0);
      const queryCount = Math.max(1, toNonNegativeInteger(query.count, 1));
      const fileHints = Array.isArray((query as any).file_path_hints)
        ? (query as any).file_path_hints.map((item: any) => normalizePath(String(item || ''))).filter((item: string) => item && isInScope(item))
        : [];
      const matchedRoutes = findMatchedRoutes(method, route);
      if (matchedRoutes.length === 0) {
        const metric = getOrCreateRouteMetric({
          method,
          pattern: route,
          route_file: '',
          controller: null,
          route,
        });
        metric.sql_count += queryCount;
        metric.sql_total_ms += durationMs * queryCount;
        metric.sql_lock_wait_ms += lockWaitMs * queryCount;
        metric.rows_examined += rowsExamined * queryCount;
        for (const fileHint of fileHints) metric.file_hints.add(fileHint);
        metric.reasons.add('runtime-db-query');
        continue;
      }

      for (const matchedRoute of matchedRoutes) {
        const metric = getOrCreateRouteMetric({
          method: method || String((matchedRoute?.reason || '').split(':')[1] || ''),
          pattern: String(matchedRoute.pattern || route),
          route_file: String(matchedRoute.route_file || ''),
          controller: matchedRoute.controller || null,
          route,
        });
        metric.sql_count += queryCount;
        metric.sql_total_ms += durationMs * queryCount;
        metric.sql_lock_wait_ms += lockWaitMs * queryCount;
        metric.rows_examined += rowsExamined * queryCount;
        for (const fileHint of fileHints) metric.file_hints.add(fileHint);
        metric.reasons.add(`route-match:${String(matchedRoute.pattern || '')}`);
      }
    }

    const percentile = (values: number[], p: number): number => {
      if (!Array.isArray(values) || values.length === 0) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
      return toFiniteNumber(sorted[idx], 0);
    };

    const runtimeEvidenceRoutes = Array.from(runtimeRouteMetricsByKey.values())
      .map(metric => {
        const requestCount = metric.request_durations.length;
        const totalRequestMs = metric.request_durations.reduce((sum, value) => sum + toFiniteNumber(value, 0), 0);
        const avgRequestMs = requestCount > 0 ? totalRequestMs / requestCount : 0;
        const maxRequestMs = requestCount > 0 ? Math.max(...metric.request_durations) : 0;
        const p95RequestMs = percentile(metric.request_durations, 95);
        const fileHints = Array.from(metric.file_hints).sort();
        const statuses = Array.from(metric.statuses).sort((a, b) => a - b);
        const sqlAvgMs = metric.sql_count > 0 ? metric.sql_total_ms / metric.sql_count : 0;
        const score = (
          (avgRequestMs / 250)
          + (maxRequestMs / 500)
          + (metric.sql_total_ms / 500)
          + (metric.sql_lock_wait_ms / 200)
        );
        return {
          method: metric.method,
          route: metric.route,
          pattern: metric.pattern,
          route_file: metric.route_file || fileHints[0] || '',
          controller: metric.controller,
          file_hints: fileHints.slice(0, 5),
          request_count: requestCount,
          request_latency_ms: {
            avg: round3(avgRequestMs),
            max: round3(maxRequestMs),
            p95: round3(p95RequestMs),
          },
          statuses,
          payload_bytes_max: round3(metric.payload_bytes_max),
          sql: {
            count: metric.sql_count,
            total_ms: round3(metric.sql_total_ms),
            avg_ms: round3(sqlAvgMs),
            lock_wait_ms: round3(metric.sql_lock_wait_ms),
            rows_examined: round3(metric.rows_examined),
          },
          reasons: Array.from(metric.reasons).sort().slice(0, 8),
          score: round3(score),
        };
      })
      .sort((left, right) => {
        const rightScore = toFiniteNumber(right?.score, 0);
        const leftScore = toFiniteNumber(left?.score, 0);
        if (rightScore !== leftScore) return rightScore - leftScore;
        return String(left?.route || '').localeCompare(String(right?.route || ''));
      });

    const runtimeEvidenceFocusRoute = '/seating_groups/assign';
    const runtimeEvidenceFocusRoutes = runtimeEvidenceRoutes.filter(item => String(item?.route || '').includes(runtimeEvidenceFocusRoute));
    const runtimeEvidenceByKey = new Map<string, any>();
    const runtimeEvidenceByMethodPattern = new Map<string, any>();
    for (const item of runtimeEvidenceRoutes) {
      const method = String(item?.method || '').trim().toUpperCase();
      const pattern = normalizeObservedRoute(String(item?.pattern || item?.route || ''));
      const routeFilePath = normalizePath(String(item?.route_file || ''));
      const controllerUid = String(item?.controller?.uid || '').trim();
      const key = routeEvidenceKey(method, pattern, routeFilePath, controllerUid);
      const methodPatternKey = `${method}|${pattern}`;
      const score = toFiniteNumber(item?.score, 0);

      const existingByKey = runtimeEvidenceByKey.get(key);
      if (!existingByKey || toFiniteNumber(existingByKey?.score, 0) < score) {
        runtimeEvidenceByKey.set(key, item);
      }

      const existingByMethodPattern = runtimeEvidenceByMethodPattern.get(methodPatternKey);
      if (!existingByMethodPattern || toFiniteNumber(existingByMethodPattern?.score, 0) < score) {
        runtimeEvidenceByMethodPattern.set(methodPatternKey, item);
      }
    }
    const runtime_evidence = {
      focus_route: runtimeEvidenceFocusRoute,
      routes: runtimeEvidenceRoutes.slice(0, 25),
      focus_routes: runtimeEvidenceFocusRoutes.slice(0, 10),
    };

    const contract_parity: any[] = [];
    const routePatternEntries = Array.from(new Map(
      [
        ...routePatterns.map(pattern => ({
          method: String(pattern?.method || '').trim().toUpperCase(),
          pattern: normalizeObservedRoute(String(pattern?.pattern || '')),
          route_file: normalizePath(String(pattern?.route_file || '')),
          controller: pattern?.controller || null,
        })),
        ...runtimeEvidenceRoutes.map(item => ({
          method: String(item?.method || '').trim().toUpperCase(),
          pattern: normalizeObservedRoute(String(item?.pattern || item?.route || '')),
          route_file: normalizePath(String(item?.route_file || '')),
          controller: item?.controller || null,
        })),
      ]
        .map(pattern => {
          const controllerUid = String(pattern?.controller?.uid || '').trim();
          const key = routeEvidenceKey(String(pattern?.method || ''), String(pattern?.pattern || ''), String(pattern?.route_file || ''), controllerUid);
          return [key, pattern];
        }),
    ).values()).filter(pattern => String(pattern?.pattern || '').trim());
    const controllerIds = Array.from(new Set(
      routePatternEntries
        .map(entry => String(entry?.controller?.uid || '').trim())
        .filter(Boolean),
    ));
    const escapeCypherValueLocal = (value: string): string => String(value || '').replace(/'/g, "''");
    const buildCypherStringListLocal = (values: string[]): string => {
      if (values.length === 0) return '[]';
      return `[${values.map(value => `'${escapeCypherValueLocal(value)}'`).join(', ')}]`;
    };
    const controllerContractRowsById = new Map<string, Array<{ type: string; reason: string; fieldName: string }>>();
    if (controllerIds.length > 0) {
      const controllerIdsCypher = buildCypherStringListLocal(controllerIds);
      try {
        const contractRows = await executeQuery(repo.id, `
          MATCH (c)-[r:CodeRelation]->(f:ContractField)
          WHERE c.id IN ${controllerIdsCypher}
            AND r.type IN ['VALIDATES_FIELD','SERIALIZES_FIELD','READS_FIELD','WRITES_FIELD']
          RETURN c.id AS controllerId, r.type AS relType, r.reason AS reason, f.fieldName AS fieldName, f.name AS fieldNameFallback
          LIMIT ${Math.max(200, Math.min(10000, controllerIds.length * 60))}
        `);
        for (const row of contractRows) {
          const controllerId = String(row.controllerId || row[0] || '').trim();
          if (!controllerId) continue;
          const list = controllerContractRowsById.get(controllerId) || [];
          list.push({
            type: String(row.relType || row[1] || '').trim(),
            reason: String(row.reason || row[2] || '').trim(),
            fieldName: String(row.fieldName || row[3] || row.fieldNameFallback || row[4] || '').trim(),
          });
          controllerContractRowsById.set(controllerId, list);
        }
      } catch {
        // best-effort parity enrichment
      }
    }

    const payloadShapesByRouteKey = new Map<string, Set<string>>();
    for (const payloadShape of runtimeSnapshot.payload_shapes.slice(0, 500)) {
      const shapePath = normalizeObservedRoute(String(payloadShape.path || ''));
      if (!shapePath) continue;
      const matchedRoutes = findMatchedRoutes('', shapePath);
      const keys = Array.isArray(payloadShape.keys)
        ? payloadShape.keys.map(item => String(item || '').trim()).filter(Boolean)
        : [];
      for (const matchedRoute of matchedRoutes) {
        const methodHint = String(matchedRoute?.method || (matchedRoute?.reason || '').split(':')[1] || '').toUpperCase();
        const key = routeEvidenceKey(
          methodHint,
          String(matchedRoute.pattern || shapePath),
          String(matchedRoute.route_file || ''),
          String(matchedRoute?.controller?.uid || ''),
        );
        const existing = payloadShapesByRouteKey.get(key) || new Set<string>();
        for (const field of keys) existing.add(field);
        payloadShapesByRouteKey.set(key, existing);
      }
    }

    for (const patternEntry of routePatternEntries) {
      const method = String(patternEntry?.method || '').trim().toUpperCase();
      const pattern = normalizeObservedRoute(String(patternEntry?.pattern || ''));
      const routeFilePath = normalizePath(String(patternEntry?.route_file || ''));
      const controller = patternEntry?.controller || null;
      const controllerUid = String(controller?.uid || '').trim();
      const key = routeEvidenceKey(method, pattern, routeFilePath, controllerUid);
      const contractRows = controllerContractRowsById.get(controllerUid) || [];
      const requestFields = new Set<string>();
      const responseFields = new Set<string>();
      for (const row of contractRows) {
        const fieldName = String(row.fieldName || '').trim();
        if (!fieldName) continue;
        const reason = String(row.reason || '').toLowerCase();
        if (row.type === 'VALIDATES_FIELD' || reason.includes('request')) requestFields.add(fieldName);
        if (row.type === 'SERIALIZES_FIELD' || reason.includes('response')) responseFields.add(fieldName);
        if (row.type === 'READS_FIELD' && reason.includes('request')) requestFields.add(fieldName);
        if (row.type === 'WRITES_FIELD' && reason.includes('response')) responseFields.add(fieldName);
      }
      const runtimeRouteMetric = runtimeEvidenceByKey.get(key)
        || runtimeEvidenceByMethodPattern.get(`${method}|${pattern}`)
        || (method === 'HEAD' ? runtimeEvidenceByMethodPattern.get(`GET|${pattern}`) : undefined);
      const runtimePayloadKeySet = payloadShapesByRouteKey.get(key) || new Set<string>();
      const runtimePayloadKeys = Array.from(runtimePayloadKeySet).sort();
      const runtimeStatuses = Array.isArray(runtimeRouteMetric?.statuses) ? runtimeRouteMetric.statuses : [];
      const missingInRuntime = Array.from(requestFields).filter(field => !runtimePayloadKeySet.has(field)).slice(0, 20);
      const extraInRuntime = runtimePayloadKeys.filter(field => !requestFields.has(field)).slice(0, 20);
      const has5xxStatus = runtimeStatuses.some((status: number) => status >= 500);
      const hasErrorOnly = runtimeStatuses.length > 0 && runtimeStatuses.every((status: number) => status >= 400);
      let parityScore = 1;
      if (requestFields.size === 0) parityScore -= 0.35;
      if (responseFields.size === 0) parityScore -= 0.35;
      if (runtimeStatuses.length === 0) parityScore -= 0.15;
      if (has5xxStatus) parityScore -= 0.2;
      if (hasErrorOnly) parityScore -= 0.1;
      if (requestFields.size > 0 && runtimePayloadKeys.length > 0) {
        const requestFieldCoverage = 1 - (missingInRuntime.length / Math.max(1, requestFields.size));
        if (requestFieldCoverage < 0.5) parityScore -= 0.15;
        else if (requestFieldCoverage < 0.8) parityScore -= 0.08;
      }
      parityScore = round3(Math.max(0, Math.min(1, parityScore)));
      const parityLevel = parityScore >= 0.8 ? 'high' : parityScore >= 0.55 ? 'medium' : 'low';
      contract_parity.push({
        route_file: routeFilePath,
        method,
        pattern,
        controller,
        request_shape: {
          field_count: requestFields.size,
          fields: Array.from(requestFields).sort().slice(0, 40),
        },
        response_shape: {
          field_count: responseFields.size,
          fields: Array.from(responseFields).sort().slice(0, 40),
        },
        status_semantics: {
          observed_statuses: runtimeStatuses,
          status_count: runtimeStatuses.length,
          has_5xx: has5xxStatus,
          error_only: hasErrorOnly,
        },
        diff: {
          request_missing_in_runtime: missingInRuntime,
          runtime_extra_vs_request: extraInRuntime,
        },
        parity_score: parityScore,
        parity_level: parityLevel,
      });
    }
    contract_parity.sort((left, right) => (
      toFiniteNumber(left?.parity_score, 0) - toFiniteNumber(right?.parity_score, 0)
    ));

    const authz: any[] = [];
    const pickPrimaryKindLabel = (value: any): string => {
      if (Array.isArray(value)) return String(value[0] || '').trim();
      return String(value || '').trim();
    };
    const controllerById = new Map<string, any>();
    const registerController = (candidate: any): void => {
      const uid = String(candidate?.uid || '').trim();
      if (!uid) return;
      const filePath = normalizePath(String(candidate?.filePath || '').trim());
      if (!filePath || !isInScope(filePath)) return;
      const kind = String(candidate?.kind || 'Method').trim() || 'Method';
      const name = String(candidate?.name || '').trim();
      const startLine = toOptionalLineNumber(candidate?.startLine);
      const incoming: any = {
        uid,
        name,
        filePath,
        kind,
      };
      if (startLine !== undefined) incoming.startLine = startLine;
      const existing = controllerById.get(uid);
      if (!existing) {
        controllerById.set(uid, incoming);
        return;
      }
      const merged: any = {
        ...existing,
        ...incoming,
      };
      if (String(incoming.name || '').length > String(existing.name || '').length) {
        merged.name = incoming.name;
      } else {
        merged.name = existing.name;
      }
      const existingStartLine = toOptionalLineNumber(existing.startLine);
      const incomingStartLine = toOptionalLineNumber(incoming.startLine);
      if (existingStartLine !== undefined) {
        merged.startLine = existing.startLine;
      } else if (incomingStartLine === undefined) {
        delete merged.startLine;
      }
      controllerById.set(uid, merged);
    };
    for (const sym of changedSymbols) {
      const kind = String(sym?.kind || '');
      const filePath = String(sym?.filePath || '');
      if (
        kind === 'Method'
        && filePath.includes('/Http/Controllers/')
        && filePath.toLowerCase().endsWith('.php')
      ) {
        registerController(sym);
      }
    }
    for (const routeEntry of route_targets) {
      for (const target of Array.isArray(routeEntry?.targets) ? routeEntry.targets : []) {
        registerController(target?.controller || null);
      }
    }
    const endpointNamesByControllerId = new Map<string, Set<string>>();
    const endpointRoutePatternsByName = new Map<string, Set<string>>();
    for (const routePattern of routePatterns) {
      const controllerUid = String(routePattern?.controller?.uid || '').trim();
      const method = String(routePattern?.method || '').trim().toLowerCase();
      const normalizedPattern = normalizeObservedRoute(String(routePattern?.pattern || '').trim());
      if (!controllerUid || !method || !normalizedPattern) continue;
      const endpointName = `endpoint:${method}:${normalizedPattern}`;
      const names = endpointNamesByControllerId.get(controllerUid) || new Set<string>();
      names.add(endpointName);
      endpointNamesByControllerId.set(controllerUid, names);
      const patternSet = endpointRoutePatternsByName.get(endpointName) || new Set<string>();
      patternSet.add(normalizedPattern);
      endpointRoutePatternsByName.set(endpointName, patternSet);
    }
    const endpointControllersByName = new Map<string, Set<string>>();
    for (const [controllerId, endpointNames] of endpointNamesByControllerId.entries()) {
      for (const endpointName of endpointNames) {
        const controllers = endpointControllersByName.get(endpointName) || new Set<string>();
        controllers.add(controllerId);
        endpointControllersByName.set(endpointName, controllers);
      }
    }

    if (controllerById.size > 0) {
      const controllerIds = Array.from(controllerById.keys());
      const controllerIdsCypher = `[${controllerIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ')}]`;

      let authRows: any[] = [];
      try {
        authRows = await executeQuery(repo.id, `
          MATCH (c)-[r:CodeRelation {type: 'CALLS'}]->(t)
          WHERE c.id IN ${controllerIdsCypher}
            AND r.confidence >= ${minConfidence}
            AND (
              r.reason STARTS WITH 'laravel-authorize:'
              OR r.reason STARTS WITH 'laravel-gate:'
              OR r.reason STARTS WITH 'laravel-can:'
              OR r.reason STARTS WITH 'laravel-route-middleware:can:'
            )
          OPTIONAL MATCH (t)-[slugRel:CodeRelation {type: 'CALLS'}]->(slug:CodeElement)
          WHERE slugRel.reason STARTS WITH 'laravel-permission-slug:'
          RETURN c.id AS controllerId,
                 t.id AS targetId, t.name AS targetName, labels(t) AS targetKind, t.filePath AS targetFilePath,
                 r.reason AS authReason, r.confidence AS authConfidence,
                 slug.id AS slugId, slug.name AS slugName, slug.filePath AS slugFilePath,
                 slugRel.reason AS slugReason, slugRel.confidence AS slugConfidence
          ORDER BY c.id ASC, r.confidence DESC, slugRel.confidence DESC
          LIMIT ${Math.max(300, Math.min(30000, controllerIds.length * 120))}
        `);
      } catch {
        authRows = [];
      }

      const checksByController = new Map<string, Map<string, any>>();
      const seenSlugsByController = new Map<string, Set<string>>();
      const normalizePermissionSlug = (value: string): string => {
        const raw = String(value || '').trim();
        if (!raw) return '';
        if (raw.startsWith('permission:')) {
          return String(raw.slice('permission:'.length)).trim();
        }
        return raw;
      };
      const getControllerChecks = (controllerId: string): Map<string, any> => {
        const existing = checksByController.get(controllerId);
        if (existing) return existing;
        const created = new Map<string, any>();
        checksByController.set(controllerId, created);
        return created;
      };
      const getSeenSlugSet = (controllerId: string): Set<string> => {
        const existing = seenSlugsByController.get(controllerId);
        if (existing) return existing;
        const created = new Set<string>();
        seenSlugsByController.set(controllerId, created);
        return created;
      };
      const getOrCreateAuthCheck = (
        controllerId: string,
        checkKey: string,
        row: any,
        source: any,
        targetUid: string,
        targetKind: string,
      ): any => {
        const controllerChecks = getControllerChecks(controllerId);
        const existing = controllerChecks.get(checkKey);
        if (existing) return existing;
        const created = {
          target: {
            uid: targetUid,
            name: String(row.targetName || row[2] || '').trim(),
            kind: targetKind,
            filePath: String(row.targetFilePath || row[4] || '').trim(),
          },
          source,
          edge: {
            reason: String(row.authReason || row[5] || '').trim(),
            confidence: normalizeConfidence(row.authConfidence ?? row[6], 1.0),
          },
        };
        controllerChecks.set(checkKey, created);
        return created;
      };
      const addPermissionSlugToCheck = (
        controllerId: string,
        checkKey: string,
        check: any,
        input: {
          mode: 'direct' | 'derived';
          id: string;
          name: string;
          filePath: string;
          reason: string;
          confidence: number;
        },
      ): void => {
        const slugName = normalizePermissionSlug(String(input.name || ''));
        if (!slugName) return;
        const stableId = input.mode === 'direct'
          ? `direct:${slugName}`
          : `${String(input.id || '').trim()}|${slugName}|${String(input.reason || '').trim()}`;
        const slugKey = `${checkKey}|${stableId}`;
        const seen = getSeenSlugSet(controllerId);
        if (seen.has(slugKey)) return;
        seen.add(slugKey);
        if (!Array.isArray(check.permission_slugs)) check.permission_slugs = [];
        check.permission_slugs.push({
          name: slugName,
          filePath: String(input.filePath || '').trim(),
          edge: {
            reason: String(input.reason || '').trim(),
            confidence: normalizeConfidence(input.confidence, 1.0),
          },
        });
      };
      const processAuthRowForController = (
        controllerId: string,
        row: any,
        source: any,
        checkKeyPrefix = '',
      ): void => {
        const targetUid = String(row.targetId || row[1] || '').trim();
        if (!targetUid) return;
        const targetKind = pickPrimaryKindLabel(row.targetKind || row[3] || '');
        const authReason = String(row.authReason || row[5] || '').trim();
        const checkKey = `${checkKeyPrefix}${targetUid}|${authReason}`;
        const check = getOrCreateAuthCheck(controllerId, checkKey, row, source, targetUid, targetKind);

        if (targetUid.startsWith('CodeElement:permission:')) {
          addPermissionSlugToCheck(controllerId, checkKey, check, {
            mode: 'direct',
            id: targetUid,
            name: String(row.targetName || row[2] || '').trim(),
            filePath: String(row.targetFilePath || row[4] || '').trim(),
            reason: authReason,
            confidence: normalizeConfidence(row.authConfidence ?? row[6], 1.0),
          });
        }

        const slugName = String(row.slugName || row[8] || '').trim();
        if (!slugName || (targetKind !== 'Const' && !targetUid.startsWith('Const:'))) return;
        addPermissionSlugToCheck(controllerId, checkKey, check, {
          mode: 'derived',
          id: String(row.slugId || row[7] || '').trim(),
          name: slugName,
          filePath: String(row.slugFilePath || row[9] || '').trim(),
          reason: String(row.slugReason || row[10] || '').trim(),
          confidence: normalizeConfidence(row.slugConfidence ?? row[11], 1.0),
        });
      };
      for (const row of authRows) {
        const controllerId = String(row.controllerId || row[0] || '').trim();
        if (!controllerId) continue;
        processAuthRowForController(controllerId, row, { kind: 'controller' });
      }

      const endpointNames = Array.from(endpointControllersByName.keys());
      if (endpointNames.length > 0) {
        let endpointRows: any[] = [];
        try {
          const endpointNamesCypher = buildCypherStringList(endpointNames);
          endpointRows = await executeQuery(repo.id, `
            MATCH (e:CodeElement)-[r:CodeRelation {type: 'CALLS'}]->(t)
            WHERE e.name IN ${endpointNamesCypher}
              AND r.confidence >= ${minConfidence}
              AND (
                r.reason STARTS WITH 'laravel-can:endpoint-middleware:'
                OR r.reason STARTS WITH 'laravel-route-middleware:can:'
              )
            OPTIONAL MATCH (t)-[slugRel:CodeRelation {type: 'CALLS'}]->(slug:CodeElement)
            WHERE slugRel.reason STARTS WITH 'laravel-permission-slug:'
            RETURN e.name AS endpointName,
                   t.id AS targetId, t.name AS targetName, labels(t) AS targetKind, t.filePath AS targetFilePath,
                   r.reason AS authReason, r.confidence AS authConfidence,
                   slug.id AS slugId, slug.name AS slugName, slug.filePath AS slugFilePath,
                   slugRel.reason AS slugReason, slugRel.confidence AS slugConfidence
            ORDER BY e.name ASC, r.confidence DESC, slugRel.confidence DESC
            LIMIT ${Math.max(200, Math.min(20000, endpointNames.length * 80))}
          `);
        } catch {
          endpointRows = [];
        }

        for (const row of endpointRows) {
          const endpointName = String(row.endpointName || row[0] || '').trim();
          if (!endpointName) continue;
          const targetUid = String(row.targetId || row[1] || '').trim();
          if (!targetUid) continue;
          const controllerIds = endpointControllersByName.get(endpointName) || new Set<string>();
          if (controllerIds.size === 0) continue;
          const routePatternsForEndpoint = Array.from(endpointRoutePatternsByName.get(endpointName) || new Set<string>());
          const source = {
            kind: 'endpoint',
            name: endpointName,
            route_patterns: routePatternsForEndpoint.slice(0, 3),
          };

          for (const controllerId of controllerIds) {
            processAuthRowForController(controllerId, row, source, `endpoint:${endpointName}|`);
          }
        }
      }

      for (const [controllerId, controller] of controllerById.entries()) {
        const checks = Array.from((checksByController.get(controllerId) || new Map<string, any>()).values())
          .map((check: any) => {
            if (!Array.isArray(check?.permission_slugs)) return check;
            return {
              ...check,
              permission_slugs: check.permission_slugs
                .filter((slug: any) => slug?.name)
                .slice(0, 3),
            };
          })
          .filter((check: any) => check?.target?.uid);

        if (checks.length === 0) continue;
        authz.push({
          controller,
          checks,
        });
      }
    }

    const perf_backend_findings: Array<{
      code: 'perf-repeated-linear-scan' | 'perf-write-amplification' | 'perf-noop-write';
      filePath: string;
      line: number;
      summary: string;
      snippet: string;
      confidence: number;
      severity: ReviewFindingSeverity;
    }> = [];
    const validation_boundary_findings: Array<{
      code: 'post-validate-sanitize-loop';
      filePath: string;
      line: number;
      summary: string;
      snippet: string;
      confidence: number;
      severity: ReviewFindingSeverity;
    }> = [];
    const changedRangeByFile = new Map<string, Array<{ start: number; end: number }>>();
    for (const changedFile of changedFileObjs) {
      const filePath = normalizePath(String(changedFile?.filePath || ''));
      if (!filePath) continue;
      const ranges = (Array.isArray(changedFile?.hunks) ? changedFile.hunks : [])
        .map(hunk => {
          const start = Math.max(1, toNonNegativeInteger(hunk?.new_start, 1));
          const lines = Math.max(1, toNonNegativeInteger(hunk?.new_lines, 1));
          return { start, end: start + lines - 1 };
        });
      changedRangeByFile.set(filePath, ranges);
    }
    const backendScanTargets = changedFileObjs
      .map(item => normalizePath(String(item?.filePath || '')))
      .filter(Boolean)
      .filter(filePath => !filePath.endsWith('.md'))
      .filter(filePath => !filePath.startsWith('apps/dashboard/'))
      .filter(filePath => (
        filePath.startsWith('apps/backend/')
        || filePath.startsWith('app/')
        || filePath.startsWith('src/')
        || filePath.includes('/Domains/')
        || filePath.toLowerCase().endsWith('.php')
      ))
      .filter((filePath, idx, arr) => arr.indexOf(filePath) === idx)
      .slice(0, 40);
    const loopLineRegex = /\b(?:for(?:each)?|while)\s*\(|\bforeach\s*\(/;
    const linearLookupRegex = /\.(?:find|findIndex|some|filter)\s*\(|->(?:find|findOrFail|firstWhere|first)\s*\(|\barray_filter\s*\(/;
    const writeInLoopRegex = /->(?:save|update|delete)\s*\(|::(?:create|update|delete|upsert|insert)\s*\(|\bDB::(?:insert|update|delete|statement)\s*\(/;
    const noOpWriteRegex = /->(?:save|update)\s*\(\s*(?:\[\s*\])?\s*\)/;
    const validateBoundaryRegex = /->validateWithBag\s*\(|->validate\s*\(|\$this->validate\s*\(|->validated\s*\(|->safe\s*\(/;

    const validationBoundariesByFileAndLine = new Map<string, Map<number, { reason: string; snippet: string }>>();
    try {
      const filePathsCypher = JSON.stringify(backendScanTargets);
      const boundaryRows = await executeQuery(repo.id, `
        MATCH (b:CodeElement)
        WHERE b.id STARTS WITH 'CodeElement:laravel-validation-boundary:'
          AND b.filePath IN ${filePathsCypher}
        RETURN b.filePath AS filePath, b.startLine AS startLine, b.name AS name, b.content AS content
        ORDER BY b.filePath ASC, b.startLine ASC
        LIMIT ${Math.max(200, Math.min(12000, backendScanTargets.length * 80))}
      `);
      for (const row of boundaryRows) {
        const filePath = normalizePath(String(row.filePath ?? row[0] ?? '').trim());
        const startLine = toNonNegativeInteger(row.startLine ?? row[1] ?? 0, 0);
        if (!filePath || startLine <= 0) continue;

        const name = String(row.name ?? row[2] ?? '').trim();
        const content = String(row.content ?? row[3] ?? '').trim();
        const reasonFromContent = content.match(/\bReason:\s*([^\n]+)/)?.[1]?.trim() || '';
        const reasonFromName = name.match(/\(([^)]+)\)/)?.[1]?.trim() || '';
        const reason = reasonFromContent || reasonFromName || '';
        const snippet = content.match(/\bSnippet:\s*([^\n]+)/)?.[1]?.trim() || '';
        if (!reason) continue;

        const byLine = validationBoundariesByFileAndLine.get(filePath) || new Map<number, { reason: string; snippet: string }>();
        if (!validationBoundariesByFileAndLine.has(filePath)) validationBoundariesByFileAndLine.set(filePath, byLine);
        if (!byLine.has(startLine)) byLine.set(startLine, { reason, snippet });
      }
    } catch {
      // Ignore: graph boundaries are optional; fallback to file scan
    }

    for (const filePath of backendScanTargets) {
      const resolved = resolvePathInsideRepo(repo.repoPath, filePath);
      if (!resolved) continue;
      let content = '';
      try {
        content = await fs.readFile(resolved.absolutePath, 'utf-8');
      } catch {
        continue;
      }
      const ranges = changedRangeByFile.get(filePath) || [];
      const lineNearChanged = (lineNo: number): boolean => {
        if (ranges.length === 0) return true;
        return ranges.some(range => lineNo >= (range.start - 10) && lineNo <= (range.end + 10));
      };

      const lines = content.split('\n');
      let loopWindow = 0;
      let validateWindow = 0;
      let validateBoundaryLine = 0;
      let validateBoundaryReason: string | null = null;
      let validateVar: string | null = null;
      let emittedValidateFinding = false;
      const boundariesForFile = validationBoundariesByFileAndLine.get(filePath) || new Map<number, { reason: string; snippet: string }>();
      for (let idx = 0; idx < lines.length; idx++) {
        const lineNo = idx + 1;
        const rawLine = String(lines[idx] || '');
        const codeLine = rawLine.replace(/\/\/.*$/g, '').trim();
        if (!codeLine) {
          if (loopWindow > 0) loopWindow -= 1;
          if (validateWindow > 0) validateWindow -= 1;
          continue;
        }
        const boundaryAtLine = boundariesForFile.get(lineNo);
        if (boundaryAtLine) {
          validateWindow = Math.max(validateWindow, 16);
          validateBoundaryLine = lineNo;
          validateBoundaryReason = boundaryAtLine.reason || null;

          const assignmentMatch = /\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[^;]*(?:->validateWithBag|->validate|\$this->validate|->validated|->safe)\b/.exec(codeLine);
          if (assignmentMatch?.[1]) validateVar = assignmentMatch[1];
        } else if (validateBoundaryRegex.test(codeLine)) {
          // Prefer precision-first: once a request payload is validated, treat additional cleanup passes as suspect
          // unless contract evidence proves they are required.
          const assignmentMatch = /\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[^;]*(?:->validateWithBag|->validate|\$this->validate|->validated|->safe)\b/.exec(codeLine);
          validateVar = assignmentMatch?.[1] ? assignmentMatch[1] : null;
          validateWindow = Math.max(validateWindow, 16);
          validateBoundaryLine = lineNo;
          validateBoundaryReason = null;
        }
        if (loopLineRegex.test(codeLine)) {
          loopWindow = Math.max(loopWindow, 8);
          continue;
        }
        if (loopWindow > 0) loopWindow -= 1;
        if (validateWindow > 0) validateWindow -= 1;

        const nearChanged = lineNearChanged(lineNo);
        if (!nearChanged) continue;

        if (validateWindow > 0 && !emittedValidateFinding) {
          const candidateVars = new Set<string>();
          if (validateVar) candidateVars.add(validateVar);
          if (codeLine.includes('$validated')) candidateVars.add('validated');

          for (const varName of candidateVars) {
            const needle = `$${varName}`;
            if (!codeLine.includes(needle)) continue;
            const isCleanup = (
              (codeLine.includes('array_filter(') && codeLine.includes(needle))
              || (codeLine.includes('collect(') && codeLine.includes('->filter') && codeLine.includes(needle))
              || (codeLine.includes('collect(') && codeLine.includes('->reject') && codeLine.includes(needle))
              || (codeLine.includes('unset(') && codeLine.includes(needle))
            );
            if (!isCleanup) continue;

            validation_boundary_findings.push({
              code: 'post-validate-sanitize-loop',
              filePath,
              line: lineNo,
              summary: `Post-validate cleanup detected near line ${lineNo} (${needle} after validate boundary at line ${validateBoundaryLine}${validateBoundaryReason ? ` (${validateBoundaryReason})` : ''}). Prefer trusting validated input unless a contract requires cleanup.`,
              snippet: codeLine.slice(0, 220),
              confidence: 0.78,
              severity: 'low',
            });
            emittedValidateFinding = true;
            break;
          }
        }

        if (loopWindow <= 0) continue;

        if (linearLookupRegex.test(codeLine) && perf_backend_findings.length < 80) {
          perf_backend_findings.push({
            code: 'perf-repeated-linear-scan',
            filePath,
            line: lineNo,
            summary: `Repeated linear scan detected inside loop near line ${lineNo}.`,
            snippet: codeLine.slice(0, 220),
            confidence: 0.84,
            severity: 'medium',
          });
        }
        if (writeInLoopRegex.test(codeLine) && perf_backend_findings.length < 80) {
          perf_backend_findings.push({
            code: 'perf-write-amplification',
            filePath,
            line: lineNo,
            summary: `Potential write amplification detected inside loop near line ${lineNo}.`,
            snippet: codeLine.slice(0, 220),
            confidence: 0.82,
            severity: 'medium',
          });
        }
        if (noOpWriteRegex.test(codeLine) && perf_backend_findings.length < 80) {
          perf_backend_findings.push({
            code: 'perf-noop-write',
            filePath,
            line: lineNo,
            summary: `Potential no-op write call detected near line ${lineNo}.`,
            snippet: codeLine.slice(0, 220),
            confidence: 0.88,
            severity: 'high',
          });
        }
      }
    }

    const frontendHygieneSignals: Array<{
      code:
        | 'prop-drilling-score'
        | 'nested-component-declaration'
        | 'signature-too-many-args'
        | 'inline-param-type-object'
        | 'default-export'
        | 'todo-comment'
        | 'react-fc'
        | 'react-usecontext'
        | 'react-context-provider'
        | 'tailwind-space-class';
      filePath: string;
      line: number;
      summary: string;
      reason: string;
      confidence: number;
      severity: ReviewFindingSeverity;
    }> = [];

    const frontendScanTargets = changedFileObjs
      .map(item => normalizePath(String(item?.filePath || '')))
      .filter(Boolean)
      .filter(filePath => filePath.startsWith('apps/dashboard/'))
      .filter(filePath => !filePath.endsWith('.md'))
      .filter(filePath => !filePath.endsWith('.d.ts'))
      .filter(filePath => (
        filePath.endsWith('.ts')
        || filePath.endsWith('.tsx')
        || filePath.endsWith('.js')
        || filePath.endsWith('.jsx')
      ))
      .filter((filePath, idx, arr) => arr.indexOf(filePath) === idx)
      .slice(0, 60);

    const countTopLevelParameters = (paramList: string): number => {
      const raw = String(paramList || '').trim();
      if (!raw) return 0;

      let depthParen = 0;
      let depthBrace = 0;
      let depthBracket = 0;
      let depthAngle = 0;
      let inSingle = false;
      let inDouble = false;
      let inTemplate = false;
      let escape = false;

      let count = 1;
      for (let idx = 0; idx < raw.length; idx += 1) {
        const ch = raw[idx];
        if (escape) {
          escape = false;
          continue;
        }
        if (inSingle) {
          if (ch === '\\\\') escape = true;
          else if (ch === '\'') inSingle = false;
          continue;
        }
        if (inDouble) {
          if (ch === '\\\\') escape = true;
          else if (ch === '"') inDouble = false;
          continue;
        }
        if (inTemplate) {
          if (ch === '\\\\') escape = true;
          else if (ch === '`') inTemplate = false;
          continue;
        }

        if (ch === '\'') {
          inSingle = true;
          continue;
        }
        if (ch === '"') {
          inDouble = true;
          continue;
        }
        if (ch === '`') {
          inTemplate = true;
          continue;
        }

        if (ch === '(') depthParen += 1;
        else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
        else if (ch === '{') depthBrace += 1;
        else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);
        else if (ch === '[') depthBracket += 1;
        else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
        else if (ch === '<') depthAngle += 1;
        else if (ch === '>') depthAngle = Math.max(0, depthAngle - 1);

        if (ch === ',' && depthParen === 0 && depthBrace === 0 && depthBracket === 0 && depthAngle === 0) {
          count += 1;
        }
      }

      return count;
    };

    const extractParenGroup = (
      lines: string[],
      startLineIndex: number,
      startCharIndex: number,
      maxLines: number,
    ): { text: string; endLineIndex: number; endCharIndex: number } | null => {
      const start = Math.max(0, startLineIndex);
      const end = Math.min(lines.length, start + Math.max(1, maxLines));
      let depth = 0;
      let text = '';

      for (let lineIdx = start; lineIdx < end; lineIdx += 1) {
        const line = String(lines[lineIdx] || '');
        const startChar = lineIdx === start ? Math.max(0, startCharIndex) : 0;
        for (let col = startChar; col < line.length; col += 1) {
          const ch = line[col];
          if (ch === '(') {
            depth += 1;
            if (depth === 1) continue;
          } else if (ch === ')') {
            depth -= 1;
            if (depth === 0) {
              return { text, endLineIndex: lineIdx, endCharIndex: col };
            }
          }
          if (depth >= 1) text += ch;
        }
        if (depth >= 1) text += '\n';
      }
      return null;
    };

    const identityPropRegex = /([A-Za-z_$][\w$]*)\s*=\s*\{\s*\1\s*\}/g;
    const spreadPropRegex = /\{\s*\.\.\.\s*[A-Za-z_$][\w$]*\s*\}/g;
    const nestedComponentFnRegex = /\bfunction\s+([A-Z][A-Za-z0-9_]*)\s*\(/;
    const nestedComponentConstRegex = /\bconst\s+([A-Z][A-Za-z0-9_]*)\b[^=]*=\s*\(/;
    const inlineParamObjectRegex = /:\s*\{/;
    const defaultExportRegex = /\bexport\s+default\b/;
    const todoCommentRegex = /(?:\/\/|\/\*).*?\b(?:TODO|FIXME)\b/i;
    const reactFcRegex = /\bReact\.(?:FC|FunctionComponent)\b/;
    const useContextRegex = /\buseContext\s*\(/;
    const providerJsxRegex = /<\s*[A-Za-z_$][\w$]*\.Provider\b/;
    const tailwindSpaceRegex = /\bspace-(?:x|y)-/;

    for (const filePath of frontendScanTargets) {
      const resolved = resolvePathInsideRepo(repo.repoPath, filePath);
      if (!resolved) continue;
      let content = '';
      try {
        content = await fs.readFile(resolved.absolutePath, 'utf-8');
      } catch {
        continue;
      }

      const ranges = changedRangeByFile.get(filePath) || [];
      const lineNearChanged = (lineNo: number): boolean => {
        if (ranges.length === 0) return true;
        return ranges.some(range => lineNo >= (range.start - 10) && lineNo <= (range.end + 10));
      };

      const lines = content.split('\n');
      const isJsxFile = filePath.endsWith('.tsx') || filePath.endsWith('.jsx');
      const isTsFile = filePath.endsWith('.ts') || filePath.endsWith('.tsx');

      // Prop drilling score (heuristic): identity props + spread props in a single JSX tag.
      if (isJsxFile) {
        const startTagRegex = /<([A-Z][A-Za-z0-9_]*)\b/;
        let currentTag: { component: string; startLine: number; identity: number; spread: number; braceDepth: number; eligible: boolean } | null = null;
        let best: { component: string; line: number; score: number; identity: number; spread: number } | null = null;

        for (let idx = 0; idx < lines.length; idx += 1) {
          const lineNo = idx + 1;
          const rawLine = String(lines[idx] || '');
          const codeLine = rawLine.replace(/\/\/.*$/g, '');
          if (!currentTag) {
            const match = startTagRegex.exec(codeLine);
            if (!match) continue;
            currentTag = {
              component: match[1],
              startLine: lineNo,
              identity: 0,
              spread: 0,
              braceDepth: 0,
              eligible: lineNearChanged(lineNo),
            };
          }

          identityPropRegex.lastIndex = 0;
          spreadPropRegex.lastIndex = 0;
          while (identityPropRegex.exec(codeLine) !== null) currentTag.identity += 1;
          while (spreadPropRegex.exec(codeLine) !== null) currentTag.spread += 1;

          let closed = false;
          for (let col = 0; col < codeLine.length; col += 1) {
            const ch = codeLine[col];
            if (ch === '{') currentTag.braceDepth += 1;
            else if (ch === '}' && currentTag.braceDepth > 0) currentTag.braceDepth -= 1;
            else if (ch === '>' && currentTag.braceDepth === 0) {
              closed = true;
              break;
            }
          }
          if (!closed) continue;

          const score = currentTag.identity + (currentTag.spread * 3);
          if (currentTag.eligible && score >= 6 && (!best || score > best.score)) {
            best = {
              component: currentTag.component,
              line: currentTag.startLine,
              score,
              identity: currentTag.identity,
              spread: currentTag.spread,
            };
          }
          currentTag = null;
        }

        if (best) {
          frontendHygieneSignals.push({
            code: 'prop-drilling-score',
            filePath,
            line: best.line,
            severity: 'low',
            confidence: 0.72,
            reason: 'jsx-prop-drilling-heuristic',
            summary: `Prop drilling score ${best.score} at line ${best.line} (<${best.component} …> passes ${best.identity} identity prop(s) and ${best.spread} spread prop(s)).`,
          });
        }
      }

      // Nested component declarations (heuristic): component defined at braceDepth > 0.
      if (isJsxFile) {
        let inBlockComment = false;
        let braceDepth = 0;
        let nestedCount = 0;
        let firstNested: { name: string; line: number } | null = null;

        const stripComments = (line: string): string => {
          let out = String(line || '');

          if (inBlockComment) {
            const endIdx = out.indexOf('*/');
            if (endIdx === -1) return '';
            out = out.slice(endIdx + 2);
            inBlockComment = false;
          }

          while (true) {
            const blockIdx = out.indexOf('/*');
            const lineIdx = out.indexOf('//');
            if (blockIdx !== -1 && (lineIdx === -1 || blockIdx < lineIdx)) {
              const endIdx = out.indexOf('*/', blockIdx + 2);
              if (endIdx === -1) {
                inBlockComment = true;
                out = out.slice(0, blockIdx);
                break;
              }
              out = out.slice(0, blockIdx) + out.slice(endIdx + 2);
              continue;
            }
            if (lineIdx !== -1) out = out.slice(0, lineIdx);
            break;
          }

          return out;
        };

        for (let idx = 0; idx < lines.length; idx += 1) {
          const lineNo = idx + 1;
          const codeLine = stripComments(lines[idx]).trim();
          if (braceDepth > 0 && lineNearChanged(lineNo)) {
            const fnMatch = nestedComponentFnRegex.exec(codeLine);
            const constMatch = fnMatch ? null : nestedComponentConstRegex.exec(codeLine);
            const nestedName = fnMatch?.[1] || constMatch?.[1] || '';
            if (nestedName) {
              nestedCount += 1;
              if (!firstNested) firstNested = { name: nestedName, line: lineNo };
            }
          }

          for (let col = 0; col < codeLine.length; col += 1) {
            const ch = codeLine[col];
            if (ch === '{') braceDepth += 1;
            else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
          }
        }

        if (nestedCount > 0 && firstNested) {
          frontendHygieneSignals.push({
            code: 'nested-component-declaration',
            filePath,
            line: firstNested.line,
            severity: 'low',
            confidence: 0.78,
            reason: 'nested-react-component-declaration',
            summary: `Nested component declaration detected (${nestedCount}); first is ${firstNested.name} at line ${firstNested.line}.`,
          });
        }
      }

      // Function signatures: > 3 args, and inline param type objects.
      if (isTsFile) {
        let tooManyArgs: { name: string; line: number; count: number } | null = null;
        let inlineParamType: { name: string; line: number } | null = null;

        for (let idx = 0; idx < lines.length; idx += 1) {
          const lineNo = idx + 1;
          if (!lineNearChanged(lineNo)) continue;
          const codeLine = String(lines[idx] || '').replace(/\/\/.*$/g, '');

          const fnMatch = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/.exec(codeLine);
          if (fnMatch) {
            const startIdx = codeLine.indexOf('(', fnMatch.index);
            const group = extractParenGroup(lines, idx, startIdx, 12);
            if (group) {
              const paramCount = countTopLevelParameters(group.text);
              if (!tooManyArgs && paramCount >= 4) {
                tooManyArgs = { name: fnMatch[1], line: lineNo, count: paramCount };
              }
              if (!inlineParamType && inlineParamObjectRegex.test(group.text)) {
                inlineParamType = { name: fnMatch[1], line: lineNo };
              }
            }
          }

          const constMatch = /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\b[^=]*=\s*\(/.exec(codeLine);
          if (constMatch) {
            const eqIdx = codeLine.indexOf('=');
            const startIdx = eqIdx >= 0 ? codeLine.indexOf('(', eqIdx) : -1;
            if (startIdx >= 0) {
              const group = extractParenGroup(lines, idx, startIdx, 12);
              if (group) {
                const tail = String(lines[group.endLineIndex] || '').slice(group.endCharIndex + 1)
                  + ' ' + String(lines[group.endLineIndex + 1] || '');
                if (tail.includes('=>')) {
                  const paramCount = countTopLevelParameters(group.text);
                  if (!tooManyArgs && paramCount >= 4) {
                    tooManyArgs = { name: constMatch[1], line: lineNo, count: paramCount };
                  }
                  if (!inlineParamType && inlineParamObjectRegex.test(group.text)) {
                    inlineParamType = { name: constMatch[1], line: lineNo };
                  }
                }
              }
            }
          }

          if (tooManyArgs && inlineParamType) break;
        }

        if (tooManyArgs) {
          frontendHygieneSignals.push({
            code: 'signature-too-many-args',
            filePath,
            line: tooManyArgs.line,
            severity: 'low',
            confidence: 0.74,
            reason: 'function-signature-arg-count',
            summary: `Function signature has ${tooManyArgs.count} parameters at line ${tooManyArgs.line} (${tooManyArgs.name}). Prefer an options object or variants.`,
          });
        }

        if (inlineParamType) {
          frontendHygieneSignals.push({
            code: 'inline-param-type-object',
            filePath,
            line: inlineParamType.line,
            severity: 'low',
            confidence: 0.84,
            reason: 'typescript-inline-param-object-type',
            summary: `Inline object type in parameter list at line ${inlineParamType.line} (${inlineParamType.name}). Prefer a named type/interface.`,
          });
        }
      }

      // Monorepo conventions (heuristic): avoid default exports, TODO/FIXME, React.FC, legacy Context APIs, and Tailwind space-*.
      {
        let defaultExportLine = 0;
        let todoLine = 0;
        let reactFcLine = 0;
        let useContextLine = 0;
        let providerLine = 0;
        let tailwindSpaceLine = 0;

        for (let idx = 0; idx < lines.length; idx += 1) {
          const lineNo = idx + 1;
          if (!lineNearChanged(lineNo)) continue;

          const rawLine = String(lines[idx] || '');
          const codeLine = rawLine.replace(/\/\/.*$/g, '');

          if (!defaultExportLine && defaultExportRegex.test(codeLine)) defaultExportLine = lineNo;
          if (!todoLine && todoCommentRegex.test(rawLine)) todoLine = lineNo;
          if (!reactFcLine && reactFcRegex.test(codeLine)) reactFcLine = lineNo;
          if (!useContextLine && useContextRegex.test(codeLine)) useContextLine = lineNo;
          if (!providerLine && isJsxFile && providerJsxRegex.test(codeLine)) providerLine = lineNo;
          if (!tailwindSpaceLine && tailwindSpaceRegex.test(codeLine)) tailwindSpaceLine = lineNo;

          if (
            defaultExportLine
            && todoLine
            && reactFcLine
            && useContextLine
            && (!isJsxFile || (providerLine && tailwindSpaceLine))
          ) {
            break;
          }
        }

        if (defaultExportLine) {
          frontendHygieneSignals.push({
            code: 'default-export',
            filePath,
            line: defaultExportLine,
            severity: 'medium',
            confidence: 0.96,
            reason: 'frontend-default-export',
            summary: `Default export detected near line ${defaultExportLine}. Prefer named exports (monorepo convention).`,
          });
        }

        if (todoLine) {
          frontendHygieneSignals.push({
            code: 'todo-comment',
            filePath,
            line: todoLine,
            severity: 'medium',
            confidence: 0.92,
            reason: 'frontend-todo-comment',
            summary: `TODO/FIXME comment detected near line ${todoLine}. Prefer resolving before merge or filing a ticket.`,
          });
        }

        if (reactFcLine) {
          frontendHygieneSignals.push({
            code: 'react-fc',
            filePath,
            line: reactFcLine,
            severity: 'low',
            confidence: 0.9,
            reason: 'frontend-react-fc',
            summary: `React.FC usage detected near line ${reactFcLine}. Prefer explicit props types without React.FC (monorepo convention).`,
          });
        }

        if (useContextLine) {
          frontendHygieneSignals.push({
            code: 'react-usecontext',
            filePath,
            line: useContextLine,
            severity: 'low',
            confidence: 0.8,
            reason: 'frontend-react-usecontext',
            summary: `useContext(...) detected near line ${useContextLine}. Prefer React 19 use(Context) when available (monorepo convention).`,
          });
        }

        if (providerLine) {
          frontendHygieneSignals.push({
            code: 'react-context-provider',
            filePath,
            line: providerLine,
            severity: 'low',
            confidence: 0.8,
            reason: 'frontend-react-context-provider',
            summary: `<Context.Provider ...> detected near line ${providerLine}. Prefer React 19 <Context value={...}> when available (monorepo convention).`,
          });
        }

        if (tailwindSpaceLine) {
          frontendHygieneSignals.push({
            code: 'tailwind-space-class',
            filePath,
            line: tailwindSpaceLine,
            severity: 'low',
            confidence: 0.86,
            reason: 'frontend-tailwind-space-class',
            summary: `Tailwind space-* class detected near line ${tailwindSpaceLine}. Prefer explicit gap/margin (monorepo convention).`,
          });
        }
      }
    }

    const addReviewFinding = (
      findings: ReviewFinding[],
      finding: ReviewFinding,
      dedupe: Set<string>,
    ): void => {
      const key = [
        finding.code,
        finding.evidence?.filePath || '',
        finding.evidence?.symbol?.uid || '',
      ].join('|');
      if (dedupe.has(key)) return;
      dedupe.add(key);
      findings.push({
        ...finding,
        confidence: round3(normalizeConfidence(finding.confidence, 0)),
      });
    };

    let reviewFindings: ReviewFinding[] = [];
    const findingDedupe = new Set<string>();

    for (const filePath of productUntrackedFiles) {
      addReviewFinding(reviewFindings, {
        code: 'untracked-file',
        severity: 'medium',
        summary: `Untracked file requires manual review: ${filePath}.`,
        reason: 'untracked-file-not-indexed',
        confidence: 0.99,
        evidence: {
          filePath,
        },
      }, findingDedupe);
    }

    for (const artifactEntry of toolingArtifactDetails) {
      addReviewFinding(reviewFindings, {
        code: 'tooling-artifact',
        severity: 'low',
        summary: `Known tooling artifact detected: ${artifactEntry.filePath}. ${artifactEntry.artifact.guidance}`,
        reason: artifactEntry.artifact.reason,
        confidence: 0.99,
        evidence: {
          filePath: normalizePath(artifactEntry.filePath),
        },
      }, findingDedupe);
    }

    for (const signal of frontendHygieneSignals.slice(0, 40)) {
      addReviewFinding(reviewFindings, {
        code: signal.code,
        severity: signal.severity,
        summary: signal.summary,
        reason: signal.reason,
        confidence: signal.confidence,
        evidence: {
          filePath: signal.filePath,
          symbol: {
            kind: 'Line',
            startLine: signal.line,
          },
        },
      }, findingDedupe);
    }

    for (const signal of validation_boundary_findings.slice(0, 40)) {
      addReviewFinding(reviewFindings, {
        code: signal.code,
        severity: signal.severity,
        summary: signal.summary,
        reason: signal.snippet || signal.code,
        confidence: signal.confidence,
        evidence: {
          filePath: signal.filePath,
          symbol: {
            kind: 'Line',
            startLine: signal.line,
          },
        },
      }, findingDedupe);
    }

    for (const hotspot of runtime_hotspots.slice(0, 20)) {
      const matchedRoute = Array.isArray(hotspot?.evidence?.matched_routes) ? hotspot.evidence.matched_routes[0] : null;
      const fileHint = Array.isArray(hotspot?.evidence?.span?.file_path_hints)
        ? hotspot.evidence.span.file_path_hints[0]
        : Array.isArray(hotspot?.evidence?.query?.file_path_hints)
          ? hotspot.evidence.query.file_path_hints[0]
          : '';
      const evidenceFilePath = String(
        fileHint
        || matchedRoute?.route_file
        || changedFileObjs[0]?.filePath
        || '',
      ).trim();
      if (!evidenceFilePath) continue;

      addReviewFinding(reviewFindings, {
        code: hotspot.kind === 'db_query' ? 'runtime-db-hotspot' : 'runtime-request-hotspot',
        severity: hotspot.severity === 'high' ? 'high' : hotspot.severity === 'medium' ? 'medium' : 'low',
        summary: `Runtime hotspot overlaps review diff: ${String(hotspot.summary || '').trim()}.`,
        reason: Array.isArray(hotspot.reasons) ? hotspot.reasons.slice(0, 2).join('; ') : 'runtime-observation-hotspot',
        confidence: normalizeConfidence(hotspot.confidence, 0.75),
        evidence: {
          filePath: normalizePath(evidenceFilePath),
          symbol: matchedRoute?.controller
            ? {
              uid: String(matchedRoute.controller.uid || '').trim() || undefined,
              name: String(matchedRoute.controller.name || '').trim() || undefined,
              kind: String(matchedRoute.controller.kind || '').trim() || undefined,
              startLine: toOptionalLineNumber(matchedRoute.controller.startLine),
            }
            : undefined,
        },
      }, findingDedupe);
    }

    for (const focusRoute of runtime_evidence.focus_routes.slice(0, 5)) {
      const filePath = normalizePath(String(
        focusRoute?.route_file
        || (Array.isArray(focusRoute?.file_hints) ? focusRoute.file_hints[0] : '')
        || '',
      )).trim();
      if (!filePath) continue;
      const avgMs = toFiniteNumber(focusRoute?.request_latency_ms?.avg, 0);
      const sqlLockWaitMs = toFiniteNumber(focusRoute?.sql?.lock_wait_ms, 0);
      const severity: ReviewFindingSeverity = (
        avgMs >= 900 || sqlLockWaitMs >= 120
          ? 'high'
          : avgMs >= 450 || sqlLockWaitMs >= 60
            ? 'medium'
            : 'low'
      );
      addReviewFinding(reviewFindings, {
        code: 'runtime-focus-route',
        severity,
        summary: `Focused runtime route evidence: ${String(focusRoute?.method || '')} ${String(focusRoute?.route || '')} avg=${avgMs}ms sql_count=${toFiniteNumber(focusRoute?.sql?.count, 0)} lock_wait=${sqlLockWaitMs}ms.`,
        reason: 'runtime-focus-route-metrics',
        confidence: 0.9,
        evidence: {
          filePath: normalizePath(filePath),
          symbol: focusRoute?.controller
            ? {
              uid: String(focusRoute.controller.uid || '').trim() || undefined,
              name: String(focusRoute.controller.name || '').trim() || undefined,
              kind: String(focusRoute.controller.kind || '').trim() || undefined,
              startLine: toOptionalLineNumber(focusRoute.controller.startLine),
            }
            : undefined,
        },
      }, findingDedupe);
    }

    for (const parityEntry of contract_parity.slice(0, 20)) {
      const parityScore = toFiniteNumber(parityEntry?.parity_score, 0);
      if (parityScore >= 0.65) continue;
      const severity: ReviewFindingSeverity = parityScore < 0.45 ? 'high' : 'medium';
      const filePath = normalizePath(String(
        parityEntry?.route_file
        || parityEntry?.controller?.filePath
        || '',
      )).trim();
      if (!filePath) continue;
      addReviewFinding(reviewFindings, {
        code: 'endpoint-contract-parity-low',
        severity,
        summary: `Endpoint parity low for ${String(parityEntry?.method || '')} ${String(parityEntry?.pattern || '')} (score=${parityScore}).`,
        reason: 'contract-parity-low-score',
        confidence: parityScore < 0.45 ? 0.92 : 0.84,
        evidence: {
          filePath: normalizePath(filePath),
          symbol: parityEntry?.controller
            ? {
              uid: String(parityEntry.controller.uid || '').trim() || undefined,
              name: String(parityEntry.controller.name || '').trim() || undefined,
              kind: String(parityEntry.controller.kind || '').trim() || undefined,
              startLine: toOptionalLineNumber(parityEntry.controller.startLine),
            }
            : undefined,
        },
      }, findingDedupe);
    }

    if (runtimeSource === 'snapshot') {
      for (const perfFinding of perf_backend_findings.slice(0, 30)) {
        addReviewFinding(reviewFindings, {
          code: String(perfFinding.code || 'perf-hot-path'),
          severity: perfFinding.severity,
          summary: `${perfFinding.summary} (${perfFinding.filePath}:${perfFinding.line})`,
          reason: perfFinding.snippet || perfFinding.code,
          confidence: perfFinding.confidence,
          evidence: {
            filePath: normalizePath(perfFinding.filePath),
            symbol: {
              name: perfFinding.code,
              kind: 'File',
              startLine: toOptionalLineNumber(perfFinding.line),
            },
          },
        }, findingDedupe);
      }
    }

    for (const sliceEntry of Array.isArray(slice_stencil?.slices) ? slice_stencil.slices : []) {
      const missingRequiredSlots = Array.isArray(sliceEntry?.stencil_delta?.missing_required_slots)
        ? sliceEntry.stencil_delta.missing_required_slots
        : [];
      const missingRoles = Array.isArray(sliceEntry?.stencil_delta?.missing_roles)
        ? sliceEntry.stencil_delta.missing_roles
        : [];
      const changedMember = Array.isArray(sliceEntry?.changed_members) ? sliceEntry.changed_members[0] : null;
      const filePath = String(changedMember?.filePath || changedFileObjs[0]?.filePath || '').trim();
      if (!filePath) continue;

      if (missingRequiredSlots.length > 0) {
        const deterministic = toFiniteNumber(sliceEntry?.gap_signals?.deterministic, 0) > 0;
        const pattern = toFiniteNumber(sliceEntry?.gap_signals?.pattern, 0) > 0;
        const severity = missingRequiredSlotSeverity(missingRequiredSlots, deterministic, pattern);
        const confidence = severity === 'high'
          ? 0.95
          : severity === 'medium'
            ? (deterministic ? 0.9 : 0.82)
            : 0.75;
        addReviewFinding(reviewFindings, {
          code: 'slice-missing-required-slots',
          severity,
          summary: `Slice ${String(sliceEntry?.slice?.label || sliceEntry?.slice?.heuristicLabel || sliceEntry?.slice?.id || '').trim() || '<unknown>'} is missing required slots: ${missingRequiredSlots.join(', ')}.`,
          reason: deterministic
            ? 'slice-stencil:deterministic-missing-required-slots'
            : pattern
              ? 'slice-stencil:pattern-missing-required-slots'
              : 'slice-stencil:heuristic-missing-required-slots',
          confidence,
          evidence: {
            filePath,
            symbol: changedMember
              ? {
                uid: String(changedMember.uid || '').trim() || undefined,
                name: String(changedMember.name || '').trim() || undefined,
                kind: String(changedMember.kind || '').trim() || undefined,
                startLine: toOptionalLineNumber(changedMember.startLine),
              }
              : undefined,
          },
        }, findingDedupe);
      }

      if (missingRoles.length > 0) {
        addReviewFinding(reviewFindings, {
          code: 'slice-missing-roles',
          severity: 'medium',
          summary: `Slice ${String(sliceEntry?.slice?.label || sliceEntry?.slice?.heuristicLabel || sliceEntry?.slice?.id || '').trim() || '<unknown>'} is missing expected roles: ${missingRoles.join(', ')}.`,
          reason: 'slice-stencil:missing-role-coverage',
          confidence: 0.82,
          evidence: {
            filePath,
            symbol: changedMember
              ? {
                uid: String(changedMember.uid || '').trim() || undefined,
                name: String(changedMember.name || '').trim() || undefined,
                kind: String(changedMember.kind || '').trim() || undefined,
                startLine: toOptionalLineNumber(changedMember.startLine),
              }
              : undefined,
          },
        }, findingDedupe);
      }
    }

    for (const route of route_targets) {
      const routeFile = String(route?.route_file || '').trim();
      if (!routeFile) continue;
      const firstTarget = Array.isArray(route?.targets) ? route.targets[0] : null;
      if (!firstTarget) {
        const hasEndpointSurface = routeFilesWithEndpointSurfaces.has(routeFile);
        addReviewFinding(reviewFindings, {
          code: hasEndpointSurface ? 'route-target-unresolved' : 'route-target-missing',
          severity: hasEndpointSurface ? 'medium' : 'high',
          summary: hasEndpointSurface
            ? `Route file changed with endpoint surfaces but without resolved controller target: ${routeFile}.`
            : `Route file changed without resolved controller target: ${routeFile}.`,
          reason: hasEndpointSurface
            ? 'route-file-endpoint-surface-without-controller-wiring'
            : 'route-file-without-controller-wiring',
          confidence: hasEndpointSurface ? 0.82 : 0.92,
          evidence: { filePath: routeFile },
        }, findingDedupe);
        continue;
      }

      addReviewFinding(reviewFindings, {
        code: 'route-target-changed',
        severity: 'low',
        summary: `Route change maps to ${String(firstTarget?.controller?.name || '<unknown>')}.`,
        reason: String(firstTarget?.edge?.reason || 'laravel-route-edge'),
        confidence: normalizeConfidence(firstTarget?.edge?.confidence, 0.9),
        evidence: {
          filePath: routeFile,
          symbol: {
            uid: String(firstTarget?.controller?.uid || '').trim() || undefined,
            name: String(firstTarget?.controller?.name || '').trim() || undefined,
            kind: String(firstTarget?.controller?.kind || '').trim() || undefined,
            startLine: toOptionalLineNumber(firstTarget?.controller?.startLine),
          },
        },
      }, findingDedupe);
    }

    const authFamily = (Array.isArray(semantic_diffs?.families) ? semantic_diffs.families : [])
      .find((family: any) => String(family?.family || '') === 'auth');
    if (toFiniteNumber(authFamily?.edge_count, 0) > 0 && authz.length === 0) {
      const sampleEdge = Array.isArray(authFamily?.sample_edges) ? authFamily.sample_edges[0] : null;
      const sourceFilePath = String(sampleEdge?.source?.filePath || '').trim();
      addReviewFinding(reviewFindings, {
        code: 'auth-delta-without-closure',
        severity: 'high',
        summary: 'Auth-related edge deltas detected without controller auth closure checks.',
        reason: String(sampleEdge?.edge?.reason || 'auth-family-delta-without-authz'),
        confidence: normalizeConfidence(sampleEdge?.edge?.confidence, 0.85),
        evidence: {
          filePath: sourceFilePath || changedFileObjs[0]?.filePath || '',
          symbol: sampleEdge?.source
            ? {
              uid: String(sampleEdge.source.uid || '').trim() || undefined,
              name: String(sampleEdge.source.name || '').trim() || undefined,
              kind: String(sampleEdge.source.kind || '').trim() || undefined,
            }
            : undefined,
        },
      }, findingDedupe);
    }

    const hasScopeChangeSignals = changedFileObjs.length > 0
      || changedSymbolCountTotal > 0
      || runtime_hotspots.length > 0
      || contract_parity.length > 0
      || perf_backend_findings.length > 0;
    if (reviewFindings.length === 0 && hasScopeChangeSignals) {
      const fallbackFilePath = normalizePath(String(changedFileObjs[0]?.filePath || analysisSymbols[0]?.filePath || ''));
      if (fallbackFilePath) {
        addReviewFinding(reviewFindings, {
          code: 'low-signal-review-fallback',
          severity: 'low',
          summary: `Low-signal review fallback for ${fallbackFilePath}; no high-confidence risk findings were emitted.`,
          reason: 'no-high-confidence-findings',
          confidence: 0.62,
          evidence: {
            filePath: fallbackFilePath,
            symbol: analysisSymbols[0]
              ? {
                  uid: String(analysisSymbols[0]?.uid || '').trim() || undefined,
                  name: String(analysisSymbols[0]?.name || '').trim() || undefined,
                  kind: String(analysisSymbols[0]?.kind || '').trim() || undefined,
                  startLine: toOptionalLineNumber(analysisSymbols[0]?.startLine),
                }
              : undefined,
          },
        }, findingDedupe);
      }
    }

    const review_kernel: any = buildReviewKernel({
      changed_files: changedFileObjs.length,
      untracked_files: productUntrackedFiles.length,
      untracked_artifacts: toolingArtifactDetails.length,
      changed_symbols: changedSymbolCountTotal,
      suggested_tests: suggested_tests.length,
      frontend_hygiene_findings: frontendHygieneSignals.length,
      ui_contracts: ui_contracts.length,
      route_files: route_targets.length,
      authz_controllers: authz.length,
      runtime_hotspots: runtime_hotspots.length,
      runtime_evidence_routes: runtime_evidence.routes.length,
      runtime_focus_routes: runtime_evidence.focus_routes.length,
      contract_parity_routes: contract_parity.length,
      contract_parity_low: contract_parity.filter(item => toFiniteNumber(item?.parity_score, 0) < 0.65).length,
      perf_backend_findings: perf_backend_findings.length,
      runtime_source: runtimeSource,
      semantic_diffs,
      slice_stencil,
      scope: effectiveScope,
      path_prefixes: pathPrefixes,
    });

    const severityRank: Record<ReviewFindingSeverity, number> = { high: 3, medium: 2, low: 1 };
    const compareFindingsRisk = (left: ReviewFinding, right: ReviewFinding): number => {
      const leftRank = severityRank[left.severity] || 0;
      const rightRank = severityRank[right.severity] || 0;
      if (rightRank !== leftRank) return rightRank - leftRank;
      if (right.confidence !== left.confidence) return right.confidence - left.confidence;
      return 0;
    };
    const compareFindingsLegacy = (left: ReviewFinding, right: ReviewFinding): number => {
      const risk = compareFindingsRisk(left, right);
      if (risk !== 0) return risk;
      return left.summary.localeCompare(right.summary);
    };
    const findingKey = (finding: ReviewFinding): string => {
      return [
        String(finding?.code || '').trim(),
        normalizePath(String(finding?.evidence?.filePath || '')),
        String(finding?.summary || '').trim(),
      ].join('|');
    };
    const findingsWithSignals = reviewFindings
      .map((finding, sourceIndex) => {
        const filePath = normalizePath(String(finding?.evidence?.filePath || ''));
        const signal = getConvergenceSignal(filePath, [
          finding.summary,
          finding.reason,
          finding.code,
          finding.evidence?.symbol?.name || '',
        ]);
        const convergenceScore = round3(toFiniteNumber(signal?.score, 0));
        const severityScore = toFiniteNumber(severityRank[finding.severity], 0);
        const confidenceScore = normalizeConfidence(finding.confidence, 0);
        const rankScore = round3(
          (severityScore * REVIEW_CONVERGENCE_RANK_WEIGHTS.findings.severity)
          + (confidenceScore * REVIEW_CONVERGENCE_RANK_WEIGHTS.findings.confidence)
          + (convergenceScore * REVIEW_CONVERGENCE_RANK_WEIGHTS.findings.convergence),
        );
        return {
          ...finding,
          ranking: {
            score: rankScore,
            components: {
              severity: round3(severityScore),
              confidence: round3(confidenceScore),
              convergence: convergenceScore,
            },
          },
          ...(convergenceScore > 0
            ? {
                convergence: {
                  score: convergenceScore,
                  cluster: String(signal?.cluster || '').trim(),
                  signature: String(signal?.signature || '').trim(),
                  route: String(signal?.route || '').trim(),
                },
              }
            : {}),
          __convergence_score: convergenceScore,
          __rank_score: rankScore,
          __source_index: sourceIndex,
        };
      });
    const findingsBaseOrder = findingsWithSignals
      .slice()
      .sort((left, right) => compareFindingsLegacy(left, right))
      .map(finding => findingKey(finding));
    findingsWithSignals.sort((left, right) => {
      const leftRank = toFiniteNumber((left as any)?.__rank_score, 0);
      const rightRank = toFiniteNumber((right as any)?.__rank_score, 0);
      if (rightRank !== leftRank) return rightRank - leftRank;
      const base = compareFindingsRisk(left, right);
      if (base !== 0) return base;
      const leftConvergence = toFiniteNumber((left as any)?.__convergence_score, 0);
      const rightConvergence = toFiniteNumber((right as any)?.__convergence_score, 0);
      if (rightConvergence !== leftConvergence) return rightConvergence - leftConvergence;
      const summarySort = String(left?.summary || '').localeCompare(String(right?.summary || ''));
      if (summarySort !== 0) return summarySort;
      return toFiniteNumber((left as any)?.__source_index, 0) - toFiniteNumber((right as any)?.__source_index, 0);
    });
    const findingsRankedOrder = findingsWithSignals.map(finding => findingKey(finding));
    const findingsBoosted = findingsWithSignals
      .filter(finding => toFiniteNumber((finding as any)?.__convergence_score, 0) > 0)
      .length;
    const findingsReordered = findingsBaseOrder.join('|') !== findingsRankedOrder.join('|');
    reviewFindings = findingsWithSignals.map((finding: any) => {
      const { __convergence_score, __rank_score, __source_index, ...rest } = finding || {};
      return rest;
    });

    if (reviewFindings.length > 0) {
      review_kernel.top_findings = Array.from(new Set(reviewFindings.map(finding => finding.summary))).slice(0, 8);
    }
    const lowSignalFallbackFindingCount = reviewFindings
      .filter(finding => String(finding?.code || '') === 'low-signal-review-fallback')
      .length;
    review_kernel.findings = reviewFindings.slice(0, 30);
    review_kernel.findings_summary = {
      total: reviewFindings.length,
      high: reviewFindings.filter(finding => finding.severity === 'high').length,
      medium: reviewFindings.filter(finding => finding.severity === 'medium').length,
      low: reviewFindings.filter(finding => finding.severity === 'low').length,
    };
    if (findingsBoosted > 0 && Array.isArray(review_kernel.next_actions)) {
      review_kernel.next_actions = [
        'Start with convergence-prioritized findings and tests to mirror strongest in-repo implementation patterns.',
        ...review_kernel.next_actions,
      ].slice(0, 8);
    }

    const symbolizedFileSet = new Set(
      analysisSymbols
        .map(symbol => normalizePath(String(symbol?.filePath || '')))
        .filter(Boolean),
    );
    const symbolizedFileCount = changedFileObjs.reduce((count, file) => {
      if (file.status === 'Deleted') return count;
      const filePath = normalizePath(String(file?.filePath || ''));
      if (!filePath) return count;
      return symbolizedFileSet.has(filePath) ? count + 1 : count;
    }, 0);
    const coverage_banner = buildCoverageBanner({
      changedFileCount: changedFileObjs.length,
      untrackedFileCount: productUntrackedFiles.length,
      untrackedArtifactCount: toolingArtifactDetails.length,
      changedSymbolCount: analysisSymbols.length,
      changedSymbolTotal: changedSymbolCountTotal,
      changedSymbolCap: analysisSymbolCap,
      suggestedTestCount: suggested_tests.length,
      symbolizedFileCount,
      runtimeHotspotCount: runtime_hotspots.length,
      runtimeSource,
      runtimeGeneratedAt: runtimeSnapshot.generatedAt || '',
      runtimeSourceFiles: runtimeSnapshot.source_files,
    });
    if (
      analysisSymbols.length > 0
      && suggested_tests.length === 0
      && (suggestedTestsSuppressedLowRank > 0 || suggestedTestsSuppressedLowAffinity > 0)
      && Array.isArray((coverage_banner as any)?.warnings)
    ) {
      coverage_banner.warnings.push(
        `Suggested tests suppressed due to low confidence/affinity (min_rank=${SUGGESTED_TEST_MIN_RANK}, min_affinity=${SUGGESTED_TEST_MIN_AFFINITY}); treat as "no confident suggested tests".`,
      );
    }
    if (
      runtimeSource === 'none'
      && perf_backend_findings.length > 0
      && Array.isArray((coverage_banner as any)?.warnings)
    ) {
      coverage_banner.warnings.push(
        'perf_backend_findings detected but not promoted into review findings without a runtime snapshot; ingest runtime evidence and re-run review_mode for perf/merge-safety prioritization.',
      );
    }
    const convergenceMeta = {
      enabled: Boolean(convergenceMatrix),
      source_path: convergenceMatrix?.sourcePath || null,
      matrix_cells: Array.isArray(convergenceMatrix?.cells) ? convergenceMatrix.cells.length : 0,
      suggested_tests_boosted: suggestedTestsBoosted,
      suggested_tests_reordered: suggestedTestsReordered,
      suggested_tests_scope_fallback: scopeFallbackSuggestedTests,
      suggested_tests_candidates: suggestedTestsRanked.length,
      suggested_tests_candidates_post_filter: suggestedTestsFiltered.length,
      suggested_tests_suppressed_low_rank: suggestedTestsSuppressedLowRank,
      suggested_tests_suppressed_low_affinity: suggestedTestsSuppressedLowAffinity,
      suggested_tests_min_rank: SUGGESTED_TEST_MIN_RANK,
      suggested_tests_min_affinity: SUGGESTED_TEST_MIN_AFFINITY,
      findings_boosted: findingsBoosted,
      findings_reordered: findingsReordered,
      low_signal_fallback_findings: lowSignalFallbackFindingCount,
      ranking_weights: REVIEW_CONVERGENCE_RANK_WEIGHTS,
    };

    return {
      status: 'ok',
      repo: repo.name,
      scope,
      base_ref: baseRef || undefined,
      path_prefixes: pathPrefixes,
      summary: {
        changed_files: changedFileObjs.length,
        untracked_files: productUntrackedFiles.length,
        untracked_artifacts: toolingArtifactDetails.length,
        changed_symbols: changedSymbolCountTotal,
        suggested_tests: suggested_tests.length,
        suggested_test_commands: test_commands.length,
        ui_contracts: ui_contracts.length,
        route_files: route_targets.length,
        authz_controllers: authz.length,
        runtime_hotspots: runtime_hotspots.length,
        runtime_evidence_routes: runtime_evidence.routes.length,
        runtime_focus_routes: runtime_evidence.focus_routes.length,
        contract_parity_routes: contract_parity.length,
        contract_parity_low: contract_parity.filter(item => toFiniteNumber(item?.parity_score, 0) < 0.65).length,
        perf_backend_findings: perf_backend_findings.length,
        regression_failure_candidates: regressionCandidateTests.length,
        preexisting_failure_candidates: baselineWatchlistTests.length,
        semantic_families: semantic_diffs.summary.family_count,
        semantic_gap_signals: semantic_diffs.summary.gap_signals,
        proof_symbols: proof_pack.summary.symbol_spans,
        proof_edges: proof_pack.summary.edge_spans,
        stencil_slices: slice_stencil.summary.changed_slices,
        stencil_templates: slice_stencil.summary.with_templates,
      },
      coverage_banner,
      untracked_files: productUntrackedFiles,
      untracked_artifacts: toolingArtifactDetails.map(entry => ({
        filePath: normalizePath(entry.filePath),
        reason: entry.artifact.reason,
        guidance: entry.artifact.guidance,
      })),
      changed_files: changedFileObjs.map(f => ({
        filePath: normalizePath(f.filePath),
        status: f.status,
        ...(f.fromPath ? { fromPath: normalizePath(f.fromPath) } : {}),
        hunks: f.hunks,
        ...(f.binary ? { binary: true } : {}),
      })),
      changed_symbols: changedSymbols,
      symbols,
      suggested_tests,
      test_commands,
      ui_contracts,
      route_targets,
      contract_parity: contract_parity.slice(0, 30),
      runtime_evidence,
      perf_backend_findings: perf_backend_findings.slice(0, 40),
      test_intelligence,
      authz,
      runtime_hotspots: runtime_hotspots.slice(0, 20),
      semantic_diffs,
      proof_pack,
      slice_stencil,
      review_kernel,
      _review_mode: {
        diff: {
          requested_scope: scope,
          effective_scope: effectiveScope,
          fallback_applied: diffSource !== 'requested',
          source: diffSource,
        },
        knobs: {
          limit_symbols: limitSymbols,
          analysis_symbol_cap: analysisSymbolCap,
          changed_symbol_total: changedSymbolCountTotal,
          changed_symbols_truncated: changedSymbolsTruncated,
          limit_callers: limitCallers,
          limit_tests: limitTests,
          min_confidence: minConfidence,
          include_ui_contracts: includeUiContracts,
          max_ui_contract_files: maxUiContractFiles,
          include_evidence_spans: includeEvidenceSpans,
          limit_evidence: limitEvidence,
          include_slice_stencil: includeSliceStencil,
          limit_slice_stencil: limitSliceStencil,
          runtime_source: runtimeSource,
          runtime_source_files: runtimeSnapshot.source_files,
        },
        convergence: convergenceMeta,
      },
    };
}
