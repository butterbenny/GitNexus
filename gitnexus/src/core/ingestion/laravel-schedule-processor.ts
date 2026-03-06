import Parser from 'tree-sitter';
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

type ScheduleCallKind = 'job' | 'command';

const KERNEL_FILE_PATH_RE = /(^|\/)app\/Console\/Kernel\.php$/i;

const looksLikePhpIdentifier = (value: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);

const normalizePhpClassRef = (value: string): { baseName: string; parts: string[] } => {
  const trimmed = value.trim().replace(/^\\+/, '');
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  const baseName = parts.at(-1) ?? '';
  return { baseName, parts };
};

const stripPhpClassConstant = (value: string): string => value.trim().replace(/::class$/i, '').trim();

const resolvePhpClassToFile = (
  classRef: string,
  currentFilePath: string,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
  kind: ScheduleCallKind,
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

  if (kind === 'job') {
    const jobHeuristic = classDefs.filter(def => def.filePath.includes('/Jobs/') || def.filePath.endsWith('Job.php'));
    if (jobHeuristic.length === 1) {
      return { filePath: jobHeuristic[0].filePath, confidence: 0.8, reason: 'job-heuristic' };
    }
  }

  if (kind === 'command') {
    const commandHeuristic = classDefs.filter(def => {
      return def.filePath.includes('/Console/Commands/') || def.filePath.endsWith('Command.php');
    });
    if (commandHeuristic.length === 1) {
      return { filePath: commandHeuristic[0].filePath, confidence: 0.8, reason: 'command-heuristic' };
    }
  }

  if (classDefs.length === 1) {
    return { filePath: classDefs[0].filePath, confidence: 0.65, reason: 'fuzzy-class' };
  }

  return null;
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

const parseClassRefFromScheduleArg = (argNode: any): string | null => {
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

  if (argNode.type === 'string') {
    const raw = extractStringContent(argNode);
    if (!raw) return null;
    const classPart = raw.split('@', 2)[0]?.trim();
    return classPart ? stripPhpClassConstant(classPart) : null;
  }

  return null;
};

const LARAVEL_SCHEDULE_QUERY = `
; $schedule->job(Foo::class) / $schedule->job(new Foo())
; $schedule->command(FooCommand::class)
(member_call_expression
  object: (variable_name) @laravel.schedule.object
  name: (name) @laravel.schedule.method
  arguments: (arguments (argument (_) @laravel.schedule.arg))
) @laravel.schedule.call
`;

export const processLaravelSchedule = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): Promise<{ filesProcessed: number; relationshipsAdded: number }> => {
  const kernelFiles = files.filter(f => KERNEL_FILE_PATH_RE.test(f.path));
  if (kernelFiles.length === 0) return { filesProcessed: 0, relationshipsAdded: 0 };

  const parser = await loadParser();
  await loadLanguage(SupportedLanguages.PHP);

  const language = parser.getLanguage();
  const query = new Parser.Query(language, LARAVEL_SCHEDULE_QUERY);

  let relationshipsAdded = 0;
  let filesProcessed = 0;

  for (const file of kernelFiles) {
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

    let matches: any[] = [];
    try {
      matches = query.matches(tree.rootNode);
    } catch {
      continue;
    }

    const sourceId = generateId('File', file.path);

    for (const match of matches) {
      const captureMap: Record<string, any> = {};
      for (const c of match.captures) captureMap[c.name] = c.node;

      const objectNode = captureMap['laravel.schedule.object'];
      const methodNode = captureMap['laravel.schedule.method'];
      const argNode = captureMap['laravel.schedule.arg'];
      if (!objectNode || !methodNode || !argNode) continue;

      if (objectNode.text?.trim() !== '$schedule') continue;

      const kindRaw = methodNode.text?.trim();
      if (kindRaw !== 'job' && kindRaw !== 'command') continue;
      const kind = kindRaw as ScheduleCallKind;

      const classRef = parseClassRefFromScheduleArg(argNode);
      if (!classRef) continue;

      const resolved = resolvePhpClassToFile(classRef, file.path, symbolTable, importMap, phpUseAliases, kind);
      if (!resolved) continue;

      const resolvedClassName = normalizePhpClassRef(stripPhpClassConstant(classRef)).baseName;
      const handlerMethodId = symbolTable.lookupExact(resolved.filePath, 'handle')
        || symbolTable.lookupExact(resolved.filePath, '__invoke');
      const classNodeId = resolvedClassName
        ? symbolTable.lookupExact(resolved.filePath, resolvedClassName)
        : undefined;
      const targetId = handlerMethodId || classNodeId;
      if (!targetId) continue;

      const relId = generateId('CALLS', `${sourceId}:laravel-schedule-${kind}->${targetId}`);
      graph.addRelationship({
        id: relId,
        type: 'CALLS',
        sourceId,
        targetId,
        confidence: resolved.confidence,
        reason: `laravel-schedule-${kind}-${resolved.reason}${handlerMethodId ? '' : '-class-entry'}`,
      });
      relationshipsAdded++;
    }
  }

  return { filesProcessed, relationshipsAdded };
};
