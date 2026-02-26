import Parser from 'tree-sitter';
import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import { SymbolTable, SymbolDefinition } from './symbol-table.js';
import { ImportMap, PhpUseAliasMap, expandPhpClassRefFromUseAliases } from './import-processor.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename, getParseableContent, yieldToEventLoop } from './utils.js';
import { loadLanguage, loadParser } from '../tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../config/supported-languages.js';

type ResolvedType = {
  baseName: string;
  filePath: string;
  confidence: number;
  reason: string;
};

type ParsedClassConst = {
  classRef: string;
  constant: string;
};

const PHP_SCALAR_TYPES = new Set([
  'int',
  'float',
  'string',
  'bool',
  'boolean',
  'array',
  'callable',
  'iterable',
  'mixed',
  'object',
  'void',
  'never',
  'false',
  'true',
  'null',
  'self',
  'static',
  'parent',
]);

const looksLikePhpIdentifier = (value: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);

const stripPhpClassConstant = (value: string): string => value.trim().replace(/::class$/i, '').trim();

const normalizePhpClassRef = (value: string): { baseName: string; parts: string[] } => {
  const trimmed = value.trim().replace(/^\\+/, '');
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  const baseName = parts.at(-1) ?? '';
  return { baseName, parts };
};

const normalizePhpTypeRef = (raw: string): string | null => {
  const cleaned = stripPhpClassConstant(String(raw || '').trim())
    .replace(/^\?+/, '')
    .replace(/^\\+/, '')
    .trim();
  if (!cleaned) return null;
  if (PHP_SCALAR_TYPES.has(cleaned.toLowerCase())) return null;
  return cleaned;
};

const resolvePhpTypeRef = (
  typeRef: string,
  currentFilePath: string,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
  allowedTypes: Set<string>,
): ResolvedType | null => {
  const normalizedRef = normalizePhpTypeRef(typeRef);
  if (!normalizedRef) return null;

  const expandedRef = expandPhpClassRefFromUseAliases(normalizedRef, currentFilePath, phpUseAliases);
  const { baseName, parts } = normalizePhpClassRef(expandedRef);
  if (!looksLikePhpIdentifier(baseName)) return null;

  const defs = symbolTable
    .lookupFuzzy(baseName)
    .filter((def: SymbolDefinition) => allowedTypes.has(def.type));

  if (defs.length === 0) return null;

  const importedFiles = importMap.get(currentFilePath);
  if (importedFiles) {
    const importedMatches = defs.filter(def => importedFiles.has(def.filePath));
    if (importedMatches.length === 1) {
      return { baseName, filePath: importedMatches[0].filePath, confidence: 0.95, reason: 'import-resolved' };
    }
  }

  if (parts.length > 1) {
    const suffixes = new Set<string>();
    suffixes.add(`${parts.join('/')}.php`);
    suffixes.add(`${parts.slice(1).join('/')}.php`);

    const suffixMatches = defs.filter(def => {
      for (const suffix of suffixes) {
        const normalizedSuffix = suffix.replace(/^\/+/, '');
        if (!normalizedSuffix) continue;
        if (def.filePath === normalizedSuffix) return true;
        if (def.filePath.endsWith('/' + normalizedSuffix)) return true;
      }
      return false;
    });
    if (suffixMatches.length === 1) {
      return { baseName, filePath: suffixMatches[0].filePath, confidence: 0.9, reason: 'namespace-suffix' };
    }
  }

  if (defs.length === 1) {
    return { baseName, filePath: defs[0].filePath, confidence: 0.8, reason: 'fuzzy-global' };
  }

  return null;
};

const walkNodes = (node: any, fn: (n: any) => void) => {
  fn(node);
  for (let i = 0; i < node.namedChildCount; i++) walkNodes(node.namedChild(i), fn);
};

const getMethodName = (node: any): string | null => {
  if (!node || node.type !== 'method_declaration') return null;
  const nameNode = node.childForFieldName?.('name');
  return nameNode?.text?.trim() || null;
};

const getMethodBodyNode = (node: any): any | null => {
  if (!node || node.type !== 'method_declaration') return null;
  return node.childForFieldName?.('body')
    || node.namedChildren?.find((c: any) => c.type === 'compound_statement')
    || node.namedChildren?.find((c: any) => c.type === 'block')
    || null;
};

const getFunctionName = (node: any): string | null => {
  if (!node || node.type !== 'function_definition') return null;
  const nameNode = node.childForFieldName?.('name');
  return nameNode?.text?.trim() || null;
};

