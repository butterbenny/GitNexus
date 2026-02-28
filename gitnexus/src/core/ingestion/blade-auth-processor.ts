import { KnowledgeGraph } from '../graph/types.js';
import { generateId } from '../../lib/utils.js';
import { SymbolTable, SymbolDefinition } from './symbol-table.js';

type BladeDirective = {
  directive: '@can' | '@cannot' | '@canany';
  slug: string;
};

const extractBladePermissionSlugs = (content: string): BladeDirective[] => {
  const results: BladeDirective[] = [];

  for (const match of content.matchAll(/@can\s*\(\s*(['"])([^'"]+)\1/g)) {
    const raw = match[2]?.trim();
    if (!raw) continue;
    if (!raw.includes('.')) continue;
    results.push({ directive: '@can', slug: raw });
  }

  for (const match of content.matchAll(/@cannot\s*\(\s*(['"])([^'"]+)\1/g)) {
    const raw = match[2]?.trim();
    if (!raw) continue;
    if (!raw.includes('.')) continue;
    results.push({ directive: '@cannot', slug: raw });
  }

  for (const match of content.matchAll(/@canany\s*\(\s*\[([\s\S]*?)\]/g)) {
    const inner = match[1] || '';
    for (const sm of inner.matchAll(/['"]([^'"]+)['"]/g)) {
      const raw = sm[1]?.trim();
      if (!raw) continue;
      if (!raw.includes('.')) continue;
      results.push({ directive: '@canany', slug: raw });
    }
  }

  const seen = new Set<string>();
  const uniq: BladeDirective[] = [];
  for (const r of results) {
    const key = `${r.directive}:${r.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(r);
  }
  return uniq;
};

const buildPermissionSlugIdSet = (graph: KnowledgeGraph): Set<string> => {
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    const id = node?.id;
    if (!id) continue;
    if (!id.startsWith('CodeElement:permission:')) continue;
    ids.add(id);
  }
  return ids;
};

const hasPermissionSlugNode = (
  slug: string,
  permissionSlugNodeIds: Set<string>,
  symbolTable: SymbolTable,
): boolean => {
  const slugNodeId = generateId('CodeElement', `permission:${slug}`);
  if (permissionSlugNodeIds.has(slugNodeId)) return true;

  const defs = symbolTable.lookupFuzzy(slug);
  return defs.some((def: SymbolDefinition) => def.nodeId === slugNodeId);
};

export const processBladeAuthorization = (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  symbolTable: SymbolTable,
): { edgesAdded: number } => {
  const permissionSlugNodeIds = buildPermissionSlugIdSet(graph);
  let edgesAdded = 0;

  for (const file of files) {
    if (!file.path.endsWith('.blade.php')) continue;
    if (!file.content) continue;

    const directives = extractBladePermissionSlugs(file.content);
    if (directives.length === 0) continue;

    const templateId = generateId('Template', file.path);

    for (const d of directives) {
      if (!hasPermissionSlugNode(d.slug, permissionSlugNodeIds, symbolTable)) continue;
      const slugNodeId = generateId('CodeElement', `permission:${d.slug}`);
      const reason = `blade-auth:${d.directive}:${d.slug}`;
      const relId = generateId('CALLS', `${templateId}:${reason}->${slugNodeId}`);
      graph.addRelationship({
        id: relId,
        type: 'CALLS',
        sourceId: templateId,
        targetId: slugNodeId,
        confidence: 0.95,
        reason,
      });
      edgesAdded++;
    }
  }

  return { edgesAdded };
};

