import { parentPort } from 'node:worker_threads';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Java from 'tree-sitter-java';
import C from 'tree-sitter-c';
import CPP from 'tree-sitter-cpp';
import CSharp from 'tree-sitter-c-sharp';
import Go from 'tree-sitter-go';
import Rust from 'tree-sitter-rust';
import PHP from 'tree-sitter-php';
import { SupportedLanguages } from '../../../config/supported-languages.js';
import { LANGUAGE_QUERIES } from '../tree-sitter-queries.js';
import { getLanguageFromFilename, getParseableContent } from '../utils.js';
import { generateId } from '../../../lib/utils.js';

// ============================================================================
// Types for serializable results
// ============================================================================

interface ParsedNode {
  id: string;
  label: string;
  properties: {
    name: string;
    filePath: string;
    startLine: number;
    endLine: number;
    language: string;
    isExported: boolean;
  };
}

interface ParsedRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: 'DEFINES' | 'MEMBER_OF';
  confidence: number;
  reason: string;
}

interface ParsedSymbol {
  filePath: string;
  name: string;
  nodeId: string;
  type: string;
}

export interface ExtractedImport {
  filePath: string;
  rawImportPath: string;
  language: string;
}

export interface ExtractedCall {
  filePath: string;
  calledName: string;
  /** generateId of enclosing function, or generateId('File', filePath) for top-level */
  sourceId: string;
  /** 0-based tree-sitter row of the call expression (PHP only for now) */
  startLine?: number;
  /** PHP-only call kind for better resolution */
  kind?: 'simple' | 'member' | 'scoped';
  /** PHP-only: receiver expression for member calls (e.g. "$this", "$service") */
  receiver?: string;
  /** PHP-only: inferred class ref for inline receivers (e.g. app(Foo::class)->bar(), (new Foo())->bar()) */
  receiverClassRef?: string;
  /** PHP-only: scope expression for scoped calls (e.g. "Foo\\Bar", "self") */
  scope?: string;
}

export interface ExtractedHeritage {
  filePath: string;
  className: string;
  parentName: string;
  /** 'extends' | 'implements' | 'trait-impl' */
  kind: string;
}

export interface ExtractedPhpAssignment {
  filePath: string;
  /** generateId of enclosing function/method */
  sourceId: string;
  /** Variable name including `$` */
  variableName: string;
  /** Raw class ref from `new <classRef>(...)` (name or qualified_name text) */
  classRef: string;
  /** 0-based tree-sitter row of the assignment */
  startLine: number;
}

export interface ExtractedPhpTraitUse {
  filePath: string;
  className: string;
  traitRef: string;
}

export interface ParseWorkerResult {
  nodes: ParsedNode[];
  relationships: ParsedRelationship[];
  symbols: ParsedSymbol[];
  imports: ExtractedImport[];
  calls: ExtractedCall[];
  heritage: ExtractedHeritage[];
  phpAssignments: ExtractedPhpAssignment[];
  phpTraitUses: ExtractedPhpTraitUse[];
  fileCount: number;
}

export interface ParseWorkerInput {
  path: string;
  content: string;
}

// ============================================================================
// Worker-local parser + language map
// ============================================================================

const parser = new Parser();

const phpLanguage = (PHP as unknown as { php?: unknown; php_only?: unknown }).php
  ?? (PHP as unknown as { php?: unknown; php_only?: unknown }).php_only
  ?? PHP;

const languageMap: Record<string, any> = {
  [SupportedLanguages.JavaScript]: JavaScript,
  [SupportedLanguages.TypeScript]: TypeScript.typescript,
  [`${SupportedLanguages.TypeScript}:tsx`]: TypeScript.tsx,
  [SupportedLanguages.Python]: Python,
  [SupportedLanguages.PHP]: phpLanguage,
  [SupportedLanguages.Java]: Java,
  [SupportedLanguages.C]: C,
  [SupportedLanguages.CPlusPlus]: CPP,
  [SupportedLanguages.CSharp]: CSharp,
  [SupportedLanguages.Go]: Go,
  [SupportedLanguages.Rust]: Rust,
};

const setLanguage = (language: SupportedLanguages, filePath: string): void => {
  const key = language === SupportedLanguages.TypeScript && filePath.endsWith('.tsx')
    ? `${language}:tsx`
    : language;
  const lang = languageMap[key];
  if (!lang) throw new Error(`Unsupported language: ${language}`);
  parser.setLanguage(lang);
};

