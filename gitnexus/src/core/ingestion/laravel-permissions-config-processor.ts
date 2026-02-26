import Parser from 'tree-sitter';
import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import { SymbolTable, SymbolDefinition } from './symbol-table.js';
import { ImportMap, PhpUseAliasMap, expandPhpClassRefFromUseAliases } from './import-processor.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename, getParseableContent, yieldToEventLoop } from './utils.js';
import { loadLanguage, loadParser } from '../tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../config/supported-languages.js';

type ResolvedEnum = {
  baseName: string;
  filePath: string;
  confidence: number;
  reason: string;
};

type ParsedClassConst = {
  kind: 'const';
  classRef: string;
  constant: string;
};

type EnumCaseValueInfo = {
  value: string;
  startLine: number;
  endLine: number;
};

const PERMISSIONS_CONFIG_PATH_RE = /(^|\/)config\/permissions\.php$/i;

const looksLikePhpIdentifier = (value: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);

const normalizePhpClassRef = (value: string): { baseName: string; parts: string[] } => {
  const trimmed = value.trim().replace(/^\\+/, '');
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  const baseName = parts.at(-1) ?? '';
  return { baseName, parts };
};

const resolvePhpEnumToFile = (
  enumRef: string,
  currentFilePath: string,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): ResolvedEnum | null => {
  const expandedRef = expandPhpClassRefFromUseAliases(enumRef, currentFilePath, phpUseAliases);
  const { baseName, parts } = normalizePhpClassRef(expandedRef);
  if (!looksLikePhpIdentifier(baseName)) return null;

  const enumDefs = symbolTable
    .lookupFuzzy(baseName)
    .filter((def: SymbolDefinition) => def.type === 'Enum');

  if (enumDefs.length === 0) return null;

  const importedFiles = importMap.get(currentFilePath);
  if (importedFiles) {
    const importedMatches = enumDefs.filter(def => importedFiles.has(def.filePath));
    if (importedMatches.length === 1) {
      return { baseName, filePath: importedMatches[0].filePath, confidence: 0.95, reason: 'import-resolved' };
    }
  }

  if (parts.length > 1) {
    const suffixes = new Set<string>();
    suffixes.add(`${parts.join('/')}.php`);
    suffixes.add(`${parts.slice(1).join('/')}.php`);

    const suffixMatches = enumDefs.filter(def => {
      for (const suffix of suffixes) {
        const normalizedSuffix = suffix.replace(/^\/+/, '');
        if (!normalizedSuffix) continue;
        if (def.filePath === normalizedSuffix) return true;
        if (def.filePath.endsWith('/' + normalizedSuffix)) return true;
      }
      return false;
    });
    if (suffixMatches.length === 1) {
      return { baseName, filePath: suffixMatches[0].filePath, confidence: 0.9, reason: 'namespace-suffix' };
    }
  }

  if (enumDefs.length === 1) {
    return { baseName, filePath: enumDefs[0].filePath, confidence: 0.65, reason: 'fuzzy-global' };
  }

  return null;
};

const walkNodes = (node: any, fn: (n: any) => void) => {
  fn(node);
  for (let i = 0; i < node.namedChildCount; i++) walkNodes(node.namedChild(i), fn);
};

const parsePhpStringLiteral = (node: any): string | null => {
  if (!node || node.type !== 'string') return null;
  const text = String(node.text || '').trim();
  if (text.length < 2) return null;
  const quote = text[0];
  if ((quote !== '\'' && quote !== '"') || text[text.length - 1] !== quote) return null;
  return text.slice(1, -1);
};

const isArrayKeyValueInitializer = (node: any): boolean => {
  if (!node || node.type !== 'array_element_initializer') return false;
  return (node.children || []).some((c: any) => c.type === '=>');
};

const getArrayInitializerKey = (node: any): any | null => {
  if (!isArrayKeyValueInitializer(node)) return null;
  return node.namedChildren?.[0] ?? null;
};

