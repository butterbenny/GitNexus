import { KnowledgeGraph } from '../graph/types.js';
import { generateId } from '../../lib/utils.js';
import { ImportMap, PhpUseAliasMap } from './import-processor.js';
import { SymbolTable, SymbolDefinition } from './symbol-table.js';
import { ROUTE_FILE_PATH_RE, buildLaravelRoutePrefixIndex, extractLaravelRouteDefinitions, getLaravelRoutePrefixForFile, resolveController } from './laravel-route-processor.js';

type MiddlewareSlug = {
  kind: 'can' | 'permission';
  slug: string;
};

type MiddlewareSpan = {
  startIndex: number;
  endIndex: number;
  slugs: MiddlewareSlug[];
};

const joinRoutePrefix = (prefix: string, routePath: string): string => {
  if (!prefix) return routePath;
  if (routePath === '/') return prefix;

  if (routePath === prefix || routePath.startsWith(prefix + '/')) return routePath;

  const left = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const right = routePath.startsWith('/') ? routePath : '/' + routePath;
  return left + right;
};

const normalizePermissionSlug = (value: string): string => value.trim();

const parsePermissionSlugsFromMiddlewareSpec = (spec: string): MiddlewareSlug[] => {
  const trimmed = String(spec || '').trim();
  if (!trimmed) return [];

  const idx = trimmed.indexOf(':');
  if (idx === -1) return [];

  const kindRaw = trimmed.slice(0, idx).trim().toLowerCase();
  const restRaw = trimmed.slice(idx + 1).trim();
  if (!restRaw) return [];

  const kind = kindRaw === 'can' ? 'can' : kindRaw === 'permission' ? 'permission' : null;
  if (!kind) return [];

  const primary = kind === 'can'
    ? restRaw.split(',', 1)[0] || ''
    : restRaw;

  const candidates = primary
    .split('|')
    .flatMap(part => part.split(','))
    .map(v => normalizePermissionSlug(v))
    .filter(Boolean)
    .filter(v => v.includes('.'));

  return candidates.map(slug => ({ kind, slug }));
};

