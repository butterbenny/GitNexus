import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import { SymbolTable, SymbolDefinition } from './symbol-table.js';
import { ImportMap, PhpUseAliasMap, expandPhpClassRefFromUseAliases } from './import-processor.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename, getParseableContent, yieldToEventLoop } from './utils.js';
import { loadLanguage, loadParser } from '../tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../config/supported-languages.js';

type ResolvedClass = {
  baseName: string;
  filePath: string;
  confidence: number;
  reason: string;
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

const normalizePhpTypeRef = (raw: string): string | null => {
  const cleaned = stripPhpClassConstant(String(raw || '').trim())
    .replace(/^\?+/, '')
    .replace(/^\\+/, '')
    .trim();
  if (!cleaned) return null;
  if (PHP_SCALAR_TYPES.has(cleaned.toLowerCase())) return null;
  return cleaned;
};

const normalizePhpClassRef = (value: string): { baseName: string; parts: string[] } => {
  const trimmed = value.trim().replace(/^\\+/, '');
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  const baseName = parts.at(-1) ?? '';
  return { baseName, parts };
};

const parsePhpNamespaceParts = (content: string): string[] => {
  const m = content.match(/^\s*namespace\s+([^;]+)\s*;/m);
  if (!m) return [];
  const raw = (m[1] || '').trim();
  if (!raw) return [];
  return raw.split('\\').map(p => p.trim()).filter(Boolean);
};

const resolvePhpClassToFile = (
  classRef: string,
  currentFilePath: string,
  currentNamespaceParts: string[],
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): ResolvedClass | null => {
  const normalized = normalizePhpTypeRef(classRef);
  if (!normalized) return null;

  const expanded = expandPhpClassRefFromUseAliases(normalized, currentFilePath, phpUseAliases);
  const expandedNormalized = normalizePhpTypeRef(expanded);
  if (!expandedNormalized) return null;

  const { baseName, parts } = normalizePhpClassRef(expandedNormalized);
  if (!looksLikePhpIdentifier(baseName)) return null;

  const classDefs = symbolTable
    .lookupFuzzy(baseName)
    .filter((def: SymbolDefinition) => def.type === 'Class');
  if (classDefs.length === 0) return null;

  const importedFiles = importMap.get(currentFilePath);
  if (importedFiles) {
    const importedMatches = classDefs.filter(def => importedFiles.has(def.filePath));
    if (importedMatches.length === 1) {
      return { baseName, filePath: importedMatches[0].filePath, confidence: 0.95, reason: 'import-resolved' };
    }
    if (importedMatches.length > 1) return null;
  }

  const tryNamespaceSuffixMatch = (pathParts: string[], reason: string): ResolvedClass | null => {
    if (pathParts.length <= 1) return null;

    const suffixes = new Set<string>();
    suffixes.add(`${pathParts.join('/')}.php`);
    suffixes.add(`${pathParts.slice(1).join('/')}.php`);

    const suffixMatches = classDefs.filter(def => {
      for (const suffix of suffixes) {
        if (suffix.length > 0 && def.filePath.endsWith(suffix)) return true;
      }
      return false;
    });
    if (suffixMatches.length !== 1) return null;
    return { baseName, filePath: suffixMatches[0].filePath, confidence: 0.9, reason };
  };

  const namespaceSuffixMatch = tryNamespaceSuffixMatch(parts, 'namespace-suffix');
  if (namespaceSuffixMatch) return namespaceSuffixMatch;

  const sameNamespaceParts = currentNamespaceParts.length > 0
    ? [...currentNamespaceParts, baseName]
    : [];
  const sameNamespaceMatch = tryNamespaceSuffixMatch(sameNamespaceParts, 'same-namespace');
  if (sameNamespaceMatch) return sameNamespaceMatch;

  return null;
};

const isLaravelModelFile = (filePath: string, content: string): boolean => {
  if (!filePath.endsWith('.php')) return false;
  if (!filePath.includes('/Models/')) return false;
  if (!content) return false;

  return /(?:\?->|->)\s*(hasMany|hasOne|belongsTo|belongsToMany|morphOne|morphMany|morphToMany|morphedByMany|hasManyThrough|hasOneThrough)\s*\(/.test(content);
};

const walkNodes = (node: any, fn: (n: any) => void) => {
  fn(node);
  for (let i = 0; i < node.namedChildCount; i++) walkNodes(node.namedChild(i), fn);
};

const peelExpression = (node: any): any | null => {
  let current = node;
  while (current) {
    if (current.type === 'parenthesized_expression') {
      current = current.namedChildren?.at(0) || null;
      continue;
    }
    return current;
  }
  return null;
};

const getCallArgumentExpressions = (argsNode: any): any[] => {
  if (!argsNode) return [];
  const named = argsNode.namedChildren || [];
  const exprs: any[] = [];

  for (const n of named) {
    if (n.type === 'argument') {
      const expr = n.namedChildren?.at(-1);
      if (expr) exprs.push(expr);
      continue;
    }
    exprs.push(n);
  }

  return exprs;
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

type RelationshipArgRole = { index: number; reasonSuffix: string };

const ELOQUENT_RELATIONSHIPS = new Map<string, RelationshipArgRole[]>([
  ['hasone', [{ index: 0, reasonSuffix: '' }]],
  ['hasmany', [{ index: 0, reasonSuffix: '' }]],
  ['belongsto', [{ index: 0, reasonSuffix: '' }]],
  ['belongstomany', [{ index: 0, reasonSuffix: '' }]],
  ['morphone', [{ index: 0, reasonSuffix: '' }]],
  ['morphmany', [{ index: 0, reasonSuffix: '' }]],
  ['morphtomany', [{ index: 0, reasonSuffix: '' }]],
  ['morphedbymany', [{ index: 0, reasonSuffix: '' }]],
  ['hasmanythrough', [{ index: 0, reasonSuffix: '' }, { index: 1, reasonSuffix: ':through' }]],
  ['hasonethrough', [{ index: 0, reasonSuffix: '' }, { index: 1, reasonSuffix: ':through' }]],
]);

const findRelationshipCallInChain = (expr: any): { call: any; methodKey: string; methodName: string } | null => {
  const node = peelExpression(expr);
  if (!node) return null;

  if (node.type !== 'member_call_expression' && node.type !== 'nullsafe_member_call_expression') return null;

  const nameNode = node.childForFieldName?.('name');
  const methodNameRaw = String(nameNode?.text || '').trim();
  const methodKey = methodNameRaw.toLowerCase();

  if (methodKey && ELOQUENT_RELATIONSHIPS.has(methodKey)) {
    const objectNode = peelExpression(node.childForFieldName?.('object'));
    if (objectNode?.type === 'variable_name' && objectNode.text === '$this') {
      return { call: node, methodKey, methodName: methodNameRaw };
    }
  }

  const objectNode = node.childForFieldName?.('object');
  return findRelationshipCallInChain(objectNode);
};

const parsePhpStringLiteral = (node: any): string | null => {
  if (!node || node.type !== 'string') return null;
  const text = String(node.text || '').trim();
  if (text.length < 2) return null;
  const quote = text[0];
  if ((quote !== '\'' && quote !== '"') || text[text.length - 1] !== quote) return null;
  const inner = text.slice(1, -1);
  if (!inner) return null;
  return inner;
};

const parsePhpClassRefFromArgExpression = (node: any): string | null => {
  const expr = peelExpression(node);
  if (!expr) return null;

  if (expr.type === 'class_constant_access_expression') {
    return normalizePhpTypeRef(String(expr.text || ''));
  }

  const asString = parsePhpStringLiteral(expr);
  if (asString) return normalizePhpTypeRef(asString);

  return null;
};

export const processLaravelEloquentRelationships = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): Promise<{ edgesAdded: number }> => {
  const parser = await loadParser();
  let edgesAdded = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (i % 250 === 0) await yieldToEventLoop();

    if (!isLaravelModelFile(file.path, file.content)) continue;

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

    const namespaceParts = parsePhpNamespaceParts(file.content);

    const methods: any[] = [];
    walkNodes(tree.rootNode, (node: any) => {
      if (node.type === 'method_declaration') methods.push(node);
    });

    for (const method of methods) {
      const methodName = getMethodName(method);
      if (!methodName) continue;

      const methodNodeId = symbolTable.lookupExact(file.path, methodName)
        || generateId('Method', `${file.path}:${methodName}`);

      const bodyNode = getMethodBodyNode(method);
      if (!bodyNode) continue;

      walkNodes(bodyNode, (node: any) => {
        if (node.type !== 'return_statement') return;

        const exprNode = node.namedChildren?.at(0);
        const relationship = findRelationshipCallInChain(exprNode);
        if (!relationship) return;

        const roles = ELOQUENT_RELATIONSHIPS.get(relationship.methodKey);
        if (!roles || roles.length === 0) return;

        const argsNode = relationship.call.childForFieldName?.('arguments');
        const args = getCallArgumentExpressions(argsNode);

        for (const role of roles) {
          const argExpr = args[role.index];
          if (!argExpr) continue;

          const classRef = parsePhpClassRefFromArgExpression(argExpr);
          if (!classRef) continue;

          const resolved = resolvePhpClassToFile(classRef, file.path, namespaceParts, symbolTable, importMap, phpUseAliases);
          if (!resolved || resolved.confidence < 0.9) continue;

          const targetId = symbolTable.lookupExact(resolved.filePath, resolved.baseName)
            || generateId('Class', `${resolved.filePath}:${resolved.baseName}`);

          const reason = `laravel-eloquent:${relationship.methodName}${role.reasonSuffix}`;
          const relId = generateId('CALLS', `${methodNodeId}:${reason}->${targetId}`);
          graph.addRelationship({
            id: relId,
            type: 'CALLS',
            sourceId: methodNodeId,
            targetId,
            confidence: resolved.confidence,
            reason,
          });
          edgesAdded++;
        }
      });
    }
  }

  return { edgesAdded };
};
