import { generateId } from '../../lib/utils.js';
import { GraphNode, KnowledgeGraph } from '../graph/types.js';

type ShapeType = 'form_request' | 'resource';
type CacheKeyType = 'query_key_factory' | 'literal';

export interface ContractShapeNode {
  id: string;
  label: string;
  heuristicLabel: string;
  shapeType: ShapeType;
  sourceNodeId: string;
  sourceFilePath: string;
}

export interface ContractFieldNode {
  id: string;
  label: string;
  heuristicLabel: string;
  fieldName: string;
  shapeId: string;
  shapeType: ShapeType;
}

export interface CacheKeyNode {
  id: string;
  label: string;
  heuristicLabel: string;
  keyName: string;
  keyType: CacheKeyType;
  sourceNodeId: string;
}

export interface TestCaseNode {
  id: string;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

export interface ShapeEdge {
  id: string;
  type: 'DEFINES' | 'MEMBER_OF' | 'VALIDATES_FIELD' | 'SERIALIZES_FIELD' | 'INVALIDATES_KEY' | 'TESTS_SHAPE';
  sourceId: string;
  targetId: string;
  confidence: number;
  reason: string;
}

export interface ContractShapeResult {
  shapes: ContractShapeNode[];
  fields: ContractFieldNode[];
  cacheKeys: CacheKeyNode[];
  testCases: TestCaseNode[];
  edges: ShapeEdge[];
  stats: {
    shapeCount: number;
    fieldCount: number;
    cacheKeyCount: number;
    testCaseCount: number;
    edgeCount: number;
    validatedFieldEdges: number;
    serializedFieldEdges: number;
    invalidationEdges: number;
    testsShapeEdges: number;
  };
}

type ResolvedFunction = {
  node: GraphNode;
  confidence: number;
};

const JS_TS_FILE_RE = /\.(c|m)?(t|j)sx?$/i;
const TEST_FILE_RE = /(^|\/)(__tests__|tests?|testing|spec)(\/|$)|(\.test\.|\.spec\.)|(_test\.)|(^test_)/i;

const normalizePath = (value: string): string => String(value || '').replace(/\\/g, '/');

const sanitizeIdSegment = (value: string): string => {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
};

const isWordBoundaryChar = (ch: string): boolean => !/[A-Za-z0-9_$]/.test(ch);

const findBalancedEnd = (
  text: string,
  startIndex: number,
  openChar: string,
  closeChar: string,
): number => {
  if (startIndex < 0 || startIndex >= text.length) return -1;
  if (text[startIndex] !== openChar) return -1;

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';
    const prev = i > 0 ? text[i - 1] : '';

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (!inSingle && !inDouble && !inTemplate) {
      if (ch === '/' && next === '/') {
        inLineComment = true;
        i++;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i++;
        continue;
      }
    }

    if (!inDouble && !inTemplate && ch === '\'' && prev !== '\\') {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && !inTemplate && ch === '"' && prev !== '\\') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && ch === '`' && prev !== '\\') {
      inTemplate = !inTemplate;
      continue;
    }

    if (inSingle || inDouble || inTemplate) continue;

    if (ch === openChar) depth++;
    if (ch === closeChar) {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }

  return -1;
};

const splitTopLevelSegments = (text: string): string[] => {
  const segments: string[] = [];
  let start = 0;

  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';
    const prev = i > 0 ? text[i - 1] : '';

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (!inSingle && !inDouble && !inTemplate) {
      if (ch === '/' && next === '/') {
        inLineComment = true;
        i++;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i++;
        continue;
      }
    }

    if (!inDouble && !inTemplate && ch === '\'' && prev !== '\\') {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && !inTemplate && ch === '"' && prev !== '\\') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && ch === '`' && prev !== '\\') {
      inTemplate = !inTemplate;
      continue;
    }

    if (inSingle || inDouble || inTemplate) continue;

    if (ch === '{') braceDepth++;
    else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === '[') bracketDepth++;
    else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === ',' && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      const segment = text.slice(start, i).trim();
      if (segment) segments.push(segment);
      start = i + 1;
    }
  }

  const tail = text.slice(start).trim();
  if (tail) segments.push(tail);
  return segments;
};

