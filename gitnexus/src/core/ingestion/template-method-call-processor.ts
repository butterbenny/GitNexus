import { KnowledgeGraph } from '../graph/types.js';
import type { SymbolDefinition, SymbolTable } from './symbol-table.js';
import { generateId } from '../../lib/utils.js';

type TemplateMethodCall = {
  receiverHint: string;
  methodName: string;
  hasArgs: boolean;
};

const isTemplateFile = (filePath: string): boolean => {
  return filePath.endsWith('.blade.php') || filePath.endsWith('.mjml');
};

const TEMPLATE_METHOD_CALL_RE = /(\$?[A-Za-z_][A-Za-z0-9_]*)\s*(?:\?->|->)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

const toPascalCase = (value: string): string => {
  const raw = value.trim().replace(/^\$+/, '');
  if (!raw) return '';

  const parts = raw.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return '';
  return parts.map(p => (p ? `${p[0].toUpperCase()}${p.slice(1)}` : '')).join('');
};

const normalizePath = (value: string): string => value.replace(/\\/g, '/');

const extractTemplateMethodCalls = (content: string): TemplateMethodCall[] => {
  const calls: TemplateMethodCall[] = [];

  for (const match of content.matchAll(TEMPLATE_METHOD_CALL_RE)) {
    const receiverRaw = String(match[1] || '').trim();
    const methodName = String(match[2] || '').trim();
    if (!receiverRaw || !methodName) continue;

    const receiverHint = receiverRaw.replace(/^\$+/, '');
    if (!receiverHint) continue;

    const matchIndex = match.index ?? -1;
    const openParenIndex = matchIndex >= 0 ? matchIndex + match[0].length : -1; // points right after '('
    let hasArgs = false;
    if (openParenIndex >= 0 && openParenIndex < content.length) {
      let i = openParenIndex;
      while (i < content.length && /\s/.test(content[i])) i++;
      hasArgs = content[i] !== ')';
    }

    calls.push({ receiverHint, methodName, hasArgs });
  }

  return calls;
};

const pickTargetMethod = (
  candidates: SymbolDefinition[],
  receiverHint: string,
): { targetId: string; confidence: number; reason: string } | null => {
  const methods = candidates.filter(d => d.type === 'Method');
  if (methods.length === 0) return null;

  if (methods.length === 1) {
    return {
      targetId: methods[0].nodeId,
      confidence: 0.9,
      reason: 'template-method:unique',
    };
  }

  const receiverClass = toPascalCase(receiverHint);
  if (!receiverClass) return null;

  const classMatches = methods.filter(m => normalizePath(m.filePath).endsWith(`/${receiverClass}.php`));
  if (classMatches.length === 1) {
    return {
      targetId: classMatches[0].nodeId,
      confidence: 0.95,
      reason: `template-method:receiver:${receiverClass}`,
    };
  }

  // Common Laravel pattern: "stringy" templates call methods provided by shared traits.
  // If the receiver hint doesn't map to a defining class file, prefer a unique trait method.
  const traitMatches = methods.filter(m => normalizePath(m.filePath).toLowerCase().includes('/traits/'));
  if (traitMatches.length === 1) {
    return {
      targetId: traitMatches[0].nodeId,
      confidence: 0.8,
      reason: `template-method:trait-default:${receiverClass}`,
    };
  }

  return null;
};

export const processTemplateMethodCallWiring = (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  symbolTable: SymbolTable,
): { edgesAdded: number } => {
  let edgesAdded = 0;

  for (const file of files) {
    if (!isTemplateFile(file.path)) continue;

    const calls = extractTemplateMethodCalls(file.content);
    if (calls.length === 0) continue;

    const sourceId = generateId('File', file.path);

    const seen = new Set<string>();
    for (const call of calls) {
      const candidates = symbolTable.lookupFuzzy(call.methodName);
      const resolved = pickTargetMethod(candidates, call.receiverHint);
      if (!resolved) continue;

      const key = `${resolved.targetId}::${call.methodName}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const reason = `${resolved.reason}:${call.methodName}`;
      const relId = generateId('CALLS', `${sourceId}:${reason}->${resolved.targetId}`);
      graph.addRelationship({
        id: relId,
        type: 'CALLS',
        sourceId,
        targetId: resolved.targetId,
        confidence: resolved.confidence,
        reason,
      });
      edgesAdded++;
    }
  }

  return { edgesAdded };
};