// ============================================================================
// Export detection (copied — needs AST parent traversal, can't cross threads)
// ============================================================================

const isNodeExported = (node: any, name: string, language: string): boolean => {
  let current = node;

  switch (language) {
    case 'javascript':
    case 'typescript':
      while (current) {
        const type = current.type;
        if (type === 'export_statement' ||
            type === 'export_specifier' ||
            type === 'lexical_declaration' && current.parent?.type === 'export_statement') {
          return true;
        }
        if (current.text?.startsWith('export ')) {
          return true;
        }
        current = current.parent;
      }
      return false;

    case 'python':
      return !name.startsWith('_');

    case 'java':
      while (current) {
        if (current.parent) {
          const parent = current.parent;
          for (let i = 0; i < parent.childCount; i++) {
            const child = parent.child(i);
            if (child?.type === 'modifiers' && child.text?.includes('public')) {
              return true;
            }
          }
          if (parent.type === 'method_declaration' || parent.type === 'constructor_declaration') {
            if (parent.text?.trimStart().startsWith('public')) {
              return true;
            }
          }
        }
        current = current.parent;
      }
      return false;

    case 'csharp':
      while (current) {
        if (current.type === 'modifier' || current.type === 'modifiers') {
          if (current.text?.includes('public')) return true;
        }
        current = current.parent;
      }
      return false;

    case 'go':
      if (name.length === 0) return false;
      const first = name[0];
      return first === first.toUpperCase() && first !== first.toLowerCase();

    case 'rust':
      while (current) {
        if (current.type === 'visibility_modifier') {
          if (current.text?.includes('pub')) return true;
        }
        current = current.parent;
      }
      return false;

    case 'c':
    case 'cpp':
      return false;

    case 'php':
      while (current) {
        if (current.parent) {
          const parent = current.parent;
          for (let i = 0; i < parent.childCount; i++) {
            const child = parent.child(i);
            if (child?.type === 'visibility_modifier') {
              if (child.text?.includes('private') || child.text?.includes('protected')) {
                return false;
              }
              if (child.text?.includes('public')) {
                return true;
              }
            }
          }
        }
        current = current.parent;
      }
      return true;

    default:
      return false;
  }
};

// ============================================================================
// Enclosing function detection (for call extraction)
// ============================================================================

const FUNCTION_NODE_TYPES = new Set([
  'function_declaration', 'arrow_function', 'function_expression',
  'method_definition', 'generator_function_declaration',
  'function_definition', 'async_function_declaration', 'async_arrow_function',
  'method_declaration', 'constructor_declaration',
  'local_function_statement', 'function_item', 'impl_item',
]);

/** Walk up AST to find enclosing function, return its generateId or null for top-level */
const findEnclosingFunctionId = (node: any, filePath: string): string | null => {
  let current = node.parent;
  while (current) {
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      let funcName: string | null = null;
      let label = 'Function';

      if (['function_declaration', 'function_definition', 'async_function_declaration',
           'generator_function_declaration', 'function_item'].includes(current.type)) {
        const nameNode = current.childForFieldName?.('name') ||
          current.children?.find((c: any) => c.type === 'identifier' || c.type === 'property_identifier');
        funcName = nameNode?.text;
      } else if (current.type === 'impl_item') {
        const funcItem = current.children?.find((c: any) => c.type === 'function_item');
        if (funcItem) {
          const nameNode = funcItem.childForFieldName?.('name') ||
            funcItem.children?.find((c: any) => c.type === 'identifier');
          funcName = nameNode?.text;
          label = 'Method';
        }
      } else if (current.type === 'method_definition') {
        const nameNode = current.childForFieldName?.('name') ||
          current.children?.find((c: any) => c.type === 'property_identifier');
        funcName = nameNode?.text;
        label = 'Method';
      } else if (current.type === 'method_declaration' || current.type === 'constructor_declaration') {
        const nameNode = current.childForFieldName?.('name') ||
          current.children?.find((c: any) => c.type === 'identifier');
        funcName = nameNode?.text;
        label = 'Method';
      } else if (current.type === 'arrow_function' || current.type === 'function_expression') {
        const parent = current.parent;
        if (parent?.type === 'variable_declarator') {
          const nameNode = parent.childForFieldName?.('name') ||
            parent.children?.find((c: any) => c.type === 'identifier');
          funcName = nameNode?.text;
        }
      }

      if (funcName) {
        return generateId(label, `${filePath}:${funcName}`);
      }
    }
    current = current.parent;
  }
  return null;
};

