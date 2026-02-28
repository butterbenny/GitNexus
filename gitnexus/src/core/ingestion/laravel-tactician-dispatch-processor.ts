import { KnowledgeGraph } from '../graph/types.js';
import Parser from 'tree-sitter';
import { ASTCache } from './ast-cache.js';
import { SymbolTable, SymbolDefinition } from './symbol-table.js';
import { ImportMap, PhpUseAliasMap, expandPhpClassRefFromUseAliases } from './import-processor.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename, getParseableContent, yieldToEventLoop } from './utils.js';
import { loadLanguage, loadParser } from '../tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../config/supported-languages.js';

type ResolvedClass = {
  filePath: string;
  confidence: number;
  reason: string;
};

type HandlerTarget = {
  methodId: string;
  confidence: number;
  reason: string;
};

type MiddlewareTarget = {
  baseName: string;
  methodId: string;
  confidence: number;
  reason: string;
};

type ScopeState = {
  parent: ScopeState | null;
  handlerByBusKey: Map<string, Map<string, HandlerTarget>>;
  commandTypeByVar: Map<string, string>;
};

const looksLikePhpIdentifier = (value: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);

const normalizePhpClassRef = (value: string): { baseName: string; parts: string[] } => {
  const trimmed = value.trim().replace(/^\\+/, '');
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  const baseName = parts.at(-1) ?? '';
  return { baseName, parts };
};

const getScopeBaseName = (value: string): string => normalizePhpClassRef(value).baseName;

const stripPhpClassConstant = (value: string): string => value.trim().replace(/::class$/i, '').trim();

const resolvePhpClassToFile = (
  classRef: string,
  currentFilePath: string,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
  kind: 'command' | 'handler' | 'middleware',
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
        const normalizedSuffix = suffix.replace(/^\/+/, '');
        if (!normalizedSuffix) continue;
        if (def.filePath === normalizedSuffix) return true;
        if (def.filePath.endsWith('/' + normalizedSuffix)) return true;
      }
      return false;
    });
    if (suffixMatches.length === 1) {
      return { filePath: suffixMatches[0].filePath, confidence: 0.9, reason: 'namespace-suffix' };
    }
  }

  const kindHeuristic = classDefs.filter(def => {
    if (kind === 'command') return def.filePath.includes('/Commands/') || def.filePath.endsWith('Command.php');
    if (kind === 'handler') return def.filePath.includes('/Handlers/') || def.filePath.endsWith('Handler.php');
    if (kind === 'middleware') return def.filePath.includes('/Middleware/') || def.filePath.endsWith('Middleware.php');
    return false;
  });
  if (kindHeuristic.length === 1) {
    return { filePath: kindHeuristic[0].filePath, confidence: 0.85, reason: `${kind}-heuristic` };
  }

  if (classDefs.length === 1) {
    return { filePath: classDefs[0].filePath, confidence: 0.65, reason: 'fuzzy-class' };
  }

  return null;
};

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

const getBusKeyFromExpression = (expr: any): string | null => {
  if (!expr) return null;
  if (expr.type === 'variable_name') return String(expr.text || '').trim() || null;
  if (expr.type === 'member_access_expression') return String(expr.text || '').trim() || null;
  return null;
};

const parseClassRefFromArg = (argNode: any): string | null => {
  if (!argNode) return null;
  if (argNode.type === 'class_constant_access_expression') return stripPhpClassConstant(String(argNode.text || '').trim());
  if (argNode.type === 'qualified_name' || argNode.type === 'name') return stripPhpClassConstant(String(argNode.text || '').trim());
  return null;
};

const inferCommandBaseNameFromExpression = (expr: any, scope: ScopeState): string | null => {
  if (!expr) return null;

  if (expr.type === 'parenthesized_expression') {
    return inferCommandBaseNameFromExpression(expr.namedChildren?.[0], scope);
  }

  if (expr.type === 'assignment_expression') {
    const right = expr.childForFieldName?.('right');
    return inferCommandBaseNameFromExpression(right, scope);
  }

  if (expr.type === 'object_creation_expression') {
    const nameNode = expr.childForFieldName?.('name')
      || expr.namedChildren?.find((c: any) => c.type === 'qualified_name' || c.type === 'name');
    const text = String(nameNode?.text || '').trim();
    const baseName = text ? getScopeBaseName(stripPhpClassConstant(text)) : '';
    return baseName.endsWith('Command') ? baseName : null;
  }

  if (expr.type === 'scoped_call_expression') {
    const scopeNode = expr.childForFieldName?.('scope');
    const scopeText = String(scopeNode?.text || '').trim();
    const baseName = scopeText ? getScopeBaseName(stripPhpClassConstant(scopeText)) : '';
    return baseName.endsWith('Command') ? baseName : null;
  }

  if (expr.type === 'variable_name') {
    const varName = String(expr.text || '').trim();
    if (!varName) return null;
    let current: ScopeState | null = scope;
    while (current) {
      const known = current.commandTypeByVar.get(varName);
      if (known) return known;
      current = current.parent;
    }
    return null;
  }

  return null;
};