const extractMiddlewareSpecsFromSnippet = (snippet: string): string[] => {
  const specs: string[] = [];

  for (const match of snippet.matchAll(/(?:Route::|->)\s*middleware\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) {
    const raw = match[2]?.trim();
    if (raw) specs.push(raw);
  }

  for (const match of snippet.matchAll(/(?:Route::|->)\s*middleware\s*\(\s*\[([\s\S]*?)\]\s*\)/g)) {
    const inner = match[1] || '';
    for (const sm of inner.matchAll(/['"]([^'"]+)['"]/g)) {
      const raw = sm[1]?.trim();
      if (raw) specs.push(raw);
    }
  }

  return Array.from(new Set(specs));
};

const extractMiddlewareSpecsFromGroupAttributes = (snippet: string): string[] => {
  const specs: string[] = [];

  for (const match of snippet.matchAll(/(?:'middleware'|"middleware")\s*=>\s*(['"])([^'"]+)\1/g)) {
    const raw = match[2]?.trim();
    if (raw) specs.push(raw);
  }

  for (const match of snippet.matchAll(/(?:'middleware'|"middleware")\s*=>\s*\[([\s\S]*?)\]/g)) {
    const inner = match[1] || '';
    for (const sm of inner.matchAll(/['"]([^'"]+)['"]/g)) {
      const raw = sm[1]?.trim();
      if (raw) specs.push(raw);
    }
  }

  return Array.from(new Set(specs));
};

const mergeMiddlewareSlugs = (items: MiddlewareSlug[]): MiddlewareSlug[] => {
  const map = new Map<string, MiddlewareSlug['kind']>();
  for (const item of items) {
    const slug = normalizePermissionSlug(item.slug);
    if (!slug) continue;
    const prev = map.get(slug);
    if (!prev) {
      map.set(slug, item.kind);
      continue;
    }
    if (prev === 'can' && item.kind === 'permission') map.set(slug, 'permission');
  }
  return Array.from(map.entries()).map(([slug, kind]) => ({ slug, kind }));
};

const skipPhpQuotedString = (content: string, startIndex: number, quote: string): number => {
  let i = startIndex + 1;
  while (i < content.length) {
    const ch = content[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i++;
  }
  return content.length;
};

const skipPhpLineComment = (content: string, startIndex: number): number => {
  let i = startIndex;
  while (i < content.length && content[i] !== '\n') i++;
  return i;
};

const skipPhpBlockComment = (content: string, startIndex: number): number => {
  const end = content.indexOf('*/', startIndex + 2);
  return end === -1 ? content.length : end + 2;
};

const findPhpGroupClosureOpenBrace = (content: string, startIndex: number): number | null => {
  let i = startIndex;
  let seenFunction = false;

  const isWordBoundary = (idx: number): boolean => {
    if (idx <= 0 || idx >= content.length) return true;
    return !/[A-Za-z0-9_]/.test(content[idx]);
  };

  while (i < content.length) {
    const ch = content[i];
    const next = i + 1 < content.length ? content[i + 1] : '';

    if (ch === '\'' || ch === '"') {
      i = skipPhpQuotedString(content, i, ch);
      continue;
    }
    if (ch === '/' && next === '/') {
      i = skipPhpLineComment(content, i);
      continue;
    }
    if (ch === '#') {
      i = skipPhpLineComment(content, i);
      continue;
    }
    if (ch === '/' && next === '*') {
      i = skipPhpBlockComment(content, i);
      continue;
    }

    if (!seenFunction && ch === 'f' && content.startsWith('function', i) && isWordBoundary(i - 1) && isWordBoundary(i + 8)) {
      seenFunction = true;
      i += 8;
      continue;
    }

    if (ch === ';') return null;

    if (seenFunction && ch === '{') return i;

    i++;
  }

  return null;
};

const findMatchingPhpCurlyBrace = (content: string, openBraceIndex: number): number | null => {
  if (openBraceIndex < 0 || openBraceIndex >= content.length) return null;
  if (content[openBraceIndex] !== '{') return null;

  let depth = 0;
  let i = openBraceIndex;

  while (i < content.length) {
    const ch = content[i];
    const next = i + 1 < content.length ? content[i + 1] : '';

    if (ch === '\'' || ch === '"') {
      i = skipPhpQuotedString(content, i, ch);
      continue;
    }
    if (ch === '/' && next === '/') {
      i = skipPhpLineComment(content, i);
      continue;
    }
    if (ch === '#') {
      i = skipPhpLineComment(content, i);
      continue;
    }
    if (ch === '/' && next === '*') {
      i = skipPhpBlockComment(content, i);
      continue;
    }

    if (ch === '{') {
      depth++;
      i++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }

    i++;
  }

  return null;
};

const buildLaravelRouteGroupMiddlewareSpans = (content: string): MiddlewareSpan[] => {
  const spans: MiddlewareSpan[] = [];

  const fluentGroupRe = /->\s*group\s*\(\s*function\b/g;
  const arrayGroupRe = /(?:Route::|->)\s*group\s*\(\s*\[/g;

  const addSpan = (matchIndex: number, isArrayGroup: boolean) => {
    const statementStart = Math.max(content.lastIndexOf(';', matchIndex - 1) + 1, 0);
    const statementBeforeGroup = content.slice(statementStart, matchIndex);
    const specs: string[] = [];
    specs.push(...extractMiddlewareSpecsFromSnippet(statementBeforeGroup));

    const openBraceIndex = findPhpGroupClosureOpenBrace(content, matchIndex);
    if (openBraceIndex === null) return;

    const closeBraceIndex = findMatchingPhpCurlyBrace(content, openBraceIndex);
    if (closeBraceIndex === null) return;

    if (isArrayGroup) {
      const snippet = content.slice(matchIndex, openBraceIndex);
      specs.push(...extractMiddlewareSpecsFromGroupAttributes(snippet));
    }

    const slugs = mergeMiddlewareSlugs(specs.flatMap(parsePermissionSlugsFromMiddlewareSpec));
    if (slugs.length === 0) return;

    spans.push({
      startIndex: openBraceIndex + 1,
      endIndex: closeBraceIndex,
      slugs,
    });
  };

  for (const match of content.matchAll(fluentGroupRe)) {
    if (match.index === undefined) continue;
    addSpan(match.index, false);
  }

  for (const match of content.matchAll(arrayGroupRe)) {
    if (match.index === undefined) continue;
    addSpan(match.index, true);
  }

  return spans;
};

const buildPermissionSlugIdSet = (graph: KnowledgeGraph): Set<string> => {
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    const id = node?.id;
    if (!id) continue;
    if (!id.startsWith('CodeElement:permission:')) continue;
    ids.add(id);
  }
  return ids;
};

const hasPermissionSlugNode = (
  slug: string,
  permissionSlugNodeIds: Set<string>,
  symbolTable: SymbolTable,
): boolean => {
  const slugNodeId = generateId('CodeElement', `permission:${slug}`);
  if (permissionSlugNodeIds.has(slugNodeId)) return true;

  const defs = symbolTable.lookupFuzzy(slug);
  return defs.some((def: SymbolDefinition) => def.nodeId === slugNodeId);
};

export const processLaravelRouteMiddlewareAuthorization = (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): { edgesAdded: number } => {
  const permissionSlugNodeIds = buildPermissionSlugIdSet(graph);
  const prefixIndex = buildLaravelRoutePrefixIndex(files);

  let edgesAdded = 0;

  for (const file of files) {
    if (!ROUTE_FILE_PATH_RE.test(file.path)) continue;
    if (!file.content) continue;

    const defs = extractLaravelRouteDefinitions(file.content);
    if (defs.length === 0) continue;

    const groupSpans = buildLaravelRouteGroupMiddlewareSpans(file.content);
    const prefix = getLaravelRoutePrefixForFile(file.path, prefixIndex);

    for (const def of defs) {
      const sourceIndex = def.sourceIndex ?? -1;
      if (sourceIndex < 0) continue;

      const statementStart = Math.max(file.content.lastIndexOf(';', sourceIndex - 1) + 1, 0);
      const statementEnd = file.content.indexOf(';', sourceIndex);
      const statement = file.content.slice(statementStart, statementEnd === -1 ? file.content.length : statementEnd + 1);

      const statementSlugs = mergeMiddlewareSlugs(extractMiddlewareSpecsFromSnippet(statement).flatMap(parsePermissionSlugsFromMiddlewareSpec));
      const groupSlugs = mergeMiddlewareSlugs(
        groupSpans
          .filter(span => sourceIndex >= span.startIndex && sourceIndex < span.endIndex)
          .flatMap(span => span.slugs)
      );

      const slugs = mergeMiddlewareSlugs([...statementSlugs, ...groupSlugs]);
      if (slugs.length === 0) continue;

      const resolvedController = resolveController(def.controllerClass, file.path, symbolTable, importMap, phpUseAliases);
      if (!resolvedController || resolvedController.confidence < 0.9) continue;

      const methodNodeId = symbolTable.lookupExact(resolvedController.filePath, def.controllerMethod);
      if (!methodNodeId) continue;

      const verbUpper = def.verb === 'any' ? 'ANY' : def.verb.toUpperCase();
      const fullPath = joinRoutePrefix(prefix, def.path);
      const canonicalPath = fullPath.replace(/\{[^}]+\}/g, '*');
      const endpointName = `endpoint:${verbUpper.toLowerCase()}:${canonicalPath}`;
      const endpointNodeId = generateId('CodeElement', endpointName);

      for (const item of slugs) {
        if (!hasPermissionSlugNode(item.slug, permissionSlugNodeIds, symbolTable)) continue;
        const slugNodeId = generateId('CodeElement', `permission:${item.slug}`);

        const controllerReason = `laravel-can:route-middleware:${item.kind}:${item.slug}`;
        const controllerRelId = generateId('CALLS', `${methodNodeId}:${controllerReason}->${slugNodeId}`);
        graph.addRelationship({
          id: controllerRelId,
          type: 'CALLS',
          sourceId: methodNodeId,
          targetId: slugNodeId,
          confidence: Math.min(resolvedController.confidence, 0.95),
          reason: controllerReason,
        });
        edgesAdded++;

        const endpointReason = `laravel-can:endpoint-middleware:${item.kind}:${item.slug}`;
        const endpointRelId = generateId('CALLS', `${endpointNodeId}:${endpointReason}->${slugNodeId}`);
        graph.addRelationship({
          id: endpointRelId,
          type: 'CALLS',
          sourceId: endpointNodeId,
          targetId: slugNodeId,
          confidence: Math.min(resolvedController.confidence, 0.95),
          reason: endpointReason,
        });
        edgesAdded++;
      }
    }
  }

  return { edgesAdded };
};