const BUILT_INS = new Set([
  'console', 'log', 'warn', 'error', 'info', 'debug',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',
  'JSON', 'parse', 'stringify',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Map', 'Set', 'WeakMap', 'WeakSet',
  'Promise', 'resolve', 'reject', 'then', 'catch', 'finally',
  'Math', 'Date', 'RegExp', 'Error',
  'require', 'import', 'export', 'fetch', 'Response', 'Request',
  'useState', 'useEffect', 'useCallback', 'useMemo', 'useRef', 'useContext',
  'useReducer', 'useLayoutEffect', 'useImperativeHandle', 'useDebugValue',
  'createElement', 'createContext', 'createRef', 'forwardRef', 'memo', 'lazy',
  'map', 'filter', 'reduce', 'forEach', 'find', 'findIndex', 'some', 'every',
  'includes', 'indexOf', 'slice', 'splice', 'concat', 'join', 'split',
  'push', 'pop', 'shift', 'unshift', 'sort', 'reverse',
  'keys', 'values', 'entries', 'assign', 'freeze', 'seal',
  'hasOwnProperty', 'toString', 'valueOf',
  'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple',
  'open', 'read', 'write', 'close', 'append', 'extend', 'update',
  'super', 'type', 'isinstance', 'issubclass', 'getattr', 'setattr', 'hasattr',
  'enumerate', 'zip', 'sorted', 'reversed', 'min', 'max', 'sum', 'abs',
]);

// ============================================================================
// Label detection from capture map
// ============================================================================

const getLabelFromCaptures = (captureMap: Record<string, any>): string | null => {
  // Skip imports (handled separately) and calls
  if (captureMap['import'] || captureMap['call']) return null;
  if (!captureMap['name']) return null;

  if (captureMap['definition.function']) return 'Function';
  if (captureMap['definition.class']) return 'Class';
  if (captureMap['definition.interface']) return 'Interface';
  if (captureMap['definition.method']) return 'Method';
  if (captureMap['definition.struct']) return 'Struct';
  if (captureMap['definition.enum']) return 'Enum';
  if (captureMap['definition.namespace']) return 'Namespace';
  if (captureMap['definition.module']) return 'Module';
  if (captureMap['definition.trait']) return 'Trait';
  if (captureMap['definition.impl']) return 'Impl';
  if (captureMap['definition.type']) return 'TypeAlias';
  if (captureMap['definition.const']) return 'Const';
  if (captureMap['definition.static']) return 'Static';
  if (captureMap['definition.typedef']) return 'Typedef';
  if (captureMap['definition.macro']) return 'Macro';
  if (captureMap['definition.union']) return 'Union';
  if (captureMap['definition.property']) return 'Property';
  if (captureMap['definition.record']) return 'Record';
  if (captureMap['definition.delegate']) return 'Delegate';
  if (captureMap['definition.annotation']) return 'Annotation';
  if (captureMap['definition.constructor']) return 'Constructor';
  if (captureMap['definition.template']) return 'Template';
  return 'CodeElement';
};

type PhpEnclosingType = { label: 'Class' | 'Interface' | 'Trait'; name: string };

const findEnclosingPhpType = (node: any): PhpEnclosingType | null => {
  let current = node?.parent;

  while (current) {
    if (current.type === 'class_declaration') {
      const nameNode = current.childForFieldName?.('name')
        || current.namedChildren?.find((c: any) => c.type === 'name');
      const name = nameNode?.text;
      return name ? { label: 'Class', name } : null;
    }

    if (current.type === 'interface_declaration') {
      const nameNode = current.childForFieldName?.('name')
        || current.namedChildren?.find((c: any) => c.type === 'name');
      const name = nameNode?.text;
      return name ? { label: 'Interface', name } : null;
    }

    if (current.type === 'trait_declaration') {
      const nameNode = current.childForFieldName?.('name')
        || current.namedChildren?.find((c: any) => c.type === 'name');
      const name = nameNode?.text;
      return name ? { label: 'Trait', name } : null;
    }

    current = current.parent;
  }

  return null;
};

