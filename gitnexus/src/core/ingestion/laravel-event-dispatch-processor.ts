import Parser from 'tree-sitter';
import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import { SymbolTable, SymbolDefinition } from './symbol-table.js';
import { ImportMap, PhpUseAliasMap, expandPhpClassRefFromUseAliases } from './import-processor.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename, yieldToEventLoop } from './utils.js';
import { loadLanguage, loadParser } from '../tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../config/supported-languages.js';

type ResolvedClass = {
  filePath: string;
  confidence: number;
  reason: string;
};

type DispatchKind = 'helper' | 'facade' | 'static';

type ExtractedEventDispatchCall = {
  callNode: any;
  kind: DispatchKind;
  classRef: string;
};

type LaravelEventHandlerTarget = {
  classRef: string;
  methodName: string;
};

type IndexedListenerTarget = {
  methodNodeId: string;
  confidence: number;
};

const EVENT_PROVIDER_FILE_PATH_RE = /(^|\/)EventServiceProvider\.php$/i;

const looksLikePhpIdentifier = (value: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);

const normalizePhpClassRef = (value: string): { baseName: string; parts: string[] } => {
  const trimmed = value.trim().replace(/^\\+/, '');
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  const baseName = parts.at(-1) ?? '';
  return { baseName, parts };
};

const stripPhpClassConstant = (value: string): string => value.trim().replace(/::class$/i, '').trim();

type ResolveKind = 'event' | 'listener';

