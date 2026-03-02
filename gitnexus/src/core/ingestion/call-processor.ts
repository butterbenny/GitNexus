import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import { SymbolTable } from './symbol-table.js';
import { expandPhpClassRefFromUseAliases, ImportMap, PhpUseAliasMap } from './import-processor.js';
import Parser from 'tree-sitter';
import { loadParser, loadLanguage } from '../tree-sitter/parser-loader.js';
import { LANGUAGE_QUERIES } from './tree-sitter-queries.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename, getParseableContent, yieldToEventLoop } from './utils.js';
import type { ExtractedCall, ExtractedPhpAssignment, ExtractedPhpTraitUse } from './workers/parse-worker.js';
import { SupportedLanguages } from '../../config/supported-languages.js';

/**
 * Node types that represent function/method definitions across languages.
 * Used to find the enclosing function for a call site.
 */
const FUNCTION_NODE_TYPES = new Set([
  // TypeScript/JavaScript
  'function_declaration',
  'arrow_function',
  'function_expression',
  'method_definition',
  'generator_function_declaration',
  // Python
  'function_definition',
  // Common async variants
  'async_function_declaration',
  'async_arrow_function',
  // Java
  'method_declaration',
  'constructor_declaration',
  // C/C++
  // 'function_definition' already included above
  // Go
  // 'method_declaration' already included from Java
  // C#
  'local_function_statement',
  // Rust
  'function_item',
  'impl_item', // Methods inside impl blocks
]);

/**
 * Walk up the AST from a node to find the enclosing function/method.
 * Returns null if the call is at module/file level (top-level code).
 */
const findEnclosingFunction = (
  node: any,
  filePath: string,
  symbolTable: SymbolTable
): string | null => {
  let current = node.parent;
  
  while (current) {
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      // Found enclosing function - try to get its name
      let funcName: string | null = null;
      let label = 'Function';
      
      // Different node types have different name locations
      if (current.type === 'function_declaration' || 
          current.type === 'function_definition' ||
          current.type === 'async_function_declaration' ||
          current.type === 'generator_function_declaration' ||
          current.type === 'function_item') { // Rust function
        // Named function: function foo() {}
        const nameNode = current.childForFieldName?.('name') || 
                         current.children?.find((c: any) => c.type === 'identifier' || c.type === 'property_identifier');
        funcName = nameNode?.text;
      } else if (current.type === 'impl_item') {
        // Rust method inside impl block: wrapper around function_item or const_item
        // We need to look inside for the function_item
        const funcItem = current.children?.find((c: any) => c.type === 'function_item');
        if (funcItem) {
           const nameNode = funcItem.childForFieldName?.('name') || 
                            funcItem.children?.find((c: any) => c.type === 'identifier');
           funcName = nameNode?.text;
           label = 'Method';
        }
      } else if (current.type === 'method_definition') {
        // Method: foo() {} inside class (JS/TS)
        const nameNode = current.childForFieldName?.('name') ||
                         current.children?.find((c: any) => c.type === 'property_identifier');
        funcName = nameNode?.text;
        label = 'Method';
      } else if (current.type === 'method_declaration') {
        // Java method: public void foo() {}
        const nameNode = current.childForFieldName?.('name') ||
                         current.children?.find((c: any) => c.type === 'identifier');
        funcName = nameNode?.text;
        label = 'Method';
      } else if (current.type === 'constructor_declaration') {
        // Java constructor: public ClassName() {}
        const nameNode = current.childForFieldName?.('name') ||
                         current.children?.find((c: any) => c.type === 'identifier');
        funcName = nameNode?.text;
        label = 'Method'; // Treat constructors as methods for process detection
      } else if (current.type === 'arrow_function' || current.type === 'function_expression') {
        // Arrow/expression: const foo = () => {} - check parent variable declarator
        const parent = current.parent;
        if (parent?.type === 'variable_declarator') {
          const nameNode = parent.childForFieldName?.('name') ||
                           parent.children?.find((c: any) => c.type === 'identifier');
          funcName = nameNode?.text;
        }
      }
      
      if (funcName) {
        // Look up the function in symbol table to get its node ID
        // Try exact match first
        const nodeId = symbolTable.lookupExact(filePath, funcName);
        if (nodeId) return nodeId;
        
        // Try construct ID manually if lookup fails (common for non-exported internal functions)
        // Format should match what parsing-processor generates: "Function:path/to/file:funcName"
        // Check if we already have a node with this ID in the symbol table to be safe
        const generatedId = generateId(label, `${filePath}:${funcName}`);
        
        // Ideally we should verify this ID exists, but strictly speaking if we are inside it,
        // it SHOULD exist. Returning it is better than falling back to File.
        return generatedId;
      }
      
      // Couldn't determine function name - try parent (might be nested)
    }
    current = current.parent;
  }
  
  return null; // Top-level call (not inside any function)
};

export const processCalls = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
  onProgress?: (current: number, total: number) => void
) => {
  const parser = await loadParser();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress?.(i + 1, files.length);
    if (i % 20 === 0) await yieldToEventLoop();

    // 1. Check language support first
    const language = getLanguageFromFilename(file.path);
    if (!language) continue;

    const queryStr = LANGUAGE_QUERIES[language];
    if (!queryStr) continue;

    // 2. ALWAYS load the language before querying (parser is stateful)
    await loadLanguage(language, file.path);

    // 3. Get AST (Try Cache First)
    let tree = astCache.get(file.path);

    if (!tree) {
      // Cache Miss: Re-parse
      // Use larger bufferSize for files > 32KB
      try {
        const content = getParseableContent(file.path, file.content);
        tree = parser.parse(content, undefined, { bufferSize: 1024 * 256 });
      } catch (parseError) {
        // Skip files that can't be parsed
        continue;
      }
      // Cache re-parsed tree so heritage phase gets hits
      astCache.set(file.path, tree);
    }

    let query;
    let matches;
    try {
      const language = parser.getLanguage();
      query = new Parser.Query(language, queryStr);
      matches = query.matches(tree.rootNode);
    } catch (queryError) {
      console.warn(`Query error for ${file.path}:`, queryError);
      continue;
    }

    // 3. Process each call match
    const phpAssignmentIndex = language === SupportedLanguages.PHP
      ? buildPhpAssignmentIndex(extractPhpVarTypesFromTree(tree.rootNode, file.path))
      : null;

    matches.forEach(match => {
      const captureMap: Record<string, any> = {};
      match.captures.forEach(c => captureMap[c.name] = c.node);

      // Only process @call captures
      if (!captureMap['call']) return;

      const nameNode = captureMap['call.name'];
      if (!nameNode) return;

      const calledName = nameNode.text;

      // Skip common built-ins and noise (language-aware)
      if (isBuiltInOrNoise(calledName, language)) return;

      const callNode = captureMap['call'];

      // 4. Resolve the target using priority strategy (returns confidence)
      const resolved = language === SupportedLanguages.PHP
        ? resolvePhpCallTargetFromAst(
            callNode,
            calledName,
            file.path,
            symbolTable,
            importMap,
            phpUseAliases,
            phpAssignmentIndex,
          )
        : resolveCallTarget(
            calledName,
            file.path,
            symbolTable,
            importMap
          );

      if (!resolved) return;

      // 5. Find the enclosing function (caller)
      const enclosingFuncId = findEnclosingFunction(callNode, file.path, symbolTable);
      
      // Use enclosing function as source, fallback to file for top-level calls
      const sourceId = enclosingFuncId || generateId('File', file.path);
      
      const relId = generateId('CALLS', `${sourceId}:${calledName}->${resolved.nodeId}`);

      graph.addRelationship({
        id: relId,
        sourceId,
        targetId: resolved.nodeId,
        type: 'CALLS',
        confidence: resolved.confidence,
        reason: resolved.reason,
      });
    });

    // Tree is now owned by the LRU cache — no manual delete needed
  }
};