const extractClassRefsFromArrayExpression = (arrayNode: any): string[] => {
  if (!arrayNode || arrayNode.type !== 'array_creation_expression') return [];
  const entries = arrayNode.namedChildren?.filter((c: any) => c.type === 'array_element_initializer') || [];
  const classRefs: string[] = [];

  for (const entry of entries) {
    const expr = entry.namedChildren?.at(-1);
    const classRef = parseClassRefFromArg(expr);
    if (classRef) classRefs.push(classRef);
  }

  return classRefs;
};

const findEnclosingPhpCallableId = (
  node: any,
  filePath: string,
  symbolTable: SymbolTable,
): string => {
  let current = node.parent;

  while (current) {
    if (current.type === 'method_declaration') {
      const nameNode = current.childForFieldName?.('name');
      const name = nameNode?.text;
      if (name) return symbolTable.lookupExact(filePath, name) || generateId('Method', `${filePath}:${name}`);
    }
    if (current.type === 'function_definition') {
      const nameNode = current.childForFieldName?.('name');
      const name = nameNode?.text;
      if (name) return symbolTable.lookupExact(filePath, name) || generateId('Function', `${filePath}:${name}`);
    }
    current = current.parent;
  }

  return generateId('File', filePath);
};

const findEnclosingPhpClassKey = (node: any, filePath: string): string | null => {
  let current = node.parent;
  while (current) {
    if (current.type === 'class_declaration') {
      const nameNode = current.childForFieldName?.('name');
      const name = String(nameNode?.text || '').trim();
      return name ? `${filePath}:${name}` : null;
    }
    current = current.parent;
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

const isTacticianRelevantFile = (filePath: string, content: string): boolean => {
  const lang = getLanguageFromFilename(filePath);
  if (lang !== SupportedLanguages.PHP) return false;
  // Cheap prefilter before parsing.
  return /\bCommandBusInterface\b/.test(content) || /->\s*addHandler\s*\(/.test(content);
};

const resolveHandlerTarget = (
  handlerClassRef: string,
  currentFilePath: string,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): HandlerTarget | null => {
  const resolved = resolvePhpClassToFile(handlerClassRef, currentFilePath, symbolTable, importMap, phpUseAliases, 'handler');
  if (!resolved || resolved.confidence < 0.8) return null;

  const methodId = symbolTable.lookupExact(resolved.filePath, 'handle')
    || symbolTable.lookupExact(resolved.filePath, '__invoke');
  if (!methodId) return null;

  return { methodId, confidence: resolved.confidence, reason: resolved.reason };
};

const resolveMiddlewareTargetMethodId = (
  middlewareClassRef: string,
  currentFilePath: string,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): HandlerTarget | null => {
  const resolved = resolvePhpClassToFile(middlewareClassRef, currentFilePath, symbolTable, importMap, phpUseAliases, 'middleware');
  if (!resolved || resolved.confidence < 0.8) return null;

  const methodId = symbolTable.lookupExact(resolved.filePath, 'execute')
    || symbolTable.lookupExact(resolved.filePath, 'handle')
    || symbolTable.lookupExact(resolved.filePath, '__invoke');
  if (!methodId) return null;

  return { methodId, confidence: resolved.confidence, reason: resolved.reason };
};

const recordConstructorHandlerMaps = (
  tree: Parser.Tree,
  filePath: string,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): Map<string, Map<string, HandlerTarget>> => {
  const byClassKey = new Map<string, Map<string, HandlerTarget>>();

  walkNodes(tree.rootNode, (node: any) => {
    if (node.type !== 'class_declaration') return;

    const classNameNode = node.childForFieldName?.('name');
    const className = String(classNameNode?.text || '').trim();
    if (!className) return;
    const classKey = `${filePath}:${className}`;

    const ctorCandidates: any[] = [];
    walkNodes(node, (inner: any) => {
      if (inner.type !== 'method_declaration') return;
      if (getMethodName(inner) !== '__construct') return;
      ctorCandidates.push(inner);
    });
    const ctor = ctorCandidates[0] || null;
    if (!ctor) return;

    const ctorBody = getMethodBodyNode(ctor);
    if (!ctorBody) return;

    const handlerMap = new Map<string, HandlerTarget>();

    walkNodes(ctorBody, (inner: any) => {
      if (inner.type !== 'member_call_expression') return;

      const methodName = String(inner.childForFieldName?.('name')?.text || '').trim();
      if (methodName !== 'addHandler') return;

      const objectNode = inner.childForFieldName?.('object');
      const busKey = getBusKeyFromExpression(objectNode);
      if (!busKey || !busKey.includes('$this->')) return;

      const argsNode = inner.childForFieldName?.('arguments');
      const args = getCallArgumentExpressions(argsNode);
      const commandClassRef = parseClassRefFromArg(args[0]);
      const handlerClassRef = parseClassRefFromArg(args[1]);
      if (!commandClassRef || !handlerClassRef) return;

      const commandBaseName = getScopeBaseName(commandClassRef);
      if (!commandBaseName.endsWith('Command')) return;

      const resolvedTarget = resolveHandlerTarget(handlerClassRef, filePath, symbolTable, importMap, phpUseAliases);
      if (!resolvedTarget) return;

      const existing = handlerMap.get(commandBaseName);
      if (existing && existing.methodId !== resolvedTarget.methodId) {
        handlerMap.delete(commandBaseName);
        return;
      }
      handlerMap.set(commandBaseName, resolvedTarget);
    });

    if (handlerMap.size > 0) byClassKey.set(classKey, handlerMap);
  });

  return byClassKey;
};

export const processLaravelTacticianDispatch = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): Promise<{ edgesAdded: number }> => {
  const parser = await loadParser();
  await loadLanguage(SupportedLanguages.PHP);

  let edgesAdded = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (i % 200 === 0) await yieldToEventLoop();

    if (!isTacticianRelevantFile(file.path, file.content)) continue;

    let tree = astCache.get(file.path);
    if (!tree) {
      try {
        const parseable = getParseableContent(file.path, file.content);
        tree = parser.parse(parseable, undefined, { bufferSize: 1024 * 256 });
        astCache.set(file.path, tree);
      } catch {
        continue;
      }
    }

    const constructorMaps = recordConstructorHandlerMaps(tree, file.path, symbolTable, importMap, phpUseAliases);

    const rootScope: ScopeState = {
      parent: null,
      handlerByBusKey: new Map<string, Map<string, HandlerTarget>>(),
      commandTypeByVar: new Map<string, string>(),
    };

    const getHandlerTargetFromScope = (scope: ScopeState, busKey: string, commandBaseName: string): HandlerTarget | null => {
      let current: ScopeState | null = scope;
      while (current) {
        const busMap = current.handlerByBusKey.get(busKey);
        if (busMap?.has(commandBaseName)) return busMap.get(commandBaseName) ?? null;
        current = current.parent;
      }
      return null;
    };

    const setHandlerTargetInScope = (scope: ScopeState, busKey: string, commandBaseName: string, target: HandlerTarget) => {
      let busMap = scope.handlerByBusKey.get(busKey);
      if (!busMap) {
        busMap = new Map<string, HandlerTarget>();
        scope.handlerByBusKey.set(busKey, busMap);
      }
      busMap.set(commandBaseName, target);
    };

    const visit = (node: any, scope: ScopeState) => {
      if (!node) return;

      if (node.type === 'compound_statement' || node.type === 'block') {
        const childScope: ScopeState = {
          parent: scope,
          handlerByBusKey: new Map<string, Map<string, HandlerTarget>>(),
          commandTypeByVar: new Map<string, string>(),
        };
        for (const child of node.namedChildren || []) visit(child, childScope);
        return;
      }

      if (node.type === 'assignment_expression') {
        const left = node.childForFieldName?.('left');
        const right = node.childForFieldName?.('right');
        if (left?.type === 'variable_name') {
          const inferred = inferCommandBaseNameFromExpression(right, scope);
          if (inferred) scope.commandTypeByVar.set(String(left.text || '').trim(), inferred);
        }
      }

      if (node.type === 'member_call_expression') {
        const methodName = String(node.childForFieldName?.('name')?.text || '').trim();
        const objectNode = node.childForFieldName?.('object');
        const busKey = getBusKeyFromExpression(objectNode);
        const argsNode = node.childForFieldName?.('arguments');
        const args = getCallArgumentExpressions(argsNode);

        if (methodName === 'addHandler' && busKey) {
          const commandClassRef = parseClassRefFromArg(args[0]);
          const handlerClassRef = parseClassRefFromArg(args[1]);
          if (commandClassRef && handlerClassRef) {
            const commandBaseName = getScopeBaseName(commandClassRef);
            if (commandBaseName.endsWith('Command')) {
              const resolvedTarget = resolveHandlerTarget(handlerClassRef, file.path, symbolTable, importMap, phpUseAliases);
              if (resolvedTarget) {
                setHandlerTargetInScope(scope, busKey, commandBaseName, resolvedTarget);
              }
            }
          }
        }

        if (methodName === 'dispatch' && busKey) {
          const commandExpr = args[0];
          const commandBaseName = inferCommandBaseNameFromExpression(commandExpr, scope);
          const sourceId = findEnclosingPhpCallableId(node, file.path, symbolTable);

          let handlerTarget: HandlerTarget | null = null;
          if (commandBaseName) {
            const localTarget = getHandlerTargetFromScope(scope, busKey, commandBaseName);
            const classKey = findEnclosingPhpClassKey(node, file.path);
            const ctorTarget = (busKey.includes('$this->') && classKey)
              ? (constructorMaps.get(classKey)?.get(commandBaseName) ?? null)
              : null;
            const target = localTarget || ctorTarget;

            if (target) {
              const reason = `laravel-tactician-dispatch:${commandBaseName}:${target.reason}`;
              const relId = generateId('CALLS', `${sourceId}:${reason}->${target.methodId}`);
              graph.addRelationship({
                id: relId,
                type: 'CALLS',
                sourceId,
                targetId: target.methodId,
                confidence: target.confidence,
                reason,
              });
              edgesAdded++;
              handlerTarget = target;
            }
          }

          const middlewareArg = args[2];
          const middlewareRefs = extractClassRefsFromArrayExpression(middlewareArg);
          if (middlewareRefs.length > 0) {
            const middlewareTargets: MiddlewareTarget[] = [];
            for (const middlewareRef of middlewareRefs) {
              const middlewareBaseName = getScopeBaseName(middlewareRef);
              const resolvedMiddleware = resolveMiddlewareTargetMethodId(middlewareRef, file.path, symbolTable, importMap, phpUseAliases);
              if (!resolvedMiddleware) continue;

              const reason = `laravel-tactician-middleware:${middlewareBaseName}:${resolvedMiddleware.reason}`;
              const relId = generateId('CALLS', `${sourceId}:${reason}->${resolvedMiddleware.methodId}`);
              graph.addRelationship({
                id: relId,
                type: 'CALLS',
                sourceId,
                targetId: resolvedMiddleware.methodId,
                confidence: resolvedMiddleware.confidence,
                reason,
              });
              edgesAdded++;

              middlewareTargets.push({
                baseName: middlewareBaseName,
                methodId: resolvedMiddleware.methodId,
                confidence: resolvedMiddleware.confidence,
                reason: resolvedMiddleware.reason,
              });
            }

            // Build a coherent middleware→handler trace so process detection can surface
            // this as a single flow rather than scattered outgoing edges.
            if (middlewareTargets.length > 1) {
              for (let i = 0; i < middlewareTargets.length - 1; i++) {
                const from = middlewareTargets[i];
                const to = middlewareTargets[i + 1];
                if (!from?.methodId || !to?.methodId) continue;

                const reason = `laravel-tactician-pipeline:${commandBaseName || 'unknown'}:middleware-order`;
                const relId = generateId('CALLS', `${from.methodId}:${reason}->${to.methodId}`);
                graph.addRelationship({
                  id: relId,
                  type: 'CALLS',
                  sourceId: from.methodId,
                  targetId: to.methodId,
                  confidence: Math.min(from.confidence, to.confidence, 0.85),
                  reason,
                });
                edgesAdded++;
              }
            }

            if (handlerTarget && middlewareTargets.length > 0) {
              const last = middlewareTargets[middlewareTargets.length - 1];
              const reason = `laravel-tactician-pipeline:${commandBaseName || 'unknown'}:middleware-to-handler`;
              const relId = generateId('CALLS', `${last.methodId}:${reason}->${handlerTarget.methodId}`);
              graph.addRelationship({
                id: relId,
                type: 'CALLS',
                sourceId: last.methodId,
                targetId: handlerTarget.methodId,
                confidence: Math.min(last.confidence, handlerTarget.confidence, 0.85),
                reason,
              });
              edgesAdded++;
            }
          }
        }
      }

      for (const child of node.namedChildren || []) visit(child, scope);
    };

    visit(tree.rootNode, rootScope);
  }

  return { edgesAdded };
};