const stripPhpClassConstantText = (value: string): string => value.trim().replace(/::class$/i, '').trim();

const getPhpBaseCallableName = (value: string): string => {
  const trimmed = value.trim().replace(/^\\+/, '');
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? trimmed;
};

const unwrapPhpParens = (expr: any): any => {
  let current = expr;
  while (current?.type === 'parenthesized_expression') {
    const inner = current.namedChildren?.[0];
    if (!inner) break;
    current = inner;
  }
  return current;
};

const getPhpCallArgumentExpressions = (argsNode: any): any[] => {
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

const inferPhpClassRefFromExpression = (expr: any): string | null => {
  const e = unwrapPhpParens(expr);
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
    if (!raw) return null;
    return raw.replace(/^\\+/, '');
  }

  if (e.type === 'function_call_expression') {
    const fnNode = e.childForFieldName?.('function') || e.childForFieldName?.('name');
    const fnText = String(fnNode?.text || '').trim();
    const fnName = getPhpBaseCallableName(fnText).toLowerCase();
    if (fnName !== 'app' && fnName !== 'resolve') return null;

    const argsNode = e.childForFieldName?.('arguments');
    const args = getPhpCallArgumentExpressions(argsNode);
    return inferFromTypeArg(args[0]);
  }

  if (e.type === 'member_call_expression') {
    const nameNode = e.childForFieldName?.('name');
    const methodName = String(nameNode?.text || '').trim().toLowerCase();
    if (methodName !== 'make' && methodName !== 'makewith') return null;

    const objectNode = unwrapPhpParens(e.childForFieldName?.('object'));
    if (!objectNode || objectNode.type !== 'function_call_expression') return null;

    const fnNode = objectNode.childForFieldName?.('function') || objectNode.childForFieldName?.('name');
    const fnText = String(fnNode?.text || '').trim();
    const fnName = getPhpBaseCallableName(fnText).toLowerCase();
    if (fnName !== 'app') return null;

    const appArgsNode = objectNode.childForFieldName?.('arguments');
    const appArgs = getPhpCallArgumentExpressions(appArgsNode);
    if (appArgs.length !== 0) return null;

    const argsNode = e.childForFieldName?.('arguments');
    const args = getPhpCallArgumentExpressions(argsNode);
    return inferFromTypeArg(args[0]);
  }

  if (e.type === 'scoped_call_expression') {
    const nameNode = e.childForFieldName?.('name');
    const methodName = String(nameNode?.text || '').trim().toLowerCase();
    if (methodName !== 'make' && methodName !== 'makewith') return null;

    const scopeNode = e.childForFieldName?.('scope');
    const scopeText = String(scopeNode?.text || '').trim();
    const scopeName = getPhpBaseCallableName(scopeText).toLowerCase();
    if (scopeName !== 'app') return null;

    const argsNode = e.childForFieldName?.('arguments');
    const args = getPhpCallArgumentExpressions(argsNode);
    return inferFromTypeArg(args[0]);
  }

  return null;
};

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