const getArrayInitializerValue = (node: any): any | null => {
  if (!isArrayKeyValueInitializer(node)) return null;
  return node.namedChildren?.[1] ?? null;
};

const findArrayValueByStringKey = (arrayNode: any, key: string): any | null => {
  if (!arrayNode || arrayNode.type !== 'array_creation_expression') return null;

  for (const initializer of arrayNode.namedChildren || []) {
    if (initializer.type !== 'array_element_initializer') continue;
    if (!isArrayKeyValueInitializer(initializer)) continue;

    const keyNode = getArrayInitializerKey(initializer);
    const valueNode = getArrayInitializerValue(initializer);
    const keyText = parsePhpStringLiteral(keyNode);
    if (!keyText || keyText !== key) continue;
    return valueNode || null;
  }

  return null;
};

const parsePhpClassConstAccess = (node: any): ParsedClassConst | null => {
  if (!node || node.type !== 'class_constant_access_expression') return null;

  const raw = String(node.text || '').trim().replace(/^\\+/, '');
  const [classPart, constPart] = raw.split('::');
  const classRef = classPart?.trim();
  const constant = constPart?.trim();
  if (!classRef || !constant) return null;
  if (constant.toLowerCase() === 'class') return null;

  return { kind: 'const', classRef, constant };
};

const getArrayElementExpression = (initializer: any): any | null => {
  if (!initializer || initializer.type !== 'array_element_initializer') return null;
  if (isArrayKeyValueInitializer(initializer)) return getArrayInitializerValue(initializer);
  return initializer.namedChildren?.[0] ?? null;
};

const extractEnumCaseNamesFromTree = (tree: Parser.Tree): string[] => {
  const names: string[] = [];

  walkNodes(tree.rootNode, (node: any) => {
    if (node.type !== 'enum_case') return;
    const nameNode = node.childForFieldName?.('name');
    const name = nameNode?.text?.trim();
    if (name) names.push(name);
  });

  return Array.from(new Set(names));
};

const extractEnumCaseValueMapFromTree = (tree: Parser.Tree): Map<string, EnumCaseValueInfo> => {
  const values = new Map<string, EnumCaseValueInfo>();

  walkNodes(tree.rootNode, (node: any) => {
    if (node.type !== 'enum_case') return;

    const nameNode = node.childForFieldName?.('name');
    const valueNode = node.childForFieldName?.('value');
    const name = nameNode?.text?.trim();
    if (!name) return;

    const parsed = parsePhpStringLiteral(valueNode);
    if (!parsed) return;

    values.set(name, {
      value: parsed,
      startLine: valueNode?.startPosition?.row ?? node.startPosition?.row ?? -1,
      endLine: valueNode?.endPosition?.row ?? node.endPosition?.row ?? -1,
    });
  });

  return values;
};

const extractPermissionSpecsFromArray = (permissionsArrayNode: any): Array<ParsedClassConst | { kind: 'all_except'; classRef: string; except: ParsedClassConst[] }> => {
  const specs: Array<ParsedClassConst | { kind: 'all_except'; classRef: string; except: ParsedClassConst[] }> = [];
  if (!permissionsArrayNode || permissionsArrayNode.type !== 'array_creation_expression') return specs;

  for (const initializer of permissionsArrayNode.namedChildren || []) {
    if (initializer.type !== 'array_element_initializer') continue;
    const expr = getArrayElementExpression(initializer);
    if (!expr) continue;

    if (expr.type === 'class_constant_access_expression') {
      const parsed = parsePhpClassConstAccess(expr);
      if (parsed) specs.push(parsed);
      continue;
    }

    if (expr.type === 'variadic_unpacking') {
      const inner = expr.namedChildren?.[0];
      if (!inner || inner.type !== 'scoped_call_expression') continue;

      const scopeNode = inner.childForFieldName?.('scope');
      const nameNode = inner.childForFieldName?.('name');
      const argsNode = inner.childForFieldName?.('arguments');
      const scope = scopeNode?.text?.trim();
      const fnName = nameNode?.text?.trim();
      if (!scope || !fnName) continue;

      if (fnName !== 'allExcept') continue;
      const firstArg = argsNode?.namedChildren?.find((n: any) => n.type === 'argument')?.namedChildren?.at(-1)
        || argsNode?.namedChildren?.at(0)
        || null;
      if (!firstArg || firstArg.type !== 'array_creation_expression') continue;

      const except: ParsedClassConst[] = [];
      for (const exceptInit of firstArg.namedChildren || []) {
        if (exceptInit.type !== 'array_element_initializer') continue;
        const exceptExpr = getArrayElementExpression(exceptInit);
        if (!exceptExpr) continue;
        const parsed = parsePhpClassConstAccess(exceptExpr);
        if (!parsed) continue;
        except.push(parsed);
      }

      specs.push({ kind: 'all_except', classRef: scope, except });
    }
  }

  return specs;
};