const getFunctionBodyNode = (node: any): any | null => {
  if (!node || node.type !== 'function_definition') return null;
  return node.childForFieldName?.('body')
    || node.namedChildren?.find((c: any) => c.type === 'compound_statement')
    || node.namedChildren?.find((c: any) => c.type === 'block')
    || null;
};

const parsePhpClassConstAccess = (node: any): ParsedClassConst | null => {
  if (!node || node.type !== 'class_constant_access_expression') return null;

  const raw = String(node.text || '').trim().replace(/^\\+/, '');
  const [classPart, constPart] = raw.split('::');
  const classRef = classPart?.trim();
  const constant = constPart?.trim();
  if (!classRef || !constant) return null;
  if (constant.toLowerCase() === 'class') return null;

  return { classRef, constant };
};

const extractMatchReturnConstsFromBody = (bodyNode: any): ParsedClassConst[] => {
  const parsed: ParsedClassConst[] = [];
  const seen = new Set<string>();

  walkNodes(bodyNode, (node: any) => {
    if (node.type !== 'match_conditional_expression' && node.type !== 'match_default_expression') return;

    const named = node.namedChildren || [];
    if (named.length === 0) return;
    const valueExpr = named.at(-1);
    if (!valueExpr || valueExpr.type !== 'class_constant_access_expression') return;

    const spec = parsePhpClassConstAccess(valueExpr);
    if (!spec) return;

    const key = `${spec.classRef}::${spec.constant}`;
    if (seen.has(key)) return;
    seen.add(key);
    parsed.push(spec);
  });

  return parsed;
};

export const processPhpMatchReturnEdges = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): Promise<{ edgesAdded: number }> => {
  const parser = await loadParser();
  let edgesAdded = 0;
  const addedRelationshipIds = new Set<string>();

  const addRelationshipOnce = (relationship: { id: string; type: string; sourceId: string; targetId: string; confidence: number; reason: string; }): boolean => {
    if (addedRelationshipIds.has(relationship.id)) return false;
    addedRelationshipIds.add(relationship.id);
    graph.addRelationship(relationship as any);
    return true;
  };

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (i % 200 === 0) await yieldToEventLoop();

    const language = getLanguageFromFilename(file.path);
    if (language !== SupportedLanguages.PHP) continue;

    await loadLanguage(language, file.path);

    let tree = astCache.get(file.path);
    if (!tree) {
      try {
        const content = getParseableContent(file.path, file.content);
        tree = parser.parse(content, undefined, { bufferSize: 1024 * 256 });
        astCache.set(file.path, tree);
      } catch {
        continue;
      }
    }

    const methods: any[] = [];
    const functions: any[] = [];
    walkNodes(tree.rootNode, (node: any) => {
      if (node.type === 'method_declaration') methods.push(node);
      if (node.type === 'function_definition') functions.push(node);
    });

    const processBody = async (symbolNodeId: string, currentFilePath: string, bodyNode: any) => {
      const specs = extractMatchReturnConstsFromBody(bodyNode);
      if (specs.length === 0) return;

      for (const spec of specs) {
        const resolved = resolvePhpTypeRef(
          spec.classRef,
          currentFilePath,
          symbolTable,
          importMap,
          phpUseAliases,
          new Set(['Enum', 'Class']),
        );
        if (!resolved || resolved.confidence < 0.9) continue;

        const defs = symbolTable
          .lookupFuzzy(spec.constant)
          .filter(def => def.filePath === resolved.filePath && def.type === 'Const');
        if (defs.length !== 1) continue;

        const targetId = defs[0].nodeId;
        const reason = `php-match-return:${resolved.baseName}::${spec.constant}`;
        const relId = generateId('CALLS', `${symbolNodeId}:${reason}->${targetId}`);
        if (addRelationshipOnce({
          id: relId,
          type: 'CALLS',
          sourceId: symbolNodeId,
          targetId,
          confidence: resolved.confidence,
          reason,
        })) {
          edgesAdded++;
        }
      }
    };

    for (const method of methods) {
      const methodName = getMethodName(method);
      if (!methodName) continue;
      const bodyNode = getMethodBodyNode(method);
      if (!bodyNode) continue;

      const methodNodeId = symbolTable.lookupExact(file.path, methodName)
        || generateId('Method', `${file.path}:${methodName}`);

      await processBody(methodNodeId, file.path, bodyNode);
    }

    for (const fn of functions) {
      const fnName = getFunctionName(fn);
      if (!fnName) continue;
      const bodyNode = getFunctionBodyNode(fn);
      if (!bodyNode) continue;

      const fnNodeId = symbolTable.lookupExact(file.path, fnName)
        || generateId('Function', `${file.path}:${fnName}`);

      await processBody(fnNodeId, file.path, bodyNode);
    }
  }

  return { edgesAdded };
};
