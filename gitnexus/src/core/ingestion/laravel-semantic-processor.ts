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

const normalizePhpClassRef = (value: string): { baseName: string; parts: string[] } => {
  const trimmed = value.trim().replace(/^\\+/, '');
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  const baseName = parts.at(-1) ?? '';
  return { baseName, parts };
};

const resolvePhpClassToFile = (
  classRef: string,
  currentFilePath: string,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): ResolvedClass | null => {
  const normalizedRef = stripPhpClassConstant(classRef);
  const expandedRef = expandPhpClassRefFromUseAliases(normalizedRef, currentFilePath, phpUseAliases);
  const { baseName, parts } = normalizePhpClassRef(expandedRef);
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
  }

  if (parts.length > 1) {
    const suffixes = new Set<string>();
    suffixes.add(`${parts.join('/')}.php`);
    suffixes.add(`${parts.slice(1).join('/')}.php`);

    const suffixMatches = classDefs.filter(def => {
      for (const suffix of suffixes) {
        if (suffix.length > 0 && def.filePath.endsWith(suffix)) return true;
      }
      return false;
    });
    if (suffixMatches.length === 1) {
      return { baseName, filePath: suffixMatches[0].filePath, confidence: 0.9, reason: 'namespace-suffix' };
    }
  }

  return null;
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

const walkNodes = (node: any, fn: (n: any) => void) => {
  fn(node);
  for (let i = 0; i < node.namedChildCount; i++) walkNodes(node.namedChild(i), fn);
};

const isLaravelControllerFile = (filePath: string): boolean => filePath.includes('/Http/Controllers/');

const isLaravelFormRequestFile = (filePath: string): boolean => filePath.includes('/Http/Requests/');

const isLaravelResourceFile = (filePath: string): boolean => filePath.includes('/Http/Resources/');

const parseClassRefFromReturnExpression = (expr: any): string | null => {
  if (!expr) return null;

  if (expr.type === 'object_creation_expression') {
    const nameNode = expr.childForFieldName?.('name');
    const text = nameNode?.text?.trim();
    if (text) return stripPhpClassConstant(text);

    const fallback = expr.namedChildren?.find((c: any) => c.type === 'qualified_name' || c.type === 'name');
    const fallbackText = fallback?.text?.trim();
    return fallbackText ? stripPhpClassConstant(fallbackText) : null;
  }

  if (expr.type === 'scoped_call_expression') {
    const scopeNode = expr.childForFieldName?.('scope');
    const scopeText = scopeNode?.text?.trim();
    return scopeText ? stripPhpClassConstant(scopeText) : null;
  }

  return null;
};

export const processLaravelSemanticEdges = async (
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
    if (i % 200 === 0) await yieldToEventLoop();

    if (!isLaravelControllerFile(file.path)) continue;

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
    walkNodes(tree.rootNode, (node: any) => {
      if (node.type === 'method_declaration') methods.push(node);
    });

    for (const method of methods) {
      const methodName = getMethodName(method);
      if (!methodName) continue;

      const methodNodeId = symbolTable.lookupExact(file.path, methodName)
        || generateId('Method', `${file.path}:${methodName}`);

      const paramsNode = method.childForFieldName?.('parameters');
      const params = paramsNode?.namedChildren || [];

      for (const param of params) {
        if (param.type !== 'simple_parameter' && param.type !== 'property_promotion_parameter') continue;

        const typeNode = param.childForFieldName?.('type');
        if (!typeNode) continue;

        const innerType = typeNode.namedChildren?.[0];
        const classRefRaw = String((innerType?.text ?? typeNode.text) || '').trim();
        const classRef = stripPhpClassConstant(classRefRaw).replace(/^\?+/, '').replace(/^\\+/, '');
        if (!classRef) continue;
        if (PHP_SCALAR_TYPES.has(classRef.toLowerCase())) continue;

        const resolved = resolvePhpClassToFile(classRef, file.path, symbolTable, importMap, phpUseAliases);
        if (!resolved || resolved.confidence < 0.9) continue;

        if (!isLaravelFormRequestFile(resolved.filePath)) continue;

        const targetId = symbolTable.lookupExact(resolved.filePath, resolved.baseName)
          || generateId('Class', `${resolved.filePath}:${resolved.baseName}`);

        const reason = 'laravel-form-request:param';
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

      const bodyNode = getMethodBodyNode(method);
      if (!bodyNode) continue;

      walkNodes(bodyNode, (node: any) => {
        if (node.type !== 'return_statement') return;

        const expr = node.namedChildren?.at(0);
        const classRef = parseClassRefFromReturnExpression(expr);
        if (!classRef) return;

        const normalized = classRef.replace(/^\?+/, '').replace(/^\\+/, '');
        if (!normalized) return;
        const { baseName } = normalizePhpClassRef(normalized);
        if (!baseName) return;
        if (PHP_SCALAR_TYPES.has(baseName.toLowerCase())) return;

        const resolved = resolvePhpClassToFile(normalized, file.path, symbolTable, importMap, phpUseAliases);
        if (!resolved || resolved.confidence < 0.9) return;
        if (!isLaravelResourceFile(resolved.filePath)) return;

        const targetId = symbolTable.lookupExact(resolved.filePath, resolved.baseName)
          || generateId('Class', `${resolved.filePath}:${resolved.baseName}`);

        const reason = 'laravel-resource:return';
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
      });
    }
  }

  return { edgesAdded };
};