/**
 * Resolution result with confidence scoring
 */
interface ResolveResult {
  nodeId: string;
  confidence: number;  // 0-1: how sure are we?
  reason: string;      // 'import-resolved' | 'same-file' | 'fuzzy-global'
}

const isFuzzyGlobalLanguageCompatible = (
  fromLanguage: SupportedLanguages | null,
  toLanguage: SupportedLanguages | null,
): boolean => {
  if (!fromLanguage || !toLanguage) return false;
  if (fromLanguage === toLanguage) return true;

  // JS/TS projects frequently contain mixed .js/.ts/.tsx/.jsx.
  if (
    (fromLanguage === SupportedLanguages.JavaScript || fromLanguage === SupportedLanguages.TypeScript)
    && (toLanguage === SupportedLanguages.JavaScript || toLanguage === SupportedLanguages.TypeScript)
  ) {
    return true;
  }

  // C/C++ projects also commonly mix extensions and headers.
  if (
    (fromLanguage === SupportedLanguages.C || fromLanguage === SupportedLanguages.CPlusPlus)
    && (toLanguage === SupportedLanguages.C || toLanguage === SupportedLanguages.CPlusPlus)
  ) {
    return true;
  }

  return false;
};

const getMonorepoAppName = (filePath: string): string | null => {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized.startsWith('apps/')) return null;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return parts[1] || null;
};

const isFuzzyGlobalScopeCompatible = (fromFilePath: string, toFilePath: string): boolean => {
  const fromApp = getMonorepoAppName(fromFilePath);
  const toApp = getMonorepoAppName(toFilePath);
  if (!fromApp || !toApp) return true;
  return fromApp === toApp;
};

const isTestFilePath = (filePath: string): boolean => {
  const p = filePath.toLowerCase().replace(/\\/g, '/');
  return (
    p.includes('.test.') || p.includes('.spec.') ||
    p.startsWith('__tests__/') || p.includes('/__tests__/') ||
    p.startsWith('__mocks__/') || p.includes('/__mocks__/') ||
    p.startsWith('test/') || p.includes('/test/') ||
    p.startsWith('tests/') || p.includes('/tests/') ||
    p.startsWith('testing/') || p.includes('/testing/') ||
    p.startsWith('fixtures/') || p.includes('/fixtures/') ||
    p.endsWith('_test.go') || p.endsWith('_test.py') ||
    p.includes('/test_') || p.includes('/conftest.')
  );
};

/**
 * Resolve a function call to its target node ID using priority strategy:
 * A. Check imported files first (highest confidence)
 * B. Check local file definitions
 * C. Fuzzy global search (lowest confidence)
 * 
 * Returns confidence score so agents know what to trust.
 */
const resolveCallTarget = (
  calledName: string,
  currentFile: string,
  symbolTable: SymbolTable,
  importMap: ImportMap
): ResolveResult | null => {
  // Strategy B first (cheapest — single map lookup): Check local file
  const localNodeId = symbolTable.lookupExact(currentFile, calledName);
  if (localNodeId) {
    return { nodeId: localNodeId, confidence: 0.85, reason: 'same-file' };
  }

  // Strategy A: Check if any definition of calledName is in an imported file
  // Reversed: instead of iterating all imports and checking each, get all definitions
  // and check if any is imported. O(definitions) instead of O(imports).
  const allDefs = symbolTable.lookupFuzzy(calledName);
  if (allDefs.length > 0) {
    const importedFiles = importMap.get(currentFile);
    if (importedFiles) {
      for (const def of allDefs) {
        if (importedFiles.has(def.filePath)) {
          return { nodeId: def.nodeId, confidence: 0.9, reason: 'import-resolved' };
        }
      }
    }

    // Strategy C: Fuzzy global (no import match found)
    // Confidence-first: only emit a fuzzy edge if there's exactly one global match.
    // Multiple matches is ambiguous and tends to inject noisy CALLS edges.
    if (allDefs.length === 1) {
      if (isTestFilePath(currentFile) || isTestFilePath(allDefs[0].filePath)) return null;
      const currentLanguage = getLanguageFromFilename(currentFile);
      const targetLanguage = getLanguageFromFilename(allDefs[0].filePath);
      if (!isFuzzyGlobalLanguageCompatible(currentLanguage, targetLanguage)) return null;
      if (!isFuzzyGlobalScopeCompatible(currentFile, allDefs[0].filePath)) return null;
      return { nodeId: allDefs[0].nodeId, confidence: 0.5, reason: 'fuzzy-global' };
    }
    return null;
  }

  return null;
};

// ============================================================================
// PHP-specific CALLS resolution (receiver + scope aware)
// ============================================================================

type PhpAssignmentIndex = Map<string, Map<string, ExtractedPhpAssignment[]>>;
type PhpTraitUseIndex = Map<string, string[]>;

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

