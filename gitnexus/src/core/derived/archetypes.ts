import { KnowledgeGraph } from '../graph/types.js';

export type ProcessStepInfo = {
  step: number;
  nodeId: string;
  name: string;
  filePath: string;
  type: string;
};

export type ProcessTraceInfo = {
  id: string;
  label: string;
  heuristicLabel: string;
  processType: string;
  stepCount: number;
  steps: ProcessStepInfo[];
};

export type HttpEdgeInfo = {
  sourceId: string;
  targetId: string;
  reason: string;
  confidence: number;
};

export type ArchetypeExample = {
  processId: string;
  label: string;
  stepCount: number;
  entry: { name: string; filePath: string; type: string };
  terminal: { name: string; filePath: string; type: string };
  httpRoutes: string[];
};

export type ArchetypeSignature = {
  signature: string;
  count: number;
  crossStack: boolean;
  topHttpRoutes: Array<{ route: string; count: number }>;
  exampleProcesses: ArchetypeExample[];
};

export type ArchetypeReport = {
  generatedAt: string;
  totalProcesses: number;
  uniqueSignatures: number;
  signatures: ArchetypeSignature[];
};

export type ArchetypeReportOptions = {
  limit?: number;
  examplesPerSignature?: number;
  minHttpConfidence?: number;
};

const normalizeFilePath = (filePath: string): string => filePath.replace(/\\/g, '/').replace(/^\/+/, '');

const looksLikeFilePath = (value: string): boolean => typeof value === 'string' && value.length > 0;

const parseHttpVerb = (reason: string): string | null => {
  const trimmed = String(reason || '').trim();
  if (!trimmed.startsWith('http-')) return null;
  const after = trimmed.slice('http-'.length);
  const idx = after.indexOf(':');
  if (idx === -1) return null;
  const verb = after.slice(0, idx).trim();
  return verb.length > 0 ? verb : null;
};

