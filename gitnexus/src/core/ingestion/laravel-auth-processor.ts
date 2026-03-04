import { KnowledgeGraph } from '../graph/types.js';
import { generateId } from '../../lib/utils.js';
import { ASTCache } from './ast-cache.js';
import { SymbolTable, SymbolDefinition } from './symbol-table.js';
import { ImportMap, PhpUseAliasMap, expandPhpClassRefFromUseAliases } from './import-processor.js';
import { getLanguageFromFilename, getParseableContent, yieldToEventLoop } from './utils.js';
import { loadLanguage, loadParser } from '../tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../config/supported-languages.js';

type ResolvedType = {
  baseName: string;
  filePath: string;
  nodeId: string;
  type: string;
  confidence: number;
  reason: string;
};

type ResolvedClassRef = {
  classRef: string;
  baseName: string;
  confidence: number;
};

const AUTH_SERVICE_PROVIDER_PATH_RE = /(^|\/)app\/Providers\/AuthServiceProvider\.php$/i;

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

const formatLaravelAbilityToMethodName = (ability: string): string => {
  const trimmed = ability.trim();
  if (!trimmed) return ability;
  if (!trimmed.includes('-')) return trimmed;

  const parts = trimmed.split('-').filter(Boolean);
  if (parts.length === 0) return trimmed;

  const [first, ...rest] = parts;
  return first + rest.map(p => p ? p[0].toUpperCase() + p.slice(1) : '').join('');
};

const stripPhpClassConstant = (value: string): string => value.trim().replace(/::class$/i, '').trim();

const normalizePhpClassRef = (value: string): { baseName: string; parts: string[] } => {
  const trimmed = value.trim().replace(/^\\+/, '');
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  const baseName = parts.at(-1) ?? '';
  return { baseName, parts };
};

const getPhpShortName = (value: string): string => normalizePhpClassRef(value).baseName;

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
  classRef: string,
  currentFilePath: string,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
  allowedTypes: Set<string>,
): ResolvedType | null => {
  const normalizedRef = normalizePhpTypeRef(classRef);
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
      const match = importedMatches[0];
      return { baseName, filePath: match.filePath, nodeId: match.nodeId, type: match.type, confidence: 0.95, reason: 'import-resolved' };
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
      const match = suffixMatches[0];
      return { baseName, filePath: match.filePath, nodeId: match.nodeId, type: match.type, confidence: 0.9, reason: 'namespace-suffix' };
    }
  }

  if (defs.length === 1) {
    const match = defs[0];
    return { baseName, filePath: match.filePath, nodeId: match.nodeId, type: match.type, confidence: 0.8, reason: 'fuzzy-global' };
  }

  return null;
};

const getMethodName = (node: any): string | null => {
  if (!node || node.type !== 'method_declaration') return null;
  const nameNode = node.childForFieldName?.('name');
  return nameNode?.text?.trim() || null;
};