const buildPhpAssignmentIndex = (assignments: ExtractedPhpAssignment[]): PhpAssignmentIndex => {
  const index: PhpAssignmentIndex = new Map();

  for (const assignment of assignments) {
    let byVar = index.get(assignment.sourceId);
    if (!byVar) {
      byVar = new Map();
      index.set(assignment.sourceId, byVar);
    }

    let list = byVar.get(assignment.variableName);
    if (!list) {
      list = [];
      byVar.set(assignment.variableName, list);
    }

    list.push(assignment);
  }

  for (const [, byVar] of index) {
    for (const [, list] of byVar) {
      list.sort((a, b) => a.startLine - b.startLine);
    }
  }

  return index;
};

const buildPhpTraitUseIndex = (traitUses: ExtractedPhpTraitUse[]): PhpTraitUseIndex => {
  const index: PhpTraitUseIndex = new Map();

  for (const use of traitUses) {
    const classId = generateId('Class', `${use.filePath}:${use.className}`);
    let list = index.get(classId);
    if (!list) {
      list = [];
      index.set(classId, list);
    }
    if (!list.includes(use.traitRef)) list.push(use.traitRef);
  }

  return index;
};

const getPhpShortName = (classRef: string): string | null => {
  const trimmed = classRef.trim().replace(/^\\+/, '');
  if (trimmed.length === 0) return null;
  const parts = trimmed.split('\\').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
};

const resolveMethodInFile = (filePath: string, methodName: string, symbolTable: SymbolTable): string | null => {
  const defs = symbolTable
    .lookupFuzzy(methodName)
    .filter(d => d.type === 'Method' && d.filePath === filePath);

  if (defs.length === 1) return defs[0].nodeId;
  return null;
};

const resolvePhpClassOrInterfaceByName = (
  shortName: string,
  currentFile: string,
  symbolTable: SymbolTable,
  importMap: ImportMap,
): { filePath: string; confidence: number; reason: string } | null => {
  const candidates = symbolTable
    .lookupFuzzy(shortName)
    .filter(d => d.type === 'Class' || d.type === 'Interface');

  if (candidates.length === 0) return null;

  const importedFiles = importMap.get(currentFile);
  if (importedFiles) {
    const importedMatches = candidates.filter(d => importedFiles.has(d.filePath));
    if (importedMatches.length === 1) {
      return { filePath: importedMatches[0].filePath, confidence: 0.95, reason: 'import-resolved' };
    }
    if (importedMatches.length > 1) return null;
  }

  if (candidates.length === 1) {
    if (isTestFilePath(currentFile) || isTestFilePath(candidates[0].filePath)) return null;
    if (!isFuzzyGlobalScopeCompatible(currentFile, candidates[0].filePath)) return null;
    return { filePath: candidates[0].filePath, confidence: 0.6, reason: 'fuzzy-global' };
  }

  return null;
};

const resolvePhpTraitByName = (
  shortName: string,
  currentFile: string,
  symbolTable: SymbolTable,
  importMap: ImportMap,
): { filePath: string; confidence: number; reason: string } | null => {
  const candidates = symbolTable
    .lookupFuzzy(shortName)
    .filter(d => d.type === 'Trait');

  if (candidates.length === 0) return null;

  const importedFiles = importMap.get(currentFile);
  if (importedFiles) {
    const importedMatches = candidates.filter(d => importedFiles.has(d.filePath));
    if (importedMatches.length === 1) {
      return { filePath: importedMatches[0].filePath, confidence: 0.95, reason: 'import-resolved' };
    }
    if (importedMatches.length > 1) return null;
  }

  if (candidates.length === 1) {
    if (isTestFilePath(currentFile) || isTestFilePath(candidates[0].filePath)) return null;
    if (!isFuzzyGlobalScopeCompatible(currentFile, candidates[0].filePath)) return null;
    return { filePath: candidates[0].filePath, confidence: 0.6, reason: 'fuzzy-global' };
  }

  return null;
};

const findPhpVarTypeBeforeLine = (
  phpAssignmentIndex: PhpAssignmentIndex,
  sourceId: string,
  variableName: string,
  line: number,
): string | null => {
  const byVar = phpAssignmentIndex.get(sourceId);
  if (!byVar) return null;

  const list = byVar.get(variableName);
  if (!list || list.length === 0) return null;

  // Pick the latest assignment <= call line
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].startLine <= line) return list[i].classRef;
  }

  return null;
};

