import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import { SymbolTable, SymbolDefinition } from './symbol-table.js';
import { ImportMap, PhpUseAliasMap, expandPhpClassRefFromUseAliases } from './import-processor.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename } from './utils.js';
import { loadLanguage, loadParser } from '../tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../config/supported-languages.js';

type ResolvedClass = {
  filePath: string;
  confidence: number;
  reason: string;
};

type LaravelEventHandlerTarget = {
  classRef: string;
  methodName: string;
};

const EVENT_PROVIDER_FILE_PATH_RE = /(^|\/)EventServiceProvider\.php$/i;

const looksLikePhpIdentifier = (value: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);

const normalizePhpClassRef = (value: string): { baseName: string; parts: string[] } => {
  const trimmed = value.trim().replace(/^\\+/, '');
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  const baseName = parts.at(-1) ?? '';
  return { baseName, parts };
};

const stripPhpClassConstant = (value: string): string => {
  return value.trim().replace(/::class$/i, '').trim();
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
      return { filePath: importedMatches[0].filePath, confidence: 0.95, reason: 'import-resolved' };
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
      return { filePath: suffixMatches[0].filePath, confidence: 0.9, reason: 'namespace-suffix' };
    }
  }

  const listenerHeuristic = classDefs.filter(def => {
    return def.filePath.includes('/Listeners/') || def.filePath.endsWith('Listener.php');
  });
  if (listenerHeuristic.length === 1) {
    return { filePath: listenerHeuristic[0].filePath, confidence: 0.8, reason: 'listener-heuristic' };
  }

  if (classDefs.length === 1) {
    return { filePath: classDefs[0].filePath, confidence: 0.65, reason: 'fuzzy-class' };
  }

  return null;
};

const walkNodes = (node: any, fn: (n: any) => void) => {
  fn(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    walkNodes(node.namedChild(i), fn);
  }
};

const extractStringContent = (node: any): string | null => {
  if (!node) return null;
  if (node.type === 'string_content') return node.text ?? null;

  const queue = [node];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    if (current.type === 'string_content') return current.text ?? null;
    for (let i = 0; i < current.namedChildCount; i++) {
      queue.push(current.namedChild(i));
    }
  }

  return null;
};

const parseClassRefFromExpression = (node: any): string | null => {
  if (!node) return null;
  if (node.type === 'class_constant_access_expression') return stripPhpClassConstant(node.text ?? '');
  if (node.type === 'qualified_name') return node.text ?? null;
  if (node.type === 'name') return node.text ?? null;

  if (node.type === 'string') {
    const raw = extractStringContent(node);
    if (!raw) return null;
    const classPart = raw.split('@', 2)[0]?.trim();
    return classPart ? stripPhpClassConstant(classPart) : null;
  }

  return null;
};

const parseListenerTargetFromExpression = (node: any): LaravelEventHandlerTarget | null => {
  if (!node) return null;

  if (node.type === 'array_creation_expression') {
    const elements = node.namedChildren.filter((c: any) => c.type === 'array_element_initializer');
    const firstExpr = elements[0]?.namedChildren?.at(-1);
    const secondExpr = elements[1]?.namedChildren?.at(-1);
    const classRef = parseClassRefFromExpression(firstExpr);
    const methodName = extractStringContent(secondExpr) || 'handle';
    if (!classRef || !looksLikePhpIdentifier(methodName)) return null;
    return { classRef, methodName };
  }

  if (node.type === 'string') {
    const raw = extractStringContent(node);
    if (!raw) return null;
    const [classPartRaw, methodPartRaw] = raw.split('@', 2);
    const classRef = classPartRaw?.trim();
    if (!classRef) return null;
    const methodName = methodPartRaw?.trim() || 'handle';
    if (!looksLikePhpIdentifier(methodName)) return null;
    return { classRef: stripPhpClassConstant(classRef), methodName };
  }

  const classRef = parseClassRefFromExpression(node);
  if (!classRef) return null;
  return { classRef, methodName: 'handle' };
};

