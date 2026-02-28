import { KnowledgeGraph, GraphNode, GraphRelationship } from '../graph/types.js';
import { generateId } from '../../lib/utils.js';

const BLADE_SUFFIX = '.blade.php';

type BladeTemplateInfo = {
  filePath: string;
  viewRoot: string;
  viewName: string;
  templateId: string;
  lineCount: number;
};

const resolveBladeViewInfo = (filePath: string): { viewRoot: string; viewName: string } | null => {
  if (!filePath.endsWith(BLADE_SUFFIX)) return null;

  const segment = 'resources/views/';
  if (filePath.startsWith(segment)) {
    const rel = filePath.slice(segment.length, -BLADE_SUFFIX.length);
    if (!rel) return null;
    return { viewRoot: '', viewName: rel.replace(/\//g, '.') };
  }

  const idx = filePath.indexOf(`/${segment}`);
  if (idx < 0) return null;
  const viewRoot = filePath.slice(0, idx + 1);
  const rel = filePath.slice(idx + 1 + segment.length, -BLADE_SUFFIX.length);
  if (!rel) return null;
  return { viewRoot, viewName: rel.replace(/\//g, '.') };
};

const extractQuotedViewArgs = (content: string, re: RegExp): string[] => {
  const results: string[] = [];
  for (const match of content.matchAll(re)) {
    const viewName = match[1]?.trim();
    if (!viewName) continue;
    results.push(viewName);
  }
  return results;
};

const normalizeBladeViteAssetPath = (value: string): string | null => {
  let v = value.trim();
  if (!v) return null;
  if (v.includes('://')) return null;
  v = v.replace(/\\/g, '/');
  v = v.replace(/^\/+/, '');
  v = v.replace(/\/{2,}/g, '/');
  if (!v) return null;
  if (!v.includes('/')) return null;
  return v;
};

const extractBladeViteAssets = (content: string): string[] => {
  const assets: string[] = [];

  for (const match of content.matchAll(/@vite\s*\(([\s\S]*?)\)/g)) {
    const args = match[1];
    if (!args) continue;
    for (const stringMatch of args.matchAll(/['"]([^'"]+)['"]/g)) {
      const raw = stringMatch[1]?.trim();
      if (!raw) continue;
      const normalized = normalizeBladeViteAssetPath(raw);
      if (!normalized) continue;
      assets.push(normalized);
    }
  }

  return Array.from(new Set(assets));
};

const extractBladeTemplateRefs = (content: string): { extends: string[]; imports: string[] } => {
  const extendsViews = extractQuotedViewArgs(
    content,
    /@extends\s*\(\s*['"]([^'"]+)['"]/g
  );

  const imports: string[] = [];
  imports.push(
    ...extractQuotedViewArgs(content, /@include(?:If|When|Unless)?\s*\(\s*['"]([^'"]+)['"]/g),
    ...extractQuotedViewArgs(content, /@component(?:If)?\s*\(\s*['"]([^'"]+)['"]/g),
    ...extractQuotedViewArgs(content, /@each\s*\(\s*['"]([^'"]+)['"]/g),
  );

  // @includeFirst(['a', 'b']) — treat each candidate as an import edge (confidence-first: no guessing beyond literals).
  for (const match of content.matchAll(/@includeFirst\s*\(\s*\[([\s\S]*?)\]/g)) {
    const raw = match[1] || '';
    for (const inner of String(raw).matchAll(/['"]([^'"]+)['"]/g)) {
      const viewName = inner[1]?.trim();
      if (!viewName) continue;
      imports.push(viewName);
    }
  }

  // Anonymous component tags: <x-foo.bar> -> resources/views/components/foo/bar.blade.php
  for (const match of content.matchAll(/<x-([A-Za-z0-9_.:-]+)\b/g)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    if (raw.includes('::')) continue; // vendor / namespaced component
    if (raw.includes(':')) continue;  // treat as namespaced component
    imports.push(`components.${raw}`);
  }

  return {
    extends: Array.from(new Set(extendsViews)),
    imports: Array.from(new Set(imports)),
  };
};

const viewKey = (viewRoot: string, viewName: string): string => `${viewRoot}::${viewName}`;

export const processBladeTemplates = (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
): { templatesCreated: number; relationshipsAdded: number } => {
  const allFilePaths = new Set(files.map(f => f.path));

  const bladeFiles = files.filter(f => {
    if (!f.path.endsWith(BLADE_SUFFIX)) return false;
    return resolveBladeViewInfo(f.path) !== null;
  });
  if (bladeFiles.length === 0) return { templatesCreated: 0, relationshipsAdded: 0 };

  const templates: BladeTemplateInfo[] = bladeFiles.map(f => {
    const lineCount = Math.max(1, f.content.split('\n').length);
    const viewInfo = resolveBladeViewInfo(f.path);
    if (!viewInfo) {
      throw new Error(`Unexpected blade template outside resources/views: ${f.path}`);
    }
    return {
      filePath: f.path,
      viewRoot: viewInfo.viewRoot,
      viewName: viewInfo.viewName,
      templateId: generateId('Template', f.path),
      lineCount,
    };
  });

  const viewNameToTemplateId = new Map<string, string>();
  for (const t of templates) {
    viewNameToTemplateId.set(viewKey(t.viewRoot, t.viewName), t.templateId);
  }

  let relationshipsAdded = 0;

  for (const t of templates) {
    const node: GraphNode = {
      id: t.templateId,
      label: 'Template',
      properties: {
        name: t.viewName,
        filePath: t.filePath,
        startLine: 0,
        endLine: t.lineCount - 1,
        language: 'blade',
      },
    };
    graph.addNode(node);

    const fileId = generateId('File', t.filePath);
    const definesId = generateId('DEFINES', `${fileId}->${t.templateId}`);
    const defines: GraphRelationship = {
      id: definesId,
      type: 'DEFINES',
      sourceId: fileId,
      targetId: t.templateId,
      confidence: 1.0,
      reason: '',
    };
    graph.addRelationship(defines);
    relationshipsAdded++;
  }

  const fileByPath = new Map<string, { path: string; content: string }>();
  for (const f of bladeFiles) fileByPath.set(f.path, f);

  for (const t of templates) {
    const file = fileByPath.get(t.filePath);
    if (!file) continue;

    const refs = extractBladeTemplateRefs(file.content);
    const viteAssets = extractBladeViteAssets(file.content);

    for (const viewName of refs.extends) {
      const targetId = viewNameToTemplateId.get(viewKey(t.viewRoot, viewName));
      if (!targetId) continue;
      const relId = generateId('EXTENDS', `${t.templateId}->${targetId}`);
      graph.addRelationship({
        id: relId,
        type: 'EXTENDS',
        sourceId: t.templateId,
        targetId,
        confidence: 1.0,
        reason: 'blade-extends',
      });
      relationshipsAdded++;
    }

    for (const viewName of refs.imports) {
      const targetId = viewNameToTemplateId.get(viewKey(t.viewRoot, viewName));
      if (!targetId) continue;
      const relId = generateId('IMPORTS', `${t.templateId}->${targetId}`);
      graph.addRelationship({
        id: relId,
        type: 'IMPORTS',
        sourceId: t.templateId,
        targetId,
        confidence: 1.0,
        reason: 'blade-import',
      });
      relationshipsAdded++;
    }

    for (const assetPath of viteAssets) {
      const resolvedAssetPath = `${t.viewRoot}${assetPath}`;
      if (!allFilePaths.has(resolvedAssetPath)) continue;

      const targetId = generateId('File', resolvedAssetPath);
      const relId = generateId('IMPORTS', `${t.templateId}->${targetId}`);
      graph.addRelationship({
        id: relId,
        type: 'IMPORTS',
        sourceId: t.templateId,
        targetId,
        confidence: 1.0,
        reason: 'blade-vite',
      });
      relationshipsAdded++;
    }
  }

  return { templatesCreated: templates.length, relationshipsAdded };
};

export const processBladeTemplatesIncremental = (
  graph: KnowledgeGraph,
  filesToProcess: { path: string; content: string }[],
  opts: {
    /** All Blade template file paths in the repo (used for viewName→Template resolution). */
    allBladeTemplatePaths: string[];
    /** All file paths in the repo (used for @vite asset links). */
    allFilePaths: Set<string>;
    /** Blade template paths that are being rebuilt (Template nodes/DEFINES should be re-created). */
    rebuildBladePaths: Set<string>;
  }
): { templatesCreated: number; relationshipsAdded: number } => {
  const bladeFiles = filesToProcess
    .filter(f => f.path.endsWith(BLADE_SUFFIX))
    .filter(f => resolveBladeViewInfo(f.path) !== null);

  if (bladeFiles.length === 0) return { templatesCreated: 0, relationshipsAdded: 0 };

  // Build viewName → TemplateId mapping from ALL blade template paths (path-only, no content needed).
  const viewNameToTemplateId = new Map<string, string>();
  for (const fp of opts.allBladeTemplatePaths) {
    const viewInfo = resolveBladeViewInfo(fp);
    if (!viewInfo) continue;
    viewNameToTemplateId.set(viewKey(viewInfo.viewRoot, viewInfo.viewName), generateId('Template', fp));
  }

  let templatesCreated = 0;
  let relationshipsAdded = 0;

  for (const file of bladeFiles) {
    const viewInfo = resolveBladeViewInfo(file.path);
    if (!viewInfo) continue;

    const templateId = generateId('Template', file.path);
    const lineCount = Math.max(1, file.content.split('\n').length);

    // Only recreate Template nodes + DEFINES when the blade file itself is rebuilt.
    if (opts.rebuildBladePaths.has(file.path)) {
      graph.addNode({
        id: templateId,
        label: 'Template',
        properties: {
          name: viewInfo.viewName,
          filePath: file.path,
          startLine: 0,
          endLine: lineCount - 1,
          language: 'blade',
        },
      } as GraphNode);
      templatesCreated++;

      const fileId = generateId('File', file.path);
      const definesId = generateId('DEFINES', `${fileId}->${templateId}`);
      graph.addRelationship({
        id: definesId,
        type: 'DEFINES',
        sourceId: fileId,
        targetId: templateId,
        confidence: 1.0,
        reason: '',
      } as GraphRelationship);
      relationshipsAdded++;
    }

    const refs = extractBladeTemplateRefs(file.content);
    const viteAssets = extractBladeViteAssets(file.content);

    for (const viewName of refs.extends) {
      const targetId = viewNameToTemplateId.get(viewKey(viewInfo.viewRoot, viewName));
      if (!targetId) continue;
      const relId = generateId('EXTENDS', `${templateId}->${targetId}`);
      graph.addRelationship({
        id: relId,
        type: 'EXTENDS',
        sourceId: templateId,
        targetId,
        confidence: 1.0,
        reason: 'blade-extends',
      });
      relationshipsAdded++;
    }

    for (const viewName of refs.imports) {
      const targetId = viewNameToTemplateId.get(viewKey(viewInfo.viewRoot, viewName));
      if (!targetId) continue;
      const relId = generateId('IMPORTS', `${templateId}->${targetId}`);
      graph.addRelationship({
        id: relId,
        type: 'IMPORTS',
        sourceId: templateId,
        targetId,
        confidence: 1.0,
        reason: 'blade-import',
      });
      relationshipsAdded++;
    }

    for (const assetPath of viteAssets) {
      const resolvedAssetPath = `${viewInfo.viewRoot}${assetPath}`;
      if (!opts.allFilePaths.has(resolvedAssetPath)) continue;

      const targetId = generateId('File', resolvedAssetPath);
      const relId = generateId('IMPORTS', `${templateId}->${targetId}`);
      graph.addRelationship({
        id: relId,
        type: 'IMPORTS',
        sourceId: templateId,
        targetId,
        confidence: 1.0,
        reason: 'blade-vite',
      });
      relationshipsAdded++;
    }
  }

  return { templatesCreated, relationshipsAdded };
};
