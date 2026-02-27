import { KnowledgeGraph } from '../graph/types.js';
import { generateId } from '../../lib/utils.js';
import { SymbolTable, SymbolDefinition } from './symbol-table.js';
import { ImportMap, PhpUseAliasMap, expandPhpClassRefFromUseAliases } from './import-processor.js';

export type LaravelRouteTarget = {
  controllerClass: string;
  controllerMethod: string;
};

export type LaravelRouteDefinition = LaravelRouteTarget & {
  verb: string;
  path: string;
  /** 0-based line number for the defining Route::* statement (best-effort). */
  sourceStartLine?: number;
  sourceEndLine?: number;
};

type ResolvedController = {
  filePath: string;
  confidence: number;
  reason: string;
};

export const ROUTE_FILE_PATH_RE = /(^|\/)routes\/[^/]+\.php$/i;
const ROUTE_SERVICE_PROVIDER_PATH_RE = /(^|\/)app\/Providers\/RouteServiceProvider\.php$/i;

const ROUTE_VERB_RE = '(?:get|post|put|patch|delete|options|any)';

// Example:
// - Route::get('/users', [UserController::class, 'index']);
// - Route::middleware('auth')->get('/users', [UserController::class, 'index']);
const ARRAY_ACTION_RE = new RegExp(
  String.raw`(?:Route::|->)\s*(${ROUTE_VERB_RE})\s*\(\s*(['"])([^'"]+)\2\s*,\s*\[\s*([^\]]+?)::\s*class\s*,\s*(['"])([^'"]+)\5\s*\]`,
  'g'
);

// Example:
// - Route::get('/users', 'UserController@index');
// - Route::middleware('auth')->get('/users', '\App\Http\Controllers\UserController@index');
const STRING_ACTION_RE = new RegExp(
  String.raw`(?:Route::|->)\s*(${ROUTE_VERB_RE})\s*\(\s*(['"])([^'"]+)\2\s*,\s*(['"])([^'"]+)\4`,
  'g'
);

// Example:
// - Route::get('/evals', EvalReportController::class);
// - Route::post('login', \App\Http\Controllers\Mobile\Auth\LoginController::class);
const INVOKABLE_ACTION_RE = new RegExp(
  String.raw`(?:Route::|->)\s*(${ROUTE_VERB_RE})\s*\(\s*(['"])([^'"]+)\2\s*,\s*(\\?[A-Za-z0-9_\\]+)\s*::\s*class\b`,
  'g'
);

const API_RESOURCE_RE = new RegExp(
  // Supports optional 3rd arg options array: Route::apiResource('x', C::class, ['as' => 'api'])
  // We only need the first two arguments (resource + controller) for path + target expansion.
  String.raw`(?:Route::|->)\s*apiResource\s*\(\s*(['"])([^'"]+)\1\s*,\s*([^,]+?)\s*(?:,|\))`,
  'g'
);

const RESOURCE_RE = new RegExp(
  // Supports optional 3rd arg options array: Route::resource('x', C::class, ['as' => 'web'])
  // We only need the first two arguments (resource + controller) for path + target expansion.
  String.raw`(?:Route::|->)\s*resource\s*\(\s*(['"])([^'"]+)\1\s*,\s*([^,]+?)\s*(?:,|\))`,
  'g'
);

// Broad patterns (do not require literal path) — used for route → controller wiring edges.
// These preserve prior behavior where we could extract controller targets even if the URI is dynamic.
const ARRAY_TARGET_RE = new RegExp(
  String.raw`(?:Route::|->)\s*${ROUTE_VERB_RE}\s*\(\s*[^,]+,\s*\[\s*([^\]]+?)::\s*class\s*,\s*(['"])([^'"]+)\2\s*\]`,
  'g'
);

const STRING_TARGET_RE = new RegExp(
  String.raw`(?:Route::|->)\s*${ROUTE_VERB_RE}\s*\(\s*[^,]+,\s*(['"])([^'"]+)\1`,
  'g'
);

// Example:
// - Route::get('/evals', EvalReportController::class);
// - Route::post('login', \App\Http\Controllers\Mobile\Auth\LoginController::class);
const INVOKABLE_CLASS_CONST_RE = new RegExp(
  String.raw`(?:Route::|->)\s*${ROUTE_VERB_RE}\s*\(\s*[^,]+,\s*(\\?[A-Za-z0-9_\\]+)\s*::\s*class\b`,
  'g'
);

