import Parser from 'tree-sitter';
import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import { SymbolTable, SymbolDefinition } from './symbol-table.js';
import { ImportMap } from './import-processor.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename, yieldToEventLoop } from './utils.js';
import { loadLanguage, loadParser } from '../tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../config/supported-languages.js';

type ResolvedClass = {
  filePath: string;
  confidence: number;
  reason: string;
};

type ExtractedLaravelViewCall = {
  callNode: any;
  viewName: string;
  reason: string;
};

type ExtractedMailMailableSend = {
  callNode: any;
  classRef: string;
};

type PendingMailSend = {
  senderFilePath: string;
  sourceId: string;
  mailableClassRef: string;
};

const VIEW_ROOT = 'resources/views/';
const BLADE_SUFFIX = '.blade.php';

const LARAVEL_VIEW_QUERY = `
; view('emails.welcome')
(function_call_expression
  function: (name) @laravel.fn
  arguments: (arguments (argument (string (string_content) @laravel.view)))
) @laravel.call

; View::make('emails.welcome') / Mail::send('emails.welcome')
(scoped_call_expression
  scope: (_) @laravel.scope
  name: (name) @laravel.method
  arguments: (arguments (argument (string (string_content) @laravel.view)))
) @laravel.call

; $this->view('emails.welcome') / response()->view('emails.welcome')
(member_call_expression
  name: (name) @laravel.method
  arguments: (arguments (argument (string (string_content) @laravel.view)))
) @laravel.call
`;

const LARAVEL_MAIL_SEND_MAILABLE_QUERY = `
; Mail::to(...)->send(new WelcomeMail())
(member_call_expression
  name: (name) @laravel.mail.method
  arguments: (arguments (argument
    (object_creation_expression (name) @laravel.mail.class)
  ))
) @laravel.mail.call

(member_call_expression
  name: (name) @laravel.mail.method
  arguments: (arguments (argument
    (object_creation_expression (qualified_name) @laravel.mail.class)
  ))
) @laravel.mail.call
`;

const normalizePhpClassRef = (value: string): { baseName: string; parts: string[] } => {
  const trimmed = value.trim().replace(/^\\+/, '');
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  const baseName = parts.at(-1) ?? '';
  return { baseName, parts };
};

const normalizeLaravelViewName = (value: string): string | null => {
  let v = value.trim();
  if (!v) return null;
  if (v.includes('::')) return null;
  v = v.replace(/\\/g, '/');
  v = v.replace(/\./g, '/');
  v = v.replace(/^\/+/, '');
  v = v.replace(/\/{2,}/g, '/');
  if (!v) return null;
  return v;
};

const viewNameToBladePath = (viewName: string): string | null => {
  const normalized = normalizeLaravelViewName(viewName);
  if (!normalized) return null;
  return `${VIEW_ROOT}${normalized}${BLADE_SUFFIX}`;
};

const looksLikePhpIdentifier = (value: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);

const resolveViewRootFromBladePath = (bladePath: string): string | null => {
  if (!bladePath.endsWith(BLADE_SUFFIX)) return null;
  if (bladePath.startsWith(VIEW_ROOT)) return '';
  const idx = bladePath.indexOf(`/${VIEW_ROOT}`);
  if (idx < 0) return null;
  return bladePath.slice(0, idx + 1);
};

const chooseViewRootForPhpFile = (phpFilePath: string, viewRoots: string[]): string | null => {
  let best: string | null = null;
  for (const root of viewRoots) {
    if (root === '') {
      if (best === null) best = '';
      continue;
    }
    if (phpFilePath.startsWith(root)) {
      if (best === null || root.length > best.length) best = root;
    }
  }
  return best;
};

const viewNameToBladePathInRoot = (viewName: string, viewRoot: string): string | null => {
  const rel = viewNameToBladePath(viewName);
  if (!rel) return null;
  return `${viewRoot}${rel}`;
};

const getScopeBaseName = (value: string): string => {
  const trimmed = value.trim().replace(/^\\+/, '');
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? trimmed;
};

