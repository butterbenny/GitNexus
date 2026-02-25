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

type NotificationCallKind = 'notify' | 'notify-route' | 'send' | 'send-now';

type ExtractedNotificationCall = {
  callNode: any;
  kind: NotificationCallKind;
  classRef: string;
};

type ExtractedViaChannels = {
  strings: Set<string>;
  classRefs: Set<string>;
};

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

  const notificationHeuristic = classDefs.filter(def => {
    return def.filePath.includes('/Notifications/') || def.filePath.endsWith('Notification.php');
  });
  if (notificationHeuristic.length === 1) {
    return { filePath: notificationHeuristic[0].filePath, confidence: 0.8, reason: 'notification-heuristic' };
  }

  if (classDefs.length === 1) {
    return { filePath: classDefs[0].filePath, confidence: 0.65, reason: 'fuzzy-class' };
  }

  return null;
};

const parseClassRefFromNotificationArg = (argNode: any): string | null => {
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

const getScopeBaseName = (value: string): string => {
  const trimmed = value.trim().replace(/^\\+/, '');
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? trimmed;
};

const NOTIFICATION_FACADE_BASE_NAMES = new Set(['Notification', 'NotificationFacade']);

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

const unwrapChainedCallObject = (node: any): any | null => {
  let current = node;

  while (current) {
    if (current.type === 'member_call_expression') {
      current = current.childForFieldName?.('object') || null;
      continue;
    }
    if (current.type === 'parenthesized_expression') {
      current = current.namedChildren?.at(0) || null;
      continue;
    }
    return current;
  }

  return null;
};

const isNotificationRouteBuilder = (node: any): boolean => {
  const base = unwrapChainedCallObject(node);
  if (!base || base.type !== 'scoped_call_expression') return false;

  const scopeNode = base.childForFieldName?.('scope');
  const methodNode = base.childForFieldName?.('name');
  const scopeText = scopeNode?.text?.trim();
  const methodName = methodNode?.text?.trim();
  if (!scopeText || !methodName) return false;

  const baseScope = getScopeBaseName(scopeText);
  return NOTIFICATION_FACADE_BASE_NAMES.has(baseScope) && methodName === 'route';
};

const extractNotificationCallsFromTree = (tree: Parser.Tree): ExtractedNotificationCall[] => {
  const calls: ExtractedNotificationCall[] = [];

  const visit = (node: any) => {
    if (!node) return;

    if (node.type === 'member_call_expression') {
      const methodNode = node.childForFieldName?.('name');
      const methodName = methodNode?.text?.trim();
      if (methodName === 'notify' || methodName === 'notifyNow') {
        const argsNode = node.childForFieldName?.('arguments');
        const args = getCallArgumentExpressions(argsNode);
        const classRef = parseClassRefFromNotificationArg(args[0]);
        if (classRef) {
          const objectNode = node.childForFieldName?.('object');
          const kind: NotificationCallKind = isNotificationRouteBuilder(objectNode) ? 'notify-route' : 'notify';
          calls.push({ callNode: node, kind, classRef });
        }
      }
    }

    if (node.type === 'scoped_call_expression') {
      const scopeNode = node.childForFieldName?.('scope');
      const methodNode = node.childForFieldName?.('name');
      const scopeText = scopeNode?.text?.trim();
      const methodName = methodNode?.text?.trim();
      if (scopeText && methodName && (methodName === 'send' || methodName === 'sendNow')) {
        const baseScope = getScopeBaseName(scopeText);
        if (NOTIFICATION_FACADE_BASE_NAMES.has(baseScope)) {
          const argsNode = node.childForFieldName?.('arguments');
          const args = getCallArgumentExpressions(argsNode);
          const classRef = parseClassRefFromNotificationArg(args.at(-1));
          if (classRef) {
            calls.push({ callNode: node, kind: methodName === 'sendNow' ? 'send-now' : 'send', classRef });
          }
        }
      }
    }

    for (const child of node.namedChildren || []) visit(child);
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

const walkNodes = (node: any, fn: (n: any) => void) => {
  fn(node);
  for (let i = 0; i < node.namedChildCount; i++) walkNodes(node.namedChild(i), fn);
};

const extractStringContent = (node: any): string | null => {
  if (!node) return null;
  if (node.type === 'string_content') return node.text ?? null;

  const queue = [node];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    if (current.type === 'string_content') return current.text ?? null;
    for (let i = 0; i < current.namedChildCount; i++) queue.push(current.namedChild(i));
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

const extractViaChannelsFromArrayExpression = (arrayNode: any): ExtractedViaChannels => {
  const strings = new Set<string>();
  const classRefs = new Set<string>();

  if (!arrayNode || arrayNode.type !== 'array_creation_expression') return { strings, classRefs };

  const entries = arrayNode.namedChildren?.filter((c: any) => c.type === 'array_element_initializer') || [];
  for (const entry of entries) {
    const expr = entry.namedChildren?.at(-1);
    if (!expr) continue;

    if (expr.type === 'string') {
      const raw = extractStringContent(expr);
      const value = raw?.trim();
      if (value) strings.add(value.toLowerCase());
      continue;
    }

    if (expr.type === 'class_constant_access_expression') {
      const raw = stripPhpClassConstant(expr.text ?? '').trim();
      if (raw) classRefs.add(raw);
    }
  }

  return { strings, classRefs };
};

const extractViaChannelsFromTree = (tree: Parser.Tree): ExtractedViaChannels => {
  const strings = new Set<string>();
  const classRefs = new Set<string>();

  const methods: any[] = [];
  walkNodes(tree.rootNode, (node: any) => {
    if (node.type === 'method_declaration') methods.push(node);
  });

  for (const method of methods) {
    if (getMethodName(method) !== 'via') continue;

    const bodyNode = getMethodBodyNode(method);
    if (!bodyNode) continue;

    walkNodes(bodyNode, (node: any) => {
      if (node.type !== 'return_statement') return;
      const expr = node.namedChildren?.at(0);
      if (!expr || expr.type !== 'array_creation_expression') return;

      const extracted = extractViaChannelsFromArrayExpression(expr);
      extracted.strings.forEach(v => strings.add(v));
      extracted.classRefs.forEach(v => classRefs.add(v));
    });
  }

  return { strings, classRefs };
};

const CHANNEL_TO_METHODS: Record<string, string[]> = {
  mail: ['toMail'],
  slack: ['toSlack'],
  database: ['toDatabase', 'toArray'],
  broadcast: ['toBroadcast', 'toArray'],
  array: ['toArray'],
  vonage: ['toVonage', 'toNexmo'],
  nexmo: ['toNexmo', 'toVonage'],
  twilio: ['toTwilio'],
};

const CHANNEL_CLASS_BASE_TO_METHODS: Record<string, string[]> = {
  mailchannel: ['toMail'],
  slackchannel: ['toSlack'],
  databasechannel: ['toDatabase', 'toArray'],
  broadcastchannel: ['toBroadcast', 'toArray'],
  twiliochannel: ['toTwilio'],
  vonagechannel: ['toVonage', 'toNexmo'],
  nexmochannel: ['toNexmo', 'toVonage'],
};

const inferNotificationMethodsFromChannelBaseName = (baseName: string): string[] => {
  const key = baseName.trim().toLowerCase();
  if (!key) return [];
  return CHANNEL_CLASS_BASE_TO_METHODS[key] || [];
};

const METHOD_TO_REASON_SUFFIX: Record<string, string> = {
  via: 'via',
  toMail: 'to-mail',
  toSlack: 'to-slack',
  toDatabase: 'to-database',
  toBroadcast: 'to-broadcast',
  toArray: 'to-array',
  toVonage: 'to-vonage',
  toNexmo: 'to-nexmo',
  toTwilio: 'to-twilio',
};

const toKebabCase = (value: string): string => {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
};

const extractChannelNotificationParamNameFromSendMethod = (methodNode: any): string | null => {
  const paramsNode = methodNode?.childForFieldName?.('parameters');
  if (!paramsNode) return null;

  const params = (paramsNode.namedChildren || []).filter((c: any) => c.type === 'simple_parameter');

  for (const param of params) {
    const name = param.childForFieldName?.('name')?.text?.trim();
    if (name === '$notification') return name;
  }

  for (const param of params) {
    const typeText = param.childForFieldName?.('type')?.text?.trim();
    const typeBase = typeText ? getScopeBaseName(typeText) : '';
    if (typeBase === 'Notification') {
      const name = param.childForFieldName?.('name')?.text?.trim();
      if (name) return name;
    }
  }

  const last = params.at(-1);
  const lastName = last?.childForFieldName?.('name')?.text?.trim();
  return lastName || null;
};

const extractNotificationMethodNamesFromChannelTree = (tree: Parser.Tree): Set<string> => {
  const methods = new Set<string>();

  const classes: any[] = [];
  const sendMethods: any[] = [];
  walkNodes(tree.rootNode, (node: any) => {
    if (node.type === 'class_declaration') classes.push(node);
    if (node.type === 'method_declaration' && getMethodName(node) === 'send') sendMethods.push(node);
  });

  for (const cls of classes) {
    const baseClause = cls.namedChildren?.find((c: any) => c.type === 'base_clause');
    const baseNameNode = baseClause?.namedChildren?.find((c: any) => c.type === 'name' || c.type === 'qualified_name');
    const baseNameText = baseNameNode?.text?.trim();
    const baseName = baseNameText ? getScopeBaseName(baseNameText) : '';
    if (baseName) inferNotificationMethodsFromChannelBaseName(baseName).forEach(m => methods.add(m));
  }

  for (const sendMethod of sendMethods) {
    const notificationVar = extractChannelNotificationParamNameFromSendMethod(sendMethod);
    if (!notificationVar) continue;

    const bodyNode = getMethodBodyNode(sendMethod);
    if (!bodyNode) continue;

    walkNodes(bodyNode, (node: any) => {
      if (node.type !== 'member_call_expression' && node.type !== 'nullsafe_member_call_expression') return;
      const objectNode = node.childForFieldName?.('object');
      const nameNode = node.childForFieldName?.('name');
      const methodName = nameNode?.text?.trim();
      if (!objectNode || !methodName) return;
      if (!methodName.startsWith('to')) return;
      if (!looksLikePhpIdentifier(methodName)) return;

      const objectText = objectNode.text?.trim();
      if (objectText === notificationVar) methods.add(methodName);
    });
  }

  return methods;
};

const isNotificationRelevantFile = (filePath: string, content: string): boolean => {
  const lang = getLanguageFromFilename(filePath);
  if (lang !== SupportedLanguages.PHP) return false;
  // Cheap prefilter before parsing.
  return /\bnotify(?:Now)?\s*\(\s*new\b|\bNotification(?:Facade)?\s*::\s*send(?:Now)?\b|\bNotification(?:Facade)?\s*::\s*route\b/.test(content);
};

export const processLaravelNotifications = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): Promise<{ edgesAdded: number }> => {
  const parser = await loadParser();
  await loadLanguage(SupportedLanguages.PHP);

  const fileByPath = new Map<string, { path: string; content: string }>();
  for (const file of files) fileByPath.set(file.path, file);

  const viaChannelsCache = new Map<string, ExtractedViaChannels>();
  const channelMethodsCache = new Map<string, Set<string>>();

  let edgesAdded = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (i % 200 === 0) await yieldToEventLoop();

    if (!isNotificationRelevantFile(file.path, file.content)) continue;

    let tree = astCache.get(file.path);
    if (!tree) {
      try {
        tree = parser.parse(file.content, undefined, { bufferSize: 1024 * 256 });
        astCache.set(file.path, tree);
      } catch {
        continue;
      }
    }

    const notifyCalls = extractNotificationCallsFromTree(tree);
    if (notifyCalls.length === 0) continue;

    for (const call of notifyCalls) {
      const resolved = resolvePhpClassToFile(call.classRef, file.path, symbolTable, importMap, phpUseAliases);
      if (!resolved) continue;

      const sourceId = findEnclosingPhpCallableId(call.callNode, file.path, symbolTable);

      const viaMethodId = symbolTable.lookupExact(resolved.filePath, 'via');
      if (viaMethodId) {
        const reason = `laravel-notify-${call.kind}-via-${resolved.reason}`;
        const relId = generateId('CALLS', `${sourceId}:${reason}->${viaMethodId}`);
        graph.addRelationship({
          id: relId,
          type: 'CALLS',
          sourceId,
          targetId: viaMethodId,
          confidence: resolved.confidence,
          reason,
        });
        edgesAdded++;
      }

      let viaChannels = viaChannelsCache.get(resolved.filePath);
      if (!viaChannels) {
        const notificationFile = fileByPath.get(resolved.filePath);
        if (!notificationFile) {
          viaChannels = { strings: new Set<string>(), classRefs: new Set<string>() };
        } else {
          let notificationTree = astCache.get(resolved.filePath);
          if (!notificationTree) {
            try {
              notificationTree = parser.parse(notificationFile.content, undefined, { bufferSize: 1024 * 256 });
              astCache.set(resolved.filePath, notificationTree);
            } catch {
              notificationTree = null;
            }
          }

          viaChannels = notificationTree ? extractViaChannelsFromTree(notificationTree) : { strings: new Set<string>(), classRefs: new Set<string>() };
        }
        viaChannelsCache.set(resolved.filePath, viaChannels);
      }

      for (const channel of viaChannels.strings) {
        const methodNames = CHANNEL_TO_METHODS[channel];
        if (!methodNames) continue;

        for (const methodName of methodNames) {
          const targetId = symbolTable.lookupExact(resolved.filePath, methodName);
          if (!targetId) continue;

          const suffix = METHOD_TO_REASON_SUFFIX[methodName] || methodName.toLowerCase();
          const reason = `laravel-notify-${call.kind}-${suffix}-${resolved.reason}`;
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
        }
      }

      for (const channelClassRef of viaChannels.classRefs) {
        const channelBaseName = normalizePhpClassRef(channelClassRef).baseName;
        const inferredFromClassRef = inferNotificationMethodsFromChannelBaseName(channelBaseName);

        const channelMethods = new Set<string>();
        inferredFromClassRef.forEach(m => channelMethods.add(m));

        const channelResolved = resolvePhpClassToFile(channelClassRef, resolved.filePath, symbolTable, importMap, phpUseAliases);
        if (channelResolved) {
          let cached = channelMethodsCache.get(channelResolved.filePath);
          if (!cached) {
            const channelFile = fileByPath.get(channelResolved.filePath);
            if (!channelFile) {
              cached = new Set<string>();
            } else {
              let channelTree = astCache.get(channelResolved.filePath);
              if (!channelTree) {
                try {
                  channelTree = parser.parse(channelFile.content, undefined, { bufferSize: 1024 * 256 });
                  astCache.set(channelResolved.filePath, channelTree);
                } catch {
                  channelTree = null;
                }
              }
              cached = channelTree ? extractNotificationMethodNamesFromChannelTree(channelTree) : new Set<string>();
            }
            channelMethodsCache.set(channelResolved.filePath, cached);
          }
          cached.forEach(m => channelMethods.add(m));
        }

        if (channelMethods.size === 0) continue;

        const channelConfidence = channelResolved?.confidence ?? (inferredFromClassRef.length > 0 ? 0.85 : 0);
        const confidence = channelConfidence > 0 ? Math.min(resolved.confidence, channelConfidence) : resolved.confidence;

        for (const methodName of channelMethods) {
          const targetId = symbolTable.lookupExact(resolved.filePath, methodName);
          if (!targetId) continue;

          const suffix = METHOD_TO_REASON_SUFFIX[methodName] || toKebabCase(methodName);
          const reason = `laravel-notify-${call.kind}-${suffix}-${resolved.reason}`;
          const relId = generateId('CALLS', `${sourceId}:${reason}->${targetId}`);
          graph.addRelationship({
            id: relId,
            type: 'CALLS',
            sourceId,
            targetId,
            confidence,
            reason,
          });
          edgesAdded++;
        }
      }
    }
  }

  return { edgesAdded };
};
