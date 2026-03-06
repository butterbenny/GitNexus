import Parser from 'tree-sitter';
import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import { SymbolDefinition, SymbolTable } from './symbol-table.js';
import { ImportMap, PhpUseAliasMap } from './import-processor.js';
import { loadLanguage, loadParser } from '../tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../config/supported-languages.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename, yieldToEventLoop } from './utils.js';
import {
  ROUTE_FILE_PATH_RE,
  extractLaravelRouteTargetsFromSnippet,
  resolveController,
} from './laravel-route-processor.js';

type ResolvedNamedRouteTarget = {
  methodNodeId: string;
  confidence: number;
  reason: string;
};

type QrDeliverySignal = 'redirect-link' | 'html-embed';

type QrDeliveryCall = {
  callNode: any;
  signal: QrDeliverySignal;
};

const QR_REDIRECT_ROUTE_NAME = 'qr-codes.redirect';
const ROUTE_VERB_RE = '(?:get|post|put|patch|delete|options|any)';
const ROUTE_VERB_CALL_RE = new RegExp(
  String.raw`(?:Route::|->)\s*${ROUTE_VERB_RE}\s*\(`,
  'g',
);
const ROUTE_NAME_RE = /->\s*(?:name|as)\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

const sliceToStatementEnd = (content: string, startIndex: number): string => {
  const maxEnd = Math.min(content.length, startIndex + 12_000);
  const semi = content.indexOf(';', startIndex);
  if (semi !== -1 && semi < maxEnd) return content.slice(startIndex, semi + 1);
  return content.slice(startIndex, maxEnd);
};

const extractLastRouteName = (statement: string): string | null => {
  let last: string | null = null;
  for (const match of statement.matchAll(ROUTE_NAME_RE)) {
    const routeName = match[2]?.trim();
    if (!routeName) continue;
    last = routeName;
  }
  return last;
};