const normalizePhpClassRef = (value: string): { baseName: string; parts: string[] } => {
  const trimmed = value.trim().replace(/^\\+/, '');
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  const baseName = parts.at(-1) ?? '';
  return { baseName, parts };
};

const looksLikePhpIdentifier = (value: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);

const looksLikePhpClassRef = (value: string): boolean => {
  const trimmed = value.trim().replace(/^\\+/, '');
  if (!trimmed) return false;
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  const baseName = parts.at(-1) ?? '';
  if (!looksLikePhpIdentifier(baseName)) return false;
  if (trimmed.includes('\\')) return true;
  return /Controller$/.test(baseName);
};

export const resolveController = (
  controllerClass: string,
  routeFilePath: string,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): ResolvedController | null => {
  const expandedClassRef = expandPhpClassRefFromUseAliases(controllerClass, routeFilePath, phpUseAliases);
  const { baseName, parts } = normalizePhpClassRef(expandedClassRef);
  if (!looksLikePhpIdentifier(baseName)) return null;

  const classDefs = symbolTable
    .lookupFuzzy(baseName)
    .filter((def: SymbolDefinition) => def.type === 'Class');

  if (classDefs.length === 0) return null;

  const importedFiles = importMap.get(routeFilePath);
  if (importedFiles) {
    const importedMatches = classDefs.filter(def => importedFiles.has(def.filePath));
    if (importedMatches.length === 1) {
      return { filePath: importedMatches[0].filePath, confidence: 0.95, reason: 'laravel-route-import-resolved' };
    }
  }

  if (parts.length > 1) {
    const suffixes = new Set<string>();
    suffixes.add(`${parts.join('/')}.php`);
    if ((parts[0] ?? '').toLowerCase() === 'app') suffixes.add(`${parts.slice(1).join('/')}.php`);

    const suffixMatches = classDefs.filter(def => {
      for (const suffix of suffixes) {
        if (suffix.length > 0 && def.filePath.endsWith(suffix)) return true;
      }
      return false;
    });
    if (suffixMatches.length === 1) {
      return { filePath: suffixMatches[0].filePath, confidence: 0.95, reason: 'laravel-route-namespace-suffix' };
    }
  }

  const controllerHeuristic = classDefs.filter(def => {
    return def.filePath.includes('/Http/Controllers/') || def.filePath.endsWith('Controller.php');
  });
  if (controllerHeuristic.length === 1) {
    return { filePath: controllerHeuristic[0].filePath, confidence: 0.8, reason: 'laravel-route-controller-heuristic' };
  }

  if (classDefs.length === 1) {
    return { filePath: classDefs[0].filePath, confidence: 0.65, reason: 'laravel-route-fuzzy-class' };
  }

  return null;
};