const getFunctionName = (node: any): string | null => {
  if (!node || node.type !== 'function_definition') return null;
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

const getFunctionBodyNode = (node: any): any | null => {
  if (!node || node.type !== 'function_definition') return null;
  return node.childForFieldName?.('body')
    || node.namedChildren?.find((c: any) => c.type === 'compound_statement')
    || node.namedChildren?.find((c: any) => c.type === 'block')
    || null;
};

const walkNodes = (node: any, fn: (n: any) => void) => {
  fn(node);
  for (let i = 0; i < node.namedChildCount; i++) walkNodes(node.namedChild(i), fn);
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

const parsePhpStringLiteral = (node: any): string | null => {
  if (!node) return null;
  if (node.type !== 'string') return null;
  const text = String(node.text || '').trim();
  if (text.length < 2) return null;
  const quote = text[0];
  if ((quote !== '\'' && quote !== '"') || text[text.length - 1] !== quote) return null;
  const inner = text.slice(1, -1);
  if (inner.includes('${')) return null;
  return inner;
};

type ParsedAbility =
  | { kind: 'string'; name: string }
  | { kind: 'class_const'; classRef: string; constant: string; display: string };

const parseAbilityExpression = (node: any): ParsedAbility | null => {
  if (!node) return null;

  const asString = parsePhpStringLiteral(node);
  if (asString) return { kind: 'string', name: asString };

  if (node.type === 'class_constant_access_expression') {
    const raw = String(node.text || '').trim().replace(/^\\+/, '');
    const [classPart, constPart] = raw.split('::');
    const classRef = classPart?.trim();
    const constant = constPart?.trim();
    if (!classRef || !constant) return null;
    if (constant.toLowerCase() === 'class') return null;
    return {
      kind: 'class_const',
      classRef,
      constant,
      display: `${getPhpShortName(classRef)}::${constant}`,
    };
  }

  return null;
};

const unwrapParenthesizedExpression = (node: any): any => {
  let current = node;
  while (current && current.type === 'parenthesized_expression') {
    current = current.namedChildren?.at(-1) || current.childForFieldName?.('expression') || current.namedChildren?.[0] || null;
  }
  return current;
};

type ParsedAbilityMethodCall = {
  receiverVar: string;
  methodName: string;
};

const parseAbilityMethodCallExpression = (node: any): ParsedAbilityMethodCall | null => {
  const expr = unwrapParenthesizedExpression(node);
  if (!expr) return null;

  if (expr.type !== 'member_call_expression' && expr.type !== 'nullsafe_member_call_expression') return null;

  const objectNode = expr.childForFieldName?.('object');
  const receiverVar = objectNode?.type === 'variable_name' ? String(objectNode.text || '').trim() : '';
  if (!receiverVar) return null;

  const nameNode = expr.childForFieldName?.('name');
  const methodName = String(nameNode?.text || '').trim();
  if (!methodName) return null;
  if (!looksLikePhpIdentifier(methodName)) return null;

  return { receiverVar, methodName };
};

const MODEL_INSTANCE_METHODS = new Set([
  'find',
  'findorfail',
  'first',
  'firstorfail',
  'firstornew',
  'firstorcreate',
  'updateorcreate',
  'sole',
  'create',
  'forcecreate',
]);

const getStaticScopeFromCallChain = (expr: any): string | null => {
  if (!expr) return null;
  if (expr.type === 'scoped_call_expression') {
    const scopeNode = expr.childForFieldName?.('scope');
    return scopeNode?.text ? String(scopeNode.text) : null;
  }
  if (expr.type === 'member_call_expression') {
    const objectNode = expr.childForFieldName?.('object');
    return getStaticScopeFromCallChain(objectNode);
  }
  return null;
};

const inferModelClassRefFromExpression = (expr: any): string | null => {
  if (!expr) return null;

  if (expr.type === 'parenthesized_expression') {
    return inferModelClassRefFromExpression(expr.namedChildren?.[0]);
  }

  if (expr.type === 'object_creation_expression') {
    const nameNode = expr.childForFieldName?.('name')
      || expr.namedChildren?.find((c: any) => c.type === 'qualified_name' || c.type === 'name');
    return nameNode?.text ? String(nameNode.text) : null;
  }

  if (expr.type === 'scoped_call_expression') {
    const scopeNode = expr.childForFieldName?.('scope');
    const nameNode = expr.childForFieldName?.('name');
    const scopeText = String(scopeNode?.text || '').trim();
    const methodName = String(nameNode?.text || '').trim().toLowerCase();
    if (!scopeText || !methodName) return null;
    if (!MODEL_INSTANCE_METHODS.has(methodName)) return null;
    return scopeText;
  }

  if (expr.type === 'member_call_expression') {
    const nameNode = expr.childForFieldName?.('name');
    const methodName = String(nameNode?.text || '').trim().toLowerCase();
    if (!methodName) return null;
    if (!MODEL_INSTANCE_METHODS.has(methodName)) return null;
    const objectNode = expr.childForFieldName?.('object');
    return getStaticScopeFromCallChain(objectNode);
  }

  return null;
};

const isLaravelControllerFile = (filePath: string): boolean => filePath.includes('/Http/Controllers/');

const isLaravelFormRequestFile = (filePath: string): boolean => filePath.includes('/Http/Requests/');

const isLaravelAuthorizationRelevantFile = (filePath: string, content: string): boolean => {
  if (!filePath.endsWith('.php')) return false;
  if (!content) return false;

  return (
    /\$this\s*->\s*authorize\s*\(/.test(content)
    || /\$this\s*->\s*authorizeResource\s*\(/.test(content)
    || /\bGate\s*::\s*(authorize|allows|denies|check)\s*\(/.test(content)
    || /(?:\?->|->)\s*can\s*\(/.test(content)
  );
};

const LARAVEL_RESOURCE_ABILITY_MAP: Record<string, string> = {
  index: 'viewAny',
  show: 'view',
  create: 'create',
  store: 'create',
  edit: 'update',
  update: 'update',
  destroy: 'delete',
  restore: 'restore',
  forceDelete: 'forceDelete',
};

const extractPolicyPairsFromProvider = (content: string): Array<{ modelRef: string; policyRef: string }> => {
  const bodyMatch = content.match(/\$policies\s*=\s*\[([\s\S]*?)\]\s*;/m);
  if (!bodyMatch) return [];

  const body = bodyMatch[1] || '';
  const pairs: Array<{ modelRef: string; policyRef: string }> = [];

  for (const match of body.matchAll(/([A-Za-z0-9_\\]+)\s*::\s*class\s*=>\s*([A-Za-z0-9_\\]+)\s*::\s*class/g)) {
    const modelRef = match[1]?.trim();
    const policyRef = match[2]?.trim();
    if (!modelRef || !policyRef) continue;
    pairs.push({ modelRef, policyRef });
  }

  return pairs;
};

const buildLaravelPolicyIndex = (
  files: { path: string; content: string }[],
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): Map<string, ResolvedType> => {
  const index = new Map<string, ResolvedType>();

  for (const file of files) {
    if (!AUTH_SERVICE_PROVIDER_PATH_RE.test(file.path)) continue;

    const pairs = extractPolicyPairsFromProvider(file.content);
    for (const pair of pairs) {
      const modelExpanded = expandPhpClassRefFromUseAliases(pair.modelRef, file.path, phpUseAliases);
      const normalizedModel = normalizePhpTypeRef(modelExpanded);
      if (!normalizedModel) continue;

      const { baseName: modelBaseName } = normalizePhpClassRef(normalizedModel);
      if (!modelBaseName) continue;

      const resolvedPolicy = resolvePhpTypeRef(pair.policyRef, file.path, symbolTable, importMap, phpUseAliases, new Set(['Class']));
      if (!resolvedPolicy || resolvedPolicy.confidence < 0.9) continue;

      index.set(modelBaseName, resolvedPolicy);
    }
  }

  return index;
};

const inferSubjectClassRef = (
  expr: any,
  varTypes: Map<string, string>,
): ResolvedClassRef | null => {
  if (!expr) return null;

  if (expr.type === 'variable_name') {
    const classRef = varTypes.get(expr.text) || null;
    if (!classRef) return null;
    const normalized = normalizePhpTypeRef(classRef);
    if (!normalized) return null;
    const { baseName } = normalizePhpClassRef(normalized);
    if (!baseName) return null;
    return { classRef: normalized, baseName, confidence: 0.95 };
  }

  if (expr.type === 'class_constant_access_expression') {
    const raw = String(expr.text || '').trim();
    const classRef = normalizePhpTypeRef(raw);
    if (!classRef) return null;
    const { baseName } = normalizePhpClassRef(classRef);
    if (!baseName) return null;
    return { classRef, baseName, confidence: 0.95 };
  }

  if (expr.type === 'array_element_initializer') {
    const valueNode = expr.childForFieldName?.('value') || expr.namedChildren?.at(-1);
    if (!valueNode) return null;
    return inferSubjectClassRef(valueNode, varTypes);
  }

  if (expr.type === 'array_creation_expression') {
    const first = expr.namedChildren?.[0];
    if (!first) return null;
    return inferSubjectClassRef(first, varTypes);
  }

  const inferred = inferModelClassRefFromExpression(expr);
  if (!inferred) return null;
  const normalized = normalizePhpTypeRef(inferred);
  if (!normalized) return null;
  const { baseName } = normalizePhpClassRef(normalized);
  if (!baseName) return null;
  return { classRef: normalized, baseName, confidence: 0.9 };
};

const recordAssignmentTypesInMethod = (methodBodyNode: any, varTypes: Map<string, string>) => {
  walkNodes(methodBodyNode, (node: any) => {
    if (node.type !== 'assignment_expression') return;

    const left = node.childForFieldName?.('left');
    const right = node.childForFieldName?.('right');
    if (!left || !right) return;

    if (left.type !== 'variable_name') return;

    const inferred = inferModelClassRefFromExpression(right);
    if (!inferred) return;

    if (!varTypes.has(left.text)) {
      varTypes.set(left.text, inferred);
    }
  });
};

export const processLaravelAuthorization = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): Promise<{ edgesAdded: number }> => {
  const parser = await loadParser();
  const policyIndex = buildLaravelPolicyIndex(files, symbolTable, importMap, phpUseAliases);
  const permissionSlugNodeIds = new Set<string>();
  for (const node of graph.nodes) {
    const id = node?.id;
    if (!id) continue;
    if (!id.startsWith('CodeElement:permission:')) continue;
    permissionSlugNodeIds.add(id);
  }

  const matchReturnTargetsByCallableId = new Map<string, Array<{ targetId: string; reason: string; confidence: number }>>();
  for (const rel of graph.relationships) {
    if (rel.type !== 'CALLS') continue;
    if (!String(rel.reason || '').startsWith('php-match-return:')) continue;
    const list = matchReturnTargetsByCallableId.get(rel.sourceId) || [];
    list.push({
      targetId: rel.targetId,
      reason: String(rel.reason || ''),
      confidence: typeof rel.confidence === 'number' ? rel.confidence : Number(rel.confidence ?? 1.0),
    });
    matchReturnTargetsByCallableId.set(rel.sourceId, list);
  }

  let edgesAdded = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (i % 200 === 0) await yieldToEventLoop();

    if (!isLaravelAuthorizationRelevantFile(file.path, file.content)) continue;

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

    const callables: any[] = [];
    walkNodes(tree.rootNode, (node: any) => {
      if (node.type === 'method_declaration' || node.type === 'function_definition') callables.push(node);
    });

    const methodsByName = new Map<string, string>();
    for (const callable of callables) {
      if (callable.type !== 'method_declaration') continue;
      const name = getMethodName(callable);
      if (!name) continue;
      const nodeId = symbolTable.lookupExact(file.path, name)
        || generateId('Method', `${file.path}:${name}`);
      methodsByName.set(name, nodeId);
    }

    const authorizeResourceModels = new Map<string, ResolvedClassRef>();
    walkNodes(tree.rootNode, (node: any) => {
      const isAuthorizeResource = node.type === 'member_call_expression'
        && String(node.childForFieldName?.('name')?.text || '').trim() === 'authorizeResource'
        && String(node.childForFieldName?.('object')?.text || '').trim() === '$this';
      if (!isAuthorizeResource) return;

      const argsNode = node.childForFieldName?.('arguments');
      const args = getCallArgumentExpressions(argsNode);
      if (args.length === 0) return;

      const subject = inferSubjectClassRef(args[0], new Map());
      if (!subject || subject.confidence < 0.9) return;

      const existing = authorizeResourceModels.get(subject.baseName);
      if (!existing || existing.confidence < subject.confidence) {
        authorizeResourceModels.set(subject.baseName, subject);
      }
    });

    for (const [modelBaseName, subject] of authorizeResourceModels) {
      const policy = policyIndex.get(modelBaseName);
      if (!policy || policy.confidence < 0.9) continue;

      for (const [controllerMethod, policyMethod] of Object.entries(LARAVEL_RESOURCE_ABILITY_MAP)) {
        const controllerMethodId = methodsByName.get(controllerMethod);
        if (!controllerMethodId) continue;

        const policyMethodId = symbolTable.lookupExact(policy.filePath, policyMethod);
        if (!policyMethodId) continue;

        const confidence = Math.min(policy.confidence, subject.confidence);
        if (confidence < 0.9) continue;

        const reason = `laravel-authorize:resource:${modelBaseName}:${controllerMethod}->${policyMethod}`;
        const relId = generateId('CALLS', `${controllerMethodId}:${reason}->${policyMethodId}`);
        graph.addRelationship({
          id: relId,
          type: 'CALLS',
          sourceId: controllerMethodId,
          targetId: policyMethodId,
          confidence,
          reason,
        });
        edgesAdded++;
      }
    }

    for (const callable of callables) {
      const callableName = callable.type === 'method_declaration'
        ? getMethodName(callable)
        : getFunctionName(callable);
      if (!callableName) continue;

      const sourceId = symbolTable.lookupExact(file.path, callableName)
        || generateId(callable.type === 'method_declaration' ? 'Method' : 'Function', `${file.path}:${callableName}`);

      const varTypes = new Map<string, string>();
      const paramsNode = callable.childForFieldName?.('parameters');
      const params = paramsNode?.namedChildren || [];
      for (const param of params) {
        if (param.type !== 'simple_parameter' && param.type !== 'property_promotion_parameter') continue;

        const varNode = param.childForFieldName?.('name');
        const varName = varNode?.type === 'variable_name' ? varNode.text : null;
        if (!varName) continue;

        const typeNode = param.childForFieldName?.('type');
        if (!typeNode) continue;

        const innerType = typeNode.namedChildren?.[0];
        const rawType = String((innerType?.text ?? typeNode.text) || '').trim();
        const normalizedType = normalizePhpTypeRef(rawType);
        if (!normalizedType) continue;

        const expanded = expandPhpClassRefFromUseAliases(normalizedType, file.path, phpUseAliases);
        const expandedNormalized = normalizePhpTypeRef(expanded);
        if (!expandedNormalized) continue;
        varTypes.set(varName, expandedNormalized);
      }

      const bodyNode = callable.type === 'method_declaration'
        ? getMethodBodyNode(callable)
        : getFunctionBodyNode(callable);
      if (!bodyNode) continue;
      recordAssignmentTypesInMethod(bodyNode, varTypes);

      walkNodes(bodyNode, (node: any) => {
        const isMemberAuthorize = node.type === 'member_call_expression'
          && String(node.childForFieldName?.('name')?.text || '').trim() === 'authorize'
          && String(node.childForFieldName?.('object')?.text || '').trim() === '$this';

        const isGateCall = node.type === 'scoped_call_expression'
          && getPhpShortName(String(node.childForFieldName?.('scope')?.text || '')) === 'Gate'
          && new Set(['authorize', 'allows', 'denies', 'check']).has(String(node.childForFieldName?.('name')?.text || '').trim());

        const isCanCall = (node.type === 'member_call_expression' || node.type === 'nullsafe_member_call_expression')
          && String(node.childForFieldName?.('name')?.text || '').trim() === 'can';

        if (!isMemberAuthorize && !isGateCall && !isCanCall) return;

        const reasonPrefix = isMemberAuthorize
          ? 'laravel-authorize:'
          : isGateCall
            ? 'laravel-gate:'
            : 'laravel-can:';

        const argsNode = node.childForFieldName?.('arguments');
        const args = getCallArgumentExpressions(argsNode);
        if (args.length === 0) return;

        const ability = parseAbilityExpression(args[0]);
        if (ability?.kind === 'class_const') {
          const resolved = resolvePhpTypeRef(ability.classRef, file.path, symbolTable, importMap, phpUseAliases, new Set(['Enum', 'Class']));
          if (!resolved || resolved.confidence < 0.9) return;

          const caseDefs = resolved.type === 'Enum'
            ? symbolTable.lookupFuzzy(ability.constant).filter(def => def.filePath === resolved.filePath && def.type === 'Const')
            : [];
          const caseNodeId = caseDefs.length === 1 ? caseDefs[0].nodeId : null;

          const reason = `${reasonPrefix}${ability.display}`;
          const targetId = caseNodeId || resolved.nodeId;
          const relId = generateId('CALLS', `${sourceId}:${reason}->${targetId}`);
          graph.addRelationship({
            id: relId,
            type: 'CALLS',
            sourceId,
            targetId,
            confidence: resolved.confidence,
            reason,
          });
          edgesAdded++;
          return;
        }

        if (!ability) {
          const derived = parseAbilityMethodCallExpression(args[0]);
          if (!derived) return;

          const receiverType = varTypes.get(derived.receiverVar);
          if (!receiverType) return;

          const resolvedReceiver = resolvePhpTypeRef(receiverType, file.path, symbolTable, importMap, phpUseAliases, new Set(['Class']));
          if (!resolvedReceiver || resolvedReceiver.confidence < 0.9) return;

          const calleeMethodId = symbolTable.lookupExact(resolvedReceiver.filePath, derived.methodName);
          if (!calleeMethodId) return;

          const targets = matchReturnTargetsByCallableId.get(calleeMethodId) || [];
          if (targets.length === 0) return;

          // If the helper method returns many possible enum cases, this becomes noisy quickly.
          // Keep it conservative — it’s still useful for permissions-like helpers with small match arms.
          const MAX_DERIVED_TARGETS = 10;
          if (targets.length > MAX_DERIVED_TARGETS) return;

          const uniqueTargetIds = Array.from(new Set(targets.map(t => t.targetId)));
          for (const targetId of uniqueTargetIds) {
            const target = targets.find(t => t.targetId === targetId) || targets[0];
            const reason = `${reasonPrefix}derived:${resolvedReceiver.baseName}::${derived.methodName}:${target.reason}`;
            const relId = generateId('CALLS', `${sourceId}:${reason}->${targetId}`);
            graph.addRelationship({
              id: relId,
              type: 'CALLS',
              sourceId,
              targetId,
              confidence: Math.min(resolvedReceiver.confidence, target.confidence, 0.9),
              reason,
            });
            edgesAdded++;
          }
          return;
        }

        if (ability.kind === 'string') {
          const slug = ability.name.trim();
          if (slug.includes('.')) {
            const slugNodeId = generateId('CodeElement', `permission:${slug}`);
            if (permissionSlugNodeIds.has(slugNodeId)) {
              const reason = `${reasonPrefix}${slug}`;
              const relId = generateId('CALLS', `${sourceId}:${reason}->${slugNodeId}`);
              graph.addRelationship({
                id: relId,
                type: 'CALLS',
                sourceId,
                targetId: slugNodeId,
                confidence: 0.95,
                reason,
              });
              edgesAdded++;
              return;
            }
          }
        }

        // Ability is a simple string — attempt to wire to Policy::<ability>() when model is resolvable.
        const subjectExpr = args[1];
        if (!subjectExpr) return;

        const subject = inferSubjectClassRef(subjectExpr, varTypes);
        if (!subject || subject.confidence < 0.9) return;

        const policy = policyIndex.get(subject.baseName);
        if (!policy || policy.confidence < 0.9) return;

        const policyMethodCandidates = Array.from(new Set([
          ability.name,
          formatLaravelAbilityToMethodName(ability.name),
        ]));

        let policyMethodId: string | null = null;
        for (const methodName of policyMethodCandidates) {
          if (!looksLikePhpIdentifier(methodName)) continue;
          const resolved = symbolTable.lookupExact(policy.filePath, methodName);
          if (resolved) {
            policyMethodId = resolved;
            break;
          }
        }
        if (!policyMethodId) return;

        const confidence = Math.min(policy.confidence, subject.confidence);
        if (confidence < 0.9) return;

        const reason = `${reasonPrefix}${ability.name}`;
        const relId = generateId('CALLS', `${sourceId}:${reason}->${policyMethodId}`);
        graph.addRelationship({
          id: relId,
          type: 'CALLS',
          sourceId,
          targetId: policyMethodId,
          confidence,
          reason,
        });
        edgesAdded++;
      });
    }
  }

  return { edgesAdded };
};