const buildQrRedirectRouteIndex = (
  files: { path: string; content: string }[],
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): ResolvedNamedRouteTarget[] => {
  const targets: ResolvedNamedRouteTarget[] = [];

  for (const file of files) {
    if (!ROUTE_FILE_PATH_RE.test(file.path)) continue;

    for (const match of file.content.matchAll(ROUTE_VERB_CALL_RE)) {
      const startIndex = match.index;
      if (startIndex === undefined) continue;

      const statement = sliceToStatementEnd(file.content, startIndex);
      if (!/->\s*(?:name|as)\s*\(/.test(statement)) continue;

      const routeName = extractLastRouteName(statement);
      if (routeName !== QR_REDIRECT_ROUTE_NAME) continue;

      const routeTargets = extractLaravelRouteTargetsFromSnippet(statement);
      if (routeTargets.length !== 1) continue;

      const routeTarget = routeTargets[0];
      const resolvedController = resolveController(
        routeTarget.controllerClass,
        file.path,
        symbolTable,
        importMap,
        phpUseAliases,
      );
      if (!resolvedController) continue;

      const methodNodeId = symbolTable.lookupExact(
        resolvedController.filePath,
        routeTarget.controllerMethod,
      );
      if (!methodNodeId) continue;

      targets.push({
        methodNodeId,
        confidence: resolvedController.confidence,
        reason: resolvedController.reason,
      });
    }
  }

  return targets;
};

const resolveQrRedirectControllerTarget = (
  files: { path: string; content: string }[],
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): ResolvedNamedRouteTarget | null => {
  const routeTargets = buildQrRedirectRouteIndex(files, symbolTable, importMap, phpUseAliases);
  if (routeTargets.length === 1) {
    return routeTargets[0];
  }

  const controllerDefs = symbolTable
    .lookupFuzzy('QrCodeRedirectController')
    .filter((def: SymbolDefinition) => (
      def.type === 'Class'
      && def.filePath.endsWith('/QrCodeRedirectController.php')
    ));

  if (controllerDefs.length !== 1) {
    return null;
  }

  const controllerFilePath = controllerDefs[0].filePath;
  const methodNodeId = symbolTable.lookupExact(controllerFilePath, '__invoke');
  if (!methodNodeId) {
    return null;
  }

  return {
    methodNodeId,
    confidence: 0.88,
    reason: 'controller-name-heuristic',
  };
};

const stripQuotes = (value: string): string => {
  if (value.length < 2) return value;
  const start = value[0];
  const end = value[value.length - 1];
  if ((start === '"' && end === '"') || (start === '\'' && end === '\'')) {
    return value.slice(1, -1);
  }
  return value;
};

const parseStringLikeLiteral = (node: any): string | null => {
  if (!node) return null;
  const text = String(node.text || '');
  if (text.length === 0) return null;

  if (node.type === 'string') return stripQuotes(text);
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

const extractQrDeliveryCallsFromTree = (tree: Parser.Tree): QrDeliveryCall[] => {
  const calls: QrDeliveryCall[] = [];

  const visit = (node: any) => {
    if (!node) return;

    if (node.type === 'function_call_expression') {
      const fnNode = node.childForFieldName?.('function');
      const fnName = fnNode?.text?.trim();
      if (fnName === 'route' || fnName === 'to_route') {
        const argsNode = node.childForFieldName?.('arguments');
        const args = getCallArgumentExpressions(argsNode);
        const routeName = parseStringLikeLiteral(args[0])?.trim();
        if (routeName === QR_REDIRECT_ROUTE_NAME) {
          calls.push({ callNode: node, signal: 'redirect-link' });
        }
      }
    }

    if (node.type === 'member_call_expression') {
      const methodNode = node.childForFieldName?.('name');
      const methodName = methodNode?.text?.trim();
      if (methodName === 'getRedirectUrl') {
        calls.push({ callNode: node, signal: 'redirect-link' });
      }
      if (methodName === 'replaceQrCodes') {
        calls.push({ callNode: node, signal: 'html-embed' });
      }
    }

    for (const child of node.namedChildren || []) {
      visit(child);
    }
  };

  visit(tree.rootNode);
  return calls;
};

const isQrDeliveryRelevantFile = (filePath: string, content: string): boolean => {
  const lang = getLanguageFromFilename(filePath);
  if (lang !== SupportedLanguages.PHP) return false;
  if (!/\b(?:getRedirectUrl|replaceQrCodes|route\s*\(\s*['"]qr-codes\.redirect['"])\b/.test(content)) {
    return false;
  }
  return /\bMailPiece\b/.test(content) || filePath.includes('/Engage/Mail/');
};

export const processLaravelQrDelivery = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): Promise<{ edgesAdded: number }> => {
  const routeTarget = resolveQrRedirectControllerTarget(files, symbolTable, importMap, phpUseAliases);
  if (!routeTarget) {
    return { edgesAdded: 0 };
  }
  const parser = await loadParser();
  await loadLanguage(SupportedLanguages.PHP);

  let edgesAdded = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (i % 200 === 0) await yieldToEventLoop();
    if (!isQrDeliveryRelevantFile(file.path, file.content)) continue;

    let tree = astCache.get(file.path);
    if (!tree) {
      try {
        tree = parser.parse(file.content, undefined, { bufferSize: 1024 * 256 });
        astCache.set(file.path, tree);
      } catch {
        continue;
      }
    }

    const qrCalls = extractQrDeliveryCallsFromTree(tree);
    if (qrCalls.length === 0) continue;

    const callableSignals = new Map<string, Set<QrDeliverySignal>>();
    for (const qrCall of qrCalls) {
      const sourceId = findEnclosingPhpCallableId(qrCall.callNode, file.path, symbolTable);
      const signals = callableSignals.get(sourceId) || new Set<QrDeliverySignal>();
      signals.add(qrCall.signal);
      callableSignals.set(sourceId, signals);
    }

    for (const [sourceId, signals] of callableSignals) {
      if (!signals.has('redirect-link') || !signals.has('html-embed')) continue;

      const reason = `laravel-qr-delivery-trackable-redirect-link:${routeTarget.reason}`;
      const relId = generateId('CALLS', `${sourceId}:${reason}->${routeTarget.methodNodeId}`);
      graph.addRelationship({
        id: relId,
        type: 'CALLS',
        sourceId,
        targetId: routeTarget.methodNodeId,
        confidence: Math.min(0.95, Math.max(0.85, routeTarget.confidence)),
        reason,
      });
      edgesAdded++;
    }
  }

  return { edgesAdded };
};