const extractPhpMethodBody = (content: string, methodName: string): string | null => {
  const regex = new RegExp(String.raw`function\s+${methodName}\s*\([^)]*\)\s*(?::\s*[^{]+)?\{`, 'g');
  const match = regex.exec(content);
  if (!match) return null;

  const openBraceIdx = (match.index + match[0].length) - 1;
  const closeBraceIdx = findBalancedEnd(content, openBraceIdx, '{', '}');
  if (closeBraceIdx <= openBraceIdx) return null;

  return content.slice(openBraceIdx + 1, closeBraceIdx);
};

const extractPhpArrayFieldKeys = (methodBody: string): string[] => {
  const found = new Set<string>();
  const returnArrayRe = /return\s*\[/g;
  let match: RegExpExecArray | null;

  while ((match = returnArrayRe.exec(methodBody)) !== null) {
    const openBracketIdx = (match.index + match[0].length) - 1;
    const closeBracketIdx = findBalancedEnd(methodBody, openBracketIdx, '[', ']');
    if (closeBracketIdx <= openBracketIdx) continue;

    const arrayText = methodBody.slice(openBracketIdx + 1, closeBracketIdx);
    const keyRe = /(['"])([A-Za-z0-9_.*\-\[\]]+)\1\s*=>/g;
    let keyMatch: RegExpExecArray | null;
    while ((keyMatch = keyRe.exec(arrayText)) !== null) {
      const key = String(keyMatch[2] || '').trim();
      if (!key) continue;
      found.add(key);
    }
  }

  return Array.from(found);
};

const extractObjectPropertyExpression = (objectBody: string, propertyName: string): string | null => {
  const entries = splitTopLevelSegments(objectBody);
  for (const entry of entries) {
    const match = entry.match(/^(?:['"]?([A-Za-z_$][A-Za-z0-9_$]*)['"]?)\s*:\s*([\s\S]+)$/);
    if (!match) continue;
    const key = String(match[1] || '').trim();
    if (key !== propertyName) continue;
    const expr = String(match[2] || '').trim();
    if (expr) return expr;
  }
  return null;
};

const extractInvalidateQueryKeyExpressions = (content: string): string[] => {
  const expressions: string[] = [];
  const token = 'invalidateQueries';

  for (let i = 0; i < content.length;) {
    const at = content.indexOf(token, i);
    if (at < 0) break;
    i = at + token.length;

    const before = at > 0 ? content[at - 1] : '';
    const after = at + token.length < content.length ? content[at + token.length] : '';
    if ((before && !isWordBoundaryChar(before)) || (after && !isWordBoundaryChar(after))) continue;

    const openParen = content.indexOf('(', at + token.length);
    if (openParen < 0) continue;
    const closeParen = findBalancedEnd(content, openParen, '(', ')');
    if (closeParen <= openParen) continue;

    const argsText = content.slice(openParen + 1, closeParen).trim();
    if (!argsText.startsWith('{')) continue;

    const closeObject = findBalancedEnd(argsText, 0, '{', '}');
    if (closeObject <= 0) continue;

    const objectBody = argsText.slice(1, closeObject);
    const expr = extractObjectPropertyExpression(objectBody, 'queryKey');
    if (!expr) continue;
    expressions.push(expr);
  }

  return expressions;
};

const extractKeyFactoryName = (expression: string): string | null => {
  const expr = expression.trim();

  const memberCall = expr.match(/^([A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
  if (memberCall?.[1]) return memberCall[1];

  const identifierCall = expr.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
  if (identifierCall?.[1]) return identifierCall[1];

  const memberRef = expr.match(/^([A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$]*)$/);
  if (memberRef?.[1]) return memberRef[1];

  return null;
};

const extractLiteralKey = (expression: string): string | null => {
  const expr = expression.trim();
  const match = expr.match(/^\[\s*['"]([^'"]+)['"]/);
  if (!match?.[1]) return null;
  return String(match[1]).trim();
};

const resolveFunctionByName = (
  functionByName: Map<string, GraphNode[]>,
  functionName: string,
  filePath: string,
): ResolvedFunction | null => {
  const candidates = functionByName.get(functionName) || [];
  if (candidates.length === 0) return null;

  const sameFile = candidates.filter(node => normalizePath(node.properties.filePath || '') === normalizePath(filePath));
  if (sameFile.length === 1) return { node: sameFile[0], confidence: 1.0 };
  if (sameFile.length > 1) return null;

  if (candidates.length === 1) return { node: candidates[0], confidence: 0.9 };
  return null;
};

const buildLabel = (prefix: string, value: string): string => `${prefix}: ${value}`;

interface ExtractedTestCase {
  name: string;
  startLine: number;
  endLine: number;
}

interface ShapeTestReference {
  shapeId: string;
  className: string;
  sourceFileBase: string;
}

interface ShapeMatch {
  shapeId: string;
  confidence: number;
  reason: string;
}

const normalizeTestName = (value: string): string => {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 160);
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const tokenExists = (content: string, token: string): boolean => {
  const trimmed = String(token || '').trim();
  if (!trimmed) return false;
  const re = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(trimmed)}(?=$|[^A-Za-z0-9_])`);
  return re.test(content);
};

const buildLineStarts = (content: string): number[] => {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') starts.push(i + 1);
  }
  return starts;
};

const lineAtOffset = (lineStarts: number[], offset: number): number => {
  let low = 0;
  let high = lineStarts.length - 1;
  let answer = 0;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lineStarts[mid] <= offset) {
      answer = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return answer + 1;
};

const extractStaticTestCases = (filePath: string, content: string): ExtractedTestCase[] => {
  const lineStarts = buildLineStarts(content);
  const extracted: ExtractedTestCase[] = [];
  const seen = new Set<string>();

  const addTestCase = (nameRaw: string, offset: number) => {
    const name = normalizeTestName(nameRaw);
    if (!name) return;
    const startLine = lineAtOffset(lineStarts, Math.max(0, offset));
    const key = `${name.toLowerCase()}::${startLine}`;
    if (seen.has(key)) return;
    seen.add(key);
    extracted.push({ name, startLine, endLine: startLine });
  };

  const jsTestRe = /\b(?:it|test)(?:\.(?:only|skip|todo|concurrent|failing))*\s*\(\s*(['"`])([\s\S]{1,200}?)\1/g;
  let match: RegExpExecArray | null;
  while ((match = jsTestRe.exec(content)) !== null) {
    addTestCase(String(match[2] || ''), match.index);
  }

  const phpNameRe = /\bfunction\s+(test_[A-Za-z0-9_]+)\s*\(/g;
  while ((match = phpNameRe.exec(content)) !== null) {
    addTestCase(String(match[1] || ''), match.index);
  }

  const phpAnnotationRe = /@test\b[\s\S]{0,200}?\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  while ((match = phpAnnotationRe.exec(content)) !== null) {
    addTestCase(String(match[1] || ''), match.index);
  }

  if (extracted.length === 0) {
    const fallbackName = normalizeTestName(filePath.split('/').pop() || filePath);
    if (fallbackName) extracted.push({ name: fallbackName, startLine: 1, endLine: 1 });
  }

  return extracted;
};

const collectShapeMatchesForTestFile = (
  filePath: string,
  content: string,
  references: ShapeTestReference[],
): ShapeMatch[] => {
  const fileName = normalizePath(filePath).split('/').pop()?.toLowerCase() || '';
  const byShapeId = new Map<string, ShapeMatch>();

  for (const reference of references) {
    let confidence = 0;
    let reason = '';

    if (reference.className && tokenExists(content, reference.className)) {
      confidence = 0.95;
      reason = 'class-name-reference';
    } else if (reference.sourceFileBase && tokenExists(content, reference.sourceFileBase)) {
      confidence = 0.9;
      reason = 'source-file-reference';
    } else if (reference.className && fileName.includes(reference.className.toLowerCase())) {
      confidence = 0.85;
      reason = 'test-file-name-hint';
    } else if (reference.sourceFileBase && fileName.includes(reference.sourceFileBase.toLowerCase())) {
      confidence = 0.8;
      reason = 'source-file-name-hint';
    }

    if (confidence === 0) continue;

    const existing = byShapeId.get(reference.shapeId);
    if (!existing || confidence > existing.confidence) {
      byShapeId.set(reference.shapeId, {
        shapeId: reference.shapeId,
        confidence,
        reason,
      });
    }
  }

  return Array.from(byShapeId.values())
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 8);
};

export const processContractShapes = async (
  knowledgeGraph: KnowledgeGraph,
  files: { path: string; content: string }[],
  onProgress?: (message: string, progress: number) => void,
): Promise<ContractShapeResult> => {
  onProgress?.('Scanning contract shape sources...', 0);

  const classByFile = new Map<string, GraphNode>();
  const classById = new Map<string, GraphNode>();
  const functionByName = new Map<string, GraphNode[]>();

  for (const node of knowledgeGraph.nodes) {
    if (node.label === 'Class') {
      const filePath = normalizePath(node.properties.filePath || '');
      if (filePath && !classByFile.has(filePath)) classByFile.set(filePath, node);
      classById.set(node.id, node);
      continue;
    }

    if (node.label === 'Function') {
      const name = String(node.properties.name || '').trim();
      if (!name) continue;
      const list = functionByName.get(name) || [];
      list.push(node);
      functionByName.set(name, list);
    }
  }

  const shapeNodeMap = new Map<string, ContractShapeNode>();
  const fieldNodeMap = new Map<string, ContractFieldNode>();
  const cacheKeyNodeMap = new Map<string, CacheKeyNode>();
  const testCaseNodeMap = new Map<string, TestCaseNode>();
  const edgeMap = new Map<string, ShapeEdge>();
  const cacheKeyIdBySourceNodeId = new Map<string, string>();

  const addEdge = (edge: ShapeEdge) => {
    if (!edge.sourceId || !edge.targetId) return;
    if (!edgeMap.has(edge.id)) edgeMap.set(edge.id, edge);
  };

  const ensureShape = (
    shapeType: ShapeType,
    sourceClassNode: GraphNode,
  ): ContractShapeNode => {
    const id = generateId('ContractShape', `${shapeType}:${sourceClassNode.id}`);
    const existing = shapeNodeMap.get(id);
    if (existing) return existing;

    const className = String(sourceClassNode.properties.name || '').trim();
    const shapeLabel = shapeType === 'form_request'
      ? buildLabel('FormRequest Shape', className || sourceClassNode.id)
      : buildLabel('Resource Shape', className || sourceClassNode.id);

    const node: ContractShapeNode = {
      id,
      label: shapeLabel,
      heuristicLabel: shapeLabel,
      shapeType,
      sourceNodeId: sourceClassNode.id,
      sourceFilePath: String(sourceClassNode.properties.filePath || ''),
    };

    shapeNodeMap.set(id, node);

    addEdge({
      id: generateId('DEFINES', `${sourceClassNode.id}->${id}`),
      type: 'DEFINES',
      sourceId: sourceClassNode.id,
      targetId: id,
      confidence: 1.0,
      reason: shapeType === 'form_request' ? 'shape:form-request' : 'shape:resource',
    });

    return node;
  };

  const ensureField = (
    fieldName: string,
    shape: ContractShapeNode,
  ): ContractFieldNode => {
    const id = generateId('ContractField', `${shape.id}:${fieldName}`);
    const existing = fieldNodeMap.get(id);
    if (existing) return existing;

    const label = buildLabel('Field', fieldName);
    const node: ContractFieldNode = {
      id,
      label,
      heuristicLabel: label,
      fieldName,
      shapeId: shape.id,
      shapeType: shape.shapeType,
    };

    fieldNodeMap.set(id, node);
    addEdge({
      id: generateId('MEMBER_OF', `${id}->${shape.id}`),
      type: 'MEMBER_OF',
      sourceId: id,
      targetId: shape.id,
      confidence: 1.0,
      reason: 'contract-shape:field',
    });
    return node;
  };

  const ensureCacheKey = (
    keyType: CacheKeyType,
    keyName: string,
    sourceNodeId: string,
  ): CacheKeyNode => {
    const sourcePart = sanitizeIdSegment(sourceNodeId) || 'unknown';
    const keyPart = sanitizeIdSegment(keyName) || 'cache_key';
    const id = generateId('CacheKey', `${keyType}:${sourcePart}:${keyPart}`);
    const existing = cacheKeyNodeMap.get(id);
    if (existing) return existing;

    const label = buildLabel('Cache Key', keyName);
    const node: CacheKeyNode = {
      id,
      label,
      heuristicLabel: label,
      keyName,
      keyType,
      sourceNodeId,
    };

    cacheKeyNodeMap.set(id, node);
    return node;
  };

  const requestCandidates = files.filter(file => {
    const filePath = normalizePath(file.path);
    return filePath.includes('/Http/Requests/') && /\bfunction\s+rules\s*\(/.test(file.content);
  });

  let validatedFieldEdges = 0;
  for (const file of requestCandidates) {
    const classNode = classByFile.get(normalizePath(file.path));
    if (!classNode) continue;

    const rulesBody = extractPhpMethodBody(file.content, 'rules');
    if (!rulesBody) continue;
    const fieldNames = extractPhpArrayFieldKeys(rulesBody);
    if (fieldNames.length === 0) continue;

    const shape = ensureShape('form_request', classNode);
    for (const fieldName of fieldNames) {
      const field = ensureField(fieldName, shape);
      addEdge({
        id: generateId('VALIDATES_FIELD', `${classNode.id}:${field.id}`),
        type: 'VALIDATES_FIELD',
        sourceId: classNode.id,
        targetId: field.id,
        confidence: 0.95,
        reason: 'laravel-form-request:rules',
      });
      validatedFieldEdges++;
    }
  }

  onProgress?.('Extracting resource serialization shapes...', 40);

  let serializedFieldEdges = 0;
  const resourceCandidates = files.filter(file => {
    const filePath = normalizePath(file.path);
    return filePath.includes('/Http/Resources/') && /\bfunction\s+toArray\s*\(/.test(file.content);
  });

  for (const file of resourceCandidates) {
    const classNode = classByFile.get(normalizePath(file.path));
    if (!classNode) continue;

    const toArrayBody = extractPhpMethodBody(file.content, 'toArray');
    if (!toArrayBody) continue;
    const fieldNames = extractPhpArrayFieldKeys(toArrayBody);
    if (fieldNames.length === 0) continue;

    const shape = ensureShape('resource', classNode);
    for (const fieldName of fieldNames) {
      const field = ensureField(fieldName, shape);
      addEdge({
        id: generateId('SERIALIZES_FIELD', `${classNode.id}:${field.id}`),
        type: 'SERIALIZES_FIELD',
        sourceId: classNode.id,
        targetId: field.id,
        confidence: 0.95,
        reason: 'laravel-resource:to-array',
      });
      serializedFieldEdges++;
    }
  }

  onProgress?.('Extracting React Query cache keys...', 70);

  for (const node of knowledgeGraph.nodes) {
    if (node.label !== 'Function') continue;
    const functionName = String(node.properties.name || '').trim();
    if (!/queryKeys\./i.test(functionName)) continue;

    const cacheKey = ensureCacheKey('query_key_factory', functionName, node.id);
    cacheKeyIdBySourceNodeId.set(node.id, cacheKey.id);
    addEdge({
      id: generateId('DEFINES', `${node.id}->${cacheKey.id}`),
      type: 'DEFINES',
      sourceId: node.id,
      targetId: cacheKey.id,
      confidence: 0.95,
      reason: 'react-query:key-factory',
    });
  }

  let invalidationEdges = 0;
  const invalidateCandidates = files.filter(file => JS_TS_FILE_RE.test(file.path) && file.content.includes('invalidateQueries('));

  for (const file of invalidateCandidates) {
    const expressions = extractInvalidateQueryKeyExpressions(file.content);
    if (expressions.length === 0) continue;

    const fileNodeId = generateId('File', normalizePath(file.path));
    for (const expression of expressions) {
      const factoryName = extractKeyFactoryName(expression);
      if (factoryName) {
        const resolved = resolveFunctionByName(functionByName, factoryName, file.path);
        if (resolved && resolved.confidence >= 0.9) {
          let cacheKeyId = cacheKeyIdBySourceNodeId.get(resolved.node.id);
          if (!cacheKeyId) {
            const cacheKey = ensureCacheKey('query_key_factory', String(resolved.node.properties.name || factoryName), resolved.node.id);
            cacheKeyId = cacheKey.id;
            cacheKeyIdBySourceNodeId.set(resolved.node.id, cacheKeyId);
          }

          addEdge({
            id: generateId('INVALIDATES_KEY', `${fileNodeId}:${cacheKeyId}`),
            type: 'INVALIDATES_KEY',
            sourceId: fileNodeId,
            targetId: cacheKeyId,
            confidence: resolved.confidence,
            reason: 'react-query:invalidateQueries',
          });
          invalidationEdges++;
          continue;
        }
      }

      const literalKey = extractLiteralKey(expression);
      if (!literalKey) continue;

      const cacheKey = ensureCacheKey('literal', literalKey, fileNodeId);
      addEdge({
        id: generateId('INVALIDATES_KEY', `${fileNodeId}:${cacheKey.id}`),
        type: 'INVALIDATES_KEY',
        sourceId: fileNodeId,
        targetId: cacheKey.id,
        confidence: 0.9,
        reason: 'react-query:invalidateQueries:literal',
      });
      invalidationEdges++;
    }
  }

  onProgress?.('Materializing static test closure...', 85);

  const shapeReferences: ShapeTestReference[] = Array.from(shapeNodeMap.values())
    .map(shape => {
      const sourceClass = classById.get(shape.sourceNodeId);
      const className = String(sourceClass?.properties?.name || '').trim();
      const sourceFile = normalizePath(shape.sourceFilePath);
      const sourceFileBase = sourceFile.split('/').pop()?.replace(/\.[^.]+$/, '') || '';
      return {
        shapeId: shape.id,
        className,
        sourceFileBase,
      };
    })
    .filter(reference => reference.className || reference.sourceFileBase);

  let testsShapeEdges = 0;
  const testCandidates = files.filter(file => TEST_FILE_RE.test(normalizePath(file.path)));

  for (const file of testCandidates) {
    const normalizedPath = normalizePath(file.path);
    const shapeMatches = collectShapeMatchesForTestFile(normalizedPath, file.content, shapeReferences);
    if (shapeMatches.length === 0) continue;

    const extractedTests = extractStaticTestCases(normalizedPath, file.content);
    const fileNodeId = generateId('File', normalizedPath);

    for (const extracted of extractedTests) {
      const testCaseId = generateId(
        'TestCase',
        `${normalizedPath}:${sanitizeIdSegment(extracted.name)}:${extracted.startLine}`
      );

      if (!testCaseNodeMap.has(testCaseId)) {
        testCaseNodeMap.set(testCaseId, {
          id: testCaseId,
          name: buildLabel('Test Case', extracted.name),
          filePath: normalizedPath,
          startLine: extracted.startLine,
          endLine: extracted.endLine,
        });
      }

      addEdge({
        id: generateId('DEFINES', `${fileNodeId}->${testCaseId}`),
        type: 'DEFINES',
        sourceId: fileNodeId,
        targetId: testCaseId,
        confidence: 0.9,
        reason: 'test-case:static-extraction',
      });

      for (const match of shapeMatches) {
        addEdge({
          id: generateId('TESTS_SHAPE', `${testCaseId}->${match.shapeId}`),
          type: 'TESTS_SHAPE',
          sourceId: testCaseId,
          targetId: match.shapeId,
          confidence: match.confidence,
          reason: `test-closure:${match.reason}`,
        });
        testsShapeEdges++;
      }
    }
  }

  onProgress?.('Contract shape extraction complete.', 100);

  return {
    shapes: Array.from(shapeNodeMap.values()),
    fields: Array.from(fieldNodeMap.values()),
    cacheKeys: Array.from(cacheKeyNodeMap.values()),
    testCases: Array.from(testCaseNodeMap.values()),
    edges: Array.from(edgeMap.values()),
    stats: {
      shapeCount: shapeNodeMap.size,
      fieldCount: fieldNodeMap.size,
      cacheKeyCount: cacheKeyNodeMap.size,
      testCaseCount: testCaseNodeMap.size,
      edgeCount: edgeMap.size,
      validatedFieldEdges,
      serializedFieldEdges,
      invalidationEdges,
      testsShapeEdges,
    },
  };
};
