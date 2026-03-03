import { generateId } from '../../lib/utils.js';
import { GraphNode, KnowledgeGraph } from '../graph/types.js';

type ShapeType = 'form_request' | 'resource' | 'controller_validation';
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

export interface DBTableNode {
  id: string;
  label: string;
  heuristicLabel: string;
  tableName: string;
  sourceFilePath: string;
}

export interface DBColumnNode {
  id: string;
  label: string;
  heuristicLabel: string;
  columnName: string;
  tableId: string;
  tableName: string;
  sourceFilePath: string;
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
  type:
    | 'DEFINES'
    | 'MEMBER_OF'
    | 'VALIDATES_FIELD'
    | 'SERIALIZES_FIELD'
    | 'INVALIDATES_KEY'
    | 'TESTS_SHAPE'
    | 'DERIVES_FROM_COLUMN';
  sourceId: string;
  targetId: string;
  confidence: number;
  reason: string;
}

export interface ContractShapeResult {
  shapes: ContractShapeNode[];
  fields: ContractFieldNode[];
  cacheKeys: CacheKeyNode[];
  dbTables: DBTableNode[];
  dbColumns: DBColumnNode[];
  testCases: TestCaseNode[];
  codeElements: GraphNode[];
  edges: ShapeEdge[];
  stats: {
    shapeCount: number;
    fieldCount: number;
    cacheKeyCount: number;
    dbTableCount: number;
    dbColumnCount: number;
    testCaseCount: number;
    codeElementCount: number;
    edgeCount: number;
    validatedFieldEdges: number;
    serializedFieldEdges: number;
    invalidationEdges: number;
    derivesFromColumnEdges: number;
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

const countNewlinesUpTo = (text: string, idx: number): number => {
  const end = Math.max(0, Math.min(text.length, idx));
  let count = 0;
  for (let i = 0; i < end; i++) {
    if (text[i] === '\n') count++;
  }
  return count;
};

const extractLineAroundIndex = (text: string, idx: number): string => {
  const safeIdx = Math.max(0, Math.min(text.length, idx));
  const start = text.lastIndexOf('\n', safeIdx);
  const end = text.indexOf('\n', safeIdx);
  const sliceStart = start >= 0 ? start + 1 : 0;
  const sliceEnd = end >= 0 ? end : text.length;
  return text.slice(sliceStart, sliceEnd).trim();
};

const extractPhpMethodBodySpan = (
  content: string,
  methodName: string,
): { body: string; openBraceIdx: number; closeBraceIdx: number } | null => {
  const regex = new RegExp(String.raw`function\s+${methodName}\s*\([^)]*\)\s*(?::\s*[^{]+)?\{`, 'g');
  const match = regex.exec(content);
  if (!match) return null;

  const openBraceIdx = (match.index + match[0].length) - 1;
  const closeBraceIdx = findBalancedEnd(content, openBraceIdx, '{', '}');
  if (closeBraceIdx <= openBraceIdx) return null;

  return {
    body: content.slice(openBraceIdx + 1, closeBraceIdx),
    openBraceIdx,
    closeBraceIdx,
  };
};

const extractPhpMethodBody = (content: string, methodName: string): string | null => {
  return extractPhpMethodBodySpan(content, methodName)?.body ?? null;
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

const extractPhpBracketArrayKeys = (expr: string): string[] => {
  const text = String(expr || '').trim();
  const openBracketIdx = text.indexOf('[');
  if (openBracketIdx < 0) return [];
  const closeBracketIdx = findBalancedEnd(text, openBracketIdx, '[', ']');
  if (closeBracketIdx <= openBracketIdx) return [];

  const arrayText = text.slice(openBracketIdx + 1, closeBracketIdx);
  const found = new Set<string>();
  const keyRe = /(['"])([A-Za-z0-9_.*\-\[\]]+)\1\s*=>/g;
  let keyMatch: RegExpExecArray | null;
  while ((keyMatch = keyRe.exec(arrayText)) !== null) {
    const key = String(keyMatch[2] || '').trim();
    if (!key) continue;
    found.add(key);
  }
  return Array.from(found);
};

const extractLaravelInlineValidationKeysFromMethodBody = (methodBody: string): { keys: string[]; reason: string } => {
  const keys = new Set<string>();
  let reason = 'laravel-controller:validate';

  const scanMethodCall = (needle: string, reasonHint: string): void => {
    for (let idx = 0; idx < methodBody.length;) {
      const at = methodBody.indexOf(needle, idx);
      if (at < 0) break;
      idx = at + needle.length;

      const openParenIdx = methodBody.indexOf('(', idx);
      if (openParenIdx < 0) continue;
      const closeParenIdx = findBalancedEnd(methodBody, openParenIdx, '(', ')');
      if (closeParenIdx <= openParenIdx) continue;

      const argsText = methodBody.slice(openParenIdx + 1, closeParenIdx).trim();
      if (!argsText) continue;

      const segments = splitTopLevelSegments(argsText);
      const arraySegment = segments.find(segment => segment.trim().startsWith('['));
      if (!arraySegment) continue;

      const extracted = extractPhpBracketArrayKeys(arraySegment);
      if (extracted.length === 0) continue;
      reason = reasonHint;
      for (const key of extracted) keys.add(key);

      idx = closeParenIdx + 1;
    }
  };

  scanMethodCall('->validateWithBag', 'laravel-request:validate-with-bag');
  scanMethodCall('->validate', 'laravel-request:validate');
  scanMethodCall('$this->validate', 'laravel-controller:validate-helper');

  // Common Laravel inline validation pattern:
  //   Validator::make($data, [...])->validate();
  for (let idx = 0; idx < methodBody.length;) {
    const at = methodBody.indexOf('Validator::make', idx);
    if (at < 0) break;
    idx = at + 'Validator::make'.length;

    const openParenIdx = methodBody.indexOf('(', idx);
    if (openParenIdx < 0) continue;
    const closeParenIdx = findBalancedEnd(methodBody, openParenIdx, '(', ')');
    if (closeParenIdx <= openParenIdx) continue;

    const tail = methodBody.slice(closeParenIdx, Math.min(methodBody.length, closeParenIdx + 160));
    if (!tail.includes('->validate')) {
      idx = closeParenIdx + 1;
      continue;
    }

    const argsText = methodBody.slice(openParenIdx + 1, closeParenIdx).trim();
    const segments = splitTopLevelSegments(argsText);
    const rulesSegment = segments.length >= 2 ? segments[1] : '';
    if (!String(rulesSegment || '').trim().startsWith('[')) {
      idx = closeParenIdx + 1;
      continue;
    }

    const extracted = extractPhpBracketArrayKeys(rulesSegment);
    if (extracted.length === 0) {
      idx = closeParenIdx + 1;
      continue;
    }

    reason = 'laravel-validator:make-validate';
    for (const key of extracted) keys.add(key);
    idx = closeParenIdx + 1;
  }

  return { keys: Array.from(keys).sort(), reason };
};

type LaravelValidationBoundary = {
  index: number;
  reason: string;
  keys: string[];
  snippet: string;
};

const extractLaravelValidationBoundariesFromMethodBody = (methodBody: string): LaravelValidationBoundary[] => {
  const boundaries: LaravelValidationBoundary[] = [];
  const seen = new Set<string>();

  const scanMethodCall = (needle: string, reasonHint: string, extraSkip?: (at: number) => boolean): void => {
    for (let idx = 0; idx < methodBody.length;) {
      const at = methodBody.indexOf(needle, idx);
      if (at < 0) break;
      idx = at + needle.length;
      if (extraSkip?.(at)) continue;

      const after = methodBody.slice(at + needle.length, at + needle.length + 1);
      if (after && /[A-Za-z0-9_]/.test(after)) continue;

      const openParenIdx = methodBody.indexOf('(', idx);
      if (openParenIdx < 0) continue;
      const closeParenIdx = findBalancedEnd(methodBody, openParenIdx, '(', ')');
      if (closeParenIdx <= openParenIdx) continue;

      const argsText = methodBody.slice(openParenIdx + 1, closeParenIdx).trim();
      const segments = argsText ? splitTopLevelSegments(argsText) : [];
      const arraySegment = segments.find(segment => segment.trim().startsWith('['));
      const keys = arraySegment ? extractPhpBracketArrayKeys(arraySegment) : [];

      const boundaryKey = `${reasonHint}|${at}`;
      if (seen.has(boundaryKey)) continue;
      seen.add(boundaryKey);

      boundaries.push({
        index: at,
        reason: reasonHint,
        keys: Array.from(new Set(keys)).sort(),
        snippet: extractLineAroundIndex(methodBody, at),
      });

      idx = closeParenIdx + 1;
    }
  };

  scanMethodCall('->validateWithBag', 'laravel-request:validate-with-bag');
  scanMethodCall('->validate', 'laravel-request:validate', (at) => (
    methodBody.startsWith('->validateWithBag', at)
    || methodBody.startsWith('->validated', at)
  ));
  scanMethodCall('$this->validate', 'laravel-controller:validate-helper');
  scanMethodCall('->validated', 'laravel-request:validated');
  scanMethodCall('->safe', 'laravel-request:safe');

  // Common Laravel inline validation pattern:
  //   Validator::make($data, [...])->validate();
  for (let idx = 0; idx < methodBody.length;) {
    const at = methodBody.indexOf('Validator::make', idx);
    if (at < 0) break;
    idx = at + 'Validator::make'.length;

    const openParenIdx = methodBody.indexOf('(', idx);
    if (openParenIdx < 0) continue;
    const closeParenIdx = findBalancedEnd(methodBody, openParenIdx, '(', ')');
    if (closeParenIdx <= openParenIdx) continue;

    const tail = methodBody.slice(closeParenIdx, Math.min(methodBody.length, closeParenIdx + 160));
    if (!tail.includes('->validate')) {
      idx = closeParenIdx + 1;
      continue;
    }

    const argsText = methodBody.slice(openParenIdx + 1, closeParenIdx).trim();
    const segments = argsText ? splitTopLevelSegments(argsText) : [];
    const rulesSegment = segments.length >= 2 ? segments[1] : '';
    const keys = String(rulesSegment || '').trim().startsWith('[')
      ? extractPhpBracketArrayKeys(rulesSegment)
      : [];

    const reasonHint = 'laravel-validator:make-validate';
    const boundaryKey = `${reasonHint}|${at}`;
    if (!seen.has(boundaryKey)) {
      seen.add(boundaryKey);
      boundaries.push({
        index: at,
        reason: reasonHint,
        keys: Array.from(new Set(keys)).sort(),
        snippet: extractLineAroundIndex(methodBody, at),
      });
    }

    idx = closeParenIdx + 1;
  }

  return boundaries.sort((a, b) => a.index - b.index);
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

interface MigrationTableBlock {
  tableName: string;
  body: string;
  sourceFilePath: string;
}

const MIGRATION_FILE_RE = /(^|\/)database\/migrations\/.+\.php$/i;

const normalizeDbName = (value: string): string => {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
};

const toSnakeCase = (value: string): string => {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
};

const pluralizeSimple = (value: string): string => {
  const token = normalizeDbName(value);
  if (!token) return '';
  if (/(s|x|z|ch|sh)$/i.test(token)) return `${token}es`;
  if (/[^aeiou]y$/i.test(token)) return `${token.slice(0, -1)}ies`;
  return `${token}s`;
};

const extractQuotedArgs = (argsText: string): string[] => {
  const matches = argsText.matchAll(/['"]([A-Za-z0-9_]+)['"]/g);
  return Array.from(matches).map(match => String(match[1] || '').trim()).filter(Boolean);
};

const extractMigrationTableBlocks = (filePath: string, content: string): MigrationTableBlock[] => {
  const blocks: MigrationTableBlock[] = [];
  const schemaCallRe = /Schema::(?:create|table)\s*\(\s*(['"])([A-Za-z0-9_]+)\1\s*,\s*function\s*\([^)]*\)\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = schemaCallRe.exec(content)) !== null) {
    const tableName = normalizeDbName(String(match[2] || ''));
    if (!tableName) continue;

    const openBraceIndex = (match.index + match[0].length) - 1;
    const closeBraceIndex = findBalancedEnd(content, openBraceIndex, '{', '}');
    if (closeBraceIndex <= openBraceIndex) continue;

    blocks.push({
      tableName,
      body: content.slice(openBraceIndex + 1, closeBraceIndex),
      sourceFilePath: normalizePath(filePath),
    });
  }

  return blocks;
};

const DEFAULT_MIGRATION_COLUMN_BY_METHOD = new Map<string, string>([
  ['id', 'id'],
  ['bigIncrements', 'id'],
  ['increments', 'id'],
  ['rememberToken', 'remember_token'],
  ['softDeletes', 'deleted_at'],
  ['softDeletesTz', 'deleted_at'],
]);

const NO_COLUMN_METHODS = new Set([
  'drop',
  'dropColumn',
  'dropIfExists',
  'renameColumn',
  'dropTimestamps',
  'dropSoftDeletes',
  'dropRememberToken',
  'dropMorphs',
  'dropConstrainedForeignId',
  'dropForeign',
  'dropIndex',
  'dropUnique',
  'dropPrimary',
  'primary',
  'unique',
  'index',
  'comment',
  'nullable',
  'default',
  'unsigned',
]);

const extractMigrationColumnNames = (body: string): string[] => {
  const names = new Set<string>();
  const callRe = /\$table->([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*?)\)\s*(?:->[A-Za-z_][A-Za-z0-9_]*\([^)]*\)\s*)*;/g;
  let match: RegExpExecArray | null;

  while ((match = callRe.exec(body)) !== null) {
    const method = String(match[1] || '').trim();
    const argsText = String(match[2] || '');
    if (!method || NO_COLUMN_METHODS.has(method)) continue;

    if (method === 'timestamps' || method === 'timestampsTz') {
      names.add('created_at');
      names.add('updated_at');
      continue;
    }

    if (method === 'morphs' || method === 'nullableMorphs' || method === 'uuidMorphs') {
      const arg = extractQuotedArgs(argsText)[0];
      const stem = normalizeDbName(arg);
      if (!stem) continue;
      names.add(`${stem}_type`);
      names.add(`${stem}_id`);
      continue;
    }

    const args = extractQuotedArgs(argsText);
    let columnName = '';
    if (args.length > 0) columnName = normalizeDbName(args[0]);
    if (!columnName && method === 'foreignIdFor' && args.length > 1) {
      columnName = normalizeDbName(args[1]);
    }
    if (!columnName) {
      columnName = normalizeDbName(DEFAULT_MIGRATION_COLUMN_BY_METHOD.get(method) || '');
    }
    if (!columnName) continue;
    names.add(columnName);
  }

  return Array.from(names);
};

const normalizeFieldKeyForColumn = (fieldName: string): string => {
  const normalized = String(fieldName || '').trim();
  if (!normalized) return '';

  const dotExpanded = normalized
    .replace(/\[/g, '.')
    .replace(/\]/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '');

  const segments = dotExpanded
    .split('.')
    .map(segment => segment.trim())
    .filter(segment => Boolean(segment) && segment !== '*' && !/^\d+$/.test(segment));

  if (segments.length === 0) return normalizeDbName(normalized);
  return normalizeDbName(segments[segments.length - 1]);
};

const extractShapeTableHints = (className: string, sourceFilePath: string): string[] => {
  const candidates = new Set<string>();
  const normalizedClass = String(className || '').trim();
  const classCore = normalizedClass.replace(/(Request|Resource|Controller|Model|Policy)$/i, '').trim();
  const classSnake = normalizeDbName(toSnakeCase(classCore));
  if (classSnake) {
    candidates.add(classSnake);
    candidates.add(pluralizeSimple(classSnake));
  }

  const fileBase = normalizePath(sourceFilePath)
    .split('/')
    .pop()
    ?.replace(/\.[^.]+$/, '')
    ?.replace(/(_request|_resource|request|resource)$/i, '') || '';
  const fileSnake = normalizeDbName(toSnakeCase(fileBase));
  if (fileSnake) {
    candidates.add(fileSnake);
    candidates.add(pluralizeSimple(fileSnake));
  }

  return Array.from(candidates).filter(Boolean);
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
  const methodByFile = new Map<string, GraphNode[]>();

  for (const node of knowledgeGraph.nodes) {
    if (node.label === 'Class') {
      const filePath = normalizePath(node.properties.filePath || '');
      if (filePath && !classByFile.has(filePath)) classByFile.set(filePath, node);
      classById.set(node.id, node);
      continue;
    }

    if (node.label === 'Method') {
      const filePath = normalizePath(node.properties.filePath || '');
      if (!filePath) continue;
      const list = methodByFile.get(filePath) || [];
      list.push(node);
      methodByFile.set(filePath, list);
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
  const dbTableNodeMap = new Map<string, DBTableNode>();
  const dbColumnNodeMap = new Map<string, DBColumnNode>();
  const dbColumnsByName = new Map<string, DBColumnNode[]>();
  const dbColumnsByTableAndName = new Map<string, DBColumnNode>();
  const testCaseNodeMap = new Map<string, TestCaseNode>();
  const codeElementNodeMap = new Map<string, GraphNode>();
  const edgeMap = new Map<string, ShapeEdge>();
  const cacheKeyIdBySourceNodeId = new Map<string, string>();

  const addEdge = (edge: ShapeEdge) => {
    if (!edge.sourceId || !edge.targetId) return;
    if (!edgeMap.has(edge.id)) edgeMap.set(edge.id, edge);
  };

  const addCodeElementNode = (node: GraphNode) => {
    if (!node?.id) return;
    if (!codeElementNodeMap.has(node.id)) codeElementNodeMap.set(node.id, node);
  };

  const ensureShape = (
    shapeType: ShapeType,
    sourceNode: GraphNode,
  ): ContractShapeNode => {
    const id = generateId('ContractShape', `${shapeType}:${sourceNode.id}`);
    const existing = shapeNodeMap.get(id);
    if (existing) return existing;

    const sourceName = String(sourceNode.properties.name || '').trim();
    const shapeLabel = shapeType === 'form_request'
      ? buildLabel('FormRequest Shape', sourceName || sourceNode.id)
      : shapeType === 'resource'
        ? buildLabel('Resource Shape', sourceName || sourceNode.id)
        : buildLabel('Controller Validation Shape', sourceName || sourceNode.id);

    const node: ContractShapeNode = {
      id,
      label: shapeLabel,
      heuristicLabel: shapeLabel,
      shapeType,
      sourceNodeId: sourceNode.id,
      sourceFilePath: String(sourceNode.properties.filePath || ''),
    };

    shapeNodeMap.set(id, node);

    if (sourceNode.label === 'Class') {
      addEdge({
        id: generateId('DEFINES', `${sourceNode.id}->${id}`),
        type: 'DEFINES',
        sourceId: sourceNode.id,
        targetId: id,
        confidence: 1.0,
        reason: shapeType === 'form_request'
          ? 'shape:form-request'
          : shapeType === 'resource'
            ? 'shape:resource'
            : 'shape:controller-validation',
      });
    }

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

  const ensureDBTable = (
    tableNameRaw: string,
    sourceFilePath: string,
  ): DBTableNode | null => {
    const tableName = normalizeDbName(tableNameRaw);
    if (!tableName) return null;

    const id = generateId('DBTable', tableName);
    const existing = dbTableNodeMap.get(id);
    if (existing) return existing;

    const label = buildLabel('DB Table', tableName);
    const node: DBTableNode = {
      id,
      label,
      heuristicLabel: label,
      tableName,
      sourceFilePath: normalizePath(sourceFilePath),
    };
    dbTableNodeMap.set(id, node);
    return node;
  };

  const ensureDBColumn = (
    table: DBTableNode,
    columnNameRaw: string,
    sourceFilePath: string,
  ): DBColumnNode | null => {
    const columnName = normalizeDbName(columnNameRaw);
    if (!columnName) return null;

    const id = generateId('DBColumn', `${table.tableName}.${columnName}`);
    const existing = dbColumnNodeMap.get(id);
    if (existing) return existing;

    const label = buildLabel('DB Column', `${table.tableName}.${columnName}`);
    const node: DBColumnNode = {
      id,
      label,
      heuristicLabel: label,
      columnName,
      tableId: table.id,
      tableName: table.tableName,
      sourceFilePath: normalizePath(sourceFilePath),
    };
    dbColumnNodeMap.set(id, node);
    dbColumnsByTableAndName.set(`${table.tableName}|${columnName}`, node);

    const byName = dbColumnsByName.get(columnName) || [];
    byName.push(node);
    dbColumnsByName.set(columnName, byName);

    addEdge({
      id: generateId('MEMBER_OF', `${id}->${table.id}`),
      type: 'MEMBER_OF',
      sourceId: id,
      targetId: table.id,
      confidence: 1.0,
      reason: 'db-schema:column',
    });

    return node;
  };

  onProgress?.('Extracting migration table/column contracts...', 15);

  const migrationCandidates = files.filter(file => MIGRATION_FILE_RE.test(normalizePath(file.path)));
  for (const file of migrationCandidates) {
    const normalizedPath = normalizePath(file.path);
    const fileNodeId = generateId('File', normalizedPath);
    const tableBlocks = extractMigrationTableBlocks(normalizedPath, file.content);
    if (tableBlocks.length === 0) continue;

    for (const block of tableBlocks) {
      const dbTable = ensureDBTable(block.tableName, block.sourceFilePath);
      if (!dbTable) continue;

      addEdge({
        id: generateId('DEFINES', `${fileNodeId}->${dbTable.id}`),
        type: 'DEFINES',
        sourceId: fileNodeId,
        targetId: dbTable.id,
        confidence: 0.95,
        reason: 'db-schema:migration-table',
      });

      const columns = extractMigrationColumnNames(block.body);
      for (const columnName of columns) {
        ensureDBColumn(dbTable, columnName, block.sourceFilePath);
      }
    }
  }

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

  const controllerCandidates = files.filter(file => {
    const filePath = normalizePath(file.path);
    return filePath.includes('/Http/Controllers/') && filePath.toLowerCase().endsWith('.php');
  });
  for (const file of controllerCandidates) {
    const filePath = normalizePath(file.path);
    const methodNodes = methodByFile.get(filePath) || [];
    if (methodNodes.length === 0) continue;

    for (const methodNode of methodNodes) {
      const methodName = String(methodNode.properties.name || '').trim();
      if (!methodName) continue;

      const methodSpan = extractPhpMethodBodySpan(file.content, methodName);
      if (!methodSpan) continue;
      const methodBody = methodSpan.body;

      const boundaries = extractLaravelValidationBoundariesFromMethodBody(methodBody);
      const inlineValidation = extractLaravelInlineValidationKeysFromMethodBody(methodBody);
      if (boundaries.length === 0 && inlineValidation.keys.length === 0) continue;

      const fileNodeId = generateId('File', filePath);
      const methodBodyStartLine = 1 + countNewlinesUpTo(file.content, methodSpan.openBraceIdx + 1);

      for (const boundary of boundaries) {
        const boundaryLine = methodBodyStartLine + countNewlinesUpTo(methodBody, boundary.index);
        const boundaryId = generateId(
          'CodeElement',
          `laravel-validation-boundary:${filePath}:${methodName}:${boundaryLine}:${boundary.reason}`
        );

        addCodeElementNode({
          id: boundaryId,
          label: 'CodeElement',
          properties: {
            name: `Validation boundary (${boundary.reason})`,
            filePath,
            startLine: boundaryLine,
            endLine: boundaryLine,
            isExported: false,
            content: [
              `Kind: laravel-validation-boundary`,
              `Reason: ${boundary.reason}`,
              `Method: ${methodName}`,
              `Snippet: ${boundary.snippet || '<unknown>'}`,
              boundary.keys.length > 0 ? `Keys:\n- ${boundary.keys.join('\n- ')}` : `Keys: <unknown>`,
            ].join('\n'),
          },
        });

        addEdge({
          id: generateId('DEFINES', `${fileNodeId}->${boundaryId}`),
          type: 'DEFINES',
          sourceId: fileNodeId,
          targetId: boundaryId,
          confidence: 0.92,
          reason: 'laravel-validation-boundary:in-file',
        });
        addEdge({
          id: generateId('DEFINES', `${methodNode.id}->${boundaryId}`),
          type: 'DEFINES',
          sourceId: methodNode.id,
          targetId: boundaryId,
          confidence: 0.92,
          reason: `laravel-validation-boundary:in-method:${boundary.reason}`,
        });

        if (boundary.keys.length === 0) continue;
        const shape = ensureShape('controller_validation', methodNode);
        for (const fieldName of boundary.keys) {
          const field = ensureField(fieldName, shape);
          addEdge({
            id: generateId('VALIDATES_FIELD', `${boundaryId}:${field.id}`),
            type: 'VALIDATES_FIELD',
            sourceId: boundaryId,
            targetId: field.id,
            confidence: 0.9,
            reason: boundary.reason,
          });
          validatedFieldEdges++;
        }
      }

      if (inlineValidation.keys.length === 0) continue;

      const shape = ensureShape('controller_validation', methodNode);
      for (const fieldName of inlineValidation.keys) {
        const field = ensureField(fieldName, shape);
        addEdge({
          id: generateId('VALIDATES_FIELD', `${methodNode.id}:${field.id}`),
          type: 'VALIDATES_FIELD',
          sourceId: methodNode.id,
          targetId: field.id,
          confidence: 0.9,
          reason: inlineValidation.reason,
        });
        validatedFieldEdges++;
      }
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

  let derivesFromColumnEdges = 0;
  if (dbColumnNodeMap.size > 0 && fieldNodeMap.size > 0) {
    for (const field of fieldNodeMap.values()) {
      const columnKey = normalizeFieldKeyForColumn(field.fieldName);
      if (!columnKey) continue;

      const candidates = dbColumnsByName.get(columnKey) || [];
      if (candidates.length === 0) continue;

      let selected: DBColumnNode | null = null;
      let reason = 'db-schema:field-name-exact';
      let confidence = 0.86;

      if (candidates.length === 1) {
        selected = candidates[0];
      } else {
        const shape = shapeNodeMap.get(field.shapeId);
        const sourceClass = shape ? classById.get(shape.sourceNodeId) : null;
        const tableHints = extractShapeTableHints(
          String(sourceClass?.properties?.name || ''),
          String(shape?.sourceFilePath || ''),
        );
        const narrowed = candidates.filter(candidate => tableHints.includes(candidate.tableName));
        if (narrowed.length === 1) {
          selected = narrowed[0];
          reason = 'db-schema:field-name-shape-table';
          confidence = 0.82;
        }
      }

      if (!selected) continue;
      addEdge({
        id: generateId('DERIVES_FROM_COLUMN', `${field.id}->${selected.id}`),
        type: 'DERIVES_FROM_COLUMN',
        sourceId: field.id,
        targetId: selected.id,
        confidence,
        reason,
      });
      derivesFromColumnEdges++;
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
    dbTables: Array.from(dbTableNodeMap.values()),
    dbColumns: Array.from(dbColumnNodeMap.values()),
    testCases: Array.from(testCaseNodeMap.values()),
    codeElements: Array.from(codeElementNodeMap.values()),
    edges: Array.from(edgeMap.values()),
    stats: {
      shapeCount: shapeNodeMap.size,
      fieldCount: fieldNodeMap.size,
      cacheKeyCount: cacheKeyNodeMap.size,
      dbTableCount: dbTableNodeMap.size,
      dbColumnCount: dbColumnNodeMap.size,
      testCaseCount: testCaseNodeMap.size,
      codeElementCount: codeElementNodeMap.size,
      edgeCount: edgeMap.size,
      validatedFieldEdges,
      serializedFieldEdges,
      invalidationEdges,
      derivesFromColumnEdges,
      testsShapeEdges,
    },
  };
};
