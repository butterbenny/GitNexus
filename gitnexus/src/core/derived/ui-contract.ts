import Parser from 'tree-sitter';
import { SupportedLanguages } from '../../config/supported-languages.js';
import { loadLanguage, loadParser } from '../tree-sitter/parser-loader.js';
import { getLanguageFromFilename, getParseableContent } from '../ingestion/utils.js';

export type UiContractEffectKind =
  | 'state-update'
  | 'mutation'
  | 'invalidate'
  | 'navigate'
  | 'toast'
  | 'http';

export type UiContractEffect = {
  kind: UiContractEffectKind;
  callee: string;
  args: string;
  line: number;
  confidence: number;
};

export type UiContractGate = {
  attribute: string;
  value: string;
  line: number;
  confidence: number;
};

export type UiContractInteraction = {
  scope?: string;
  event: string;
  element: string;
  handler: { kind: 'inline' | 'identifier' | 'member' | 'unknown'; name: string; line: number };
  gates: UiContractGate[];
  effects: UiContractEffect[];
  smells: UiContractSmell[];
};

export type UiControlledSurface = {
  element: string;
  open: string;
  onOpenChange: string;
  line: number;
};

export type UiContractSmell = {
  kind: string;
  message: string;
  line: number;
  confidence: number;
};

export type UiContractCard = {
  filePath: string;
  controlled: UiControlledSurface[];
  interactions: UiContractInteraction[];
  queries: UiQueryContract[];
  cacheLinks: UiCacheLink[];
  cacheCoverage?: UiCacheCoverage[];
  effectsSummary: Record<UiContractEffectKind, number>;
  smells: UiContractSmell[];
};

export type UiCacheOperationKind = 'refetch' | 'write' | 'remove';

export type UiCacheOperation = {
  kind: UiCacheOperationKind;
  method: string;
  callee: string;
  queryKey: string;
  queryKeyParts?: string[];
  exact?: boolean;
  line: number;
  confidence: number;
};

export type UiCacheLinkMatch = {
  hook: string;
  queryKey: string;
  line: number;
  match: 'exact' | 'prefix';
  confidence: number;
};

export type UiCacheLink = {
  operation: UiCacheOperation;
  matches: UiCacheLinkMatch[];
};

export type UiQueryRefetchTrigger = {
  method: string;
  queryKey: string;
  match: 'exact' | 'prefix';
  line: number;
  confidence: number;
};

export type UiQueryCacheWriteTrigger = {
  method: string;
  queryKey: string;
  match: 'exact' | 'prefix';
  line: number;
  confidence: number;
};

export type UiQueryContract = {
  scope?: string;
  hook: string;
  queryKey: string;
  queryKeyParts?: string[];
  refetchTriggers?: UiQueryRefetchTrigger[];
  cacheWriteTriggers?: UiQueryCacheWriteTrigger[];
  enabled?: string;
  staleTime?: string;
  refetchOnMount?: string;
  refetchOnWindowFocus?: string;
  refetchInterval?: string;
  gcTime?: string;
  line: number;
  confidence: number;
};

export type UiCacheCoverage = {
  scope: string;
  interaction: {
    event: string;
    element: string;
    handler: { kind: 'inline' | 'identifier' | 'member' | 'unknown'; name: string; line: number };
    line: number;
  };
  mutations: Array<{ callee: string; line: number; confidence: number }>;
  operations: UiCacheOperation[];
  links: UiCacheLink[];
  missing_queries: Array<{ hook: string; queryKey: string; line: number; confidence: number }>;
  confidence: number;
};

const UI_EVENT_ATTRS = new Set([
  'onClick',
  'onSubmit',
  'onSelect',
  'onOpenChange',
  'onValueChange',
  'onCheckedChange',
]);

const INVALIDATION_METHODS = new Set([
  'invalidateQueries',
  'refetchQueries',
  'resetQueries',
  'removeQueries',
  'setQueryData',
  'setQueriesData',
]);

const MUTATION_METHODS = new Set(['mutate', 'mutateAsync']);

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

const GATE_ATTRS = new Set([
  'disabled',
  'aria-disabled',
  'aria-busy',
  'isDisabled',
  'isLoading',
  'loading',
  'isPending',
  'pending',
  'isSubmitting',
  'isFetching',
  'isSaving',
  'isProcessing',
]);

const MAX_TEXT_LEN = 180;