export const normalizeLaravelRoutePath = (raw: string): string | null => {
  let value = raw.trim();
  if (value.length === 0) return '/';

  const queryStart = value.indexOf('?');
  if (queryStart !== -1) value = value.slice(0, queryStart);
  const hashStart = value.indexOf('#');
  if (hashStart !== -1) value = value.slice(0, hashStart);

  value = value.trim();
  if (value.length === 0) return '/';

  // Keep it conservative: only path-like strings.
  if (/^https?:\/\//i.test(value)) return null;

  if (!value.startsWith('/')) value = '/' + value;

  value = value.replace(/\/{2,}/g, '/');
  if (value.length > 1) value = value.replace(/\/+$/g, '');

  return value;
};

const normalizeLaravelRoutePrefix = (rawPrefix: string): string => {
  const trimmed = rawPrefix.trim();
  if (!trimmed) return '';

  const normalized = normalizeLaravelRoutePath(trimmed);
  return normalized && normalized !== '/' ? normalized : '';
};

const findLaravelPrefixInStatement = (statement: string): string => {
  const prefixMatches = Array.from(statement.matchAll(/(?:Route::|->)\s*prefix\s*\(\s*(['"])([^'"]+)\1\s*\)/g));
  const last = prefixMatches.at(-1)?.[2];
  if (!last) return '';
  return normalizeLaravelRoutePrefix(last);
};

const extractLaravelVarPrefixAssignments = (content: string): Map<string, string> => {
  const result = new Map<string, string>();

  for (const match of content.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*Route::[\s\S]*?;/g)) {
    const varName = match[1];
    const statement = match[0];
    if (!varName) continue;
    result.set(varName, findLaravelPrefixInStatement(statement));
  }

  return result;
};

export const buildLaravelRoutePrefixIndex = (files: { path: string; content: string }[]): Map<string, string> => {
  const prefixIndex = new Map<string, string>();

  for (const file of files) {
    if (!ROUTE_SERVICE_PROVIDER_PATH_RE.test(file.path)) continue;

    const laravelRoot = file.path.replace(/\/app\/Providers\/RouteServiceProvider\.php$/i, '');
    const varPrefixes = extractLaravelVarPrefixAssignments(file.content);

    for (const match of file.content.matchAll(/->\s*group\s*\(\s*base_path\s*\(\s*(['"])routes\/([^'"]+\.php)\1\s*\)\s*\)\s*;/gi)) {
      const routeFile = match[2]?.trim();
      if (!routeFile) continue;

      const matchStart = match.index ?? 0;
      const statementStart = Math.max(file.content.lastIndexOf(';', matchStart - 1) + 1, 0);
      const statement = file.content.slice(statementStart, matchStart + match[0].length);

      let prefix = findLaravelPrefixInStatement(statement);

      if (!prefix) {
        const varMatch = statement.match(/\$([A-Za-z_][A-Za-z0-9_]*)\s*->\s*group\b/);
        const varName = varMatch?.[1];
        if (varName) prefix = varPrefixes.get(varName) ?? '';
      }

      const fullRouteFilePath = laravelRoot ? `${laravelRoot}/routes/${routeFile}` : `routes/${routeFile}`;
      prefixIndex.set(fullRouteFilePath.replace(/\/{2,}/g, '/'), prefix);
    }
  }

  return prefixIndex;
};

export const getLaravelRoutePrefixForFile = (routeFilePath: string, prefixIndex?: Map<string, string>): string => {
  if (prefixIndex?.has(routeFilePath)) return prefixIndex.get(routeFilePath) ?? '';
  return /(^|\/)routes\/api\.php$/i.test(routeFilePath) ? '/api' : '';
};

type LaravelRouteGroupPrefixSpan = {
  startIndex: number;
  endIndex: number;
  prefix: string;
};

const joinLaravelRoutePrefix = (prefix: string, routePath: string): string => {
  if (!prefix) return routePath;
  if (!routePath) return prefix;
  if (routePath === '/') return prefix;

  if (routePath === prefix || routePath.startsWith(prefix + '/')) return routePath;

  const left = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const right = routePath.startsWith('/') ? routePath : '/' + routePath;
  return left + right;
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

const extractLaravelPrefixCallsFromStatement = (statement: string): string[] => {
  const prefixes: string[] = [];
  for (const match of statement.matchAll(/(?:Route::|->)\s*prefix\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) {
    const raw = match[2]?.trim();
    if (!raw) continue;
    const normalized = normalizeLaravelRoutePrefix(raw);
    if (normalized) prefixes.push(normalized);
  }
  return prefixes;
};

const extractLaravelPrefixFromGroupAttributes = (snippet: string): string => {
  let last: string | null = null;
  for (const match of snippet.matchAll(/(?:'prefix'|"prefix")\s*=>\s*(['"])([^'"]+)\1/g)) {
    const raw = match[2]?.trim();
    if (!raw) continue;
    last = raw;
  }
  return last ? normalizeLaravelRoutePrefix(last) : '';
};

const buildLaravelRouteGroupPrefixSpans = (content: string): LaravelRouteGroupPrefixSpan[] => {
  const spans: LaravelRouteGroupPrefixSpan[] = [];

  const fluentGroupRe = /->\s*group\s*\(\s*function\b/g;
  const arrayGroupRe = /(?:Route::|->)\s*group\s*\(\s*\[/g;

  const addSpan = (matchIndex: number, isArrayGroup: boolean) => {
    const statementStart = Math.max(content.lastIndexOf(';', matchIndex - 1) + 1, 0);
    const statementBeforeGroup = content.slice(statementStart, matchIndex);
    const prefixCalls = extractLaravelPrefixCallsFromStatement(statementBeforeGroup);

    const openBraceIndex = findPhpGroupClosureOpenBrace(content, matchIndex);
    if (openBraceIndex === null) return;

    const closeBraceIndex = findMatchingPhpCurlyBrace(content, openBraceIndex);
    if (closeBraceIndex === null) return;

    let combinedPrefix = '';
    for (const p of prefixCalls) combinedPrefix = joinLaravelRoutePrefix(combinedPrefix, p);

    if (isArrayGroup) {
      const snippet = content.slice(matchIndex, openBraceIndex);
      const attrPrefix = extractLaravelPrefixFromGroupAttributes(snippet);
      if (attrPrefix) combinedPrefix = joinLaravelRoutePrefix(combinedPrefix, attrPrefix);
    }

    if (!combinedPrefix) return;

    spans.push({
      startIndex: openBraceIndex + 1,
      endIndex: closeBraceIndex,
      prefix: combinedPrefix,
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

export const extractLaravelRouteDefinitions = (content: string): LaravelRouteDefinition[] => {
  const targets: LaravelRouteDefinition[] = [];
  const groupSpans = buildLaravelRouteGroupPrefixSpans(content);

  const buildLineLookup = (text: string) => {
    const newlines: number[] = [];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) newlines.push(i);
    }

    const lineAt = (index: number): number => {
      if (index <= 0) return 0;
      let lo = 0;
      let hi = newlines.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (newlines[mid] < index) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };

    return { lineAt };
  };

  const lineLookup = buildLineLookup(content);
  const getSourceLine = (index: number | undefined): number => {
    if (index === undefined) return -1;
    return lineLookup.lineAt(index);
  };

  const getGroupPrefixForIndex = (index: number): string => {
    if (groupSpans.length === 0) return '';

    const active = groupSpans.filter(span => index >= span.startIndex && index < span.endIndex);
    if (active.length === 0) return '';

    active.sort((a, b) => a.startIndex - b.startIndex);

    let combined = '';
    for (const span of active) {
      combined = joinLaravelRoutePrefix(combined, span.prefix);
    }
    return combined;
  };

  for (const match of content.matchAll(ARRAY_ACTION_RE)) {
    const verb = match[1]?.trim().toLowerCase();
    const rawPath = match[3]?.trim();
    const path = rawPath ? normalizeLaravelRoutePath(rawPath) : null;
    const controllerClass = match[4]?.trim();
    const controllerMethod = match[6]?.trim();

    if (!verb || !path || !controllerClass || !controllerMethod) continue;
    if (!looksLikePhpIdentifier(controllerMethod)) continue;
    const groupPrefix = match.index !== undefined ? getGroupPrefixForIndex(match.index) : '';
    const fullPath = groupPrefix ? joinLaravelRoutePrefix(groupPrefix, path) : path;
    const sourceLine = getSourceLine(match.index);
    targets.push({ verb, path: fullPath, controllerClass, controllerMethod, sourceStartLine: sourceLine, sourceEndLine: sourceLine });
  }

  for (const match of content.matchAll(STRING_ACTION_RE)) {
    const verb = match[1]?.trim().toLowerCase();
    const rawPath = match[3]?.trim();
    const path = rawPath ? normalizeLaravelRoutePath(rawPath) : null;
    const action = match[5]?.trim();
    if (!verb || !path || !action) continue;

    if (action.includes('@')) {
      const [controllerRaw, methodRaw] = action.split('@', 2);
      const controllerClass = controllerRaw?.trim();
      const controllerMethod = methodRaw?.trim();

      if (!controllerClass || !controllerMethod) continue;
      if (!looksLikePhpIdentifier(controllerMethod)) continue;
      const groupPrefix = match.index !== undefined ? getGroupPrefixForIndex(match.index) : '';
      const fullPath = groupPrefix ? joinLaravelRoutePrefix(groupPrefix, path) : path;
      const sourceLine = getSourceLine(match.index);
      targets.push({ verb, path: fullPath, controllerClass, controllerMethod, sourceStartLine: sourceLine, sourceEndLine: sourceLine });
      continue;
    }

    if (!looksLikePhpClassRef(action)) continue;
    {
      const groupPrefix = match.index !== undefined ? getGroupPrefixForIndex(match.index) : '';
      const fullPath = groupPrefix ? joinLaravelRoutePrefix(groupPrefix, path) : path;
      const sourceLine = getSourceLine(match.index);
      targets.push({ verb, path: fullPath, controllerClass: action, controllerMethod: '__invoke', sourceStartLine: sourceLine, sourceEndLine: sourceLine });
    }
  }

  for (const match of content.matchAll(INVOKABLE_ACTION_RE)) {
    const verb = match[1]?.trim().toLowerCase();
    const rawPath = match[3]?.trim();
    const path = rawPath ? normalizeLaravelRoutePath(rawPath) : null;
    const controllerClass = match[4]?.trim();

    if (!verb || !path || !controllerClass) continue;
    const groupPrefix = match.index !== undefined ? getGroupPrefixForIndex(match.index) : '';
    const fullPath = groupPrefix ? joinLaravelRoutePrefix(groupPrefix, path) : path;
    const sourceLine = getSourceLine(match.index);
    targets.push({ verb, path: fullPath, controllerClass, controllerMethod: '__invoke', sourceStartLine: sourceLine, sourceEndLine: sourceLine });
  }

  const extractStringArgs = (value: string): string[] => {
    const args: string[] = [];
    for (const m of value.matchAll(/(['"])([^'"]+)\1/g)) {
      if (m[2]) args.push(m[2]);
    }
    return args;
  };

  const toLaravelParamName = (resource: string): string => {
    const cleaned = resource.trim().replace(/^[\\/]+/, '').replace(/[\\/]+$/, '').replace(/-/g, '_');
    if (cleaned.endsWith('ies')) return cleaned.slice(0, -3) + 'y';
    if (cleaned.endsWith('ses')) return cleaned.slice(0, -2);
    if (cleaned.endsWith('s') && !cleaned.endsWith('ss')) return cleaned.slice(0, -1);
    return cleaned;
  };

  const normalizeApiResourceBasePath = (resource: string): { basePath: string; paramName: string } | null => {
    const trimmed = resource.trim();
    if (!trimmed) return null;

    const segments = trimmed.includes('.') ? trimmed.split('.').filter(Boolean) : null;

    if (segments && segments.length > 0) {
      const last = segments.at(-1) ?? '';
      const paramName = toLaravelParamName(last) || 'id';
      let rawPath = '';
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i].trim();
        if (!seg) continue;
        rawPath += '/' + seg;
        if (i < segments.length - 1) {
          const parentParam = toLaravelParamName(seg) || 'id';
          rawPath += `/{${parentParam}}`;
        }
      }
      const basePath = normalizeLaravelRoutePath(rawPath);
      if (!basePath) return null;
      return { basePath, paramName };
    }

    const parts = trimmed.split('/').filter(Boolean);
    const last = parts.at(-1) ?? '';
    const paramName = (last.startsWith('{') && last.endsWith('}'))
      ? last.slice(1, -1)
      : (toLaravelParamName(last) || 'id');

    const basePath = normalizeLaravelRoutePath(trimmed);
    if (!basePath) return null;
    return { basePath, paramName };
  };

  const normalizeControllerClassFromExpression = (expr: string): string | null => {
    const trimmed = expr.trim();
    if (!trimmed) return null;

    const classConst = trimmed.match(/^(\\?[A-Za-z0-9_\\]+)\s*::\s*class\b/);
    if (classConst?.[1]) return classConst[1];

    // Common Laravel pattern for a fully-qualified class string:
    //   '\\' . FooController::class
    // We only support a pure backslash prefix to avoid mis-parsing arbitrary string concatenations.
    const leadingSlashConcat = trimmed.match(/^(['"])(\\+)\1\s*\.\s*(\\?[A-Za-z0-9_\\]+)\s*::\s*class\b/);
    if (leadingSlashConcat?.[2] && leadingSlashConcat?.[3]) return leadingSlashConcat[3];

    const stringLiteral = trimmed.match(/^(['"])([^'"]+)\1$/);
    if (stringLiteral?.[2]) return stringLiteral[2];

    return null;
  };

  for (const match of content.matchAll(API_RESOURCE_RE)) {
    const resource = match[2]?.trim();
    const controllerExpr = match[3]?.trim();
    if (!resource || !controllerExpr) continue;

    const routeBase = normalizeApiResourceBasePath(resource);
    if (!routeBase) continue;

    const controllerClass = normalizeControllerClassFromExpression(controllerExpr);
    if (!controllerClass) continue;

    const statementStart = match.index ?? 0;
    const statementEnd = content.indexOf(';', statementStart);
    const statement = statementEnd === -1 ? content.slice(statementStart) : content.slice(statementStart, statementEnd);

    const onlyMatch = statement.match(/->\s*only\s*\(\s*([^)]+?)\s*\)/);
    const onlyArgs = onlyMatch?.[1] ? new Set(extractStringArgs(onlyMatch[1])) : null;
    const exceptMatch = statement.match(/->\s*except\s*\(\s*([^)]+?)\s*\)/);
    const exceptArgs = exceptMatch?.[1] ? new Set(extractStringArgs(exceptMatch[1])) : null;

    const allow = (action: string): boolean => {
      if (onlyArgs && onlyArgs.size > 0 && !onlyArgs.has(action)) return false;
      if (exceptArgs && exceptArgs.size > 0 && exceptArgs.has(action)) return false;
      return true;
    };

    const collectionPath = routeBase.basePath;
    const memberPath = collectionPath === '/'
      ? `/{${routeBase.paramName}}`
      : `${collectionPath}/{${routeBase.paramName}}`;

    const groupPrefix = match.index !== undefined ? getGroupPrefixForIndex(match.index) : '';
    const withGroupPrefix = (p: string): string => groupPrefix ? joinLaravelRoutePrefix(groupPrefix, p) : p;
    const sourceLine = getSourceLine(match.index);

    if (allow('index')) targets.push({ verb: 'get', path: withGroupPrefix(collectionPath), controllerClass, controllerMethod: 'index', sourceStartLine: sourceLine, sourceEndLine: sourceLine });
    if (allow('store')) targets.push({ verb: 'post', path: withGroupPrefix(collectionPath), controllerClass, controllerMethod: 'store', sourceStartLine: sourceLine, sourceEndLine: sourceLine });
    if (allow('show')) targets.push({ verb: 'get', path: withGroupPrefix(memberPath), controllerClass, controllerMethod: 'show', sourceStartLine: sourceLine, sourceEndLine: sourceLine });
    if (allow('update')) {
      targets.push({ verb: 'put', path: withGroupPrefix(memberPath), controllerClass, controllerMethod: 'update', sourceStartLine: sourceLine, sourceEndLine: sourceLine });
      targets.push({ verb: 'patch', path: withGroupPrefix(memberPath), controllerClass, controllerMethod: 'update', sourceStartLine: sourceLine, sourceEndLine: sourceLine });
    }
    if (allow('destroy')) targets.push({ verb: 'delete', path: withGroupPrefix(memberPath), controllerClass, controllerMethod: 'destroy', sourceStartLine: sourceLine, sourceEndLine: sourceLine });
  }

  for (const match of content.matchAll(RESOURCE_RE)) {
    const resource = match[2]?.trim();
    const controllerExpr = match[3]?.trim();
    if (!resource || !controllerExpr) continue;

    const routeBase = normalizeApiResourceBasePath(resource);
    if (!routeBase) continue;

    const controllerClass = normalizeControllerClassFromExpression(controllerExpr);
    if (!controllerClass) continue;

    const statementStart = match.index ?? 0;
    const statementEnd = content.indexOf(';', statementStart);
    const statement = statementEnd === -1 ? content.slice(statementStart) : content.slice(statementStart, statementEnd);

    const onlyMatch = statement.match(/->\s*only\s*\(\s*([^)]+?)\s*\)/);
    const onlyArgs = onlyMatch?.[1] ? new Set(extractStringArgs(onlyMatch[1])) : null;
    const exceptMatch = statement.match(/->\s*except\s*\(\s*([^)]+?)\s*\)/);
    const exceptArgs = exceptMatch?.[1] ? new Set(extractStringArgs(exceptMatch[1])) : null;

    const allow = (action: string): boolean => {
      if (onlyArgs && onlyArgs.size > 0 && !onlyArgs.has(action)) return false;
      if (exceptArgs && exceptArgs.size > 0 && exceptArgs.has(action)) return false;
      return true;
    };

    const collectionPath = routeBase.basePath;
    const memberPath = collectionPath === '/'
      ? `/{${routeBase.paramName}}`
      : `${collectionPath}/{${routeBase.paramName}}`;

    const createPath = collectionPath === '/' ? '/create' : `${collectionPath}/create`;
    const editPath = `${memberPath}/edit`;

    const groupPrefix = match.index !== undefined ? getGroupPrefixForIndex(match.index) : '';
    const withGroupPrefix = (p: string): string => groupPrefix ? joinLaravelRoutePrefix(groupPrefix, p) : p;
    const sourceLine = getSourceLine(match.index);

    if (allow('index')) targets.push({ verb: 'get', path: withGroupPrefix(collectionPath), controllerClass, controllerMethod: 'index', sourceStartLine: sourceLine, sourceEndLine: sourceLine });
    if (allow('create')) targets.push({ verb: 'get', path: withGroupPrefix(createPath), controllerClass, controllerMethod: 'create', sourceStartLine: sourceLine, sourceEndLine: sourceLine });
    if (allow('store')) targets.push({ verb: 'post', path: withGroupPrefix(collectionPath), controllerClass, controllerMethod: 'store', sourceStartLine: sourceLine, sourceEndLine: sourceLine });
    if (allow('show')) targets.push({ verb: 'get', path: withGroupPrefix(memberPath), controllerClass, controllerMethod: 'show', sourceStartLine: sourceLine, sourceEndLine: sourceLine });
    if (allow('edit')) targets.push({ verb: 'get', path: withGroupPrefix(editPath), controllerClass, controllerMethod: 'edit', sourceStartLine: sourceLine, sourceEndLine: sourceLine });
    if (allow('update')) {
      targets.push({ verb: 'put', path: withGroupPrefix(memberPath), controllerClass, controllerMethod: 'update', sourceStartLine: sourceLine, sourceEndLine: sourceLine });
      targets.push({ verb: 'patch', path: withGroupPrefix(memberPath), controllerClass, controllerMethod: 'update', sourceStartLine: sourceLine, sourceEndLine: sourceLine });
    }
    if (allow('destroy')) targets.push({ verb: 'delete', path: withGroupPrefix(memberPath), controllerClass, controllerMethod: 'destroy', sourceStartLine: sourceLine, sourceEndLine: sourceLine });
  }

  return targets;
};

export const extractLaravelRouteTargetsFromSnippet = (content: string): LaravelRouteTarget[] => {
  const targets: LaravelRouteTarget[] = [];

  for (const match of content.matchAll(ARRAY_TARGET_RE)) {
    const controllerClass = match[1]?.trim();
    const controllerMethod = match[3]?.trim();
    if (!controllerClass || !controllerMethod) continue;
    if (!looksLikePhpIdentifier(controllerMethod)) continue;
    targets.push({ controllerClass, controllerMethod });
  }

  for (const match of content.matchAll(STRING_TARGET_RE)) {
    const action = match[2]?.trim();
    if (!action) continue;

    if (action.includes('@')) {
      const [controllerRaw, methodRaw] = action.split('@', 2);
      const controllerClass = controllerRaw?.trim();
      const controllerMethod = methodRaw?.trim();

      if (!controllerClass || !controllerMethod) continue;
      if (!looksLikePhpIdentifier(controllerMethod)) continue;
      targets.push({ controllerClass, controllerMethod });
      continue;
    }

    if (!looksLikePhpClassRef(action)) continue;
    targets.push({ controllerClass: action, controllerMethod: '__invoke' });
  }

  for (const match of content.matchAll(INVOKABLE_CLASS_CONST_RE)) {
    const controllerClass = match[1]?.trim();
    if (!controllerClass) continue;
    targets.push({ controllerClass, controllerMethod: '__invoke' });
  }

  return targets;
};

export const processLaravelRoutes = (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): { filesProcessed: number; relationshipsAdded: number } => {
  let relationshipsAdded = 0;
  let filesProcessed = 0;

  for (const file of files) {
    if (!ROUTE_FILE_PATH_RE.test(file.path)) continue;
    filesProcessed++;

    const targets = extractLaravelRouteTargetsFromSnippet(file.content);
    if (targets.length === 0) continue;

    const sourceId = generateId('File', file.path);

    for (const target of targets) {
      const resolvedController = resolveController(target.controllerClass, file.path, symbolTable, importMap, phpUseAliases);
      if (!resolvedController) continue;

      const methodNodeId = symbolTable.lookupExact(resolvedController.filePath, target.controllerMethod);
      if (!methodNodeId) continue;

      const relId = generateId('CALLS', `${sourceId}:laravel-route->${methodNodeId}`);
      graph.addRelationship({
        id: relId,
        type: 'CALLS',
        sourceId,
        targetId: methodNodeId,
        confidence: resolvedController.confidence,
        reason: resolvedController.reason,
      });
      relationshipsAdded++;
    }
  }

  return { filesProcessed, relationshipsAdded };
};