const extractPhpVarTypes = (rootNode: any, filePath: string): ExtractedPhpAssignment[] => {
  const assignments: ExtractedPhpAssignment[] = [];

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

          // named_type wraps (name|qualified_name)
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

      const sourceId = findEnclosingFunctionId(node, filePath);
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

const extractPhpTraitUses = (rootNode: any, filePath: string): ExtractedPhpTraitUse[] => {
  const traitUses: ExtractedPhpTraitUse[] = [];

  const visit = (node: any) => {
    if (!node) return;

    if (node.type === 'class_declaration') {
      const classNameNode = node.childForFieldName?.('name')
        || node.namedChildren?.find((c: any) => c.type === 'name');
      const className = classNameNode?.text;

      const bodyNode = node.childForFieldName?.('body')
        || node.namedChildren?.find((c: any) => c.type === 'declaration_list');
      const decls = bodyNode?.namedChildren || [];

      if (className) {
        for (const decl of decls) {
          if (decl.type !== 'use_declaration') continue;

          for (const child of decl.namedChildren || []) {
            if (child.type !== 'name' && child.type !== 'qualified_name') continue;
            const traitRef = String(child.text || '').trim();
            if (!traitRef) continue;
            traitUses.push({ filePath, className, traitRef });
          }
        }
      }
    }

    for (const child of node.namedChildren || []) {
      visit(child);
    }
  };

  visit(rootNode);
  return traitUses;
};

// ============================================================================
// Process a batch of files
// ============================================================================

const processBatch = (files: ParseWorkerInput[], onProgress?: (filesProcessed: number) => void): ParseWorkerResult => {
  const result: ParseWorkerResult = {
    nodes: [],
    relationships: [],
    symbols: [],
    imports: [],
    calls: [],
    heritage: [],
    phpAssignments: [],
    phpTraitUses: [],
    fileCount: 0,
  };

  // Group by language to minimize setLanguage calls
  const byLanguage = new Map<SupportedLanguages, ParseWorkerInput[]>();
  for (const file of files) {
    const lang = getLanguageFromFilename(file.path);
    if (!lang) continue;
    let list = byLanguage.get(lang);
    if (!list) {
      list = [];
      byLanguage.set(lang, list);
    }
    list.push(file);
  }

  let totalProcessed = 0;
  let lastReported = 0;
  const PROGRESS_INTERVAL = 100; // report every 100 files

  const onFileProcessed = onProgress ? () => {
    totalProcessed++;
    if (totalProcessed - lastReported >= PROGRESS_INTERVAL) {
      lastReported = totalProcessed;
      onProgress(totalProcessed);
    }
  } : undefined;

  for (const [language, langFiles] of byLanguage) {
    const queryString = LANGUAGE_QUERIES[language];
    if (!queryString) continue;

    // Track if we need to handle tsx separately
    const tsxFiles: ParseWorkerInput[] = [];
    const regularFiles: ParseWorkerInput[] = [];

    if (language === SupportedLanguages.TypeScript) {
      for (const f of langFiles) {
        if (f.path.endsWith('.tsx')) {
          tsxFiles.push(f);
        } else {
          regularFiles.push(f);
        }
      }
    } else {
      regularFiles.push(...langFiles);
    }

    // Process regular files for this language
    if (regularFiles.length > 0) {
      setLanguage(language, regularFiles[0].path);
      processFileGroup(regularFiles, language, queryString, result, onFileProcessed);
    }

    // Process tsx files separately (different grammar)
    if (tsxFiles.length > 0) {
      setLanguage(language, tsxFiles[0].path);
      processFileGroup(tsxFiles, language, queryString, result, onFileProcessed);
    }
  }

  return result;
};

const processFileGroup = (
  files: ParseWorkerInput[],
  language: SupportedLanguages,
  queryString: string,
  result: ParseWorkerResult,
  onFileProcessed?: () => void,
): void => {
  let query: any;
  try {
    const lang = parser.getLanguage();
    query = new Parser.Query(lang, queryString);
  } catch {
    return;
  }

  for (const file of files) {
    let tree;
    const content = getParseableContent(file.path, file.content);
    try {
      tree = parser.parse(content, undefined, { bufferSize: 1024 * 256 });
    } catch {
      continue;
    }

    result.fileCount++;
    onFileProcessed?.();

    let matches;
    try {
      matches = query.matches(tree.rootNode);
    } catch {
      continue;
    }

    for (const match of matches) {
      const captureMap: Record<string, any> = {};
      for (const c of match.captures) {
        captureMap[c.name] = c.node;
      }

      // Extract import paths before skipping
      if (captureMap['import'] && captureMap['import.source']) {
        const rawImportPath = captureMap['import.source'].text.replace(/['"<>]/g, '');
        result.imports.push({
          filePath: file.path,
          rawImportPath,
          language: language,
        });
        continue;
      }

      // Extract call sites
      if (captureMap['call']) {
        const callNameNode = captureMap['call.name'];
        if (callNameNode) {
          const calledName = callNameNode.text;
          if (!BUILT_INS.has(calledName)) {
            const callNode = captureMap['call'];
            const sourceId = findEnclosingFunctionId(callNode, file.path)
              || generateId('File', file.path);
            const extracted: ExtractedCall = { filePath: file.path, calledName, sourceId };

            if (language === SupportedLanguages.PHP) {
              extracted.startLine = callNode.startPosition.row;
              if (callNode.type === 'member_call_expression') {
                extracted.kind = 'member';
                const objectNode = callNode.childForFieldName?.('object');
                if (objectNode?.type === 'variable_name') {
                  extracted.receiver = objectNode.text;
                } else if (objectNode?.type === 'member_access_expression') {
                  const baseNode = objectNode.childForFieldName?.('object');
                  if (baseNode?.type === 'variable_name' && baseNode.text === '$this') {
                    extracted.receiver = objectNode.text;
                  }
                } else {
                  const classRef = inferPhpClassRefFromExpression(objectNode);
                  if (classRef) extracted.receiverClassRef = classRef;
                }
              } else if (callNode.type === 'scoped_call_expression') {
                extracted.kind = 'scoped';
                const scopeNode = callNode.childForFieldName?.('scope');
                extracted.scope = scopeNode?.text;
              } else if (callNode.type === 'function_call_expression') {
                extracted.kind = 'simple';
              }
            }

            result.calls.push(extracted);
          }
        }
        continue;
      }

      // Extract heritage (extends/implements)
      if (captureMap['heritage.class']) {
        if (captureMap['heritage.extends']) {
          result.heritage.push({
            filePath: file.path,
            className: captureMap['heritage.class'].text,
            parentName: captureMap['heritage.extends'].text,
            kind: 'extends',
          });
        }
        if (captureMap['heritage.implements']) {
          result.heritage.push({
            filePath: file.path,
            className: captureMap['heritage.class'].text,
            parentName: captureMap['heritage.implements'].text,
            kind: 'implements',
          });
        }
        if (captureMap['heritage.trait']) {
          result.heritage.push({
            filePath: file.path,
            className: captureMap['heritage.class'].text,
            parentName: captureMap['heritage.trait'].text,
            kind: 'trait-impl',
          });
        }
        if (captureMap['heritage.extends'] || captureMap['heritage.implements'] || captureMap['heritage.trait']) {
          continue;
        }
      }

      const nodeLabel = getLabelFromCaptures(captureMap);
      if (!nodeLabel) continue;

      const nameNode = captureMap['name'];
      const nodeName = nameNode.text;
      const nodeId = generateId(nodeLabel, `${file.path}:${nodeName}`);

      result.nodes.push({
        id: nodeId,
        label: nodeLabel,
        properties: {
          name: nodeName,
          filePath: file.path,
          startLine: nameNode.startPosition.row,
          endLine: nameNode.endPosition.row,
          language: language,
          isExported: isNodeExported(nameNode, nodeName, language),
        },
      });

      result.symbols.push({
        filePath: file.path,
        name: nodeName,
        nodeId,
        type: nodeLabel,
      });

      const fileId = generateId('File', file.path);
      const relId = generateId('DEFINES', `${fileId}->${nodeId}`);
      result.relationships.push({
        id: relId,
        sourceId: fileId,
        targetId: nodeId,
        type: 'DEFINES',
        confidence: 1.0,
        reason: '',
      });

      if (language === SupportedLanguages.PHP && nodeLabel === 'Method') {
        const methodNode = captureMap['definition.method'];
        const enclosing = methodNode ? findEnclosingPhpType(methodNode) : null;
        if (enclosing) {
          const containerId = generateId(enclosing.label, `${file.path}:${enclosing.name}`);
          const memberRelId = generateId('MEMBER_OF', `${nodeId}->${containerId}`);
          result.relationships.push({
            id: memberRelId,
            sourceId: nodeId,
            targetId: containerId,
            type: 'MEMBER_OF',
            confidence: 1.0,
            reason: 'php-enclosing-type',
          });
        }
      }
    }

    if (language === SupportedLanguages.PHP) {
      result.phpAssignments.push(...extractPhpVarTypes(tree.rootNode, file.path));
      result.phpTraitUses.push(...extractPhpTraitUses(tree.rootNode, file.path));
    }
  }
};

// ============================================================================
// Worker message handler
// ============================================================================

parentPort!.on('message', (files: ParseWorkerInput[]) => {
  const result = processBatch(files, (filesProcessed) => {
    parentPort!.postMessage({ type: 'progress', filesProcessed });
  });
  parentPort!.postMessage({ type: 'result', data: result });
});