export const processLaravelPermissionsConfig = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): Promise<{ edgesAdded: number; nodesAdded: number }> => {
  const parser = await loadParser();
  const fileContents = new Map<string, string>();
  for (const file of files) fileContents.set(file.path, file.content);

  const enumCaseCache = new Map<string, string[]>();
  const enumCaseValueCache = new Map<string, Map<string, EnumCaseValueInfo>>();
  const addedNodeIds = new Set<string>();
  const addedRelationshipIds = new Set<string>();

  const addRelationshipOnce = (relationship: { id: string; type: string; sourceId: string; targetId: string; confidence: number; reason: string; }): boolean => {
    if (addedRelationshipIds.has(relationship.id)) return false;
    addedRelationshipIds.add(relationship.id);
    graph.addRelationship(relationship as any);
    return true;
  };

  const getEnumCaseNames = async (filePath: string): Promise<string[] | null> => {
    if (enumCaseCache.has(filePath)) return enumCaseCache.get(filePath) ?? null;

    const content = fileContents.get(filePath);
    if (!content) {
      enumCaseCache.set(filePath, []);
      return null;
    }

    await loadLanguage(SupportedLanguages.PHP, filePath);

    let tree = astCache.get(filePath);
    if (!tree) {
      try {
        const parseable = getParseableContent(filePath, content);
        tree = parser.parse(parseable, undefined, { bufferSize: 1024 * 256 });
        astCache.set(filePath, tree);
      } catch {
        enumCaseCache.set(filePath, []);
        return null;
      }
    }

    const names = extractEnumCaseNamesFromTree(tree);
    enumCaseCache.set(filePath, names);
    return names;
  };

  const getEnumCaseValueMap = async (filePath: string): Promise<Map<string, EnumCaseValueInfo> | null> => {
    if (enumCaseValueCache.has(filePath)) return enumCaseValueCache.get(filePath) ?? null;

    const content = fileContents.get(filePath);
    if (!content) {
      const empty = new Map<string, EnumCaseValueInfo>();
      enumCaseValueCache.set(filePath, empty);
      return null;
    }

    await loadLanguage(SupportedLanguages.PHP, filePath);

    let tree = astCache.get(filePath);
    if (!tree) {
      try {
        const parseable = getParseableContent(filePath, content);
        tree = parser.parse(parseable, undefined, { bufferSize: 1024 * 256 });
        astCache.set(filePath, tree);
      } catch {
        const empty = new Map<string, EnumCaseValueInfo>();
        enumCaseValueCache.set(filePath, empty);
        return null;
      }
    }

    const map = extractEnumCaseValueMapFromTree(tree);
    enumCaseValueCache.set(filePath, map);
    return map.size > 0 ? map : null;
  };

  const addPermissionSlugEdges = async (
    sourceRoleId: string,
    enumFilePath: string,
    roleEdgeConfidence: number,
    constNodeId: string,
    constName: string,
  ): Promise<void> => {
    const map = await getEnumCaseValueMap(enumFilePath);
    const info = map?.get(constName);
    const slug = info?.value?.trim();
    if (!slug) return;

    const slugNodeId = generateId('CodeElement', `permission:${slug}`);
    if (!addedNodeIds.has(slugNodeId)) {
      addedNodeIds.add(slugNodeId);
      graph.addNode({
        id: slugNodeId,
        label: 'CodeElement',
        properties: {
          name: slug,
          filePath: enumFilePath,
          startLine: info?.startLine ?? -1,
          endLine: info?.endLine ?? -1,
          isExported: true,
        }
      });
      nodesAdded++;

      const enumFileId = generateId('File', enumFilePath);
      const definesId = generateId('DEFINES', `${enumFileId}->${slugNodeId}`);
      addRelationshipOnce({
        id: definesId,
        type: 'DEFINES',
        sourceId: enumFileId,
        targetId: slugNodeId,
        confidence: 1.0,
        reason: '',
      });
    }

    const enumToSlugReason = `laravel-permission-slug:${slug}`;
    const enumToSlugId = generateId('CALLS', `${constNodeId}:${enumToSlugReason}->${slugNodeId}`);
    if (addRelationshipOnce({
      id: enumToSlugId,
      type: 'CALLS',
      sourceId: constNodeId,
      targetId: slugNodeId,
      confidence: 1.0,
      reason: enumToSlugReason,
    })) {
      edgesAdded++;
    }

    const roleToSlugReason = `laravel-role-permission-slug:${slug}`;
    const roleToSlugId = generateId('CALLS', `${sourceRoleId}:${roleToSlugReason}->${slugNodeId}`);
    if (addRelationshipOnce({
      id: roleToSlugId,
      type: 'CALLS',
      sourceId: sourceRoleId,
      targetId: slugNodeId,
      confidence: roleEdgeConfidence,
      reason: roleToSlugReason,
    })) {
      edgesAdded++;
    }
  };

  let edgesAdded = 0;
  let nodesAdded = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (i % 200 === 0) await yieldToEventLoop();

    if (!PERMISSIONS_CONFIG_PATH_RE.test(file.path)) continue;

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

    let rootArray: any | null = null;
    walkNodes(tree.rootNode, (node: any) => {
      if (rootArray) return;
      if (node.type !== 'return_statement') return;
      const arrayNode = node.namedChildren?.find((n: any) => n.type === 'array_creation_expression') || null;
      if (arrayNode) rootArray = arrayNode;
    });
    if (!rootArray) continue;

    const rolesArray = findArrayValueByStringKey(rootArray, 'roles');
    if (!rolesArray || rolesArray.type !== 'array_creation_expression') continue;

    for (const initializer of rolesArray.namedChildren || []) {
      if (initializer.type !== 'array_element_initializer') continue;
      if (!isArrayKeyValueInitializer(initializer)) continue;

      const roleKeyNode = getArrayInitializerKey(initializer);
      const roleSlug = parsePhpStringLiteral(roleKeyNode);
      if (!roleSlug) continue;

      const roleConfigNode = getArrayInitializerValue(initializer);
      if (!roleConfigNode || roleConfigNode.type !== 'array_creation_expression') continue;

      const permissionsNode = findArrayValueByStringKey(roleConfigNode, 'permissions');
      if (!permissionsNode || permissionsNode.type !== 'array_creation_expression') continue;

      const roleNodeName = `role:${roleSlug}`;
      const roleNodeId = generateId('CodeElement', `${file.path}:${roleNodeName}`);
      if (!addedNodeIds.has(roleNodeId)) {
        addedNodeIds.add(roleNodeId);
        graph.addNode({
          id: roleNodeId,
          label: 'CodeElement',
          properties: {
            name: roleNodeName,
            filePath: file.path,
            startLine: roleKeyNode?.startPosition?.row ?? -1,
            endLine: roleKeyNode?.endPosition?.row ?? -1,
            isExported: false,
          }
        });
        nodesAdded++;
      }

      const fileId = generateId('File', file.path);
      const definesId = generateId('DEFINES', `${fileId}->${roleNodeId}`);
      addRelationshipOnce({
        id: definesId,
        type: 'DEFINES',
        sourceId: fileId,
        targetId: roleNodeId,
        confidence: 1.0,
        reason: '',
      });

      const specs = extractPermissionSpecsFromArray(permissionsNode);

      for (const spec of specs) {
        if (spec.kind === 'all_except') {
          const resolved = resolvePhpEnumToFile(spec.classRef, file.path, symbolTable, importMap, phpUseAliases);
          if (!resolved || resolved.confidence < 0.9) continue;

          const allCases = await getEnumCaseNames(resolved.filePath);
          if (!allCases || allCases.length === 0) continue;

          const excluded = new Set<string>();
          for (const ex of spec.except) excluded.add(ex.constant);

          const allowedCases = allCases.filter(name => name !== 'ALL' && !excluded.has(name));
          if (allowedCases.length === 0) continue;

          for (const caseName of allowedCases) {
            const defs = symbolTable.lookupFuzzy(caseName).filter(def => def.filePath === resolved.filePath && def.type === 'Const');
            if (defs.length !== 1) continue;
            const targetId = defs[0].nodeId;

            const reason = `laravel-role-permission:${resolved.baseName}::${caseName}`;
            const relId = generateId('CALLS', `${roleNodeId}:${reason}->${targetId}`);
            const edgeConfidence = Math.min(resolved.confidence, 0.9);
            if (addRelationshipOnce({
              id: relId,
              type: 'CALLS',
              sourceId: roleNodeId,
              targetId,
              confidence: edgeConfidence,
              reason,
            })) {
              edgesAdded++;
            }

            await addPermissionSlugEdges(roleNodeId, resolved.filePath, edgeConfidence, targetId, caseName);
          }

          continue;
        }

        const resolved = resolvePhpEnumToFile(spec.classRef, file.path, symbolTable, importMap, phpUseAliases);
        if (!resolved || resolved.confidence < 0.9) continue;

        if (spec.constant === 'ALL') {
          const allCases = await getEnumCaseNames(resolved.filePath);
          if (!allCases || allCases.length === 0) continue;

          const expanded = allCases.filter(name => name !== 'ALL');
          if (expanded.length === 0) continue;

          for (const caseName of expanded) {
            const defs = symbolTable.lookupFuzzy(caseName).filter(def => def.filePath === resolved.filePath && def.type === 'Const');
            if (defs.length !== 1) continue;
            const targetId = defs[0].nodeId;

            const reason = `laravel-role-permission:${resolved.baseName}::${caseName}`;
            const relId = generateId('CALLS', `${roleNodeId}:${reason}->${targetId}`);
            const edgeConfidence = Math.min(resolved.confidence, 0.9);
            if (addRelationshipOnce({
              id: relId,
              type: 'CALLS',
              sourceId: roleNodeId,
              targetId,
              confidence: edgeConfidence,
              reason,
            })) {
              edgesAdded++;
            }

            await addPermissionSlugEdges(roleNodeId, resolved.filePath, edgeConfidence, targetId, caseName);
          }

          continue;
        }

        const defs = symbolTable.lookupFuzzy(spec.constant).filter(def => def.filePath === resolved.filePath && def.type === 'Const');
        if (defs.length !== 1) continue;

        const targetId = defs[0].nodeId;
        const reason = `laravel-role-permission:${resolved.baseName}::${spec.constant}`;
        const relId = generateId('CALLS', `${roleNodeId}:${reason}->${targetId}`);
        const edgeConfidence = Math.min(resolved.confidence, 0.95);
        if (addRelationshipOnce({
          id: relId,
          type: 'CALLS',
          sourceId: roleNodeId,
          targetId,
          confidence: edgeConfidence,
          reason,
        })) {
          edgesAdded++;
        }

        await addPermissionSlugEdges(roleNodeId, resolved.filePath, edgeConfidence, targetId, spec.constant);
      }
    }
  }

  return { edgesAdded, nodesAdded };
};
