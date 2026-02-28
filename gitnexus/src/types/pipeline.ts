import { GraphNode, GraphRelationship, KnowledgeGraph } from '../core/graph/types.js';
import { CommunityDetectionResult } from '../core/ingestion/community-processor.js';
import { MicroDataflowResult } from '../core/ingestion/micro-dataflow-processor.js';
import { ProcessDetectionResult } from '../core/ingestion/process-processor.js';
import { ProvenanceResult } from '../core/ingestion/provenance-processor.js';
import { PrecisionOverlayResult } from '../core/ingestion/precision-overlay-processor.js';
import { ValueGraphResult } from '../core/ingestion/value-graph-processor.js';

export type PipelinePhase = 'idle' | 'extracting' | 'structure' | 'parsing' | 'imports' | 'calls' | 'shapes' | 'heritage' | 'precision' | 'microflow' | 'values' | 'provenance' | 'communities' | 'processes' | 'slices' | 'gaps' | 'cochange' | 'enriching' | 'complete' | 'error';

export interface PipelineProgress {
  phase: PipelinePhase;
  percent: number;
  message: string;
  detail?: string;
  stats?: {
    filesProcessed: number;
    totalFiles: number;
    nodesCreated: number;
  };
}

// Original result type (used internally in pipeline)
export interface PipelineResult {
  graph: KnowledgeGraph;
  fileContents: Map<string, string>;
  communityResult?: CommunityDetectionResult;
  processResult?: ProcessDetectionResult;
  precisionOverlayResult?: PrecisionOverlayResult;
  microDataflowResult?: MicroDataflowResult;
  valueGraphResult?: ValueGraphResult;
  provenanceResult?: ProvenanceResult;
}

// Serializable version for Web Worker communication
// Maps and functions cannot be transferred via postMessage
export interface SerializablePipelineResult {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  fileContents: Record<string, string>; // Object instead of Map
}

// Helper to convert PipelineResult to serializable format
export const serializePipelineResult = (result: PipelineResult): SerializablePipelineResult => ({
  nodes: result.graph.nodes,
  relationships: result.graph.relationships,
  fileContents: Object.fromEntries(result.fileContents),
});

// Helper to reconstruct from serializable format (used in main thread)
export const deserializePipelineResult = (
  serialized: SerializablePipelineResult,
  createGraph: () => KnowledgeGraph
): PipelineResult => {
  const graph = createGraph();
  serialized.nodes.forEach(node => graph.addNode(node));
  serialized.relationships.forEach(rel => graph.addRelationship(rel));
  
  return {
    graph,
    fileContents: new Map(Object.entries(serialized.fileContents)),
  };
};