const extractEventProviderTargets = (rootNode: any): { listen: LaravelEventHandlerTarget[]; subscribe: string[] } => {
  const listen: LaravelEventHandlerTarget[] = [];
  const subscribe: string[] = [];

  const propertyElements: any[] = [];
  walkNodes(rootNode, (node: any) => {
    if (node.type === 'property_element') propertyElements.push(node);
  });

  for (const element of propertyElements) {
    const variableNode = element.namedChildren.find((n: any) => n.type === 'variable_name');
    const initializerNode = element.namedChildren.find((n: any) => n.type === 'property_initializer');
    if (!variableNode || !initializerNode) continue;

    const variable = variableNode.text?.trim();
    if (variable !== '$listen' && variable !== '$subscribe') continue;

    const valueExpr = initializerNode.namedChildren.at(0);
    if (!valueExpr || valueExpr.type !== 'array_creation_expression') continue;

    const topLevelElements = valueExpr.namedChildren.filter((c: any) => c.type === 'array_element_initializer');

    if (variable === '$listen') {
      for (const entry of topLevelElements) {
        const entryChildren = entry.namedChildren;
        if (!entryChildren || entryChildren.length < 2) continue;
        const listenersExpr = entryChildren[1];
        if (!listenersExpr || listenersExpr.type !== 'array_creation_expression') continue;

        const listenerEntries = listenersExpr.namedChildren.filter((c: any) => c.type === 'array_element_initializer');
        for (const listenerEntry of listenerEntries) {
          const value = listenerEntry.namedChildren?.at(-1);
          const target = parseListenerTargetFromExpression(value);
          if (!target) continue;
          listen.push(target);
        }
      }
    }

    if (variable === '$subscribe') {
      for (const entry of topLevelElements) {
        const value = entry.namedChildren?.at(-1);
        const classRef = parseClassRefFromExpression(value);
        if (!classRef) continue;
        subscribe.push(classRef);
      }
    }
  }

  return { listen, subscribe };
};

export const processLaravelEvents = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): Promise<{ filesProcessed: number; relationshipsAdded: number }> => {
  const eventProviderFiles = files.filter(f => EVENT_PROVIDER_FILE_PATH_RE.test(f.path));
  if (eventProviderFiles.length === 0) return { filesProcessed: 0, relationshipsAdded: 0 };

  const parser = await loadParser();
  await loadLanguage(SupportedLanguages.PHP);

  let relationshipsAdded = 0;
  let filesProcessed = 0;

  for (const file of eventProviderFiles) {
    const lang = getLanguageFromFilename(file.path);
    if (lang !== SupportedLanguages.PHP) continue;

    filesProcessed++;

    let tree = astCache.get(file.path);
    if (!tree) {
      try {
        tree = parser.parse(file.content, undefined, { bufferSize: 1024 * 256 });
        astCache.set(file.path, tree);
      } catch {
        continue;
      }
    }

    const targets = extractEventProviderTargets(tree.rootNode);
    if (targets.listen.length === 0 && targets.subscribe.length === 0) continue;

    const sourceId = generateId('File', file.path);

    for (const handler of targets.listen) {
      const resolved = resolvePhpClassToFile(handler.classRef, file.path, symbolTable, importMap, phpUseAliases);
      if (!resolved) continue;

      const methodNodeId = symbolTable.lookupExact(resolved.filePath, handler.methodName);
      if (!methodNodeId) continue;

      const relId = generateId('CALLS', `${sourceId}:laravel-event-listen->${methodNodeId}`);
      graph.addRelationship({
        id: relId,
        type: 'CALLS',
        sourceId,
        targetId: methodNodeId,
        confidence: resolved.confidence,
        reason: `laravel-event-listen-${resolved.reason}`,
      });
      relationshipsAdded++;
    }

    for (const subscriberClassRef of targets.subscribe) {
      const resolved = resolvePhpClassToFile(subscriberClassRef, file.path, symbolTable, importMap, phpUseAliases);
      if (!resolved) continue;

      const methodNodeId = symbolTable.lookupExact(resolved.filePath, 'subscribe');
      if (!methodNodeId) continue;

      const relId = generateId('CALLS', `${sourceId}:laravel-event-subscribe->${methodNodeId}`);
      graph.addRelationship({
        id: relId,
        type: 'CALLS',
        sourceId,
        targetId: methodNodeId,
        confidence: resolved.confidence,
        reason: `laravel-event-subscribe-${resolved.reason}`,
      });
      relationshipsAdded++;
    }
  }

  return { filesProcessed, relationshipsAdded };
};
