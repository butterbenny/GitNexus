import { generateId } from '../../lib/utils.js';
import { GraphNode, GraphRelationship, KnowledgeGraph } from '../graph/types.js';

type ProvenanceCertainty = 'deterministic' | 'assisted' | 'heuristic';

export interface ProvenanceResult {
  edges: GraphRelationship[];
  stats: {
    emittedEdges: number;
    routeExpansionEdges: number;
    enumToSlugEdges: number;
    configDrivenEdges: number;
    compiledArtifactEdges: number;
    frameworkDerivedEdges: number;
    skippedDuplicates: number;
    skippedMalformed: number;
  };
}

const normalizePath = (value: unknown): string => {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
};

const isEndpointNode = (node: GraphNode): boolean => {
  if (node.label !== 'CodeElement') return false;
  const id = String(node.id || '');
  const name = String(node.properties?.name || '');
  return id.startsWith('CodeElement:endpoint:') || name.startsWith('endpoint:');
};

const isPermissionNode = (node: GraphNode): boolean => {
  if (node.label !== 'CodeElement') return false;
  const id = String(node.id || '');
  const name = String(node.properties?.name || '');
  return id.startsWith('CodeElement:permission:') || name.startsWith('permission:');
};

const isRoleNode = (node: GraphNode): boolean => {
  if (node.label !== 'CodeElement') return false;
  const name = String(node.properties?.name || '');
  return name.startsWith('role:');
};

const isConfigPermissionsPath = (filePath: string): boolean => {
  return /(^|\/)config\/permissions\.php$/i.test(filePath);
};

const makeReason = (family: string, certainty: ProvenanceCertainty): string => {
  return `provenance:${family}:${certainty}`;
};

export const processProvenanceEdges = async (
  knowledgeGraph: KnowledgeGraph,
  onProgress?: (message: string, progress: number) => void,
): Promise<ProvenanceResult> => {
  onProgress?.('Scanning graph for derived/provenance artifacts...', 10);

  const nodeById = new Map<string, GraphNode>();
  const fileNodeIdByPath = new Map<string, string>();
  for (const node of knowledgeGraph.nodes) {
    nodeById.set(node.id, node);
    if (node.label !== 'File') continue;
    const filePath = normalizePath(node.properties?.filePath);
    if (!filePath) continue;
    if (!fileNodeIdByPath.has(filePath)) fileNodeIdByPath.set(filePath, node.id);
  }

  const existingPairs = new Set<string>(
    knowledgeGraph.relationships.map(rel => `${rel.type}|${rel.sourceId}|${rel.targetId}`),
  );
  const emittedPairs = new Set<string>();

  const edges: GraphRelationship[] = [];
  let routeExpansionEdges = 0;
  let enumToSlugEdges = 0;
  let configDrivenEdges = 0;
  let compiledArtifactEdges = 0;
  let frameworkDerivedEdges = 0;
  let skippedDuplicates = 0;
  let skippedMalformed = 0;

  const addEdge = (
    sourceId: string,
    targetId: string,
    family: string,
    certainty: ProvenanceCertainty,
    confidence: number,
    counter: 'route' | 'enum' | 'config' | 'compiled' | 'framework',
  ): void => {
    if (!sourceId || !targetId || sourceId === targetId) {
      skippedMalformed++;
      return;
    }
    if (!nodeById.has(sourceId) || !nodeById.has(targetId)) {
      skippedMalformed++;
      return;
    }

    const pair = `DERIVES_FROM|${sourceId}|${targetId}`;
    if (existingPairs.has(pair) || emittedPairs.has(pair)) {
      skippedDuplicates++;
      return;
    }
    emittedPairs.add(pair);

    const reason = makeReason(family, certainty);
    edges.push({
      id: generateId('DERIVES_FROM', `${sourceId}->${targetId}:${reason}`),
      type: 'DERIVES_FROM',
      sourceId,
      targetId,
      confidence: Math.max(0.6, Math.min(1.0, Number(confidence) || 0.9)),
      reason,
    });

    if (counter === 'route') routeExpansionEdges++;
    if (counter === 'enum') enumToSlugEdges++;
    if (counter === 'config') configDrivenEdges++;
    if (counter === 'compiled') compiledArtifactEdges++;
    if (counter === 'framework') frameworkDerivedEdges++;
  };

  for (const node of knowledgeGraph.nodes) {
    const filePath = normalizePath(node.properties?.filePath);

    if (isEndpointNode(node) && filePath) {
      const fileNodeId = fileNodeIdByPath.get(filePath);
      if (fileNodeId) {
        addEdge(node.id, fileNodeId, 'route-expansion.file', 'deterministic', 0.99, 'route');
      }
    }

    if (node.label === 'Template' && filePath) {
      const fileNodeId = fileNodeIdByPath.get(filePath);
      if (fileNodeId) {
        addEdge(node.id, fileNodeId, 'compiled-template.file', 'deterministic', 0.97, 'compiled');
      }
    }

    if (isRoleNode(node) && filePath && isConfigPermissionsPath(filePath)) {
      const fileNodeId = fileNodeIdByPath.get(filePath);
      if (fileNodeId) {
        addEdge(node.id, fileNodeId, 'config-driven.role', 'deterministic', 0.97, 'config');
      }
    }
  }

  onProgress?.('Materializing provenance edges from derived relation signals...', 55);

  for (const rel of knowledgeGraph.relationships) {
    if (rel.type !== 'CALLS') continue;
    const reason = String(rel.reason || '');

    if (reason.startsWith('laravel-endpoint:')) {
      addEdge(rel.sourceId, rel.targetId, 'route-expansion.handler', 'deterministic', rel.confidence || 0.95, 'route');
      continue;
    }

    if (reason.startsWith('laravel-permission-slug:')) {
      const targetNode = nodeById.get(rel.targetId);
      if (targetNode && isPermissionNode(targetNode)) {
        addEdge(rel.targetId, rel.sourceId, 'enum-to-slug', 'deterministic', rel.confidence || 0.96, 'enum');
      }
      continue;
    }

    if (reason.startsWith('laravel-role-permission-slug:')) {
      const targetNode = nodeById.get(rel.targetId);
      if (targetNode && isPermissionNode(targetNode)) {
        addEdge(rel.targetId, rel.sourceId, 'config-driven.role-slug', 'deterministic', rel.confidence || 0.95, 'config');
      }
      continue;
    }

    if (reason.startsWith('laravel-role-permission:')) {
      addEdge(rel.sourceId, rel.targetId, 'config-driven.enum-expansion', 'assisted', rel.confidence || 0.9, 'config');
      continue;
    }

    if (reason.startsWith('laravel-can:endpoint-middleware:') || reason.startsWith('laravel-can:route-middleware:')) {
      addEdge(rel.sourceId, rel.targetId, 'framework-middleware.permission', 'deterministic', rel.confidence || 0.93, 'framework');
      continue;
    }
  }

  onProgress?.('Provenance edge materialization complete.', 100);

  return {
    edges,
    stats: {
      emittedEdges: edges.length,
      routeExpansionEdges,
      enumToSlugEdges,
      configDrivenEdges,
      compiledArtifactEdges,
      frameworkDerivedEdges,
      skippedDuplicates,
      skippedMalformed,
    },
  };
};