export const deriveLayerTag = (filePath: string): string => {
  const fp = normalizeFilePath(filePath);
  const lower = fp.toLowerCase();

  if (lower.endsWith('.blade.php')) return 'Template:Blade';

  if (lower.endsWith('.svelte')) return 'FE:Svelte';

  // Monorepo conventions
  if (lower.startsWith('apps/dashboard/')) {
    if (lower.includes('/src/pages/')) return 'FE:Page';
    if (lower.includes('/src/customhooks/') || lower.includes('/src/hooks/')) return 'FE:Hook';
    if (lower.includes('/src/api/')) return 'FE:Api';
    if (lower.includes('/src/querykeys/') || lower.includes('/src/query-keys/')) return 'FE:QueryKey';
    if (lower.includes('/src/components/')) return 'FE:Component';
    if (lower.includes('/src/stores/') || lower.includes('/src/store/')) return 'FE:Store';
    if (lower.includes('/src/lib/')) return 'FE:Lib';
    if (lower.includes('/src/utils/') || lower.includes('/src/helpers/')) return 'FE:Util';
    return 'FE:Dashboard';
  }

  if (lower.startsWith('apps/backend/')) {
    if (lower.includes('/routes/')) return 'BE:Routes';
    if (lower.includes('/app/http/controllers/')) return 'BE:Controller';
    if (lower.includes('/app/http/requests/')) return 'BE:FormRequest';
    if (lower.includes('/app/http/resources/')) return 'BE:Resource';
    if (lower.includes('/app/models/')) return 'BE:Model';
    if (lower.includes('/app/policies/')) return 'BE:Policy';
    if (lower.includes('/app/services/')) return 'BE:Service';
    if (lower.includes('/app/jobs/')) return 'BE:Job';
    if (lower.includes('/app/listeners/')) return 'BE:Listener';
    if (lower.includes('/app/events/')) return 'BE:Event';
    if (lower.includes('/app/console/')) return 'BE:Console';
    if (lower.includes('/app/providers/')) return 'BE:Provider';
    if (lower.includes('/app/mail/')) return 'BE:Mail';
    if (lower.includes('/app/notifications/')) return 'BE:Notification';
    return 'BE:Backend';
  }

  // Generic Laravel conventions (non-monorepo)
  if (lower.includes('/routes/')) return 'BE:Routes';
  if (lower.includes('/http/controllers/')) return 'BE:Controller';
  if (lower.includes('/http/requests/')) return 'BE:FormRequest';
  if (lower.includes('/http/resources/')) return 'BE:Resource';
  if (lower.includes('/models/')) return 'BE:Model';
  if (lower.includes('/policies/')) return 'BE:Policy';
  if (lower.includes('/services/')) return 'BE:Service';

  // Generic frontend conventions
  if (lower.includes('/src/pages/')) return 'FE:Page';
  if (lower.includes('/src/hooks/') || lower.includes('/src/customhooks/')) return 'FE:Hook';
  if (lower.includes('/src/api/')) return 'FE:Api';
  if (lower.includes('/src/querykeys/') || lower.includes('/src/query-keys/')) return 'FE:QueryKey';

  // Extension fallbacks
  if (lower.endsWith('.php')) return 'BE:PHP';
  if (lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.js') || lower.endsWith('.jsx')) return 'FE:TS';

  return 'Other';
};

export const extractProcessesFromGraph = (graph: KnowledgeGraph): ProcessTraceInfo[] => {
  const nodeById = new Map(graph.nodes.map(n => [n.id, n]));
  const processNodes = graph.nodes.filter(n => n.label === 'Process');

  const processById = new Map<string, ProcessTraceInfo>();
  for (const node of processNodes) {
    processById.set(node.id, {
      id: node.id,
      label: node.properties.name || node.id,
      heuristicLabel: (node.properties as any).heuristicLabel || node.properties.name || node.id,
      processType: String((node.properties as any).processType || ''),
      stepCount: Number((node.properties as any).stepCount || 0),
      steps: [],
    });
  }

  for (const rel of graph.relationships) {
    if (rel.type !== 'STEP_IN_PROCESS') continue;
    const process = processById.get(rel.targetId);
    if (!process) continue;
    const node = nodeById.get(rel.sourceId);
    if (!node) continue;

    const step = Number((rel as any).step || 0);
    process.steps.push({
      step,
      nodeId: node.id,
      name: node.properties.name || '',
      filePath: node.properties.filePath || '',
      type: node.label,
    });
  }

  for (const proc of processById.values()) {
    proc.steps.sort((a, b) => a.step - b.step);
    if (!proc.stepCount) proc.stepCount = proc.steps.length;
  }

  return Array.from(processById.values()).filter(p => p.steps.length > 0);
};

export const extractHttpEdgesFromGraph = (graph: KnowledgeGraph, minConfidence = 0.9): HttpEdgeInfo[] => {
  return graph.relationships
    .filter(r => r.type === 'CALLS'
      && typeof r.reason === 'string'
      && r.reason.startsWith('http-')
      && (r.confidence ?? 0) >= minConfidence)
    .map(r => ({
      sourceId: r.sourceId,
      targetId: r.targetId,
      reason: r.reason,
      confidence: r.confidence,
    }));
};

export const buildArchetypeReport = (
  processes: ProcessTraceInfo[],
  httpEdges: HttpEdgeInfo[],
  options: ArchetypeReportOptions = {}
): ArchetypeReport => {
  const limit = Math.max(1, Math.min(100, options.limit ?? 25));
  const examplesPerSignature = Math.max(1, Math.min(10, options.examplesPerSignature ?? 3));
  const minHttpConfidence = options.minHttpConfidence ?? 0.9;

  const httpEdgeMap = new Map<string, HttpEdgeInfo>();
  for (const edge of httpEdges) {
    if ((edge.confidence ?? 0) < minHttpConfidence) continue;
    httpEdgeMap.set(`${edge.sourceId}::${edge.targetId}`, edge);
  }

  type SigAgg = {
    signature: string;
    processes: Array<{ proc: ProcessTraceInfo; httpRoutes: string[] }>;
    httpRouteCounts: Map<string, number>;
    crossStack: boolean;
  };

  const bySignature = new Map<string, SigAgg>();

  for (const proc of processes) {
    const steps = proc.steps.filter(s => looksLikeFilePath(s.filePath));
    if (steps.length === 0) continue;

    const tokens: string[] = [];
    const httpRoutes: string[] = [];

    const pushToken = (token: string) => {
      if (tokens.length > 0 && tokens[tokens.length - 1] === token) return;
      tokens.push(token);
    };

    for (let i = 0; i < steps.length; i++) {
      const curr = steps[i];
      pushToken(deriveLayerTag(curr.filePath));

      if (i + 1 < steps.length) {
        const next = steps[i + 1];
        const httpEdge = httpEdgeMap.get(`${curr.nodeId}::${next.nodeId}`);
        if (httpEdge) {
          const verb = parseHttpVerb(httpEdge.reason);
          pushToken(verb ? `HTTP:${verb.toUpperCase()}` : 'HTTP');
          httpRoutes.push(httpEdge.reason);
        }
      }
    }

    const signature = tokens.join(' → ');
    if (!signature) continue;

    const crossStack = tokens.some(t => t.startsWith('HTTP:') || t.startsWith('HTTP'))
      || (tokens.some(t => t.startsWith('FE:')) && tokens.some(t => t.startsWith('BE:')))
      || (tokens.some(t => t.startsWith('FE:')) && tokens.some(t => t.startsWith('Template:')))
      || (tokens.some(t => t.startsWith('BE:')) && tokens.some(t => t.startsWith('Template:')));

    let agg = bySignature.get(signature);
    if (!agg) {
      agg = { signature, processes: [], httpRouteCounts: new Map(), crossStack };
      bySignature.set(signature, agg);
    }

    for (const route of new Set(httpRoutes)) {
      agg.httpRouteCounts.set(route, (agg.httpRouteCounts.get(route) || 0) + 1);
    }

    agg.crossStack = agg.crossStack || crossStack;
    agg.processes.push({ proc, httpRoutes: Array.from(new Set(httpRoutes)) });
  }

  const signatures: ArchetypeSignature[] = Array.from(bySignature.values())
    .sort((a, b) => b.processes.length - a.processes.length)
    .slice(0, limit)
    .map(agg => {
      const topHttpRoutes = Array.from(agg.httpRouteCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([route, count]) => ({ route, count }));

      const exampleProcesses = agg.processes
        .slice()
        .sort((a, b) => (b.proc.stepCount || b.proc.steps.length) - (a.proc.stepCount || a.proc.steps.length))
        .slice(0, examplesPerSignature)
        .map(({ proc, httpRoutes }): ArchetypeExample => {
          const entry = proc.steps[0];
          const terminal = proc.steps.at(-1) || proc.steps[0];

          return {
            processId: proc.id,
            label: proc.heuristicLabel || proc.label || proc.id,
            stepCount: proc.stepCount || proc.steps.length,
            entry: { name: entry?.name || '', filePath: entry?.filePath || '', type: entry?.type || '' },
            terminal: { name: terminal?.name || '', filePath: terminal?.filePath || '', type: terminal?.type || '' },
            httpRoutes,
          };
        });

      return {
        signature: agg.signature,
        count: agg.processes.length,
        crossStack: agg.crossStack,
        topHttpRoutes,
        exampleProcesses,
      };
    });

  return {
    generatedAt: new Date().toISOString(),
    totalProcesses: processes.length,
    uniqueSignatures: bySignature.size,
    signatures,
  };
};

