import { KnowledgeGraph } from '../graph/types.js';
import { generateId } from '../../lib/utils.js';
import { SymbolTable, SymbolDefinition } from './symbol-table.js';
import { ImportMap } from './import-processor.js';

export type LaravelRouteTarget = {
  controllerClass: string;
  controllerMethod: string;
};

export type LaravelRouteDefinition = LaravelRouteTarget & {
  verb: string;
  path: string;
};

type ResolvedController = {
  filePath: string;
  confidence: number;
  reason: string;
};

export const ROUTE_FILE_PATH_RE = /(^|\/)routes\/[^/]+\.php$/i;

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
): ResolvedController | null => {
  const { baseName, parts } = normalizePhpClassRef(controllerClass);
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
    suffixes.add(`${parts.slice(1).join('/')}.php`);

    const suffixMatches = classDefs.filter(def => {
      for (const suffix of suffixes) {
        if (suffix.length > 0 && def.filePath.endsWith(suffix)) return true;
      }
      return false;
    });
    if (suffixMatches.length === 1) {
      return { filePath: suffixMatches[0].filePath, confidence: 0.9, reason: 'laravel-route-namespace-suffix' };
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

export const getLaravelRoutePrefixForFile = (routeFilePath: string): string => {
  return /(^|\/)routes\/api\.php$/i.test(routeFilePath) ? '/api' : '';
};

export const extractLaravelRouteDefinitions = (content: string): LaravelRouteDefinition[] => {
  const targets: LaravelRouteDefinition[] = [];

  for (const match of content.matchAll(ARRAY_ACTION_RE)) {
    const verb = match[1]?.trim().toLowerCase();
    const rawPath = match[3]?.trim();
    const path = rawPath ? normalizeLaravelRoutePath(rawPath) : null;
    const controllerClass = match[4]?.trim();
    const controllerMethod = match[6]?.trim();

    if (!verb || !path || !controllerClass || !controllerMethod) continue;
    if (!looksLikePhpIdentifier(controllerMethod)) continue;
    targets.push({ verb, path, controllerClass, controllerMethod });
  }

  for (const match of content.matchAll(STRING_ACTION_RE)) {
    const verb = match[1]?.trim().toLowerCase();
    const rawPath = match[3]?.trim();
    const path = rawPath ? normalizeLaravelRoutePath(rawPath) : null;
    const action = match[5]?.trim();
    if (!verb || !path || !action || !action.includes('@')) continue;

    const [controllerRaw, methodRaw] = action.split('@', 2);
    const controllerClass = controllerRaw?.trim();
    const controllerMethod = methodRaw?.trim();

    if (!controllerClass || !controllerMethod) continue;
    if (!looksLikePhpIdentifier(controllerMethod)) continue;
    targets.push({ verb, path, controllerClass, controllerMethod });
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
      const resolvedController = resolveController(target.controllerClass, file.path, symbolTable, importMap);
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
