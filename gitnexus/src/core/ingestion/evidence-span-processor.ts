import { KnowledgeGraph } from '../graph/types.js';

export type EvidenceSpanRole = 'primary' | 'witness' | 'proof';

export interface EvidenceSpan {
  filePath: string;
  startLine: number;
  endLine: number;
  role: EvidenceSpanRole;
}

export interface NodeEvidence {
  nodeId: string;
  nodeLabel: string;
  nodeName: string;
  primarySpan: EvidenceSpan;
  witnessSpans: EvidenceSpan[];
  proofSpans: EvidenceSpan[];
}

export interface EdgeEvidence {
  edgeId: string;
  relationType: string;
  sourceId: string;
  targetId: string;
  reason: string;
  witnessSpans: EvidenceSpan[];
  proofSpans: EvidenceSpan[];
}

export interface EvidenceSpanSnapshot {
  version: 1;
  generatedAt: string;
  stats: {
    nodeEvidenceCount: number;
    edgeEvidenceCount: number;
    uniqueFiles: number;
    primarySpanCount: number;
    witnessSpanCount: number;
    proofSpanCount: number;
  };
  nodes: NodeEvidence[];
  edges: EdgeEvidence[];
}

const normalizePath = (value: unknown): string => {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
};

const clampLine = (value: unknown, fallback: number): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
};

const spanKey = (span: EvidenceSpan): string => {
  return `${span.filePath}:${span.startLine}:${span.endLine}:${span.role}`;
};

const dedupeSpans = (spans: EvidenceSpan[]): EvidenceSpan[] => {
  const byKey = new Map<string, EvidenceSpan>();
  for (const span of spans) {
    if (!span.filePath || span.startLine <= 0 || span.endLine <= 0) continue;
    byKey.set(spanKey(span), span);
  }
  return Array.from(byKey.values()).sort((a, b) => {
    if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    if (a.endLine !== b.endLine) return a.endLine - b.endLine;
    return a.role.localeCompare(b.role);
  });
};

const toRoleSpan = (span: EvidenceSpan, role: EvidenceSpanRole): EvidenceSpan => ({
  filePath: span.filePath,
  startLine: span.startLine,
  endLine: span.endLine,
  role,
});

const createPrimarySpan = (node: KnowledgeGraph['nodes'][number]): EvidenceSpan | null => {
  const filePath = normalizePath(node.properties?.filePath);
  if (!filePath) return null;

  const startLine = clampLine(node.properties?.startLine, 1);
  const endLineRaw = clampLine(node.properties?.endLine, startLine);
  const endLine = endLineRaw >= startLine ? endLineRaw : startLine;

  return {
    filePath,
    startLine,
    endLine,
    role: 'primary',
  };
};

const hasProofSignal = (relationType: string, reason: string): boolean => {
  if (reason.trim().length > 0) return true;
  return relationType === 'CALLS'
    || relationType === 'DEFINES'
    || relationType === 'READS_FIELD'
    || relationType === 'WRITES_FIELD'
    || relationType === 'INVALIDATES_KEY'
    || relationType === 'SERIALIZES_FIELD'
    || relationType === 'VALIDATES_FIELD'
    || relationType === 'MEMBER_OF'
    || relationType === 'STEP_IN_PROCESS';
};

export const processEvidenceSpans = async (
  knowledgeGraph: KnowledgeGraph,
  onProgress?: (message: string, progress: number) => void,
): Promise<EvidenceSpanSnapshot> => {
  onProgress?.('Collecting primary node spans...', 10);

  const primaryByNodeId = new Map<string, EvidenceSpan>();
  const nodeEvidence: NodeEvidence[] = [];

  for (const node of knowledgeGraph.nodes) {
    const primarySpan = createPrimarySpan(node);
    if (!primarySpan) continue;

    primaryByNodeId.set(node.id, primarySpan);

    const witnessSpans = dedupeSpans([toRoleSpan(primarySpan, 'witness')]);
    const proofSpans = dedupeSpans([toRoleSpan(primarySpan, 'proof')]);

    nodeEvidence.push({
      nodeId: node.id,
      nodeLabel: node.label,
      nodeName: String(node.properties?.name || ''),
      primarySpan,
      witnessSpans,
      proofSpans,
    });
  }

  onProgress?.('Collecting edge witness/proof spans...', 55);

  const edgeEvidence: EdgeEvidence[] = [];
  for (const rel of knowledgeGraph.relationships) {
    const sourcePrimary = primaryByNodeId.get(rel.sourceId);
    const targetPrimary = primaryByNodeId.get(rel.targetId);
    if (!sourcePrimary && !targetPrimary) continue;

    const witnessSpans = dedupeSpans([
      ...(sourcePrimary ? [toRoleSpan(sourcePrimary, 'witness')] : []),
      ...(targetPrimary ? [toRoleSpan(targetPrimary, 'witness')] : []),
    ]);

    const proofSpans = hasProofSignal(rel.type, rel.reason || '')
      ? dedupeSpans([
        ...(sourcePrimary ? [toRoleSpan(sourcePrimary, 'proof')] : []),
        ...(targetPrimary ? [toRoleSpan(targetPrimary, 'proof')] : []),
      ])
      : [];

    if (witnessSpans.length === 0 && proofSpans.length === 0) continue;

    edgeEvidence.push({
      edgeId: rel.id,
      relationType: rel.type,
      sourceId: rel.sourceId,
      targetId: rel.targetId,
      reason: rel.reason || '',
      witnessSpans,
      proofSpans,
    });
  }

  onProgress?.('Finalizing evidence span snapshot...', 95);

  const fileKeys = new Set<string>();
  let primarySpanCount = 0;
  let witnessSpanCount = 0;
  let proofSpanCount = 0;

  for (const node of nodeEvidence) {
    primarySpanCount += 1;
    witnessSpanCount += node.witnessSpans.length;
    proofSpanCount += node.proofSpans.length;
    fileKeys.add(node.primarySpan.filePath);
  }
  for (const edge of edgeEvidence) {
    witnessSpanCount += edge.witnessSpans.length;
    proofSpanCount += edge.proofSpans.length;
    for (const span of edge.witnessSpans) fileKeys.add(span.filePath);
    for (const span of edge.proofSpans) fileKeys.add(span.filePath);
  }

  onProgress?.('Evidence span snapshot complete.', 100);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    stats: {
      nodeEvidenceCount: nodeEvidence.length,
      edgeEvidenceCount: edgeEvidence.length,
      uniqueFiles: fileKeys.size,
      primarySpanCount,
      witnessSpanCount,
      proofSpanCount,
    },
    nodes: nodeEvidence,
    edges: edgeEvidence,
  };
};