const resolvePhpClassToFile = (
  classRef: string,
  currentFilePath: string,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
  kind: ResolveKind,
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

  if (kind === 'event') {
    const eventHeuristic = classDefs.filter(def => def.filePath.includes('/Events/'));
    if (eventHeuristic.length === 1) {
      return { filePath: eventHeuristic[0].filePath, confidence: 0.8, reason: 'event-heuristic' };
    }
  }

  if (kind === 'listener') {
    const listenerHeuristic = classDefs.filter(def => {
      return def.filePath.includes('/Listeners/') || def.filePath.endsWith('Listener.php');
    });
    if (listenerHeuristic.length === 1) {
      return { filePath: listenerHeuristic[0].filePath, confidence: 0.8, reason: 'listener-heuristic' };
    }
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

const extractEventListenMappings = (rootNode: any): Array<{ eventClassRef: string; handler: LaravelEventHandlerTarget }> => {
  const mappings: Array<{ eventClassRef: string; handler: LaravelEventHandlerTarget }> = [];

  const propertyElements: any[] = [];
  walkNodes(rootNode, (node: any) => {
    if (node.type === 'property_element') propertyElements.push(node);
  });

  for (const element of propertyElements) {
    const variableNode = element.namedChildren.find((n: any) => n.type === 'variable_name');
    const initializerNode = element.namedChildren.find((n: any) => n.type === 'property_initializer');
    if (!variableNode || !initializerNode) continue;

    const variable = variableNode.text?.trim();
    if (variable !== '$listen') continue;

    const valueExpr = initializerNode.namedChildren.at(0);
    if (!valueExpr || valueExpr.type !== 'array_creation_expression') continue;

    const topLevelElements = valueExpr.namedChildren.filter((c: any) => c.type === 'array_element_initializer');
    for (const entry of topLevelElements) {
      const entryChildren = entry.namedChildren;
      if (!entryChildren || entryChildren.length < 2) continue;

      const eventExpr = entryChildren[0];
      const listenersExpr = entryChildren[1];
      if (!listenersExpr || listenersExpr.type !== 'array_creation_expression') continue;

      const eventClassRef = parseClassRefFromExpression(eventExpr);
      if (!eventClassRef) continue;

      const listenerEntries = listenersExpr.namedChildren.filter((c: any) => c.type === 'array_element_initializer');
      for (const listenerEntry of listenerEntries) {
        const value = listenerEntry.namedChildren?.at(-1);
        const target = parseListenerTargetFromExpression(value);
        if (!target) continue;
        mappings.push({ eventClassRef, handler: target });
      }
    }
  }

  return mappings;
};

const extractEventSubscriberClassRefs = (rootNode: any): string[] => {
  const subscriberClassRefs: string[] = [];

  const propertyElements: any[] = [];
  walkNodes(rootNode, (node: any) => {
    if (node.type === 'property_element') propertyElements.push(node);
  });

  for (const element of propertyElements) {
    const variableNode = element.namedChildren.find((n: any) => n.type === 'variable_name');
    const initializerNode = element.namedChildren.find((n: any) => n.type === 'property_initializer');
    if (!variableNode || !initializerNode) continue;

    const variable = variableNode.text?.trim();
    if (variable !== '$subscribe') continue;

    const valueExpr = initializerNode.namedChildren.at(0);
    if (!valueExpr || valueExpr.type !== 'array_creation_expression') continue;

    const entries = valueExpr.namedChildren.filter((c: any) => c.type === 'array_element_initializer');
    for (const entry of entries) {
      const value = entry.namedChildren?.at(-1);
      const classRef = parseClassRefFromExpression(value);
      if (!classRef) continue;
      subscriberClassRefs.push(classRef);
    }
  }

  return Array.from(new Set(subscriberClassRefs));
};

const parseClassRefFromDispatchArg = (argNode: any): string | null => {
  if (!argNode) return null;

  if (argNode.type === 'class_constant_access_expression') {
    return stripPhpClassConstant(argNode.text ?? '');
  }

  if (argNode.type === 'object_creation_expression') {
    const nameNode = argNode.childForFieldName?.('name');
    const text = nameNode?.text?.trim();
    if (text) return stripPhpClassConstant(text);

    const fallback = argNode.namedChildren.find((c: any) => c.type === 'qualified_name' || c.type === 'name');
    const fallbackText = fallback?.text?.trim();
    return fallbackText ? stripPhpClassConstant(fallbackText) : null;
  }

  if (argNode.type === 'qualified_name' || argNode.type === 'name') {
    const text = argNode.text?.trim();
    return text ? stripPhpClassConstant(text) : null;
  }

  return null;
};

const getMethodName = (node: any): string | null => {
  if (!node || node.type !== 'method_declaration') return null;
  const nameNode = node.childForFieldName?.('name');
  return nameNode?.text?.trim() || null;
};

const getMethodParametersNode = (node: any): any | null => {
  if (!node || node.type !== 'method_declaration') return null;
  return node.childForFieldName?.('parameters')
    || node.namedChildren?.find((c: any) => c.type === 'formal_parameters')
    || null;
};

const getMethodBodyNode = (node: any): any | null => {
  if (!node || node.type !== 'method_declaration') return null;
  return node.childForFieldName?.('body')
    || node.namedChildren?.find((c: any) => c.type === 'compound_statement')
    || node.namedChildren?.find((c: any) => c.type === 'block')
    || null;
};

const extractSubscriberListenMappings = (
  rootNode: any,
): Array<{ eventClassRef: string; handler: LaravelEventHandlerTarget }> => {
  const mappings: Array<{ eventClassRef: string; handler: LaravelEventHandlerTarget }> = [];

  const methods: any[] = [];
  walkNodes(rootNode, (node: any) => {
    if (node.type === 'method_declaration') methods.push(node);
  });

  for (const method of methods) {
    const name = getMethodName(method);
    if (name !== 'subscribe') continue;

    const paramVars = new Set<string>();
    const paramsNode = getMethodParametersNode(method);
    if (paramsNode) {
      walkNodes(paramsNode, (node: any) => {
        if (node.type === 'variable_name') {
          const text = node.text?.trim();
          if (text) paramVars.add(text);
        }
      });
    }

    const dispatcherVars = paramVars.size > 0 ? paramVars : new Set<string>(['$events']);

    const bodyNode = getMethodBodyNode(method);
    if (!bodyNode) continue;

    walkNodes(bodyNode, (node: any) => {
      if (node.type !== 'member_call_expression') return;

      const objectNode = node.childForFieldName?.('object');
      const nameNode = node.childForFieldName?.('name');
      const argsNode = node.childForFieldName?.('arguments');
      const objectText = objectNode?.text?.trim();
      const methodName = nameNode?.text?.trim();
      if (!objectText || !methodName || methodName !== 'listen') return;
      if (objectNode?.type !== 'variable_name') return;
      if (!dispatcherVars.has(objectText)) return;

      const args = getCallArgumentExpressions(argsNode);
      if (args.length < 2) return;

      const eventClassRef = parseClassRefFromDispatchArg(args[0]);
      if (!eventClassRef) return;

      const handler = parseListenerTargetFromExpression(args[1]);
      if (!handler) return;

      mappings.push({ eventClassRef, handler });
    });
  }

  return mappings;
};

const getScopeBaseName = (value: string): string => {
  const trimmed = value.trim().replace(/^\\+/, '');
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? trimmed;
};

const DISPATCH_STATIC_METHODS = new Set([
  'dispatch',
  'dispatchAfterResponse',
  'dispatchIf',
  'dispatchUnless',
]);

const getCallArgumentExpressions = (argsNode: any): any[] => {
  if (!argsNode) return [];
  const named = argsNode.namedChildren || [];
  const exprs: any[] = [];

  for (const node of named) {
    if (node.type === 'argument') {
      const expr = node.namedChildren?.at(-1);
      if (expr) exprs.push(expr);
      continue;
    }
    exprs.push(node);
  }

  return exprs;
};

const extractEventDispatchCallsFromTree = (tree: Parser.Tree): ExtractedEventDispatchCall[] => {
  const calls: ExtractedEventDispatchCall[] = [];

  const visit = (node: any) => {
    if (!node) return;

    if (node.type === 'function_call_expression') {
      const fnNode = node.childForFieldName?.('function');
      const fnName = fnNode?.text?.trim();
      if (fnName === 'event') {
        const argsNode = node.childForFieldName?.('arguments');
        const args = getCallArgumentExpressions(argsNode);
        const classRef = parseClassRefFromDispatchArg(args[0]);
        if (classRef) calls.push({ callNode: node, kind: 'helper', classRef });
      }
    }

    if (node.type === 'scoped_call_expression') {
      const scopeNode = node.childForFieldName?.('scope');
      const methodNode = node.childForFieldName?.('name');
      const methodName = methodNode?.text?.trim();
      const scopeText = scopeNode?.text?.trim();

      if (methodName && scopeText && DISPATCH_STATIC_METHODS.has(methodName)) {
        const baseScope = getScopeBaseName(scopeText);
        if (baseScope === 'Event') {
          const argsNode = node.childForFieldName?.('arguments');
          const args = getCallArgumentExpressions(argsNode);
          const classRef = parseClassRefFromDispatchArg(args[0]);
          if (classRef) calls.push({ callNode: node, kind: 'facade', classRef });
        } else {
          calls.push({ callNode: node, kind: 'static', classRef: stripPhpClassConstant(scopeText) });
        }
      }
    }

    for (const child of node.namedChildren || []) {
      visit(child);
    }
  };

  visit(tree.rootNode);
  return calls;
};

const findEnclosingPhpCallableId = (
  node: any,
  filePath: string,
  symbolTable: SymbolTable
): string => {
  let current = node.parent;

  while (current) {
    if (current.type === 'method_declaration') {
      const nameNode = current.childForFieldName?.('name');
      const name = nameNode?.text;
      if (name) {
        return symbolTable.lookupExact(filePath, name) || generateId('Method', `${filePath}:${name}`);
      }
    }
    if (current.type === 'function_definition') {
      const nameNode = current.childForFieldName?.('name');
      const name = nameNode?.text;
      if (name) {
        return symbolTable.lookupExact(filePath, name) || generateId('Function', `${filePath}:${name}`);
      }
    }
    current = current.parent;
  }

  return generateId('File', filePath);
};

const isEventDispatchRelevantFile = (filePath: string, content: string): boolean => {
  const lang = getLanguageFromFilename(filePath);
  if (lang !== SupportedLanguages.PHP) return false;
  // Cheap prefilter before parsing.
  return /\bevent\s*\(|\bEvent\s*::\s*dispatch\b|::\s*dispatch(?:AfterResponse|If|Unless)?\s*\(/.test(content);
};

const buildLaravelEventListenerIndex = async (
  files: { path: string; content: string }[],
  astCache: ASTCache,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
  parser: Parser,
): Promise<{ listenersByEventFile: Map<string, IndexedListenerTarget[]>; eventBaseNames: Set<string> }> => {
  const listenersByEventFile = new Map<string, IndexedListenerTarget[]>();
  const eventBaseNames = new Set<string>();

  const fileByPath = new Map<string, { path: string; content: string }>();
  for (const file of files) fileByPath.set(file.path, file);

  const providerFiles = files.filter(f => EVENT_PROVIDER_FILE_PATH_RE.test(f.path));
  if (providerFiles.length === 0) return { listenersByEventFile, eventBaseNames };

  for (const file of providerFiles) {
    const lang = getLanguageFromFilename(file.path);
    if (lang !== SupportedLanguages.PHP) continue;

    let tree = astCache.get(file.path);
    if (!tree) {
      try {
        tree = parser.parse(file.content, undefined, { bufferSize: 1024 * 256 });
        astCache.set(file.path, tree);
      } catch {
        continue;
      }
    }

    const mappings = extractEventListenMappings(tree.rootNode);
    const subscriberClassRefs = extractEventSubscriberClassRefs(tree.rootNode);

    for (const mapping of mappings) {
      const resolvedEvent = resolvePhpClassToFile(mapping.eventClassRef, file.path, symbolTable, importMap, phpUseAliases, 'event');
      if (!resolvedEvent) continue;

      const resolvedListener = resolvePhpClassToFile(mapping.handler.classRef, file.path, symbolTable, importMap, phpUseAliases, 'listener');
      if (!resolvedListener) continue;

      const methodNodeId = symbolTable.lookupExact(resolvedListener.filePath, mapping.handler.methodName);
      if (!methodNodeId) continue;

      const confidence = Math.min(resolvedEvent.confidence, resolvedListener.confidence);

      const expandedEventRef = expandPhpClassRefFromUseAliases(
        stripPhpClassConstant(mapping.eventClassRef),
        file.path,
        phpUseAliases,
      );
      eventBaseNames.add(normalizePhpClassRef(expandedEventRef).baseName);

      let list = listenersByEventFile.get(resolvedEvent.filePath);
      if (!list) {
        list = [];
        listenersByEventFile.set(resolvedEvent.filePath, list);
      }

      if (!list.some(item => item.methodNodeId === methodNodeId)) {
        list.push({ methodNodeId, confidence });
      }
    }

    for (const subscriberClassRef of subscriberClassRefs) {
      const resolvedSubscriber = resolvePhpClassToFile(subscriberClassRef, file.path, symbolTable, importMap, phpUseAliases, 'listener');
      if (!resolvedSubscriber) continue;

      const subscriberFile = fileByPath.get(resolvedSubscriber.filePath);
      if (!subscriberFile) continue;
      if (!/\b->\s*listen\s*\(/.test(subscriberFile.content)) continue;

      let subscriberTree = astCache.get(subscriberFile.path);
      if (!subscriberTree) {
        try {
          subscriberTree = parser.parse(subscriberFile.content, undefined, { bufferSize: 1024 * 256 });
          astCache.set(subscriberFile.path, subscriberTree);
        } catch {
          continue;
        }
      }

      const subscriberMappings = extractSubscriberListenMappings(subscriberTree.rootNode);
      if (subscriberMappings.length === 0) continue;

      for (const mapping of subscriberMappings) {
        const resolvedEvent = resolvePhpClassToFile(mapping.eventClassRef, subscriberFile.path, symbolTable, importMap, phpUseAliases, 'event');
        if (!resolvedEvent) continue;

        const handlerClassRef = mapping.handler.classRef;
        const resolvedListener = handlerClassRef === 'self' || handlerClassRef === 'static' || handlerClassRef === 'parent'
          ? { filePath: subscriberFile.path, confidence: 0.95, reason: 'self-file' }
          : resolvePhpClassToFile(handlerClassRef, subscriberFile.path, symbolTable, importMap, phpUseAliases, 'listener');
        if (!resolvedListener) continue;

        const methodNodeId = symbolTable.lookupExact(resolvedListener.filePath, mapping.handler.methodName);
        if (!methodNodeId) continue;

        const confidence = Math.min(resolvedEvent.confidence, resolvedListener.confidence);

        const expandedEventRef = expandPhpClassRefFromUseAliases(
          stripPhpClassConstant(mapping.eventClassRef),
          subscriberFile.path,
          phpUseAliases,
        );
        eventBaseNames.add(normalizePhpClassRef(expandedEventRef).baseName);

        let list = listenersByEventFile.get(resolvedEvent.filePath);
        if (!list) {
          list = [];
          listenersByEventFile.set(resolvedEvent.filePath, list);
        }

        if (!list.some(item => item.methodNodeId === methodNodeId)) {
          list.push({ methodNodeId, confidence });
        }
      }
    }
  }

  return { listenersByEventFile, eventBaseNames };
};

export const processLaravelEventDispatch = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): Promise<{ edgesAdded: number }> => {
  const parser = await loadParser();
  await loadLanguage(SupportedLanguages.PHP);

  const { listenersByEventFile, eventBaseNames } = await buildLaravelEventListenerIndex(
    files,
    astCache,
    symbolTable,
    importMap,
    phpUseAliases,
    parser
  );
  if (listenersByEventFile.size === 0) return { edgesAdded: 0 };

  let edgesAdded = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (i % 200 === 0) await yieldToEventLoop();

    if (!isEventDispatchRelevantFile(file.path, file.content)) continue;

    let tree = astCache.get(file.path);
    if (!tree) {
      try {
        tree = parser.parse(file.content, undefined, { bufferSize: 1024 * 256 });
        astCache.set(file.path, tree);
      } catch {
        continue;
      }
    }

    const dispatchCalls = extractEventDispatchCallsFromTree(tree);
    if (dispatchCalls.length === 0) continue;

    for (const call of dispatchCalls) {
      const expandedCallRef = expandPhpClassRefFromUseAliases(
        stripPhpClassConstant(call.classRef),
        file.path,
        phpUseAliases,
      );
      const { baseName } = normalizePhpClassRef(expandedCallRef);
      if (!eventBaseNames.has(baseName)) continue;

      const resolvedEvent = resolvePhpClassToFile(call.classRef, file.path, symbolTable, importMap, phpUseAliases, 'event');
      if (!resolvedEvent) continue;

      const listenerTargets = listenersByEventFile.get(resolvedEvent.filePath);
      if (!listenerTargets || listenerTargets.length === 0) continue;

      const sourceId = findEnclosingPhpCallableId(call.callNode, file.path, symbolTable);
      const reason = `laravel-event-dispatch-${call.kind}-${resolvedEvent.reason}`;

      for (const listenerTarget of listenerTargets) {
        const confidence = Math.min(resolvedEvent.confidence, listenerTarget.confidence);
        const relId = generateId('CALLS', `${sourceId}:${reason}->${listenerTarget.methodNodeId}`);
        graph.addRelationship({
          id: relId,
          type: 'CALLS',
          sourceId,
          targetId: listenerTarget.methodNodeId,
          confidence,
          reason,
        });
        edgesAdded++;
      }
    }
  }

  return { edgesAdded };
};