const extractPhpVarTypesFromTree = (rootNode: any, filePath: string): ExtractedPhpAssignment[] => {
  const assignments: ExtractedPhpAssignment[] = [];

  const findEnclosingPhpCallableId = (node: any): string | null => {
    let current = node?.parent;
    while (current) {
      if (current.type === 'method_declaration') {
        const nameNode = current.childForFieldName?.('name');
        const name = nameNode?.text;
        return name ? generateId('Method', `${filePath}:${name}`) : null;
      }

      if (current.type === 'function_definition') {
        const nameNode = current.childForFieldName?.('name');
        const name = nameNode?.text;
        return name ? generateId('Function', `${filePath}:${name}`) : null;
      }
      current = current.parent;
    }
    return null;
  };

  const visit = (node: any) => {
    if (!node) return;

    if (node.type === 'class_declaration') {
      const bodyNode = node.childForFieldName?.('body')
        || node.namedChildren?.find((c: any) => c.type === 'declaration_list');
      const decls = bodyNode?.namedChildren || [];

      const propertyTypes = new Map<string, string>();

      const normalizeType = (raw: string): string | null => {
        const cleaned = raw.trim().replace(/^\?+/, '').replace(/^\\+/, '');
        if (!cleaned) return null;
        if (PHP_SCALAR_TYPES.has(cleaned.toLowerCase())) return null;
        return cleaned;
      };

      const stripPhpClassConstant = (value: string): string => value.trim().replace(/::class$/i, '').trim();

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

      const getBaseCallableName = (value: string): string => {
        const trimmed = value.trim().replace(/^\\+/, '');
        const parts = trimmed.split(/[\\/]+/).filter(Boolean);
        return parts.at(-1) ?? trimmed;
      };

      for (const decl of decls) {
        if (decl.type === 'property_declaration') {
          const typeNode = decl.childForFieldName?.('type');
          if (!typeNode) continue;

          const innerType = typeNode.namedChildren?.[0];
          const classRef = normalizeType(String((innerType?.text ?? typeNode.text) || ''));
          if (!classRef) continue;

          for (const child of decl.namedChildren || []) {
            if (child.type !== 'property_element') continue;
            const varNode = child.namedChildren?.find((c: any) => c.type === 'variable_name');
            const varText = varNode?.text;
            if (!varText) continue;
            const propName = varText.replace(/^\$/, '');
            if (!propName) continue;
            propertyTypes.set(`$this->${propName}`, classRef);
          }
        }

        if (decl.type === 'method_declaration') {
          const nameNode = decl.childForFieldName?.('name');
          if (nameNode?.text !== '__construct') continue;

          const constructorParamTypes = new Map<string, string>();

          const paramsNode = decl.childForFieldName?.('parameters');
          const params = paramsNode?.namedChildren || [];

          for (const param of params) {
            const varNode = param.childForFieldName?.('name');
            const varText = varNode?.type === 'variable_name' ? varNode.text : null;
            if (!varText) continue;

            const typeNode = param.childForFieldName?.('type');
            if (!typeNode) continue;

            const innerType = typeNode.namedChildren?.[0];
            const classRef = normalizeType(String((innerType?.text ?? typeNode.text) || ''));
            if (!classRef) continue;

            constructorParamTypes.set(varText, classRef);

            if (param.type === 'property_promotion_parameter') {
              const propName = varText.replace(/^\$/, '');
              if (!propName) continue;
              propertyTypes.set(`$this->${propName}`, classRef);
            }
          }

          const inferClassRefFromExpression = (expr: any): string | null => {
            if (!expr) return null;

            if (expr.type === 'parenthesized_expression') {
              return inferClassRefFromExpression(expr.namedChildren?.[0]);
            }

            if (expr.type === 'variable_name') {
              return constructorParamTypes.get(expr.text) || null;
            }

            if (expr.type === 'object_creation_expression') {
              const classNode = (expr.namedChildren || []).find((c: any) => c.type === 'name' || c.type === 'qualified_name');
              const classRef = normalizeType(String(classNode?.text || ''));
              return classRef;
            }

            if (expr.type === 'function_call_expression') {
              const fnNode = expr.childForFieldName?.('function') || expr.childForFieldName?.('name');
              const fnText = String(fnNode?.text || '').trim();
              const fnName = getBaseCallableName(fnText).toLowerCase();
              if (fnName !== 'app' && fnName !== 'resolve') return null;

              const argsNode = expr.childForFieldName?.('arguments');
              const args = getCallArgumentExpressions(argsNode);
              const first = args[0];
              if (!first) return null;

              if (first.type === 'class_constant_access_expression') {
                return normalizeType(stripPhpClassConstant(String(first.text || '')));
              }
              if (first.type === 'qualified_name' || first.type === 'name') {
                return normalizeType(stripPhpClassConstant(String(first.text || '')));
              }
              return null;
            }

            if (expr.type === 'member_call_expression') {
              const nameNode = expr.childForFieldName?.('name');
              const methodName = String(nameNode?.text || '').trim().toLowerCase();
              if (methodName !== 'make' && methodName !== 'makewith') return null;

              const objectNode = expr.childForFieldName?.('object');
              if (objectNode?.type !== 'function_call_expression') return null;

              const fnNode = objectNode.childForFieldName?.('function') || objectNode.childForFieldName?.('name');
              const fnText = String(fnNode?.text || '').trim();
              const fnName = getBaseCallableName(fnText).toLowerCase();
              if (fnName !== 'app') return null;

              const appArgsNode = objectNode.childForFieldName?.('arguments');
              const appArgs = getCallArgumentExpressions(appArgsNode);
              if (appArgs.length !== 0) return null;

              const argsNode = expr.childForFieldName?.('arguments');
              const args = getCallArgumentExpressions(argsNode);
              const first = args[0];
              if (!first) return null;

              if (first.type === 'class_constant_access_expression') {
                return normalizeType(stripPhpClassConstant(String(first.text || '')));
              }
              if (first.type === 'qualified_name' || first.type === 'name') {
                return normalizeType(stripPhpClassConstant(String(first.text || '')));
              }
              return null;
            }

            if (expr.type === 'scoped_call_expression') {
              const nameNode = expr.childForFieldName?.('name');
              const methodName = String(nameNode?.text || '').trim().toLowerCase();
              if (methodName !== 'make' && methodName !== 'makewith') return null;

              const scopeNode = expr.childForFieldName?.('scope');
              const scopeText = String(scopeNode?.text || '').trim();
              const scopeName = getBaseCallableName(scopeText).toLowerCase();
              if (scopeName !== 'app') return null;

              const argsNode = expr.childForFieldName?.('arguments');
              const args = getCallArgumentExpressions(argsNode);
              const first = args[0];
              if (!first) return null;

              if (first.type === 'class_constant_access_expression') {
                return normalizeType(stripPhpClassConstant(String(first.text || '')));
              }
              if (first.type === 'qualified_name' || first.type === 'name') {
                return normalizeType(stripPhpClassConstant(String(first.text || '')));
              }
              return null;
            }

            return null;
          };

          const bodyNode = decl.childForFieldName?.('body')
            || decl.namedChildren?.find((c: any) => c.type === 'compound_statement');

          const visitConstructorBody = (node: any) => {
            if (!node) return;

            if (node.type === 'assignment_expression') {
              const left = node.childForFieldName?.('left');
              const right = node.childForFieldName?.('right');

              if (left?.type === 'member_access_expression') {
                const baseNode = left.childForFieldName?.('object');
                if (baseNode?.type === 'variable_name' && baseNode.text === '$this') {
                  const variableName = left.text;
                  const classRef = inferClassRefFromExpression(right);
                  if (variableName && classRef) {
                    const existing = propertyTypes.get(variableName);
                    if (!existing) propertyTypes.set(variableName, classRef);
                  }
                }
              }
            }

            for (const child of node.namedChildren || []) {
              visitConstructorBody(child);
            }
          };

          visitConstructorBody(bodyNode);
        }
      }

      if (propertyTypes.size > 0) {
        for (const decl of decls) {
          if (decl.type !== 'method_declaration') continue;
          const nameNode = decl.childForFieldName?.('name');
          const methodName = nameNode?.text;
          if (!methodName) continue;

          const sourceId = generateId('Method', `${filePath}:${methodName}`);

          for (const [variableName, classRef] of propertyTypes) {
            assignments.push({
              filePath,
              sourceId,
              variableName,
              classRef,
              startLine: decl.startPosition.row,
            });
          }
        }
      }
    }

    if (node.type === 'method_declaration' || node.type === 'function_definition') {
      const nameNode = node.childForFieldName?.('name');
      const callableName = nameNode?.text;
      const label = node.type === 'method_declaration' ? 'Method' : 'Function';
      const sourceId = callableName ? generateId(label, `${filePath}:${callableName}`) : null;

      if (sourceId) {
        const paramsNode = node.childForFieldName?.('parameters');
        const params = paramsNode?.namedChildren || [];
        for (const param of params) {
          if (param.type !== 'simple_parameter') continue;

          const varNode = param.childForFieldName?.('name');
          const variableName = varNode?.type === 'variable_name' ? varNode.text : null;
          if (!variableName) continue;

          const typeNode = param.childForFieldName?.('type');
          if (!typeNode) continue;

          const innerType = typeNode.namedChildren?.[0];
          const classRefRaw = String((innerType?.text ?? typeNode.text) || '').trim();
          const classRef = classRefRaw.replace(/^\?+/, '').replace(/^\\+/, '');
          if (!classRef) continue;
          if (PHP_SCALAR_TYPES.has(classRef.toLowerCase())) continue;

          assignments.push({
            filePath,
            sourceId,
            variableName,
            classRef,
            startLine: node.startPosition.row,
          });
        }
      }
    }

    if (node.type === 'assignment_expression') {
      const left = node.childForFieldName?.('left');
      const right = node.childForFieldName?.('right');

      const sourceId = findEnclosingPhpCallableId(node);
      if (sourceId) {
        const normalizeType = (raw: string): string | null => {
          const cleaned = raw.trim().replace(/^\?+/, '').replace(/^\\+/, '');
          if (!cleaned) return null;
          if (PHP_SCALAR_TYPES.has(cleaned.toLowerCase())) return null;
          return cleaned;
        };

        const stripPhpClassConstant = (value: string): string => value.trim().replace(/::class$/i, '').trim();

        const getBaseCallableName = (value: string): string => {
          const trimmed = value.trim().replace(/^\\+/, '');
          const parts = trimmed.split(/[\\/]+/).filter(Boolean);
          return parts.at(-1) ?? trimmed;
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

        const inferClassRefFromExpression = (expr: any): string | null => {
          if (!expr) return null;

          if (expr.type === 'parenthesized_expression') {
            return inferClassRefFromExpression(expr.namedChildren?.[0]);
          }

          if (expr.type === 'object_creation_expression') {
            const classNode = (expr.namedChildren || []).find((c: any) => c.type === 'name' || c.type === 'qualified_name');
            return classNode?.text ? normalizeType(String(classNode.text)) : null;
          }

          if (expr.type === 'function_call_expression') {
            const fnNode = expr.childForFieldName?.('function') || expr.childForFieldName?.('name');
            const fnText = String(fnNode?.text || '').trim();
            const fnName = getBaseCallableName(fnText).toLowerCase();
            if (fnName !== 'app' && fnName !== 'resolve') return null;

            const argsNode = expr.childForFieldName?.('arguments');
            const args = getCallArgumentExpressions(argsNode);
            const first = args[0];
            if (!first) return null;

            if (first.type === 'class_constant_access_expression') {
              return normalizeType(stripPhpClassConstant(String(first.text || '')));
            }
            if (first.type === 'qualified_name' || first.type === 'name') {
              return normalizeType(stripPhpClassConstant(String(first.text || '')));
            }
            return null;
          }

          if (expr.type === 'member_call_expression') {
            const nameNode = expr.childForFieldName?.('name');
            const methodName = String(nameNode?.text || '').trim().toLowerCase();
            if (methodName !== 'make' && methodName !== 'makewith') return null;

            const objectNode = expr.childForFieldName?.('object');
            if (objectNode?.type !== 'function_call_expression') return null;

            const fnNode = objectNode.childForFieldName?.('function') || objectNode.childForFieldName?.('name');
            const fnText = String(fnNode?.text || '').trim();
            const fnName = getBaseCallableName(fnText).toLowerCase();
            if (fnName !== 'app') return null;

            const appArgsNode = objectNode.childForFieldName?.('arguments');
            const appArgs = getCallArgumentExpressions(appArgsNode);
            if (appArgs.length !== 0) return null;

            const argsNode = expr.childForFieldName?.('arguments');
            const args = getCallArgumentExpressions(argsNode);
            const first = args[0];
            if (!first) return null;

            if (first.type === 'class_constant_access_expression') {
              return normalizeType(stripPhpClassConstant(String(first.text || '')));
            }
            if (first.type === 'qualified_name' || first.type === 'name') {
              return normalizeType(stripPhpClassConstant(String(first.text || '')));
            }
            return null;
          }

          if (expr.type === 'scoped_call_expression') {
            const nameNode = expr.childForFieldName?.('name');
            const methodName = String(nameNode?.text || '').trim().toLowerCase();
            if (methodName !== 'make' && methodName !== 'makewith') return null;

            const scopeNode = expr.childForFieldName?.('scope');
            const scopeText = String(scopeNode?.text || '').trim();
            const scopeName = getBaseCallableName(scopeText).toLowerCase();
            if (scopeName !== 'app') return null;

            const argsNode = expr.childForFieldName?.('arguments');
            const args = getCallArgumentExpressions(argsNode);
            const first = args[0];
            if (!first) return null;

            if (first.type === 'class_constant_access_expression') {
              return normalizeType(stripPhpClassConstant(String(first.text || '')));
            }
            if (first.type === 'qualified_name' || first.type === 'name') {
              return normalizeType(stripPhpClassConstant(String(first.text || '')));
            }
            return null;
          }

          return null;
        };

        if (left?.type === 'variable_name') {
          const variableName = left.text;
          const classRef = inferClassRefFromExpression(right);
          if (variableName && classRef) {
            assignments.push({
              filePath,
              sourceId,
              variableName,
              classRef,
              startLine: node.startPosition.row,
            });
          }
        }

        if (left?.type === 'member_access_expression') {
          const baseNode = left.childForFieldName?.('object');
          if (baseNode?.type === 'variable_name' && baseNode.text === '$this') {
            const variableName = left.text;
            const classRef = inferClassRefFromExpression(right);
            if (variableName && classRef) {
              assignments.push({
                filePath,
                sourceId,
                variableName,
                classRef,
                startLine: node.startPosition.row,
              });
            }
          }
        }
      }
    }

    for (const child of node.namedChildren || []) {
      visit(child);
    }
  };

  visit(rootNode);
  return assignments;
};

const resolvePhpCallTargetFromExtracted = (
  call: ExtractedCall,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
  phpAssignmentIndex: PhpAssignmentIndex,
  phpTraitUseIndex: PhpTraitUseIndex,
  phpMethodContainerMap: Map<string, string>,
): ResolveResult | null => {
  if (call.kind === 'member') {
    if (typeof call.startLine !== 'number') return null;

    if (call.receiver === '$this') {
      const methodId = resolveMethodInFile(call.filePath, call.calledName, symbolTable);
      if (methodId) return { nodeId: methodId, confidence: 0.85, reason: 'same-file' };

      const containerId = phpMethodContainerMap.get(call.sourceId);
      if (!containerId) return null;

      const traitRefs = phpTraitUseIndex.get(containerId);
      if (!traitRefs || traitRefs.length === 0) return null;

      const resolvedMethods: ResolveResult[] = [];
      for (const traitRef of traitRefs) {
        const expanded = expandPhpClassRefFromUseAliases(traitRef, call.filePath, phpUseAliases);
        const shortName = getPhpShortName(expanded);
        if (!shortName) continue;

        const resolvedTrait = resolvePhpTraitByName(shortName, call.filePath, symbolTable, importMap);
        if (!resolvedTrait) continue;

        const traitMethodId = resolveMethodInFile(resolvedTrait.filePath, call.calledName, symbolTable);
        if (!traitMethodId) continue;

        resolvedMethods.push({ nodeId: traitMethodId, confidence: resolvedTrait.confidence, reason: resolvedTrait.reason });
      }

      const unique = new Map<string, ResolveResult>();
      for (const r of resolvedMethods) unique.set(r.nodeId, r);
      if (unique.size === 1) return Array.from(unique.values())[0];
      return null;
    }

    if (call.receiver) {
      const classRef = findPhpVarTypeBeforeLine(phpAssignmentIndex, call.sourceId, call.receiver, call.startLine);
      if (!classRef) return null;

      const expanded = expandPhpClassRefFromUseAliases(classRef, call.filePath, phpUseAliases);
      const shortName = getPhpShortName(expanded);
      if (!shortName) return null;

      const resolvedType = resolvePhpClassOrInterfaceByName(shortName, call.filePath, symbolTable, importMap);
      if (!resolvedType) return null;

      const methodId = resolveMethodInFile(resolvedType.filePath, call.calledName, symbolTable);
      if (!methodId) return null;

      return { nodeId: methodId, confidence: resolvedType.confidence, reason: resolvedType.reason };
    }

    if (call.receiverClassRef) {
      const receiver = call.receiverClassRef.trim();
      if (!receiver) return null;

      const lower = receiver.toLowerCase();
      if (lower === 'self' || lower === 'static') {
        const methodId = resolveMethodInFile(call.filePath, call.calledName, symbolTable);
        return methodId ? { nodeId: methodId, confidence: 0.85, reason: 'same-file' } : null;
      }
      if (lower === 'parent') return null;

      const expanded = expandPhpClassRefFromUseAliases(receiver, call.filePath, phpUseAliases);
      const shortName = getPhpShortName(expanded);
      if (!shortName) return null;

      const resolvedType = resolvePhpClassOrInterfaceByName(shortName, call.filePath, symbolTable, importMap);
      if (!resolvedType) return null;

      const methodId = resolveMethodInFile(resolvedType.filePath, call.calledName, symbolTable);
      if (!methodId) return null;

      return { nodeId: methodId, confidence: resolvedType.confidence, reason: resolvedType.reason };
    }

    return null;
  }

  if (call.kind === 'scoped') {
    if (!call.scope) return null;

    const scope = call.scope.trim();
    if (scope.length === 0) return null;

    const lower = scope.toLowerCase();
    if (lower === 'self' || lower === 'static') {
      const methodId = resolveMethodInFile(call.filePath, call.calledName, symbolTable);
      return methodId ? { nodeId: methodId, confidence: 0.85, reason: 'same-file' } : null;
    }

    if (lower === 'parent') return null;

    const expanded = expandPhpClassRefFromUseAliases(scope, call.filePath, phpUseAliases);
    const shortName = getPhpShortName(expanded);
    if (!shortName) return null;

    const resolvedType = resolvePhpClassOrInterfaceByName(shortName, call.filePath, symbolTable, importMap);
    if (!resolvedType) return null;

    const methodId = resolveMethodInFile(resolvedType.filePath, call.calledName, symbolTable);
    if (!methodId) return null;

    return { nodeId: methodId, confidence: resolvedType.confidence, reason: resolvedType.reason };
  }

  // Simple function calls: fall back to name-only resolution
  return resolveCallTarget(call.calledName, call.filePath, symbolTable, importMap);
};

const resolvePhpCallTargetFromAst = (
  callNode: any,
  calledName: string,
  filePath: string,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
  phpAssignmentIndex: PhpAssignmentIndex | null,
  ): ResolveResult | null => {
  if (callNode?.type === 'member_call_expression') {
    const objectNode = callNode.childForFieldName?.('object');
    let receiver: string | null = null;

    if (objectNode?.type === 'variable_name') {
      receiver = objectNode.text;
    } else if (objectNode?.type === 'member_access_expression') {
      const baseNode = objectNode.childForFieldName?.('object');
      if (baseNode?.type === 'variable_name' && baseNode.text === '$this') {
        receiver = objectNode.text;
      }
    }

    const stripPhpClassConstantText = (value: string): string => value.trim().replace(/::class$/i, '').trim();

    const unwrapParens = (expr: any): any => {
      let current = expr;
      while (current?.type === 'parenthesized_expression') {
        const inner = current.namedChildren?.[0];
        if (!inner) break;
        current = inner;
      }
      return current;
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

    const getBaseCallableName = (value: string): string => {
      const trimmed = value.trim().replace(/^\\+/, '');
      const parts = trimmed.split(/[\\/]+/).filter(Boolean);
      return parts.at(-1) ?? trimmed;
    };

    const inferClassRefFromExpression = (expr: any): string | null => {
      const e = unwrapParens(expr);
      if (!e) return null;

      const inferFromTypeArg = (arg: any): string | null => {
        if (!arg) return null;

        if (arg.type === 'class_constant_access_expression') {
          const raw = stripPhpClassConstantText(String(arg.text || '')).trim();
          return raw ? raw.replace(/^\\+/, '') : null;
        }

        if (arg.type === 'qualified_name' || arg.type === 'name') {
          const raw = stripPhpClassConstantText(String(arg.text || '')).trim();
          return raw ? raw.replace(/^\\+/, '') : null;
        }

        return null;
      };

      if (e.type === 'object_creation_expression') {
        const classNode = (e.namedChildren || []).find((c: any) => c.type === 'name' || c.type === 'qualified_name');
        const raw = String(classNode?.text || '').trim();
        return raw ? raw.replace(/^\\+/, '') : null;
      }

      if (e.type === 'function_call_expression') {
        const fnNode = e.childForFieldName?.('function') || e.childForFieldName?.('name');
        const fnText = String(fnNode?.text || '').trim();
        const fnName = getBaseCallableName(fnText).toLowerCase();
        if (fnName !== 'app' && fnName !== 'resolve') return null;

        const argsNode = e.childForFieldName?.('arguments');
        const args = getCallArgumentExpressions(argsNode);
        return inferFromTypeArg(args[0]);
      }

      if (e.type === 'member_call_expression') {
        const nameNode = e.childForFieldName?.('name');
        const methodName = String(nameNode?.text || '').trim().toLowerCase();
        if (methodName !== 'make' && methodName !== 'makewith') return null;

        const objectNode = unwrapParens(e.childForFieldName?.('object'));
        if (!objectNode || objectNode.type !== 'function_call_expression') return null;

        const fnNode = objectNode.childForFieldName?.('function') || objectNode.childForFieldName?.('name');
        const fnText = String(fnNode?.text || '').trim();
        const fnName = getBaseCallableName(fnText).toLowerCase();
        if (fnName !== 'app') return null;

        const appArgsNode = objectNode.childForFieldName?.('arguments');
        const appArgs = getCallArgumentExpressions(appArgsNode);
        if (appArgs.length !== 0) return null;

        const argsNode = e.childForFieldName?.('arguments');
        const args = getCallArgumentExpressions(argsNode);
        return inferFromTypeArg(args[0]);
      }

      if (e.type === 'scoped_call_expression') {
        const nameNode = e.childForFieldName?.('name');
        const methodName = String(nameNode?.text || '').trim().toLowerCase();
        if (methodName !== 'make' && methodName !== 'makewith') return null;

        const scopeNode = e.childForFieldName?.('scope');
        const scopeText = String(scopeNode?.text || '').trim();
        const scopeName = getBaseCallableName(scopeText).toLowerCase();
        if (scopeName !== 'app') return null;

        const argsNode = e.childForFieldName?.('arguments');
        const args = getCallArgumentExpressions(argsNode);
        return inferFromTypeArg(args[0]);
      }

      return null;
    };

    if (!receiver) {
      const classRef = inferClassRefFromExpression(objectNode);
      if (!classRef) return null;

      const lower = classRef.trim().toLowerCase();
      if (lower === 'self' || lower === 'static') {
        const methodId = resolveMethodInFile(filePath, calledName, symbolTable);
        return methodId ? { nodeId: methodId, confidence: 0.85, reason: 'same-file' } : null;
      }
      if (lower === 'parent') return null;

      const expanded = expandPhpClassRefFromUseAliases(classRef, filePath, phpUseAliases);
      const shortName = getPhpShortName(expanded);
      if (!shortName) return null;

      const resolvedType = resolvePhpClassOrInterfaceByName(shortName, filePath, symbolTable, importMap);
      if (!resolvedType) return null;

      const methodId = resolveMethodInFile(resolvedType.filePath, calledName, symbolTable);
      if (!methodId) return null;

      return { nodeId: methodId, confidence: resolvedType.confidence, reason: resolvedType.reason };
    }
    if (receiver === '$this') {
      const methodId = resolveMethodInFile(filePath, calledName, symbolTable);
      if (methodId) return { nodeId: methodId, confidence: 0.85, reason: 'same-file' };

      let current = callNode.parent;
      while (current) {
        if (current.type === 'class_declaration') {
          const bodyNode = current.childForFieldName?.('body')
            || current.namedChildren?.find((c: any) => c.type === 'declaration_list');
          const decls = bodyNode?.namedChildren || [];

          const traitRefs: string[] = [];
          for (const decl of decls) {
            if (decl.type !== 'use_declaration') continue;
            for (const child of decl.namedChildren || []) {
              if (child.type !== 'name' && child.type !== 'qualified_name') continue;
              const traitRef = String(child.text || '').trim();
              if (!traitRef) continue;
              traitRefs.push(traitRef);
            }
          }

          const resolvedMethods: ResolveResult[] = [];
          for (const traitRef of traitRefs) {
            const expanded = expandPhpClassRefFromUseAliases(traitRef, filePath, phpUseAliases);
            const shortName = getPhpShortName(expanded);
            if (!shortName) continue;

            const resolvedTrait = resolvePhpTraitByName(shortName, filePath, symbolTable, importMap);
            if (!resolvedTrait) continue;

            const traitMethodId = resolveMethodInFile(resolvedTrait.filePath, calledName, symbolTable);
            if (!traitMethodId) continue;

            resolvedMethods.push({ nodeId: traitMethodId, confidence: resolvedTrait.confidence, reason: resolvedTrait.reason });
          }

          const unique = new Map<string, ResolveResult>();
          for (const r of resolvedMethods) unique.set(r.nodeId, r);
          if (unique.size === 1) return Array.from(unique.values())[0];
          return null;
        }
        current = current.parent;
      }

      return null;
    }

    if (!phpAssignmentIndex) return null;

    const sourceId = findEnclosingFunction(callNode, filePath, symbolTable);
    if (!sourceId) return null;

    const startLine = callNode.startPosition?.row;
    if (typeof startLine !== 'number') return null;

    const classRef = findPhpVarTypeBeforeLine(phpAssignmentIndex, sourceId, receiver, startLine);
    if (!classRef) return null;

    const expanded = expandPhpClassRefFromUseAliases(classRef, filePath, phpUseAliases);
    const shortName = getPhpShortName(expanded);
    if (!shortName) return null;

    const resolvedType = resolvePhpClassOrInterfaceByName(shortName, filePath, symbolTable, importMap);
    if (!resolvedType) return null;

    const methodId = resolveMethodInFile(resolvedType.filePath, calledName, symbolTable);
    if (!methodId) return null;

    return { nodeId: methodId, confidence: resolvedType.confidence, reason: resolvedType.reason };
  }

  if (callNode?.type === 'scoped_call_expression') {
    const scopeNode = callNode.childForFieldName?.('scope');
    const scopeText = String(scopeNode?.text || '').trim();
    if (!scopeText) return null;

    const lower = scopeText.toLowerCase();
    if (lower === 'self' || lower === 'static') {
      const methodId = resolveMethodInFile(filePath, calledName, symbolTable);
      return methodId ? { nodeId: methodId, confidence: 0.85, reason: 'same-file' } : null;
    }

    if (lower === 'parent') return null;

    const expanded = expandPhpClassRefFromUseAliases(scopeText, filePath, phpUseAliases);
    const shortName = getPhpShortName(expanded);
    if (!shortName) return null;

    const resolvedType = resolvePhpClassOrInterfaceByName(shortName, filePath, symbolTable, importMap);
    if (!resolvedType) return null;

    const methodId = resolveMethodInFile(resolvedType.filePath, calledName, symbolTable);
    if (!methodId) return null;

    return { nodeId: methodId, confidence: resolvedType.confidence, reason: resolvedType.reason };
  }

  return resolveCallTarget(calledName, filePath, symbolTable, importMap);
};

/**
 * Filter out common built-in functions and noise
 * that shouldn't be tracked as calls
 */
const BUILT_INS = new Set([
    // JavaScript/TypeScript built-ins
    'console', 'log', 'warn', 'error', 'info', 'debug',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite',
    'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',
    'JSON', 'parse', 'stringify',
    'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
    'Map', 'Set', 'WeakMap', 'WeakSet',
    'Promise', 'resolve', 'reject', 'then', 'catch', 'finally',
    'Math', 'Date', 'RegExp', 'Error',
    'require', 'import', 'export',
    'fetch', 'Response', 'Request',
    // React hooks and common functions
    'useState', 'useEffect', 'useCallback', 'useMemo', 'useRef', 'useContext',
    'useReducer', 'useLayoutEffect', 'useImperativeHandle', 'useDebugValue',
    'createElement', 'createContext', 'createRef', 'forwardRef', 'memo', 'lazy',
    // Common array/object methods
    'map', 'filter', 'reduce', 'forEach', 'find', 'findIndex', 'some', 'every',
    'includes', 'indexOf', 'slice', 'splice', 'concat', 'join', 'split',
    'push', 'pop', 'shift', 'unshift', 'sort', 'reverse',
    'keys', 'values', 'entries', 'assign', 'freeze', 'seal',
    'hasOwnProperty', 'toString', 'valueOf',
    // Python built-ins
    'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple',
    'open', 'read', 'write', 'close', 'append', 'extend', 'update',
    'super', 'type', 'isinstance', 'issubclass', 'getattr', 'setattr', 'hasattr',
    'enumerate', 'zip', 'sorted', 'reversed', 'min', 'max', 'sum', 'abs',
]);

// PHP/Laravel: treat framework helpers as built-ins (avoid noisy/incorrect fuzzy call edges)
// and allow-list common domain verbs that are meaningful in backend call graphs.
const PHP_BUILT_IN_ALLOWLIST = new Set([
  // Common Laravel controller/service verbs
  'update',
]);

const PHP_FRAMEWORK_HELPERS = new Set([
  'abort',
  'abort_if',
  'abort_unless',
  'app',
  'auth',
  'back',
  'config',
  'dispatch',
  'dispatch_sync',
  'event',
  'redirect',
  'report',
  'request',
  'response',
  'resolve',
  'route',
  'to_route',
  'throw_if',
  'throw_unless',
  'view',
]);

const isBuiltInOrNoise = (name: string, language: SupportedLanguages | null): boolean => {
  if (language === SupportedLanguages.PHP) {
    if (PHP_FRAMEWORK_HELPERS.has(name)) return true;
    return BUILT_INS.has(name) && !PHP_BUILT_IN_ALLOWLIST.has(name);
  }

  return BUILT_INS.has(name);
};

/**
 * Fast path: resolve pre-extracted call sites from workers.
 * No AST parsing — workers already extracted calledName + sourceId.
 * This function only does symbol table lookups + graph mutations.
 */
export const processCallsFromExtracted = async (
  graph: KnowledgeGraph,
  extractedCalls: ExtractedCall[],
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
  phpAssignments: ExtractedPhpAssignment[],
  phpTraitUses: ExtractedPhpTraitUse[],
  onProgress?: (current: number, total: number) => void
) => {
  const phpAssignmentIndex = buildPhpAssignmentIndex(phpAssignments);
  const phpTraitUseIndex = buildPhpTraitUseIndex(phpTraitUses);

  const phpMethodContainerMap = new Map<string, string>();
  if (phpTraitUses.length > 0) {
    for (const rel of graph.relationships) {
      if (rel.type === 'MEMBER_OF' && rel.reason === 'php-enclosing-type') {
        phpMethodContainerMap.set(rel.sourceId, rel.targetId);
      }
    }
  }

  // Group by file for progress reporting
  const byFile = new Map<string, ExtractedCall[]>();
  for (const call of extractedCalls) {
    let list = byFile.get(call.filePath);
    if (!list) {
      list = [];
      byFile.set(call.filePath, list);
    }
    list.push(call);
  }

  const totalFiles = byFile.size;
  let filesProcessed = 0;

  for (const [_filePath, calls] of byFile) {
    filesProcessed++;
    if (filesProcessed % 100 === 0) {
      onProgress?.(filesProcessed, totalFiles);
      await yieldToEventLoop();
    }

    for (const call of calls) {
      const language = getLanguageFromFilename(call.filePath);
      if (!language) continue;
      if (isBuiltInOrNoise(call.calledName, language)) continue;

      const resolved = language === SupportedLanguages.PHP
        ? resolvePhpCallTargetFromExtracted(
            call,
            symbolTable,
            importMap,
            phpUseAliases,
            phpAssignmentIndex,
            phpTraitUseIndex,
            phpMethodContainerMap,
          )
        : resolveCallTarget(
            call.calledName,
            call.filePath,
            symbolTable,
            importMap
          );
      if (!resolved) continue;

      const relId = generateId('CALLS', `${call.sourceId}:${call.calledName}->${resolved.nodeId}`);
      graph.addRelationship({
        id: relId,
        sourceId: call.sourceId,
        targetId: resolved.nodeId,
        type: 'CALLS',
        confidence: resolved.confidence,
        reason: resolved.reason,
      });
    }
  }

  onProgress?.(totalFiles, totalFiles);
};
