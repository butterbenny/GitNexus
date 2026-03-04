import { generateId } from '../../lib/utils.js';
import { KnowledgeGraph, GraphRelationship } from '../graph/types.js';

type PatternCatalogSection = {
  category: string;
  title: string;
  startLine: number;
  endLine: number;
  templateFiles: string[];
  alsoGoodFiles: string[];
  otherFiles: string[];
  content: string;
  findingCodes: string[];
};

const FINDING_CODE_REGEX = /\bFinding\s+code:\s*([A-Za-z0-9][A-Za-z0-9_-]{1,120})\b/i;
const FIXES_CODE_REGEX = /\bFixes:\s*([A-Za-z0-9][A-Za-z0-9_-]{1,120})\b/i;

const normalizeRepoRelativePath = (value: string): string => {
  return String(value || '').trim().replace(/\\/g, '/');
};

const extractBacktickFilePaths = (line: string): string[] => {
  const out: string[] = [];
  const re = /`([^`]+)`/g;
  let match: RegExpExecArray | null = null;
  while ((match = re.exec(line)) !== null) {
    const raw = normalizeRepoRelativePath(match[1] || '');
    if (!raw) continue;
    if (raw.includes(' ')) continue;
    if (!raw.includes('/')) continue;
    if (!/\.[a-z0-9]{1,8}$/i.test(raw)) continue;
    out.push(raw);
  }
  return out;
};

const extractFindingCodes = (content: string): string[] => {
  const codes = new Set<string>();
  const lines = String(content || '').split('\n');

  for (const line of lines) {
    const addCode = (raw: string) => {
      const normalized = String(raw || '').trim().toLowerCase().replace(/_/g, '-');
      if (/^[a-z0-9][a-z0-9-]{1,120}$/.test(normalized)) codes.add(normalized);
    };

    const findingMatch = FINDING_CODE_REGEX.exec(line);
    if (findingMatch?.[1]) addCode(findingMatch[1]);

    const fixesMatch = FIXES_CODE_REGEX.exec(line);
    if (fixesMatch?.[1]) addCode(fixesMatch[1]);

    if (/\bFixes:\b/i.test(line) || /\bFinding\s+code:\b/i.test(line)) {
      const tail = line.split(/(?:Fixes:|Finding\s+code:)/i)[1] || '';
      for (const part of tail.split(/[,|\s]+/g)) {
        const candidate = String(part || '').trim();
        if (!candidate) continue;
        addCode(candidate.replace(/[^A-Za-z0-9_-]/g, ''));
      }
    }
  }

  return Array.from(codes.values());
};

const parsePatternCatalogMarkdown = (content: string): PatternCatalogSection[] => {
  const lines = String(content || '').split('\n');
  const sections: PatternCatalogSection[] = [];

  let category = '';
  let mode: 'template' | 'also-good' | 'other' | null = null;
  let current: {
    category: string;
    title: string;
    startLine: number;
    endLine: number;
    templateFiles: string[];
    alsoGoodFiles: string[];
    otherFiles: string[];
    rawLines: string[];
    findingCodes: Set<string>;
  } | null = null;

  const finalize = (endLine: number) => {
    if (!current) return;
    const dedupe = (items: string[]) => Array.from(new Set(items.map(normalizeRepoRelativePath).filter(Boolean)));
    current.endLine = Math.max(current.startLine, endLine);
    const findingCodes = Array.from(current.findingCodes.values());
    sections.push({
      category: current.category,
      title: current.title,
      startLine: current.startLine,
      endLine: current.endLine,
      templateFiles: dedupe(current.templateFiles),
      alsoGoodFiles: dedupe(current.alsoGoodFiles),
      otherFiles: dedupe(current.otherFiles),
      content: current.rawLines.join('\n').trim(),
      findingCodes,
    });
    current = null;
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = String(lines[idx] || '');
    const trimmed = line.trim();
    const lineNo = idx + 1;

    if (trimmed.startsWith('## ')) {
      category = trimmed.slice(3).trim();
      mode = null;
      continue;
    }

    if (trimmed.startsWith('### ')) {
      finalize(lineNo - 1);
      current = {
        category,
        title: trimmed.slice(4).trim(),
        startLine: lineNo,
        endLine: lineNo,
        templateFiles: [],
        alsoGoodFiles: [],
        otherFiles: [],
        rawLines: [],
        findingCodes: new Set<string>(),
      };
      mode = null;
      continue;
    }

    if (!current) continue;
    current.rawLines.push(line);
    for (const code of extractFindingCodes(line)) current.findingCodes.add(code);

    const lowered = trimmed.toLowerCase();
    if (lowered === 'template:') {
      mode = 'template';
      continue;
    }
    if (lowered === 'also good:') {
      mode = 'also-good';
      continue;
    }
    if (lowered === 'notes:' || lowered === 'note:') {
      mode = 'other';
      continue;
    }

    const filePaths = extractBacktickFilePaths(line);
    if (filePaths.length === 0) continue;

    const target = mode === 'template'
      ? current.templateFiles
      : mode === 'also-good'
        ? current.alsoGoodFiles
        : current.otherFiles;
    target.push(...filePaths);
  }

  finalize(lines.length);
  return sections;
};

export const processPatternCatalogTemplates = (
  graph: KnowledgeGraph,
  files: Array<{ path: string; content: string }>,
  allFilePathSet: Set<string>,
): { nodeCount: number; edgeCount: number; sectionCount: number } => {
  const catalogPath = '.agents/review/pattern-catalog.md';
  const entry = files.find(file => normalizeRepoRelativePath(file.path) === catalogPath);
  if (!entry) return { nodeCount: 0, edgeCount: 0, sectionCount: 0 };

  const sections = parsePatternCatalogMarkdown(entry.content);
  if (sections.length === 0) return { nodeCount: 0, edgeCount: 0, sectionCount: 0 };

  const catalogFileId = generateId('File', catalogPath);
  const catalogFileExists = allFilePathSet.has(catalogPath);

  let nodeCount = 0;
  let edgeCount = 0;
  const findingValueNodesCreated = new Set<string>();

  const addRel = (rel: GraphRelationship) => {
    graph.addRelationship(rel);
    edgeCount += 1;
  };

  for (const section of sections) {
    const key = `pattern-catalog:${section.category}:${section.title}`.trim();
    if (!key) continue;

    const sectionId = generateId('CodeElement', key);
    graph.addNode({
      id: sectionId,
      label: 'CodeElement',
      properties: {
        name: section.title,
        filePath: catalogPath,
        startLine: section.startLine,
        endLine: section.endLine,
        isExported: false,
        content: [
          section.category ? `Category: ${section.category}` : '',
          section.content,
          section.templateFiles.length > 0 ? `\nTemplate:\n- ${section.templateFiles.join('\n- ')}` : '',
          section.alsoGoodFiles.length > 0 ? `\nAlso good:\n- ${section.alsoGoodFiles.join('\n- ')}` : '',
          section.otherFiles.length > 0 ? `\nNotes:\n- ${section.otherFiles.join('\n- ')}` : '',
        ]
          .filter(Boolean)
          .join('\n')
          .trim(),
      },
    });
    nodeCount += 1;

    if (catalogFileExists) {
      addRel({
        id: generateId('DEFINES', `${catalogFileId}->${sectionId}`),
        type: 'DEFINES',
        sourceId: catalogFileId,
        targetId: sectionId,
        confidence: 1.0,
        reason: 'pattern-catalog:section',
      });
    }

    for (const code of section.findingCodes || []) {
      const valueKey = `finding_code:${code}`;
      const valueId = generateId('ValueNode', valueKey);
      if (!findingValueNodesCreated.has(valueId)) {
        findingValueNodesCreated.add(valueId);
        graph.addNode({
          id: valueId,
          label: 'ValueNode',
          properties: {
            name: code,
            filePath: '',
            heuristicLabel: 'FindingCode',
            valueType: 'finding_code',
            valueKey,
            valueRaw: code,
          },
        });
        nodeCount += 1;
      }

      addRel({
        id: generateId('USES', `${sectionId}->${valueId}:pattern-catalog:fixes`),
        type: 'USES',
        sourceId: sectionId,
        targetId: valueId,
        confidence: 1.0,
        reason: 'pattern-catalog:fixes',
      });
    }

    const pushTemplateEdge = (filePathRaw: string, reason: string) => {
      const filePath = normalizeRepoRelativePath(filePathRaw);
      if (!filePath) return;
      if (!allFilePathSet.has(filePath)) return;
      const fileId = generateId('File', filePath);
      addRel({
        id: generateId('USES', `${sectionId}->${fileId}:${reason}`),
        type: 'USES',
        sourceId: sectionId,
        targetId: fileId,
        confidence: 1.0,
        reason,
      });
    };

    for (const filePath of section.templateFiles) pushTemplateEdge(filePath, 'pattern-catalog:template');
    for (const filePath of section.alsoGoodFiles) pushTemplateEdge(filePath, 'pattern-catalog:also-good');
    for (const filePath of section.otherFiles) pushTemplateEdge(filePath, 'pattern-catalog:other');
  }

  return { nodeCount, edgeCount, sectionCount: sections.length };
};
