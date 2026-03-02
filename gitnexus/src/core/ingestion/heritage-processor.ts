/**
 * Heritage Processor
 * 
 * Extracts class inheritance relationships:
 * - EXTENDS: Class extends another Class (TS, JS, Python)
 * - IMPLEMENTS: Class implements an Interface (TS only)
 */

import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import { SymbolTable } from './symbol-table.js';
import Parser from 'tree-sitter';
import { loadParser, loadLanguage } from '../tree-sitter/parser-loader.js';
import { LANGUAGE_QUERIES } from './tree-sitter-queries.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename, getParseableContent, yieldToEventLoop } from './utils.js';
import type { ExtractedHeritage } from './workers/parse-worker.js';
import type { SymbolDefinition } from './symbol-table.js';

const resolveUniqueDefinition = (
  defs: SymbolDefinition[],
  allowedTypes: Set<string>,
): SymbolDefinition | null => {
  const filtered = defs.filter(d => allowedTypes.has(d.type));
  if (filtered.length === 1) return filtered[0];
  return null;
};

export const processHeritage = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  symbolTable: SymbolTable,
  onProgress?: (current: number, total: number) => void
) => {
  const parser = await loadParser();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress?.(i + 1, files.length);
    if (i % 20 === 0) await yieldToEventLoop();

    // 1. Check language support
    const language = getLanguageFromFilename(file.path);
    if (!language) continue;

    const queryStr = LANGUAGE_QUERIES[language];
    if (!queryStr) continue;

    // 2. Load the language
    await loadLanguage(language, file.path);

    // 3. Get AST
    let tree = astCache.get(file.path);

    if (!tree) {
      // Use larger bufferSize for files > 32KB
      try {
        const content = getParseableContent(file.path, file.content);
        tree = parser.parse(content, undefined, { bufferSize: 1024 * 256 });
      } catch (parseError) {
        // Skip files that can't be parsed
        continue;
      }
      // Cache re-parsed tree for potential future use
      astCache.set(file.path, tree);
    }

    let query;
    let matches;
    try {
      const language = parser.getLanguage();
      query = new Parser.Query(language, queryStr);
      matches = query.matches(tree.rootNode);
    } catch (queryError) {
      console.warn(`Heritage query error for ${file.path}:`, queryError);
      continue;
    }

    // 4. Process heritage matches
    matches.forEach(match => {
      const captureMap: Record<string, any> = {};
      match.captures.forEach(c => {
        captureMap[c.name] = c.node;
      });

      // EXTENDS: Class extends another Class
      if (captureMap['heritage.class'] && captureMap['heritage.extends']) {
        const className = captureMap['heritage.class'].text;
        const parentClassName = captureMap['heritage.extends'].text;

        // Resolve both class IDs
        const childId = symbolTable.lookupExact(file.path, className)
          ?? resolveUniqueDefinition(symbolTable.lookupFuzzy(className), new Set(['Class', 'Interface']))?.nodeId
          ?? null;

        const parentId = resolveUniqueDefinition(symbolTable.lookupFuzzy(parentClassName), new Set(['Class', 'Interface']))?.nodeId
          ?? null;

        if (childId && parentId && childId !== parentId) {
          const relId = generateId('EXTENDS', `${childId}->${parentId}`);
          
          graph.addRelationship({
            id: relId,
            sourceId: childId,
            targetId: parentId,
            type: 'EXTENDS',
            confidence: 1.0,
            reason: '',
          });
        }
      }

      // IMPLEMENTS: Class implements Interface (TypeScript only)
      if (captureMap['heritage.class'] && captureMap['heritage.implements']) {
        const className = captureMap['heritage.class'].text;
        const interfaceName = captureMap['heritage.implements'].text;

        // Resolve class and interface IDs
        const classId = symbolTable.lookupExact(file.path, className)
          ?? resolveUniqueDefinition(symbolTable.lookupFuzzy(className), new Set(['Class']))?.nodeId
          ?? null;

        const interfaceId = resolveUniqueDefinition(symbolTable.lookupFuzzy(interfaceName), new Set(['Interface']))?.nodeId
          ?? null;

        if (classId && interfaceId) {
          const relId = generateId('IMPLEMENTS', `${classId}->${interfaceId}`);
          
          graph.addRelationship({
            id: relId,
            sourceId: classId,
            targetId: interfaceId,
            type: 'IMPLEMENTS',
            confidence: 1.0,
            reason: '',
          });
        }
      }

      // IMPLEMENTS (Rust): impl Trait for Struct
      if (captureMap['heritage.trait'] && captureMap['heritage.class']) {
        const structName = captureMap['heritage.class'].text;
        const traitName = captureMap['heritage.trait'].text;

        // Resolve struct and trait IDs
        const structId = symbolTable.lookupExact(file.path, structName)
          ?? resolveUniqueDefinition(symbolTable.lookupFuzzy(structName), new Set(['Struct']))?.nodeId
          ?? null;

        const traitId = resolveUniqueDefinition(symbolTable.lookupFuzzy(traitName), new Set(['Trait']))?.nodeId
          ?? null;

        if (structId && traitId) {
          const relId = generateId('IMPLEMENTS', `${structId}->${traitId}`);
          
          graph.addRelationship({
            id: relId,
            sourceId: structId,
            targetId: traitId,
            type: 'IMPLEMENTS',
            confidence: 1.0,
            reason: 'trait-impl',
          });
        }
      }
    });

    // Tree is now owned by the LRU cache — no manual delete needed
  }
};

