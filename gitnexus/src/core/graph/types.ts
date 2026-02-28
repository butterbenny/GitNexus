export type NodeLabel =
  | 'Project'
  | 'Package'
  | 'Module'
  | 'Folder'
  | 'File'
  | 'Class'
  | 'Function'
  | 'Method'
  | 'Variable'
  | 'Interface'
  | 'Enum'
  // Multi-language code element labels (persisted in Kuzu schema)
  | 'Struct'
  | 'Macro'
  | 'Typedef'
  | 'Union'
  | 'Namespace'
  | 'Trait'
  | 'Impl'
  | 'TypeAlias'
  | 'Const'
  | 'Static'
  | 'Property'
  | 'Record'
  | 'Delegate'
  | 'Annotation'
  | 'Constructor'
  | 'Template'
  | 'Decorator'
  | 'Import'
  | 'Type'
  | 'CodeElement'
  | 'Community'
  | 'Process'
  | 'FeatureSlice'
  | 'Gap'
  | 'ContractShape'
  | 'ContractField'
  | 'CacheKey'
  | 'DBTable'
  | 'DBColumn'
  | 'ValueNode'
  | 'TestCase';


export type NodeProperties = {
  name: string,
  filePath: string,
  startLine?: number,
  endLine?: number,
  language?: string,
  isExported?: boolean,
  // Community-specific properties
  heuristicLabel?: string,
  cohesion?: number,
  symbolCount?: number,
  keywords?: string[],
  description?: string,
  enrichedBy?: 'heuristic' | 'llm',
  // Process-specific properties
  processType?: 'intra_community' | 'cross_community',
  stepCount?: number,
  communities?: string[],
  entryPointId?: string,
  terminalId?: string,
  // FeatureSlice-specific properties
  sliceType?: string,
  anchorId?: string,
  anchorName?: string,
  closureSlots?: string[],
  closedSlots?: string[],
  closureScore?: number,
  // Gap-specific properties
  gapType?: string,
  absenceTier?: 'deterministic_missing' | 'pattern_missing' | 'heuristic_suspicion',
  severity?: 'high' | 'medium' | 'low',
  sliceId?: string,
  missingSlots?: string[],
  evidence?: string[],
  // ContractShape-specific properties
  shapeType?: string,
  sourceNodeId?: string,
  sourceFilePath?: string,
  // ContractField-specific properties
  fieldName?: string,
  shapeId?: string,
  // CacheKey-specific properties
  keyName?: string,
  keyType?: string,
  // DBTable/DBColumn-specific properties
  tableName?: string,
  columnName?: string,
  tableId?: string,
  // ValueNode-specific properties
  valueType?: string,
  valueKey?: string,
  valueRaw?: string,
  // Entry point scoring (computed by process detection)
  entryPointScore?: number,
  entryPointReason?: string,
}

export type RelationshipType = 
  | 'CONTAINS' 
  | 'CO_CHANGES_WITH'
  | 'CALLS' 
  | 'INHERITS' 
  | 'OVERRIDES' 
  | 'IMPORTS'
  | 'USES'
  | 'DEFINES'
  | 'VALIDATES_FIELD'
  | 'SERIALIZES_FIELD'
  | 'READS_FIELD'
  | 'WRITES_FIELD'
  | 'DERIVES_FROM'
  | 'DERIVES_FROM_COLUMN'
  | 'INVALIDATES_KEY'
  | 'TESTS_SHAPE'
  | 'DECORATES'
  | 'IMPLEMENTS'
  | 'EXTENDS'
  | 'MEMBER_OF'
  | 'STEP_IN_PROCESS'

export type RelationshipCertaintyTier =
  | 'deterministic'
  | 'typed'
  | 'historical'
  | 'semantic'
  | 'heuristic';

export type RelationshipAbsenceSemantics =
  | 'closed_world'
  | 'open_world'
  | 'not_applicable';

export interface GraphNode {
  id:  string,
  label: NodeLabel,
  properties: NodeProperties,  
}

export interface GraphRelationship {
  id: string,
  sourceId: string,
  targetId: string,
  type: RelationshipType,
  /** Confidence score 0-1 (1.0 = certain, lower = uncertain resolution) */
  confidence: number,
  /** Resolution reason: 'import-resolved', 'same-file', 'fuzzy-global', or empty for non-CALLS */
  reason: string,
  /** Step number for STEP_IN_PROCESS relationships (1-indexed) */
  step?: number,
  /** Certainty tier for relation ranking/guardrails */
  certaintyTier?: RelationshipCertaintyTier,
  /** Provenance family inferred from relation reason/type */
  provenanceFamily?: string,
  /** Whether absence of this relation family should be treated as meaningful */
  absenceSemantics?: RelationshipAbsenceSemantics,
  /** Stable witness path identifiers for proof-pack linking */
  witnessPathIds?: string[],
}

export interface KnowledgeGraph {
  nodes: GraphNode[],
  relationships: GraphRelationship[],
  nodeCount: number,
  relationshipCount: number,
  addNode: (node: GraphNode) => void,
  addRelationship: (relationship: GraphRelationship) => void,
  removeNode: (nodeId: string) => boolean,
  removeNodesByFile: (filePath: string) => number,
}
