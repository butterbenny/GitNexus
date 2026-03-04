import { generateId } from '../../lib/utils.js';
import { KnowledgeGraph, GraphRelationship } from '../graph/types.js';

type MarkdownSection = {
  title: string;
  level: number;
  startLine: number;
  endLine: number;
  content: string;
  referencedFiles: string[];
};

const FINDING_CODE_REGEX = /\bFinding\s+code:\s*([A-Za-z0-9][A-Za-z0-9_-]{1,120})\b/i;

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

const stripLeadingCommentHash = (line: string): string => {
  return String(line || '').replace(/^#\s?/, '');
};

const extractFindingCodes = (content: string): string[] => {
  const codes = new Set<string>();
  const lines = String(content || '').split('\n');

  for (const line of lines) {
    const match = FINDING_CODE_REGEX.exec(line);
    if (match?.[1]) {
      const raw = String(match[1] || '').trim();
      const normalized = raw.toLowerCase().replace(/_/g, '-');
      if (/^[a-z0-9][a-z0-9-]{1,120}$/.test(normalized)) codes.add(normalized);
    }

    // Allow "Finding code: a, b, c" and similar multi-value lines.
    if (/\bFinding\s+code:\b/i.test(line)) {
      const tail = line.split(/Finding\s+code:/i)[1] || '';
      for (const part of tail.split(/[,|\s]+/g)) {
        const candidate = String(part || '').trim();
        if (!candidate) continue;
        const normalized = candidate.toLowerCase().replace(/_/g, '-').replace(/[^a-z0-9-]/g, '');
        if (/^[a-z0-9][a-z0-9-]{1,120}$/.test(normalized)) codes.add(normalized);
      }
    }
  }

  return Array.from(codes.values());
};

const parseMarkdownSections = (content: string): MarkdownSection[] => {
  const lines = String(content || '').split('\n');
  const sections: MarkdownSection[] = [];

  let current: {
    title: string;
    level: number;
    startLine: number;
    rawLines: string[];
  } | null = null;

  const finalize = (endLine: number) => {
    if (!current) return;
    const referencedFiles = Array.from(new Set(current.rawLines.flatMap(line => extractBacktickFilePaths(line))));
    sections.push({
      title: current.title,
      level: current.level,
      startLine: current.startLine,
      endLine: Math.max(current.startLine, endLine),
      content: current.rawLines.join('\n').trim(),
      referencedFiles,
    });
    current = null;
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = String(lines[idx] || '');
    const trimmed = line.trimEnd();
    const lineNo = idx + 1;

    const heading = /^(#{2,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      finalize(lineNo - 1);
      current = {
        title: String(heading[2] || '').trim(),
        level: heading[1].length,
        startLine: lineNo,
        rawLines: [],
      };
      continue;
    }

    if (current) current.rawLines.push(line);
  }

  finalize(lines.length);

  return sections.filter(section => section.title && section.level >= 2 && section.level <= 4);
};

const parseCommentPrefixedGuidelineSections = (content: string): MarkdownSection[] => {
  const rawLines = String(content || '').split('\n');
  const lines = rawLines.map(stripLeadingCommentHash);
  const sections: MarkdownSection[] = [];

  let current: {
    title: string;
    level: number;
    startLine: number;
    rawLines: string[];
  } | null = null;

  const isSeparator = (line: string): boolean => {
    const trimmed = String(line || '').trim();
    return /^-{8,}$/.test(trimmed);
  };

  const finalize = (endLine: number) => {
    if (!current) return;
    const referencedFiles = Array.from(new Set(current.rawLines.flatMap(line => extractBacktickFilePaths(line))));
    sections.push({
      title: current.title,
      level: current.level,
      startLine: current.startLine,
      endLine: Math.max(current.startLine, endLine),
      content: current.rawLines.join('\n').trim(),
      referencedFiles,
    });
    current = null;
  };

  const startSection = (title: string, startLine: number) => {
    current = {
      title: String(title || '').trim(),
      level: 2,
      startLine,
      rawLines: [],
    };
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = String(lines[idx] || '');
    const lineNo = idx + 1;

    // Header blocks look like:
    //   ------------------------------------------------------------
    //   Section title
    //   ------------------------------------------------------------
    if (isSeparator(line)) {
      let titleIdx = idx + 1;
      while (titleIdx < lines.length && String(lines[titleIdx] || '').trim() === '') titleIdx += 1;
      if (titleIdx >= lines.length) continue;

      const titleLine = String(lines[titleIdx] || '');
      if (isSeparator(titleLine) || titleLine.trim() === '') continue;

      let tailIdx = titleIdx + 1;
      while (tailIdx < lines.length && String(lines[tailIdx] || '').trim() === '') tailIdx += 1;
      if (tailIdx >= lines.length || !isSeparator(String(lines[tailIdx] || ''))) continue;

      finalize(lineNo - 1);
      startSection(titleLine, titleIdx + 1);
      idx = tailIdx;
      continue;
    }

    if (!current && line.trim()) {
      // Preamble section: first non-empty line becomes title.
      startSection(line, lineNo);
      continue;
    }

    if (current) current.rawLines.push(line);
  }

  finalize(lines.length);

  return sections.filter(section => section.title);
};

const shouldProcessAgentDoc = (filePath: string): { kind: string } | null => {
  const fp = normalizeRepoRelativePath(filePath);
  if (fp === 'AGENTS.md') return { kind: 'agents' };
  if (fp === 'CLAUDE.md') return { kind: 'claude' };
  if (fp.toLowerCase() === 'agents.override.md') return { kind: 'override' };
  if (fp === '.agents/architecture/anti-patterns.md') return { kind: 'anti-patterns' };
  if (fp.startsWith('.agents/review/') && /^\.agents\/review\/sweep-.*\.md$/i.test(fp)) return { kind: 'review-sweep' };
  return null;
};

export const processAgentDocs = (
  graph: KnowledgeGraph,
  files: Array<{ path: string; content: string }>,
  allFilePathSet: Set<string>,
): { nodeCount: number; edgeCount: number; sectionCount: number } => {
  const docEntries = files
    .map(file => ({ file, meta: shouldProcessAgentDoc(file.path) }))
    .filter(item => Boolean(item.meta));

  if (docEntries.length === 0) return { nodeCount: 0, edgeCount: 0, sectionCount: 0 };

  let nodeCount = 0;
  let edgeCount = 0;
  let sectionCount = 0;
  const findingValueNodesCreated = new Set<string>();

  const addRel = (rel: GraphRelationship) => {
    graph.addRelationship(rel);
    edgeCount += 1;
  };

  const trunc = (value: string, maxChars: number): string => {
    const raw = String(value || '');
    if (raw.length <= maxChars) return raw;
    return `${raw.slice(0, maxChars).trimEnd()}\n…`;
  };

  for (const entry of docEntries) {
    const filePath = normalizeRepoRelativePath(entry.file.path);
    const meta = entry.meta!;
    if (!filePath) continue;

    const fileExists = allFilePathSet.has(filePath);
    const fileId = fileExists ? generateId('File', filePath) : '';

    const sections = meta.kind === 'override'
      ? parseCommentPrefixedGuidelineSections(entry.file.content)
      : parseMarkdownSections(entry.file.content);
    if (sections.length === 0) continue;

    for (const section of sections) {
      const key = `agent-doc:${meta.kind}:${filePath}:${section.title}:${section.startLine}`.trim();
      if (!key) continue;

      const sectionId = generateId('CodeElement', key);
      graph.addNode({
        id: sectionId,
        label: 'CodeElement',
        properties: {
          name: section.title,
          filePath,
          startLine: section.startLine,
          endLine: section.endLine,
          isExported: false,
          content: trunc(section.content, 12_000),
        },
      });
      nodeCount += 1;
      sectionCount += 1;

      if (fileExists) {
        addRel({
          id: generateId('DEFINES', `${fileId}->${sectionId}`),
          type: 'DEFINES',
          sourceId: fileId,
          targetId: sectionId,
          confidence: 1.0,
          reason: `agent-doc:section:${meta.kind}`,
        });
      }

      for (const referencedPathRaw of section.referencedFiles) {
        const referencedPath = normalizeRepoRelativePath(referencedPathRaw);
        if (!referencedPath) continue;
        if (!allFilePathSet.has(referencedPath)) continue;

        const referencedId = generateId('File', referencedPath);
        addRel({
          id: generateId('USES', `${sectionId}->${referencedId}:agent-doc:${meta.kind}`),
          type: 'USES',
          sourceId: sectionId,
          targetId: referencedId,
          confidence: 1.0,
          reason: `agent-doc:ref:${meta.kind}`,
        });
      }

      const findingCodes = extractFindingCodes(section.content);
      for (const code of findingCodes) {
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
          id: generateId('USES', `${sectionId}->${valueId}:agent-doc:finding-code:${meta.kind}`),
          type: 'USES',
          sourceId: sectionId,
          targetId: valueId,
          confidence: 1.0,
          reason: `agent-doc:finding-code:${meta.kind}`,
        });
      }
    }
  }

  return { nodeCount, edgeCount, sectionCount };
};