const resolvePhpClassToFile = (
  classRef: string,
  currentFilePath: string,
  symbolTable: SymbolTable,
  importMap: ImportMap,
): ResolvedClass | null => {
  const { baseName, parts } = normalizePhpClassRef(classRef);
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

  const mailHeuristic = classDefs.filter(def => def.filePath.includes('/Mail/'));
  if (mailHeuristic.length === 1) {
    return { filePath: mailHeuristic[0].filePath, confidence: 0.8, reason: 'mail-heuristic' };
  }

  if (classDefs.length === 1) {
    return { filePath: classDefs[0].filePath, confidence: 0.65, reason: 'fuzzy-class' };
  }

  return null;
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

const parseLaravelViewCallsFromMatch = (captureMap: Record<string, any>): ExtractedLaravelViewCall | null => {
  const callNode = captureMap['laravel.call'];
  const viewNode = captureMap['laravel.view'];
  if (!callNode || !viewNode) return null;

  const viewName = viewNode.text?.trim();
  if (!viewName) return null;

  const fnNode = captureMap['laravel.fn'];
  if (fnNode) {
    const fnName = fnNode.text?.trim();
    if (fnName === 'view') {
      return { callNode, viewName, reason: 'laravel-view' };
    }
    return null;
  }

  const scopeNode = captureMap['laravel.scope'];
  const methodNode = captureMap['laravel.method'];
  const methodName = methodNode?.text?.trim();

  if (scopeNode && methodName) {
    const scopeBase = getScopeBaseName(scopeNode.text || '');
    if (scopeBase === 'View' && (methodName === 'make' || methodName === 'first')) {
      return { callNode, viewName, reason: 'laravel-view' };
    }
    if (scopeBase === 'Mail' && methodName === 'send') {
      return { callNode, viewName, reason: 'laravel-mail-view' };
    }
    return null;
  }

  if (methodName) {
    if (methodName === 'view' || methodName === 'markdown' || methodName === 'text') {
      return { callNode, viewName, reason: 'laravel-mailable-view' };
    }
  }

  return null;
};

const parseMailMailableSendFromMatch = (captureMap: Record<string, any>): ExtractedMailMailableSend | null => {
  const callNode = captureMap['laravel.mail.call'];
  const methodNode = captureMap['laravel.mail.method'];
  const classNode = captureMap['laravel.mail.class'];
  if (!callNode || !methodNode || !classNode) return null;

  const methodName = methodNode.text?.trim();
  if (!methodName) return null;
  if (methodName !== 'send' && methodName !== 'queue' && methodName !== 'later' && methodName !== 'sendNow') return null;

  const classRef = classNode.text?.trim();
  if (!classRef) return null;

  return { callNode, classRef };
};

export const processLaravelViewsAndMail = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  symbolTable: SymbolTable,
  importMap: ImportMap,
): Promise<{ viewEdgesAdded: number; mailEdgesAdded: number }> => {
  const bladePaths = new Set(files.filter(f => f.path.endsWith(BLADE_SUFFIX)).map(f => f.path));
  if (bladePaths.size === 0) return { viewEdgesAdded: 0, mailEdgesAdded: 0 };

  const viewRoots = Array.from(new Set(
    Array.from(bladePaths)
      .map(resolveViewRootFromBladePath)
      .filter((v): v is string => v !== null)
  ));
  viewRoots.sort((a, b) => b.length - a.length);

  const parser = await loadParser();
  await loadLanguage(SupportedLanguages.PHP);

  const language = parser.getLanguage();
  const viewQuery = new Parser.Query(language, LARAVEL_VIEW_QUERY);
  const mailQuery = new Parser.Query(language, LARAVEL_MAIL_SEND_MAILABLE_QUERY);

  const templatesUsedByPhpFile = new Map<string, Set<string>>();
  const pendingMailSends: PendingMailSend[] = [];

  let viewEdgesAdded = 0;
  let mailEdgesAdded = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (i % 100 === 0) await yieldToEventLoop();

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

    let viewMatches: any[] = [];
    let mailMatches: any[] = [];
    try {
      viewMatches = viewQuery.matches(tree.rootNode);
      mailMatches = mailQuery.matches(tree.rootNode);
    } catch {
      continue;
    }

    for (const match of viewMatches) {
      const captureMap: Record<string, any> = {};
      for (const c of match.captures) captureMap[c.name] = c.node;

      const parsed = parseLaravelViewCallsFromMatch(captureMap);
      if (!parsed) continue;

      const viewRoot = chooseViewRootForPhpFile(file.path, viewRoots);
      if (viewRoot === null) continue;

      const bladePath = viewNameToBladePathInRoot(parsed.viewName, viewRoot);
      if (!bladePath) continue;
      if (!bladePaths.has(bladePath)) continue;

      const sourceId = findEnclosingPhpCallableId(parsed.callNode, file.path, symbolTable);
      const targetId = generateId('Template', bladePath);
      const relId = generateId('CALLS', `${sourceId}:${parsed.reason}->${targetId}`);

      graph.addRelationship({
        id: relId,
        type: 'CALLS',
        sourceId,
        targetId,
        confidence: 1.0,
        reason: parsed.reason,
      });
      viewEdgesAdded++;

      let set = templatesUsedByPhpFile.get(file.path);
      if (!set) {
        set = new Set();
        templatesUsedByPhpFile.set(file.path, set);
      }
      set.add(targetId);
    }

    for (const match of mailMatches) {
      const captureMap: Record<string, any> = {};
      for (const c of match.captures) captureMap[c.name] = c.node;

      const parsed = parseMailMailableSendFromMatch(captureMap);
      if (!parsed) continue;

      const sourceId = findEnclosingPhpCallableId(parsed.callNode, file.path, symbolTable);
      pendingMailSends.push({
        senderFilePath: file.path,
        sourceId,
        mailableClassRef: parsed.classRef,
      });
    }
  }

  for (const pending of pendingMailSends) {
    const resolved = resolvePhpClassToFile(pending.mailableClassRef, pending.senderFilePath, symbolTable, importMap);
    if (!resolved) continue;

    const templateTargets = templatesUsedByPhpFile.get(resolved.filePath);
    if (!templateTargets || templateTargets.size === 0) continue;

    for (const templateId of templateTargets) {
      const relId = generateId('CALLS', `${pending.sourceId}:laravel-mail-send-mailable->${templateId}`);
      graph.addRelationship({
        id: relId,
        type: 'CALLS',
        sourceId: pending.sourceId,
        targetId: templateId,
        confidence: resolved.confidence,
        reason: `laravel-mail-send-mailable:${resolved.reason}`,
      });
      mailEdgesAdded++;
    }
  }

  return { viewEdgesAdded, mailEdgesAdded };
};