/**
 * Fast path: resolve pre-extracted heritage from workers.
 * No AST parsing — workers already extracted className + parentName + kind.
 */
export const processHeritageFromExtracted = async (
  graph: KnowledgeGraph,
  extractedHeritage: ExtractedHeritage[],
  symbolTable: SymbolTable,
  onProgress?: (current: number, total: number) => void
) => {
  const total = extractedHeritage.length;

  for (let i = 0; i < extractedHeritage.length; i++) {
    if (i % 500 === 0) {
      onProgress?.(i, total);
      await yieldToEventLoop();
    }

    const h = extractedHeritage[i];

    if (h.kind === 'extends') {
      const childId = symbolTable.lookupExact(h.filePath, h.className)
        ?? resolveUniqueDefinition(symbolTable.lookupFuzzy(h.className), new Set(['Class', 'Interface']))?.nodeId
        ?? null;

      const parentId = resolveUniqueDefinition(symbolTable.lookupFuzzy(h.parentName), new Set(['Class', 'Interface']))?.nodeId
        ?? null;

      if (childId && parentId && childId !== parentId) {
        graph.addRelationship({
          id: generateId('EXTENDS', `${childId}->${parentId}`),
          sourceId: childId,
          targetId: parentId,
          type: 'EXTENDS',
          confidence: 1.0,
          reason: '',
        });
      }
    } else if (h.kind === 'implements') {
      const classId = symbolTable.lookupExact(h.filePath, h.className)
        ?? resolveUniqueDefinition(symbolTable.lookupFuzzy(h.className), new Set(['Class']))?.nodeId
        ?? null;

      const interfaceId = resolveUniqueDefinition(symbolTable.lookupFuzzy(h.parentName), new Set(['Interface']))?.nodeId
        ?? null;

      if (classId && interfaceId) {
        graph.addRelationship({
          id: generateId('IMPLEMENTS', `${classId}->${interfaceId}`),
          sourceId: classId,
          targetId: interfaceId,
          type: 'IMPLEMENTS',
          confidence: 1.0,
          reason: '',
        });
      }
    } else if (h.kind === 'trait-impl') {
      const structId = symbolTable.lookupExact(h.filePath, h.className)
        ?? resolveUniqueDefinition(symbolTable.lookupFuzzy(h.className), new Set(['Struct']))?.nodeId
        ?? null;

      const traitId = resolveUniqueDefinition(symbolTable.lookupFuzzy(h.parentName), new Set(['Trait']))?.nodeId
        ?? null;

      if (structId && traitId) {
        graph.addRelationship({
          id: generateId('IMPLEMENTS', `${structId}->${traitId}`),
          sourceId: structId,
          targetId: traitId,
          type: 'IMPLEMENTS',
          confidence: 1.0,
          reason: 'trait-impl',
        });
      }
    }
  }

  onProgress?.(total, total);
};