const compactText = (text: string, maxLen = MAX_TEXT_LEN): string => {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen - 1)}…`;
};

const peelExpression = (node: Parser.SyntaxNode | null): Parser.SyntaxNode | null => {
  let current: Parser.SyntaxNode | null = node;
  while (current) {
    if (current.type === 'parenthesized_expression') {
      current = current.namedChildren?.[0] || null;
      continue;
    }
    if (current.type === 'await_expression') {
      current = current.namedChildren?.[0] || null;
      continue;
    }
    if (current.type === 'as_expression' || current.type === 'type_assertion' || current.type === 'satisfies_expression') {
      current = (current as any).childForFieldName?.('expression') || current.namedChildren?.[0] || null;
      continue;
    }
    return current;
  }
  return null;
};

const extractArrayLiteralParts = (node: Parser.SyntaxNode | null): string[] | undefined => {
  const expr = peelExpression(node);
  if (!expr || expr.type !== 'array') return undefined;

  const parts = (expr.namedChildren || [])
    .map(child => compactText(String((child as any)?.text || '').trim()))
    .filter(Boolean);

  return parts.length > 0 ? parts : undefined;
};

const walkNamed = (node: Parser.SyntaxNode, fn: (n: Parser.SyntaxNode) => void) => {
  fn(node);
  for (let i = 0; i < node.namedChildCount; i++) walkNamed(node.namedChild(i), fn);
};

const getNodeLine = (node: Parser.SyntaxNode | null | undefined): number => {
  const row = (node as any)?.startPosition?.row;
  return typeof row === 'number' ? row + 1 : 1;
};

const getCallExpressionCallee = (callNode: Parser.SyntaxNode): {
  kind: 'identifier' | 'member' | 'other';
  calleeText: string;
  name?: string;
  objectText?: string;
  propertyText?: string;
} | null => {
  const fnNode = (callNode as any).childForFieldName?.('function') as Parser.SyntaxNode | null;
  if (!fnNode) return null;

  if (fnNode.type === 'identifier') {
    const name = String((fnNode as any).text || '').trim();
    if (!name) return null;
    return { kind: 'identifier', calleeText: name, name };
  }

  if (fnNode.type === 'member_expression') {
    const objNode = (fnNode as any).childForFieldName?.('object') as Parser.SyntaxNode | null;
    const propNode = (fnNode as any).childForFieldName?.('property') as Parser.SyntaxNode | null;
    const objectText = compactText(String((objNode as any)?.text || ''));
    const propertyText = compactText(String((propNode as any)?.text || ''));
    const calleeText = compactText(String((fnNode as any).text || ''));
    if (!propertyText || !calleeText) return null;
    return { kind: 'member', calleeText, objectText, propertyText };
  }

  const calleeText = compactText(String((fnNode as any).text || ''));
  if (!calleeText) return null;
  return { kind: 'other', calleeText };
};

const getCallExpressionArgs = (callNode: Parser.SyntaxNode): string => {
  const argsNode = (callNode as any).childForFieldName?.('arguments') as Parser.SyntaxNode | null;
  if (!argsNode) return '';
  return compactText(String((argsNode as any).text || ''));
};

const classifyCallExpression = (callNode: Parser.SyntaxNode): UiContractEffect | null => {
  if (callNode.type !== 'call_expression') return null;

  const callee = getCallExpressionCallee(callNode);
  if (!callee) return null;

  const args = getCallExpressionArgs(callNode);
  const line = getNodeLine(callNode);

  if (callee.kind === 'identifier') {
    const name = callee.name || '';

    if (name === 'fetch') {
      return { kind: 'http', callee: name, args, line, confidence: 0.9 };
    }

    if (name === 'refetch') {
      return { kind: 'invalidate', callee: name, args, line, confidence: 0.6 };
    }

    if (/invalidate|invalidation|invalidations/i.test(name)) {
      return { kind: 'invalidate', callee: name, args, line, confidence: 0.5 };
    }

    if (name === 'navigate') {
      return { kind: 'navigate', callee: name, args, line, confidence: 0.9 };
    }

    if (name === 'toast') {
      return { kind: 'toast', callee: name, args, line, confidence: 0.9 };
    }

    if (name === 'mutate' || name === 'mutateAsync') {
      return { kind: 'mutation', callee: name, args, line, confidence: 0.75 };
    }

    if (/^set[A-Z]/.test(name)) {
      return { kind: 'state-update', callee: name, args, line, confidence: 0.8 };
    }

    return null;
  }

  if (callee.kind === 'member') {
    const objectText = callee.objectText || '';
    const propertyText = callee.propertyText || '';

    if (INVALIDATION_METHODS.has(propertyText)) {
      return { kind: 'invalidate', callee: callee.calleeText, args, line, confidence: 0.95 };
    }

    if (propertyText === 'refetch') {
      return { kind: 'invalidate', callee: callee.calleeText, args, line, confidence: 0.75 };
    }

    if (MUTATION_METHODS.has(propertyText)) {
      return { kind: 'mutation', callee: callee.calleeText, args, line, confidence: 0.9 };
    }

    if (propertyText === 'push' || propertyText === 'replace') {
      if (objectText === 'router' || objectText === 'history') {
        return { kind: 'navigate', callee: callee.calleeText, args, line, confidence: 0.9 };
      }
      return { kind: 'navigate', callee: callee.calleeText, args, line, confidence: 0.7 };
    }

    if (propertyText === 'assign' && objectText === 'window.location') {
      return { kind: 'navigate', callee: callee.calleeText, args, line, confidence: 0.85 };
    }

    if (objectText === 'toast' || propertyText === 'toast') {
      return { kind: 'toast', callee: callee.calleeText, args, line, confidence: 0.9 };
    }

    if ((objectText === 'Axios' || objectText === 'axios') && HTTP_METHODS.has(propertyText)) {
      return { kind: 'http', callee: callee.calleeText, args, line, confidence: 0.9 };
    }

    return null;
  }

  return null;
};

const getMemberExpressionParts = (node: Parser.SyntaxNode): { objectText: string; propertyText: string; fullText: string } | null => {
  if (!node || node.type !== 'member_expression') return null;
  const objNode = (node as any).childForFieldName?.('object') as Parser.SyntaxNode | null;
  const propNode = (node as any).childForFieldName?.('property') as Parser.SyntaxNode | null;
  const objectText = compactText(String((objNode as any)?.text || '').trim());
  const propertyText = compactText(String((propNode as any)?.text || '').trim());
  const fullText = compactText(String((node as any)?.text || '').trim());
  if (!propertyText || !fullText) return null;
  return { objectText, propertyText, fullText };
};

const getFunctionBodyNode = (fnNode: Parser.SyntaxNode): Parser.SyntaxNode | null => {
  const body = (fnNode as any).childForFieldName?.('body') as Parser.SyntaxNode | null;
  if (body) return body;

  // tree-sitter-typescript uses statement_block for many function bodies.
  const block = fnNode.namedChildren.find(c => c.type === 'statement_block') || null;
  return block;
};

const getEnclosingScopeKey = (node: Parser.SyntaxNode | null): string => {
  let current: Parser.SyntaxNode | null = node;
  while (current) {
    if (current.type === 'function_declaration') {
      const nameNode = (current as any).childForFieldName?.('name') as Parser.SyntaxNode | null;
      const name = String((nameNode as any)?.text || '').trim();
      const line = getNodeLine(current);
      return name ? `fn:${name}@${line}` : `fn:@${line}`;
    }

    if (current.type === 'method_definition') {
      const nameNode = (current as any).childForFieldName?.('name') as Parser.SyntaxNode | null;
      const name = String((nameNode as any)?.text || '').trim();
      const line = getNodeLine(current);
      return name ? `method:${name}@${line}` : `method:@${line}`;
    }

    if (current.type === 'arrow_function' || current.type === 'function_expression') {
      const line = getNodeLine(current);

      const parent = current.parent;
      if (parent?.type === 'variable_declarator') {
        const nameNode = (parent as any).childForFieldName?.('name') as Parser.SyntaxNode | null;
        const name = nameNode?.type === 'identifier' ? String((nameNode as any).text || '').trim() : '';
        return name ? `fn:${name}@${line}` : `fn:@${line}`;
      }

      if (parent?.type === 'pair') {
        const keyNode = parent.namedChildren?.[0] || null;
        const key = (keyNode?.type === 'property_identifier' || keyNode?.type === 'identifier')
          ? String((keyNode as any).text || '').trim()
          : '';
        return key ? `fn:${key}@${line}` : `fn:@${line}`;
      }

      return `fn:@${line}`;
    }

    current = current.parent;
  }

  return '';
};

const analyzeEffects = (
  handlerNode: Parser.SyntaxNode,
  fnNodesByName: Map<string, Parser.SyntaxNode>,
  opts?: {
    maxDepth?: number;
    depth?: number;
    visited?: Set<string>;
    mutationTriggerNames?: Set<string>;
  }
): UiContractEffect[] => {
  const bodyNode = getFunctionBodyNode(handlerNode) ?? handlerNode;
  const effects: UiContractEffect[] = [];

  const maxDepth = opts?.maxDepth ?? 2;
  const depth = opts?.depth ?? 0;
  const visited = opts?.visited ?? new Set<string>();
  const mutationTriggerNames = opts?.mutationTriggerNames ?? new Set<string>();

  const addIndirectEffects = (calleeName: string) => {
    if (!calleeName) return;
    if (depth >= maxDepth) return;
    if (visited.has(calleeName)) return;

    const target = fnNodesByName.get(calleeName) || null;
    if (!target) return;

    visited.add(calleeName);
    const derived = analyzeEffects(target, fnNodesByName, { maxDepth, depth: depth + 1, visited, mutationTriggerNames });
    for (const eff of derived) {
      effects.push({ ...eff, confidence: Math.min(eff.confidence, 0.7) });
    }
  };

  walkNamed(bodyNode, node => {
    const effect = classifyCallExpression(node);
    if (effect) effects.push(effect);

    if (node.type !== 'call_expression') return;

    const callee = getCallExpressionCallee(node);
    if (!callee) return;

    if (callee.kind === 'identifier' && callee.name) {
      if (!effect && mutationTriggerNames.has(callee.name)) {
        effects.push({
          kind: 'mutation',
          callee: callee.name,
          args: getCallExpressionArgs(node),
          line: getNodeLine(node),
          confidence: 0.85,
        });
      }
      addIndirectEffects(callee.name);
    }
  });

  const seen = new Set<string>();
  return effects.filter(e => {
    const key = `${e.kind}|${e.callee}|${e.args}|${e.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

type MutationCallbackMap = Map<string, Parser.SyntaxNode[]>;

const isUseMutationCall = (callNode: Parser.SyntaxNode): boolean => {
  if (callNode.type !== 'call_expression') return false;
  const callee = getCallExpressionCallee(callNode);
  if (!callee) return false;
  if (callee.kind === 'identifier') return callee.name === 'useMutation';
  if (callee.kind === 'member') return callee.propertyText === 'useMutation';
  return false;
};

const getFirstObjectArg = (callNode: Parser.SyntaxNode): Parser.SyntaxNode | null => {
  const argsNode = (callNode as any).childForFieldName?.('arguments') as Parser.SyntaxNode | null;
  const obj = argsNode?.namedChildren?.find((c: any) => c.type === 'object') || null;
  return obj;
};

const getObjectPairs = (objectNode: Parser.SyntaxNode): Array<{ key: string; value: Parser.SyntaxNode }> => {
  const out: Array<{ key: string; value: Parser.SyntaxNode }> = [];
  if (!objectNode || objectNode.type !== 'object') return out;

  for (const child of objectNode.namedChildren || []) {
    if (child.type !== 'pair') continue;
    const [keyNode, valueNode] = child.namedChildren || [];
    if (!keyNode || !valueNode) continue;
    const key = (keyNode.type === 'property_identifier' || keyNode.type === 'identifier')
      ? String((keyNode as any).text || '').trim()
      : '';
    if (!key) continue;
    out.push({ key, value: valueNode });
  }

  return out;
};

const getCallExpressionFirstArg = (callNode: Parser.SyntaxNode): Parser.SyntaxNode | null => {
  const argsNode = (callNode as any).childForFieldName?.('arguments') as Parser.SyntaxNode | null;
  if (!argsNode) return null;
  return argsNode.namedChildren?.[0] || null;
};

const interpretBoolLiteral = (node: Parser.SyntaxNode | null): boolean | undefined => {
  const expr = peelExpression(node);
  const text = compactText(String((expr as any)?.text || '').trim());
  if (text === 'true') return true;
  if (text === 'false') return false;
  return undefined;
};

const extractCacheOperations = (root: Parser.SyntaxNode): UiCacheOperation[] => {
  const operations: UiCacheOperation[] = [];

  walkNamed(root, node => {
    if (node.type !== 'call_expression') return;

    const callee = getCallExpressionCallee(node);
    if (!callee) return;

    let method = '';
    let confidence = 0;

    if (callee.kind === 'member') {
      const prop = callee.propertyText || '';
      if (!INVALIDATION_METHODS.has(prop)) return;
      method = prop;
      confidence = 0.95;
    } else if (callee.kind === 'identifier') {
      const name = callee.name || '';
      if (!INVALIDATION_METHODS.has(name)) return;
      method = name;
      confidence = 0.7;
    } else {
      return;
    }

    const firstArg = getCallExpressionFirstArg(node);
    if (!firstArg) return;

    let queryKeyNode: Parser.SyntaxNode | null = null;
    let exact: boolean | undefined;

    const peeledFirst = peelExpression(firstArg);
    if (peeledFirst?.type === 'object') {
      const pairs = getObjectPairs(peeledFirst);
      const queryKeyPair = pairs.find(p => p.key === 'queryKey');
      if (queryKeyPair) queryKeyNode = queryKeyPair.value;
      const exactPair = pairs.find(p => p.key === 'exact');
      if (exactPair) exact = interpretBoolLiteral(exactPair.value);
    } else {
      queryKeyNode = firstArg;
    }

    const queryKeyExpr = peelExpression(queryKeyNode);
    const queryKey = compactText(String((queryKeyExpr as any)?.text || '').trim());
    if (!queryKey) return;

    operations.push({
      kind: method === 'setQueryData' || method === 'setQueriesData'
        ? 'write'
        : method === 'removeQueries'
          ? 'remove'
          : 'refetch',
      method,
      callee: callee.calleeText,
      queryKey,
      queryKeyParts: extractArrayLiteralParts(queryKeyExpr),
      exact,
      line: getNodeLine(node),
      confidence,
    });
  });

  operations.sort((a, b) => a.line - b.line);

  const seen = new Set<string>();
  return operations.filter(op => {
    const key = `${op.method}|${op.callee}|${op.queryKey}|${op.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const buildCacheLinks = (operations: UiCacheOperation[], queries: UiQueryContract[]): UiCacheLink[] => {
  const links: UiCacheLink[] = [];

  for (const op of operations) {
    const matches: UiCacheLinkMatch[] = [];

    for (const q of queries) {
      if (!q || !q.queryKey) continue;

      if (q.queryKey === op.queryKey) {
        matches.push({ hook: q.hook, queryKey: q.queryKey, line: q.line, match: 'exact', confidence: 0.95 });
        continue;
      }

      const qParts = q.queryKeyParts;
      const opParts = op.queryKeyParts;
      if (!qParts || !opParts) continue;

      if (op.method === 'setQueryData') {
        if (opParts.length !== qParts.length) continue;
        let ok = true;
        for (let i = 0; i < opParts.length; i++) {
          if (opParts[i] !== qParts[i]) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        matches.push({ hook: q.hook, queryKey: q.queryKey, line: q.line, match: 'exact', confidence: 0.95 });
        continue;
      }

      if (op.exact === true) continue;
      if (opParts.length > qParts.length) continue;

      let ok = true;
      for (let i = 0; i < opParts.length; i++) {
        if (opParts[i] !== qParts[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      const matchKind: UiCacheLinkMatch['match'] = opParts.length === qParts.length ? 'exact' : 'prefix';
      matches.push({ hook: q.hook, queryKey: q.queryKey, line: q.line, match: matchKind, confidence: matchKind === 'exact' ? 0.95 : 0.9 });
    }

    matches.sort((a, b) => a.line - b.line);
    links.push({ operation: op, matches });
  }

  return links;
};

const annotateQueriesWithRefetchTriggers = (queries: UiQueryContract[], cacheLinks: UiCacheLink[]): UiQueryContract[] => {
  if (!queries || queries.length === 0) return [];

  const triggersByLine = new Map<number, UiQueryRefetchTrigger[]>();

  for (const link of cacheLinks) {
    if (link.operation.kind === 'write') continue;
    for (const match of link.matches) {
      const existing = triggersByLine.get(match.line) || [];
      existing.push({
        method: link.operation.method,
        queryKey: link.operation.queryKey,
        match: match.match,
        line: link.operation.line,
        confidence: Math.min(link.operation.confidence, match.confidence),
      });
      triggersByLine.set(match.line, existing);
    }
  }

  return queries.map(q => {
    const triggers = (q?.line && triggersByLine.get(q.line)) || [];
    if (!triggers || triggers.length === 0) return q;

    const seen = new Set<string>();
    const deduped = triggers.filter(t => {
      const key = `${t.method}|${t.queryKey}|${t.match}|${t.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    deduped.sort((a, b) => a.line - b.line);

    return { ...q, refetchTriggers: deduped };
  });
};

const annotateQueriesWithCacheWriteTriggers = (queries: UiQueryContract[], cacheLinks: UiCacheLink[]): UiQueryContract[] => {
  if (!queries || queries.length === 0) return [];

  const triggersByLine = new Map<number, UiQueryCacheWriteTrigger[]>();

  for (const link of cacheLinks) {
    if (link.operation.kind !== 'write') continue;
    for (const match of link.matches) {
      const existing = triggersByLine.get(match.line) || [];
      existing.push({
        method: link.operation.method,
        queryKey: link.operation.queryKey,
        match: match.match,
        line: link.operation.line,
        confidence: Math.min(link.operation.confidence, match.confidence),
      });
      triggersByLine.set(match.line, existing);
    }
  }

  return queries.map(q => {
    const triggers = (q?.line && triggersByLine.get(q.line)) || [];
    if (!triggers || triggers.length === 0) return q;

    const seen = new Set<string>();
    const deduped = triggers.filter(t => {
      const key = `${t.method}|${t.queryKey}|${t.match}|${t.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    deduped.sort((a, b) => a.line - b.line);

    return { ...q, cacheWriteTriggers: deduped };
  });
};

const extractMutationCallbackNodes = (
  callNode: Parser.SyntaxNode,
  fnNodesByName: Map<string, Parser.SyntaxNode>
): Parser.SyntaxNode[] => {
  const obj = getFirstObjectArg(callNode);
  if (!obj) return [];

  const callbackKeys = new Set(['onSuccess', 'onError', 'onSettled', 'onMutate']);
  const nodes: Parser.SyntaxNode[] = [];

  for (const pair of getObjectPairs(obj)) {
    if (!callbackKeys.has(pair.key)) continue;
    const value = pair.value;

    if (value.type === 'arrow_function' || value.type === 'function_expression') {
      nodes.push(value);
      continue;
    }

    if (value.type === 'identifier') {
      const name = String((value as any).text || '').trim();
      const resolved = name ? fnNodesByName.get(name) : null;
      if (resolved) nodes.push(resolved);
    }
  }

  return nodes;
};

const extractMutationTriggersFromObjectPattern = (patternNode: Parser.SyntaxNode): string[] => {
  const triggers: string[] = [];
  if (!patternNode || patternNode.type !== 'object_pattern') return triggers;

  for (const child of patternNode.namedChildren || []) {
    if (child.type === 'shorthand_property_identifier_pattern') {
      const name = String((child as any).text || '').trim();
      if (name && MUTATION_METHODS.has(name)) triggers.push(name);
      continue;
    }

    if (child.type === 'pair_pattern') {
      const [keyNode, valueNode] = child.namedChildren || [];
      if (!keyNode || !valueNode) continue;
      const key = (keyNode.type === 'property_identifier' || keyNode.type === 'identifier')
        ? String((keyNode as any).text || '').trim()
        : '';
      if (!key || !MUTATION_METHODS.has(key)) continue;
      if (valueNode.type === 'identifier') {
        const local = String((valueNode as any).text || '').trim();
        if (local) triggers.push(local);
      }
    }
  }

  return triggers;
};

const buildMutationCallbackMap = (root: Parser.SyntaxNode, fnNodesByName: Map<string, Parser.SyntaxNode>): MutationCallbackMap => {
  const map: MutationCallbackMap = new Map();

  walkNamed(root, node => {
    if (node.type !== 'call_expression') return;
    if (!isUseMutationCall(node)) return;

    const callbacks = extractMutationCallbackNodes(node, fnNodesByName);
    if (callbacks.length === 0) return;

    const declarator = node.parent;
    if (!declarator || declarator.type !== 'variable_declarator') return;

    const nameNode = (declarator as any).childForFieldName?.('name') as Parser.SyntaxNode | null;
    if (!nameNode) return;

    const triggers: string[] = [];

    if (nameNode.type === 'identifier') {
      const varName = String((nameNode as any).text || '').trim();
      if (varName) {
        triggers.push(`${varName}.mutate`);
        triggers.push(`${varName}.mutateAsync`);
      }
    } else if (nameNode.type === 'object_pattern') {
      triggers.push(...extractMutationTriggersFromObjectPattern(nameNode));
    }

    for (const trigger of triggers) {
      if (!trigger) continue;
      const existing = map.get(trigger) || [];
      existing.push(...callbacks);
      map.set(trigger, existing);
    }
  });

  return map;
};

const expandMutationCallbackEffects = (
  effects: UiContractEffect[],
  mutationCallbacks: MutationCallbackMap,
  fnNodesByName: Map<string, Parser.SyntaxNode>,
  mutationTriggerNames: Set<string>
): UiContractEffect[] => {
  const mutationTriggers = Array.from(new Set(effects.filter(e => e.kind === 'mutation').map(e => e.callee).filter(Boolean)));
  if (mutationTriggers.length === 0) return [];

  const callbackNodes: Parser.SyntaxNode[] = [];
  for (const trigger of mutationTriggers) {
    const nodes = mutationCallbacks.get(trigger);
    if (nodes) callbackNodes.push(...nodes);
  }
  if (callbackNodes.length === 0) return [];

  const derived: UiContractEffect[] = [];
  for (const cb of callbackNodes) {
    derived.push(...analyzeEffects(cb, fnNodesByName, { visited: new Set<string>(), mutationTriggerNames }));
  }

  // Dedupe by kind+callee+args+line to keep output compact.
  const seen = new Set<string>();
  return derived.filter(e => {
    const key = `${e.kind}|${e.callee}|${e.args}|${e.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const collectNamedFunctionNodes = (root: Parser.SyntaxNode): Map<string, Parser.SyntaxNode> => {
  const map = new Map<string, Parser.SyntaxNode>();

  walkNamed(root, node => {
    if (node.type === 'function_declaration') {
      const nameNode = (node as any).childForFieldName?.('name') as Parser.SyntaxNode | null;
      const name = String((nameNode as any)?.text || '').trim();
      if (name && !map.has(name)) map.set(name, node);
      return;
    }

    if (node.type === 'variable_declarator') {
      const nameNode = (node as any).childForFieldName?.('name') as Parser.SyntaxNode | null;
      const valueNode = (node as any).childForFieldName?.('value') as Parser.SyntaxNode | null;
      const name = nameNode?.type === 'identifier' ? String((nameNode as any).text || '').trim() : '';
      if (!name || map.has(name) || !valueNode) return;

      if (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression') {
        map.set(name, valueNode);
      }
    }
  });

  return map;
};

const getJsxAttributeName = (attrNode: Parser.SyntaxNode): string => {
  const nameNode = (attrNode as any).childForFieldName?.('name') as Parser.SyntaxNode | null;
  const name = String((nameNode as any)?.text || '').trim();
  if (name) return name;
  const fallback = attrNode.namedChildren.find(c => c.type.endsWith('identifier')) || null;
  return String((fallback as any)?.text || '').trim();
};

const getJsxAttributeExpression = (attrNode: Parser.SyntaxNode): Parser.SyntaxNode | null => {
  // tree-sitter-typescript's TSX grammar does not expose field names for jsx_attribute
  // (name/value), so we use the named children shape:
  //   jsx_attribute -> property_identifier, jsx_expression
  const valueNode = attrNode.namedChildren.find(c => c.type === 'jsx_expression')
    || attrNode.namedChildren.find(c => c.type === 'string')
    || null;

  if (!valueNode) return null;

  if (valueNode.type === 'jsx_expression') {
    return valueNode.namedChildren[0] || null;
  }

  return valueNode;
};

const findOpeningElementNode = (attrNode: Parser.SyntaxNode): Parser.SyntaxNode | null => {
  let current: Parser.SyntaxNode | null = attrNode.parent;
  while (current) {
    if (current.type === 'jsx_opening_element' || current.type === 'jsx_self_closing_element') return current;
    current = current.parent;
  }
  return null;
};

const getJsxElementName = (openingNode: Parser.SyntaxNode): string => {
  const nameNode = (openingNode as any).childForFieldName?.('name') as Parser.SyntaxNode | null;
  const name = String((nameNode as any)?.text || '').trim();
  if (name) return name;
  return compactText(String((openingNode as any).text || '').trim());
};

const getOpeningElementAttributeMap = (openingNode: Parser.SyntaxNode): Map<string, Parser.SyntaxNode> => {
  const map = new Map<string, Parser.SyntaxNode>();

  for (const child of openingNode.namedChildren || []) {
    if (child.type !== 'jsx_attribute') continue;
    const name = getJsxAttributeName(child);
    if (!name) continue;
    map.set(name, child);
  }

  return map;
};

const extractGatesFromAttributeMap = (attrMap: Map<string, Parser.SyntaxNode>): UiContractGate[] => {
  const gates: UiContractGate[] = [];

  for (const [name, node] of attrMap.entries()) {
    if (!GATE_ATTRS.has(name)) continue;
    const expr = getJsxAttributeExpression(node);

    const value = expr
      ? compactText(String((expr as any)?.text || '').trim())
      : 'true';

    if (!value) continue;

    const confidence = name === 'disabled' || name === 'aria-disabled' ? 0.9 : 0.75;
    gates.push({ attribute: name, value, line: getNodeLine(node), confidence });
  }

  return gates;
};

const extractControlledSurfaces = (root: Parser.SyntaxNode): UiControlledSurface[] => {
  const controlled: UiControlledSurface[] = [];

  walkNamed(root, node => {
    if (node.type !== 'jsx_opening_element' && node.type !== 'jsx_self_closing_element') return;
    const attrs = getOpeningElementAttributeMap(node);
    const openAttr = attrs.get('open');
    const onOpenChangeAttr = attrs.get('onOpenChange');
    if (!openAttr || !onOpenChangeAttr) return;

    const openExpr = getJsxAttributeExpression(openAttr);
    const onOpenChangeExpr = getJsxAttributeExpression(onOpenChangeAttr);
    const element = getJsxElementName(node);

    controlled.push({
      element,
      open: compactText(String((openExpr as any)?.text || '')),
      onOpenChange: compactText(String((onOpenChangeExpr as any)?.text || '')),
      line: getNodeLine(openAttr),
    });
  });

  return controlled;
};

const extractQueryContracts = (root: Parser.SyntaxNode): UiQueryContract[] => {
  const queries: UiQueryContract[] = [];

  const interestingOptionKeys = new Set([
    'enabled',
    'staleTime',
    'refetchOnMount',
    'refetchOnWindowFocus',
    'refetchInterval',
    'gcTime',
    'cacheTime',
  ]);

  const getHookName = (callNode: Parser.SyntaxNode): string => {
    const callee = getCallExpressionCallee(callNode);
    if (!callee) return '';
    if (callee.kind === 'identifier') return callee.name || '';
    if (callee.kind === 'member') return callee.propertyText || '';
    return '';
  };

  const isQueryHookName = (name: string): boolean => {
    return name === 'useQuery'
      || name === 'useSuspenseQuery'
      || name === 'useInfiniteQuery'
      || name === 'useSuspenseInfiniteQuery';
  };

  walkNamed(root, node => {
    if (node.type !== 'call_expression') return;

    const hook = getHookName(node);
    if (!isQueryHookName(hook)) return;

    const obj = getFirstObjectArg(node);
    if (!obj) return;

    const pairs = getObjectPairs(obj);
    const queryKeyPair = pairs.find(p => p.key === 'queryKey');
    if (!queryKeyPair) return;

    const queryKeyNode = peelExpression(queryKeyPair.value);
    const queryKey = compactText(String((queryKeyNode as any)?.text || '').trim());
    if (!queryKey) return;

    const contract: UiQueryContract = {
      scope: getEnclosingScopeKey(node),
      hook,
      queryKey,
      queryKeyParts: extractArrayLiteralParts(queryKeyNode),
      line: getNodeLine(node),
      confidence: 0.9,
    };

    for (const pair of pairs) {
      if (!interestingOptionKeys.has(pair.key)) continue;
      const valueText = compactText(String((pair.value as any)?.text || '').trim());
      if (!valueText) continue;

      const normalizedKey = pair.key === 'cacheTime' ? 'gcTime' : pair.key;
      (contract as any)[normalizedKey] = valueText;
    }

    queries.push(contract);
  });

  return queries;
};

const buildCacheCoverage = (opts: {
  interactions: UiContractInteraction[];
  queries: UiQueryContract[];
  cacheOperations: UiCacheOperation[];
  cacheLinks: UiCacheLink[];
}): UiCacheCoverage[] => {
  const { interactions, queries, cacheOperations, cacheLinks } = opts;
  if (!interactions || interactions.length === 0) return [];
  if (!queries || queries.length === 0) return [];
  if (!cacheOperations || cacheOperations.length === 0) return [];
  if (!cacheLinks || cacheLinks.length === 0) return [];

  const opsByLine = new Map<number, UiCacheOperation[]>();
  for (const op of cacheOperations) {
    const line = op?.line;
    if (!line || !Number.isFinite(line)) continue;
    const existing = opsByLine.get(line) || [];
    existing.push(op);
    opsByLine.set(line, existing);
  }

  const linksByOpKey = new Map<string, UiCacheLink>();
  for (const link of cacheLinks) {
    const op = link?.operation;
    if (!op) continue;
    const key = `${op.method}|${op.queryKey}|${op.line}`;
    if (!key) continue;
    linksByOpKey.set(key, link);
  }

  const coverages: UiCacheCoverage[] = [];

  for (const interaction of interactions) {
    const scope = String(interaction?.scope || '').trim();
    if (!scope) continue;

    const mutations = (interaction.effects || [])
      .filter(e => e.kind === 'mutation')
      .map(e => ({ callee: e.callee, line: e.line, confidence: e.confidence }))
      .filter(m => m.callee);
    if (mutations.length === 0) continue;

    const queriesInScope = queries.filter(q => String(q?.scope || '').trim() === scope);
    if (queriesInScope.length === 0) continue;

    const invalidateLines = Array.from(new Set((interaction.effects || [])
      .filter(e => e.kind === 'invalidate')
      .map(e => e.line)
      .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    ));

    const operations: UiCacheOperation[] = [];
    for (const line of invalidateLines) {
      const ops = opsByLine.get(line) || [];
      operations.push(...ops);
    }

    const opSeen = new Set<string>();
    const dedupedOps = operations.filter(op => {
      const key = `${op.method}|${op.queryKey}|${op.line}`;
      if (!key || opSeen.has(key)) return false;
      opSeen.add(key);
      return true;
    });

    if (dedupedOps.length === 0) continue;

    const scopeQueryLines = new Set<number>(queriesInScope.map(q => q.line).filter((n): n is number => typeof n === 'number' && Number.isFinite(n)));

    const links: UiCacheLink[] = [];
    for (const op of dedupedOps) {
      const key = `${op.method}|${op.queryKey}|${op.line}`;
      const link = linksByOpKey.get(key);
      if (!link) continue;
      const matches = (link.matches || []).filter(m => scopeQueryLines.has(m.line));
      links.push({ operation: link.operation, matches });
    }

    const matchedQueryLines = new Set<number>();
    for (const link of links) {
      for (const match of link.matches || []) matchedQueryLines.add(match.line);
    }

    const missingQueries = queriesInScope
      .filter(q => !matchedQueryLines.has(q.line))
      .map(q => ({ hook: q.hook, queryKey: q.queryKey, line: q.line, confidence: q.confidence }));

    const hasAnyMatch = Array.from(matchedQueryLines).length > 0;
    const confidence = hasAnyMatch ? 0.35 : 0.4;

    coverages.push({
      scope,
      interaction: {
        event: interaction.event,
        element: interaction.element,
        handler: interaction.handler,
        line: interaction.handler.line,
      },
      mutations: mutations.slice(0, 5),
      operations: dedupedOps.slice(0, 12),
      links: links.slice(0, 12),
      missing_queries: missingQueries.slice(0, 12),
      confidence,
    });
  }

  return coverages;
};

const buildInteractionSmells = (interaction: {
  event: string;
  element: string;
  line: number;
  effects: UiContractEffect[];
  gates: UiContractGate[];
  attributeNames: Set<string>;
  hasControlledDialog: boolean;
  hasControlledAlertDialog: boolean;
}): UiContractSmell[] => {
  const smells: UiContractSmell[] = [];

  const hasMutation = interaction.effects.some(e => e.kind === 'mutation');
  const hasInvalidate = interaction.effects.some(e => e.kind === 'invalidate');
  const hasPendingGate = interaction.gates.some(g => /pending|loading|submitting|fetching|processing/i.test(g.attribute) || /pending|loading|submitting|fetching|processing/i.test(g.value));

  if (hasMutation && !hasInvalidate) {
    smells.push({
      kind: 'mutation-without-invalidation',
      message: 'Mutation triggered without invalidateQueries/refetch in the same handler; verify cache refresh path.',
      line: interaction.line,
      confidence: 0.6,
    });
  }

  if (interaction.event !== 'onSubmit' && hasMutation && !hasPendingGate) {
    smells.push({
      kind: 'mutation-without-pending-ux',
      message: 'Mutation triggered without a visible pending/disabled gate on the same element; verify isPending/loading UX.',
      line: interaction.line,
      confidence: 0.45,
    });
  }

  if (/DropdownMenu/i.test(interaction.element) && interaction.event === 'onClick' && !interaction.attributeNames.has('onSelect')) {
    smells.push({
      kind: 'dropdownmenu-onclick-without-onselect',
      message: 'DropdownMenu item uses onClick without onSelect(e.preventDefault()); may cause menu close/focus quirks.',
      line: interaction.line,
      confidence: 0.7,
    });
  }

  const isAlertDialogAction = /AlertDialog/i.test(interaction.element) && /Action/i.test(interaction.element);
  if (isAlertDialogAction && hasMutation && !interaction.hasControlledAlertDialog) {
    smells.push({
      kind: 'alertdialog-action-async-uncontrolled',
      message: 'AlertDialog.Action triggers async work without a controlled open state; it may close immediately.',
      line: interaction.line,
      confidence: 0.7,
    });
  }

  const isDialogAction = /Dialog/i.test(interaction.element) && /Action|Close|Submit/i.test(interaction.element);
  if (isDialogAction && hasMutation && !interaction.hasControlledDialog) {
    smells.push({
      kind: 'dialog-action-async-uncontrolled',
      message: 'Dialog action triggers async work without a controlled open state; verify close timing + pending UX.',
      line: interaction.line,
      confidence: 0.55,
    });
  }

  return smells;
};

export const extractUiContractCard = async (filePath: string, content: string): Promise<UiContractCard> => {
  const language = getLanguageFromFilename(filePath);
  if (language !== SupportedLanguages.TypeScript && language !== SupportedLanguages.JavaScript) {
    return {
      filePath,
      controlled: [],
      interactions: [],
      queries: [],
      cacheLinks: [],
      effectsSummary: {
        'state-update': 0,
        mutation: 0,
        invalidate: 0,
        navigate: 0,
        toast: 0,
        http: 0,
      },
      smells: [],
    };
  }

  const parser = await loadParser();
  await loadLanguage(language, filePath);

  let tree: Parser.Tree;
  try {
    const parseable = getParseableContent(filePath, content);
    tree = parser.parse(parseable, undefined, { bufferSize: 1024 * 256 });
  } catch {
    return {
      filePath,
      controlled: [],
      interactions: [],
      queries: [],
      cacheLinks: [],
      effectsSummary: {
        'state-update': 0,
        mutation: 0,
        invalidate: 0,
        navigate: 0,
        toast: 0,
        http: 0,
      },
      smells: [],
    };
  }

  const root = tree.rootNode;
  const fnNodesByName = collectNamedFunctionNodes(root);
  const mutationCallbacks = buildMutationCallbackMap(root, fnNodesByName);
  const mutationTriggerNames = new Set<string>(mutationCallbacks.keys());
  const controlled = extractControlledSurfaces(root);
  const rawQueries = extractQueryContracts(root);
  const cacheOperations = extractCacheOperations(root);
  const cacheLinks = buildCacheLinks(cacheOperations, rawQueries);
  const queries = annotateQueriesWithCacheWriteTriggers(
    annotateQueriesWithRefetchTriggers(rawQueries, cacheLinks),
    cacheLinks
  );

  const hasControlledDialog = controlled.some(s => /Dialog/i.test(s.element));
  const hasControlledAlertDialog = controlled.some(s => /AlertDialog/i.test(s.element));

  const interactions: UiContractInteraction[] = [];

  walkNamed(root, node => {
    if (node.type !== 'jsx_attribute') return;

    const event = getJsxAttributeName(node);
    if (!UI_EVENT_ATTRS.has(event)) return;

    const opening = findOpeningElementNode(node);
    if (!opening) return;

    const element = getJsxElementName(opening);
    const attrMap = getOpeningElementAttributeMap(opening);
    const attrNames = new Set(attrMap.keys());
    const gates = extractGatesFromAttributeMap(attrMap);

    const expr = getJsxAttributeExpression(node);
    const handlerLine = getNodeLine(node);

    let handlerKind: UiContractInteraction['handler']['kind'] = 'unknown';
    let handlerName = '';
    let effects: UiContractEffect[] = [];

    if (!expr) {
      handlerKind = 'unknown';
      handlerName = '';
      effects = [];
    } else if (expr.type === 'identifier') {
      handlerKind = 'identifier';
      handlerName = String((expr as any).text || '').trim();
      const fnNode = fnNodesByName.get(handlerName) || null;
      effects = fnNode ? analyzeEffects(fnNode, fnNodesByName, { visited: new Set<string>(), mutationTriggerNames }) : [];
      if (!fnNode && /^set[A-Z]/.test(handlerName)) {
        effects = [{ kind: 'state-update', callee: handlerName, args: '(…)', line: handlerLine, confidence: 0.65 }];
      }
    } else if (expr.type === 'member_expression') {
      handlerKind = 'member';
      handlerName = compactText(String((expr as any).text || '').trim());
      effects = [];

      const member = getMemberExpressionParts(expr);
      if (member) {
        if (MUTATION_METHODS.has(member.propertyText)) {
          effects.push({ kind: 'mutation', callee: member.fullText, args: '(…)', line: handlerLine, confidence: 0.7 });
        } else if (INVALIDATION_METHODS.has(member.propertyText)) {
          effects.push({ kind: 'invalidate', callee: member.fullText, args: '(…)', line: handlerLine, confidence: 0.55 });
        } else if ((member.objectText === 'Axios' || member.objectText === 'axios') && HTTP_METHODS.has(member.propertyText)) {
          effects.push({ kind: 'http', callee: member.fullText, args: '(…)', line: handlerLine, confidence: 0.7 });
        }
      }
    } else if (expr.type === 'call_expression') {
      handlerKind = 'unknown';
      handlerName = compactText(String((expr as any).text || '').trim());
      effects = [];

      const callee = getCallExpressionCallee(expr);
      const isHandleSubmit = callee
        ? (callee.kind === 'identifier' && callee.name === 'handleSubmit')
          || (callee.kind === 'member' && callee.propertyText === 'handleSubmit')
        : false;

      if (isHandleSubmit) {
        const argsNode = (expr as any).childForFieldName?.('arguments') as Parser.SyntaxNode | null;
        const firstArg = argsNode?.namedChildren?.[0] || null;

        if (firstArg?.type === 'identifier') {
          const name = String((firstArg as any).text || '').trim();
          const fnNode = name ? fnNodesByName.get(name) : null;
          effects = fnNode ? analyzeEffects(fnNode, fnNodesByName, { visited: new Set<string>(), mutationTriggerNames }) : [];
        } else if (firstArg && (firstArg.type === 'arrow_function' || firstArg.type === 'function_expression')) {
          effects = analyzeEffects(firstArg, fnNodesByName, { visited: new Set<string>(), mutationTriggerNames });
        }
      }
    } else if (expr.type === 'arrow_function' || expr.type === 'function_expression') {
      handlerKind = 'inline';
      handlerName = '(inline)';
      effects = analyzeEffects(expr, fnNodesByName, { visited: new Set<string>(), mutationTriggerNames });
    } else {
      handlerKind = 'unknown';
      handlerName = compactText(String((expr as any).text || '').trim());
      effects = [];
    }

    const expanded = expandMutationCallbackEffects(effects, mutationCallbacks, fnNodesByName, mutationTriggerNames);
    if (expanded.length > 0) effects = [...effects, ...expanded];

    const smells = buildInteractionSmells({
      event,
      element,
      line: handlerLine,
      effects,
      gates,
      attributeNames: attrNames,
      hasControlledDialog,
      hasControlledAlertDialog,
    });

    interactions.push({
      scope: getEnclosingScopeKey(node),
      event,
      element,
      handler: { kind: handlerKind, name: handlerName, line: handlerLine },
      gates,
      effects,
      smells,
    });
  });

  const cacheCoverage = buildCacheCoverage({
    interactions,
    queries,
    cacheOperations,
    cacheLinks,
  });

  const cacheCoverageByHandlerLine = new Map<number, UiCacheCoverage[]>();
  for (const item of cacheCoverage) {
    const line = item?.interaction?.handler?.line;
    if (typeof line !== 'number' || !Number.isFinite(line)) continue;
    const existing = cacheCoverageByHandlerLine.get(line) || [];
    existing.push(item);
    cacheCoverageByHandlerLine.set(line, existing);
  }

  for (const interaction of interactions) {
    const items = cacheCoverageByHandlerLine.get(interaction.handler.line) || [];
    if (items.length === 0) continue;

    // Conservative lint: only warn when a small surface has queries that are not matched by
    // any invalidate/setQueryData/remove operation triggered in this interaction.
    const missingCount = items.reduce((sum, i) => sum + ((i?.missing_queries || []).length || 0), 0);
    if (missingCount === 0) continue;

    const scopeQueries = queries.filter(q => String(q?.scope || '').trim() === String(interaction.scope || '').trim());
    if (scopeQueries.length > 8) continue;

    const example = items.flatMap(i => i.missing_queries || [])[0]?.queryKey || '';
    interaction.smells.push({
      kind: 'cache-coverage-gap',
      message: `Cache coverage check: ${missingCount} queryKey(s) in this surface have no matching invalidate/setQueryData/remove operation. Example: ${compactText(example, 80)}`,
      line: interaction.handler.line,
      confidence: Math.min(...items.map(i => i.confidence || 0.35)),
    });
  }

  const effectsSummary: Record<UiContractEffectKind, number> = {
    'state-update': 0,
    mutation: 0,
    invalidate: 0,
    navigate: 0,
    toast: 0,
    http: 0,
  };

  const smells: UiContractSmell[] = [];
  for (const interaction of interactions) {
    for (const eff of interaction.effects) effectsSummary[eff.kind] = (effectsSummary[eff.kind] || 0) + 1;
    smells.push(...interaction.smells);
  }

  return {
    filePath,
    controlled,
    interactions,
    queries,
    cacheLinks,
    cacheCoverage,
    effectsSummary,
    smells,
  };
};
