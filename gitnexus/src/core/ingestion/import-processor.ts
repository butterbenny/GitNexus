import fs from 'fs/promises';
import path from 'path';
import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import Parser from 'tree-sitter';
import { loadParser, loadLanguage } from '../tree-sitter/parser-loader.js';
import { LANGUAGE_QUERIES } from './tree-sitter-queries.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename, getParseableContent, yieldToEventLoop } from './utils.js';
import { SupportedLanguages } from '../../config/supported-languages.js';
import type { ExtractedImport } from './workers/parse-worker.js';

const isDev = process.env.NODE_ENV === 'development';

// Type: Map<FilePath, Set<ResolvedFilePath>>
// Stores all files that a given file imports from
export type ImportMap = Map<string, Set<string>>;

export const createImportMap = (): ImportMap => new Map();

// PHP: Map<FilePath, Map<AliasName, FullyQualifiedName>>
// Example: "use App\\Services\\EmailService as Mailer;" -> { Mailer: "App\\Services\\EmailService" }
export type PhpUseAliasMap = Map<string, Map<string, string>>;

export const createPhpUseAliasMap = (): PhpUseAliasMap => new Map();

// ============================================================================
// LANGUAGE-SPECIFIC CONFIG
// ============================================================================

/** TypeScript path alias config parsed from tsconfig.json */
interface TsconfigPaths {
  /** Map of alias prefix -> target prefix (e.g., "@/" -> "src/") */
  aliases: Map<string, string>;
  /** Base URL for path resolution (relative to repo root) */
  baseUrl: string;
}

/** Go module config parsed from go.mod */
interface GoModuleConfig {
  /** Module path (e.g., "github.com/user/repo") */
  modulePath: string;
}

/** Composer PSR-4 config parsed from composer.json */
interface ComposerPsr4Config {
  /** Relative path to composer.json within the repo */
  composerJsonPath: string;
  /** Directory containing composer.json (relative to repo root; '' for root) */
  composerDir: string;
  /** Sorted longest-prefix-first namespace mappings */
  mappings: {
    /** Normalized namespace prefix, using '/' separators and trailing '/' (e.g. 'App/') */
    namespacePrefix: string;
    /** One or more target directories (relative to composerDir), normalized with trailing '/' */
    targetDirs: string[];
  }[];
}

const normalizePosixPath = (p: string): string => p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');

const normalizeComposerNamespacePrefix = (ns: string): string => {
  const normalized = normalizePosixPath(ns);
  return normalized.endsWith('/') ? normalized : normalized + '/';
};

const normalizeComposerTargetDir = (dir: string): string => {
  const normalized = normalizePosixPath(dir).replace(/^\.\//, '').replace(/^\/+/, '');
  if (normalized.length === 0) return '';
  return normalized.endsWith('/') ? normalized : normalized + '/';
};

async function loadComposerPsr4Config(
  repoRoot: string,
  composerJsonPath: string,
  cache: Map<string, ComposerPsr4Config | null>,
): Promise<ComposerPsr4Config | null> {
  if (cache.has(composerJsonPath)) return cache.get(composerJsonPath) ?? null;

  if (!repoRoot) {
    cache.set(composerJsonPath, null);
    return null;
  }

  try {
    const absPath = path.join(repoRoot, composerJsonPath);
    const raw = await fs.readFile(absPath, 'utf-8');
    const json = JSON.parse(raw);

    const psr4 = {
      ...(json?.autoload?.['psr-4'] || {}),
      ...(json?.['autoload-dev']?.['psr-4'] || {}),
    } as Record<string, string | string[]>;

    const mappings: ComposerPsr4Config['mappings'] = [];
    for (const [nsRaw, dirRaw] of Object.entries(psr4)) {
      const namespacePrefix = normalizeComposerNamespacePrefix(nsRaw);
      const targetDirs = (Array.isArray(dirRaw) ? dirRaw : [dirRaw])
        .filter(Boolean)
        .map(normalizeComposerTargetDir);
      if (targetDirs.length === 0) continue;
      mappings.push({ namespacePrefix, targetDirs });
    }

    // Longest prefix wins
    mappings.sort((a, b) => b.namespacePrefix.length - a.namespacePrefix.length);

    const composerDir = normalizePosixPath(path.posix.dirname(composerJsonPath));
    const cfg: ComposerPsr4Config = {
      composerJsonPath,
      composerDir: composerDir === '.' ? '' : composerDir,
      mappings,
    };

    cache.set(composerJsonPath, cfg);
    return cfg;
  } catch {
    cache.set(composerJsonPath, null);
    return null;
  }
}

function findNearestComposerJson(filePath: string, composerJsonFiles: Set<string>): string | null {
  const parts = normalizePosixPath(filePath).split('/').slice(0, -1);
  for (let i = parts.length; i >= 0; i--) {
    const dir = parts.slice(0, i).join('/');
    const candidate = dir ? `${dir}/composer.json` : 'composer.json';
    if (composerJsonFiles.has(candidate)) return candidate;
  }
  return null;
}

function splitTopLevelByComma(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '{') {
      depth++;
      current += ch;
      continue;
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1);
      current += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }

  parts.push(current);
  return parts;
}

function stripPhpAlias(value: string): string {
  return value.replace(/\s+as\s+[\w\x80-\xff]+/i, '').trim();
}

function parsePhpAliasClause(value: string): { imported: string; alias: string | null } {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { imported: '', alias: null };

  const match = /\s+as\s+([\w\x80-\xff]+)\s*$/i.exec(trimmed);
  if (!match || match.index === undefined) return { imported: trimmed, alias: null };

  const alias = match[1]?.trim();
  const imported = trimmed.slice(0, match.index).trim();
  return { imported, alias: alias || null };
}

function extractPhpUseAliases(raw: string): Map<string, string> {
  let body = raw.trim();
  if (body.length === 0) return new Map();

  body = body.replace(/^use\s+/i, '').replace(/;+\s*$/, '').trim();
  if (body.length === 0) return new Map();

  // Ignore `use function ...` / `use const ...`
  if (/^(function|const)\s+/i.test(body)) return new Map();

  const aliases = new Map<string, string>();
  const topLevel = splitTopLevelByComma(body);

  const getDefaultAlias = (imported: string): string | null => {
    const trimmed = imported.replace(/^\\+/, '').trim();
    if (!trimmed) return null;
    const parts = trimmed.split(/[\\/]+/).filter(Boolean);
    return parts.at(-1) ?? null;
  };

  for (const partRaw of topLevel) {
    let part = partRaw.trim();
    if (part.length === 0) continue;

    part = part.replace(/^\\+/, '');

    const braceStart = part.indexOf('{');
    if (braceStart >= 0) {
      const braceEnd = part.lastIndexOf('}');
      if (braceEnd < braceStart) continue;

      const prefixRaw = part.slice(0, braceStart).trim().replace(/^\\+/, '');
      const innerRaw = part.slice(braceStart + 1, braceEnd).trim();

      const prefix = prefixRaw.length === 0
        ? ''
        : prefixRaw.endsWith('\\') ? prefixRaw : prefixRaw + '\\';

      const innerParts = splitTopLevelByComma(innerRaw);
      for (const innerPartRaw of innerParts) {
        const innerPart = innerPartRaw.trim();
        if (innerPart.length === 0) continue;
        if (/^(function|const)\s+/i.test(innerPart)) continue;

        const parsed = parsePhpAliasClause(innerPart);
        const imported = parsed.imported.replace(/^\\+/, '').trim();
        if (imported.length === 0) continue;

        const alias = parsed.alias || getDefaultAlias(imported);
        if (!alias) continue;
        if (!parsed.alias && aliases.has(alias)) continue;

        aliases.set(alias, prefix + imported);
      }
      continue;
    }

    const parsed = parsePhpAliasClause(part);
    const imported = parsed.imported.replace(/^\\+/, '').trim();
    if (imported.length === 0) continue;

    const alias = parsed.alias || getDefaultAlias(imported);
    if (!alias) continue;
    if (!parsed.alias && aliases.has(alias)) continue;

    aliases.set(alias, imported);
  }

  return aliases;
}

export const expandPhpClassRefFromUseAliases = (
  classRef: string,
  currentFilePath: string,
  phpUseAliases: PhpUseAliasMap,
): string => {
  const aliasMap = phpUseAliases.get(currentFilePath);
  if (!aliasMap || aliasMap.size === 0) return classRef;

  const trimmed = classRef.trim().replace(/^\\+/, '');
  if (trimmed.length === 0) return classRef;

  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return classRef;

  const aliasTarget = aliasMap.get(parts[0]);
  if (!aliasTarget) return classRef;

  if (parts.length === 1) return aliasTarget;
  return `${aliasTarget}\\${parts.slice(1).join('\\')}`;
};

/**
 * Expand a PHP `use ...;` declaration into one-or-more imported fully-qualified names.
 * Handles:
 * - `use Foo\\Bar;`
 * - `use Foo\\Bar as Baz;`
 * - `use Foo\\Bar\\{Baz,Qux as Quux};`
 * - `use Foo\\Bar, Foo\\Baz;`
 */
function expandPhpUseDeclaration(raw: string): string[] {
  let body = raw.trim();
  if (body.length === 0) return [];

  body = body.replace(/^use\s+/i, '').replace(/;+\s*$/, '').trim();
  if (body.length === 0) return [];

  // Ignore `use function ...` / `use const ...` (file-level imports only for now)
  if (/^(function|const)\s+/i.test(body)) return [];

  const results: string[] = [];
  const topLevel = splitTopLevelByComma(body);
  for (const partRaw of topLevel) {
    let part = partRaw.trim();
    if (part.length === 0) continue;

    // Strip leading global namespace prefix `\`
    part = part.replace(/^\\+/, '');

    const braceStart = part.indexOf('{');
    if (braceStart >= 0) {
      const braceEnd = part.lastIndexOf('}');
      if (braceEnd < braceStart) continue;

      const prefixRaw = part.slice(0, braceStart).trim();
      const innerRaw = part.slice(braceStart + 1, braceEnd).trim();

      const prefix = prefixRaw.length === 0
        ? ''
        : prefixRaw.endsWith('\\') ? prefixRaw : prefixRaw + '\\';

      const innerParts = splitTopLevelByComma(innerRaw);
      for (const innerPartRaw of innerParts) {
        let innerPart = innerPartRaw.trim();
        if (innerPart.length === 0) continue;

        if (/^(function|const)\s+/i.test(innerPart)) continue;

        innerPart = stripPhpAlias(innerPart).replace(/^\\+/, '');
        if (innerPart.length === 0) continue;

        results.push(prefix + innerPart);
      }
      continue;
    }

    part = stripPhpAlias(part);
    if (part.length === 0) continue;
    results.push(part);
  }

  return Array.from(new Set(results));
}

/**
 * Parse tsconfig.json to extract path aliases.
 * Tries tsconfig.json, tsconfig.app.json, tsconfig.base.json in order.
 */
async function loadTsconfigPaths(repoRoot: string): Promise<TsconfigPaths | null> {
  const candidates = ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.base.json'];

  for (const filename of candidates) {
    try {
      const tsconfigPath = path.join(repoRoot, filename);
      const raw = await fs.readFile(tsconfigPath, 'utf-8');
      // Strip JSON comments (// and /* */ style) for robustness
      const stripped = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const tsconfig = JSON.parse(stripped);
      const compilerOptions = tsconfig.compilerOptions;
      if (!compilerOptions?.paths) continue;

      const baseUrl = compilerOptions.baseUrl || '.';
      const aliases = new Map<string, string>();

      for (const [pattern, targets] of Object.entries(compilerOptions.paths)) {
        if (!Array.isArray(targets) || targets.length === 0) continue;
        const target = targets[0] as string;

        // Convert glob patterns: "@/*" -> "@/", "src/*" -> "src/"
        const aliasPrefix = pattern.endsWith('/*') ? pattern.slice(0, -1) : pattern;
        const targetPrefix = target.endsWith('/*') ? target.slice(0, -1) : target;

        aliases.set(aliasPrefix, targetPrefix);
      }

      if (aliases.size > 0) {
        if (isDev) {
          console.log(`📦 Loaded ${aliases.size} path aliases from ${filename}`);
        }
        return { aliases, baseUrl };
      }
    } catch {
      // File doesn't exist or isn't valid JSON - try next
    }
  }

  return null;
}

/**
 * Parse go.mod to extract module path.
 */
async function loadGoModulePath(repoRoot: string): Promise<GoModuleConfig | null> {
  try {
    const goModPath = path.join(repoRoot, 'go.mod');
    const content = await fs.readFile(goModPath, 'utf-8');
    const match = content.match(/^module\s+(\S+)/m);
    if (match) {
      if (isDev) {
        console.log(`📦 Loaded Go module path: ${match[1]}`);
      }
      return { modulePath: match[1] };
    }
  } catch {
    // No go.mod
  }
  return null;
}

// ============================================================================
// IMPORT PATH RESOLUTION
// ============================================================================

/** All file extensions to try during resolution */
const EXTENSIONS = [
  '',
  // TypeScript/JavaScript
  '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js',
  // Svelte
  '.svelte', '/index.svelte',
  // Python
  '.py', '/__init__.py',
  // PHP
  '.php',
  // Java
  '.java',
  // C/C++
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.hxx', '.hh',
  // C#
  '.cs',
  // Go
  '.go',
  // Rust
  '.rs', '/mod.rs',
];

/**
 * Try to match a path (with extensions) against the known file set.
 * Returns the matched file path or null.
 */
function tryResolveWithExtensions(
  basePath: string,
  allFiles: Set<string>,
): string | null {
  for (const ext of EXTENSIONS) {
    const candidate = basePath + ext;
    if (allFiles.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Build a suffix index for O(1) endsWith lookups.
 * Maps every possible path suffix to its original file path.
 * e.g. for "src/com/example/Foo.java":
 *   "Foo.java" -> "src/com/example/Foo.java"
 *   "example/Foo.java" -> "src/com/example/Foo.java"
 *   "com/example/Foo.java" -> "src/com/example/Foo.java"
 *   etc.
 */
export interface SuffixIndex {
  /** Exact suffix lookup (case-sensitive) */
  get(suffix: string): string | undefined;
  /** Case-insensitive suffix lookup */
  getInsensitive(suffix: string): string | undefined;
  /** Get all files in a directory suffix */
  getFilesInDir(dirSuffix: string, extension: string): string[];
}

function buildSuffixIndex(normalizedFileList: string[], allFileList: string[]): SuffixIndex {
  // Map: normalized suffix -> original file path
  const exactMap = new Map<string, string>();
  // Map: lowercase suffix -> original file path
  const lowerMap = new Map<string, string>();
  // Map: directory suffix -> list of file paths in that directory
  const dirMap = new Map<string, string[]>();

  for (let i = 0; i < normalizedFileList.length; i++) {
    const normalized = normalizedFileList[i];
    const original = allFileList[i];
    const parts = normalized.split('/');

    // Index all suffixes: "a/b/c.java" -> ["c.java", "b/c.java", "a/b/c.java"]
    for (let j = parts.length - 1; j >= 0; j--) {
      const suffix = parts.slice(j).join('/');
      // Only store first match (longest path wins for ambiguous suffixes)
      if (!exactMap.has(suffix)) {
        exactMap.set(suffix, original);
      }
      const lower = suffix.toLowerCase();
      if (!lowerMap.has(lower)) {
        lowerMap.set(lower, original);
      }
    }

    // Index directory membership
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash >= 0) {
      // Build all directory suffixes
      const dirParts = parts.slice(0, -1);
      const fileName = parts[parts.length - 1];
      const ext = fileName.substring(fileName.lastIndexOf('.'));

      for (let j = dirParts.length - 1; j >= 0; j--) {
        const dirSuffix = dirParts.slice(j).join('/');
        const key = `${dirSuffix}:${ext}`;
        let list = dirMap.get(key);
        if (!list) {
          list = [];
          dirMap.set(key, list);
        }
        list.push(original);
      }
    }
  }

  return {
    get: (suffix: string) => exactMap.get(suffix),
    getInsensitive: (suffix: string) => lowerMap.get(suffix.toLowerCase()),
    getFilesInDir: (dirSuffix: string, extension: string) => {
      return dirMap.get(`${dirSuffix}:${extension}`) || [];
    },
  };
}

/**
 * Suffix-based resolution using index. O(1) per lookup instead of O(files).
 */
function suffixResolve(
  pathParts: string[],
  normalizedFileList: string[],
  allFileList: string[],
  index?: SuffixIndex,
): string | null {
  if (index) {
    for (let i = 0; i < pathParts.length; i++) {
      const suffix = pathParts.slice(i).join('/');
      for (const ext of EXTENSIONS) {
        const suffixWithExt = suffix + ext;
        const result = index.get(suffixWithExt) || index.getInsensitive(suffixWithExt);
        if (result) return result;
      }
    }
    return null;
  }

  // Fallback: linear scan (for backward compatibility)
  for (let i = 0; i < pathParts.length; i++) {
    const suffix = pathParts.slice(i).join('/');
    for (const ext of EXTENSIONS) {
      const suffixWithExt = suffix + ext;
      const suffixPattern = '/' + suffixWithExt;
      const matchIdx = normalizedFileList.findIndex(filePath =>
        filePath.endsWith(suffixPattern) || filePath.toLowerCase().endsWith(suffixPattern.toLowerCase())
      );
      if (matchIdx !== -1) {
        return allFileList[matchIdx];
      }
    }
  }
  return null;
}

/**
 * Resolve an import path to a file path in the repository.
 *
 * Language-specific preprocessing is applied before the generic resolution:
 * - TypeScript/JavaScript: rewrites tsconfig path aliases
 * - Rust: converts crate::/super::/self:: to relative paths
 *
 * Java wildcards and Go package imports are handled separately in processImports
 * because they resolve to multiple files.
 */
const resolveImportPath = (
  currentFile: string,
  importPath: string,
  allFiles: Set<string>,
  allFileList: string[],
  normalizedFileList: string[],
  resolveCache: Map<string, string | null>,
  language: SupportedLanguages,
  tsconfigPaths: TsconfigPaths | null,
  composerPsr4: ComposerPsr4Config | null,
  index?: SuffixIndex,
): string | null => {
  const cacheKey = `${currentFile}::${importPath}`;
  if (resolveCache.has(cacheKey)) return resolveCache.get(cacheKey) ?? null;

  const cache = (result: string | null): string | null => {
    resolveCache.set(cacheKey, result);
    return result;
  };

  const importPathForResolution = language === SupportedLanguages.PHP
    ? importPath.replace(/\\/g, '/').replace(/^\/+/, '')
    : importPath;

  // ---- TypeScript/JavaScript: rewrite path aliases ----
  if (
    (language === SupportedLanguages.TypeScript || language === SupportedLanguages.JavaScript) &&
    tsconfigPaths &&
    !importPath.startsWith('.')
  ) {
    for (const [aliasPrefix, targetPrefix] of tsconfigPaths.aliases) {
      if (importPath.startsWith(aliasPrefix)) {
        const remainder = importPath.slice(aliasPrefix.length);
        // Build the rewritten path relative to baseUrl
        const rewritten = tsconfigPaths.baseUrl === '.'
          ? targetPrefix + remainder
          : tsconfigPaths.baseUrl + '/' + targetPrefix + remainder;

        // Try direct resolution from repo root
        const resolved = tryResolveWithExtensions(rewritten, allFiles);
        if (resolved) return cache(resolved);

        // Try suffix matching as fallback
        const parts = rewritten.split('/').filter(Boolean);
        const suffixResult = suffixResolve(parts, normalizedFileList, allFileList, index);
        if (suffixResult) return cache(suffixResult);
      }
    }
  }

  // ---- Rust: convert module path syntax to file paths ----
  if (language === SupportedLanguages.Rust) {
    const rustResult = resolveRustImport(currentFile, importPath, allFiles);
    if (rustResult) return cache(rustResult);
    // Fall through to generic resolution if Rust-specific didn't match
  }

  // ---- PHP: namespace import resolution (use Foo\\Bar\\Baz) ----
  if (language === SupportedLanguages.PHP) {
    // Prefer deterministic resolution via Composer PSR-4 (nearest composer.json)
    if (composerPsr4) {
      for (const { namespacePrefix, targetDirs } of composerPsr4.mappings) {
        if (!importPathForResolution.startsWith(namespacePrefix)) continue;
        const remainder = importPathForResolution.slice(namespacePrefix.length);
        for (const targetDir of targetDirs) {
          const basePath = normalizePosixPath([composerPsr4.composerDir, targetDir, remainder].filter(Boolean).join('/'))
            .replace(/^\/+/, '');
          const direct = tryResolveWithExtensions(basePath, allFiles);
          if (direct) return cache(direct);
        }
      }
    }

    const candidates = new Set<string>();
    candidates.add(importPathForResolution);

    // Laravel convention: `App\\...` namespace maps to `app/...` directory
    if (importPathForResolution.startsWith('App/')) {
      const remainder = importPathForResolution.slice('App/'.length);
      candidates.add(`app/${remainder}`);
      candidates.add(remainder);
    }

    for (const candidate of candidates) {
      const direct = tryResolveWithExtensions(candidate, allFiles);
      if (direct) return cache(direct);

      const parts = candidate.split('/').filter(Boolean);
      const suffixResult = suffixResolve(parts, normalizedFileList, allFileList, index);
      if (suffixResult) return cache(suffixResult);
    }
  }

  // ---- Generic relative import resolution (./ and ../) ----
  const currentDir = currentFile.split('/').slice(0, -1);
  const parts = importPathForResolution.split('/');

  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      currentDir.pop();
    } else {
      currentDir.push(part);
    }
  }

  const basePath = currentDir.join('/');

  if (importPathForResolution.startsWith('.')) {
    const resolved = tryResolveWithExtensions(basePath, allFiles);
    return cache(resolved);
  }

  // ---- Generic package/absolute import resolution (suffix matching) ----
  // Java wildcards are handled in processImports, not here
  if (importPathForResolution.endsWith('.*')) {
    return cache(null);
  }

  const pathLike = importPathForResolution.includes('/')
    ? importPathForResolution
    : importPathForResolution.replace(/\./g, '/');
  const pathParts = pathLike.split('/').filter(Boolean);

  const resolved = suffixResolve(pathParts, normalizedFileList, allFileList, index);
  return cache(resolved);
};

// ============================================================================
// RUST MODULE RESOLUTION
// ============================================================================

/**
 * Resolve Rust use-path to a file.
 * Handles crate::, super::, self:: prefixes and :: path separators.
 */
function resolveRustImport(
  currentFile: string,
  importPath: string,
  allFiles: Set<string>,
): string | null {
  let rustPath: string;

  if (importPath.startsWith('crate::')) {
    // crate:: resolves from src/ directory (standard Rust layout)
    rustPath = importPath.slice(7).replace(/::/g, '/');

    // Try from src/ (standard layout)
    const fromSrc = tryRustModulePath('src/' + rustPath, allFiles);
    if (fromSrc) return fromSrc;

    // Try from repo root (non-standard)
    const fromRoot = tryRustModulePath(rustPath, allFiles);
    if (fromRoot) return fromRoot;

    return null;
  }

  if (importPath.startsWith('super::')) {
    // super:: = parent directory of current file's module
    const currentDir = currentFile.split('/').slice(0, -1);
    currentDir.pop(); // Go up one level for super::
    rustPath = importPath.slice(7).replace(/::/g, '/');
    const fullPath = [...currentDir, rustPath].join('/');
    return tryRustModulePath(fullPath, allFiles);
  }

  if (importPath.startsWith('self::')) {
    // self:: = current module's directory
    const currentDir = currentFile.split('/').slice(0, -1);
    rustPath = importPath.slice(6).replace(/::/g, '/');
    const fullPath = [...currentDir, rustPath].join('/');
    return tryRustModulePath(fullPath, allFiles);
  }

  // Bare path without prefix (e.g., from a use in a nested module)
  // Convert :: to / and try suffix matching
  if (importPath.includes('::')) {
    rustPath = importPath.replace(/::/g, '/');
    return tryRustModulePath(rustPath, allFiles);
  }

  return null;
}

/**
 * Try to resolve a Rust module path to a file.
 * Tries: path.rs, path/mod.rs, and with the last segment stripped
 * (last segment might be a symbol name, not a module).
 */
function tryRustModulePath(modulePath: string, allFiles: Set<string>): string | null {
  // Try direct: path.rs
  if (allFiles.has(modulePath + '.rs')) return modulePath + '.rs';
  // Try directory: path/mod.rs
  if (allFiles.has(modulePath + '/mod.rs')) return modulePath + '/mod.rs';
  // Try path/lib.rs (for crate root)
  if (allFiles.has(modulePath + '/lib.rs')) return modulePath + '/lib.rs';

  // The last segment might be a symbol (function, struct, etc.), not a module.
  // Strip it and try again.
  const lastSlash = modulePath.lastIndexOf('/');
  if (lastSlash > 0) {
    const parentPath = modulePath.substring(0, lastSlash);
    if (allFiles.has(parentPath + '.rs')) return parentPath + '.rs';
    if (allFiles.has(parentPath + '/mod.rs')) return parentPath + '/mod.rs';
  }

  return null;
}

// ============================================================================
// JAVA MULTI-FILE RESOLUTION
// ============================================================================

/**
 * Resolve a Java wildcard import (com.example.*) to all matching .java files.
 * Returns an array of file paths.
 */
function resolveJavaWildcard(
  importPath: string,
  normalizedFileList: string[],
  allFileList: string[],
  index?: SuffixIndex,
): string[] {
  // "com.example.util.*" -> "com/example/util"
  const packagePath = importPath.slice(0, -2).replace(/\./g, '/');

  if (index) {
    // Use directory index: get all .java files in this package directory
    const candidates = index.getFilesInDir(packagePath, '.java');
    // Filter to only direct children (no subdirectories)
    const packageSuffix = '/' + packagePath + '/';
    return candidates.filter(f => {
      const normalized = f.replace(/\\/g, '/');
      const idx = normalized.indexOf(packageSuffix);
      if (idx < 0) return false;
      const afterPkg = normalized.substring(idx + packageSuffix.length);
      return !afterPkg.includes('/');
    });
  }

  // Fallback: linear scan
  const packageSuffix = '/' + packagePath + '/';
  const matches: string[] = [];
  for (let i = 0; i < normalizedFileList.length; i++) {
    const normalized = normalizedFileList[i];
    if (normalized.includes(packageSuffix) && normalized.endsWith('.java')) {
      const afterPackage = normalized.substring(normalized.indexOf(packageSuffix) + packageSuffix.length);
      if (!afterPackage.includes('/')) {
        matches.push(allFileList[i]);
      }
    }
  }
  return matches;
}

/**
 * Try to resolve a Java static import by stripping the member name.
 * "com.example.Constants.VALUE" -> resolve "com.example.Constants"
 */
function resolveJavaStaticImport(
  importPath: string,
  normalizedFileList: string[],
  allFileList: string[],
  index?: SuffixIndex,
): string | null {
  // Static imports look like: com.example.Constants.VALUE or com.example.Constants.*
  // The last segment is a member name (field/method) if it starts with lowercase or is ALL_CAPS
  const segments = importPath.split('.');
  if (segments.length < 3) return null;

  const lastSeg = segments[segments.length - 1];
  // If last segment is a wildcard or ALL_CAPS constant or starts with lowercase, strip it
  if (lastSeg === '*' || /^[a-z]/.test(lastSeg) || /^[A-Z_]+$/.test(lastSeg)) {
    const classPath = segments.slice(0, -1).join('/');
    const classSuffix = classPath + '.java';

    if (index) {
      return index.get(classSuffix) || index.getInsensitive(classSuffix) || null;
    }

    // Fallback: linear scan
    const fullSuffix = '/' + classSuffix;
    for (let i = 0; i < normalizedFileList.length; i++) {
      if (normalizedFileList[i].endsWith(fullSuffix) ||
          normalizedFileList[i].toLowerCase().endsWith(fullSuffix.toLowerCase())) {
        return allFileList[i];
      }
    }
  }

  return null;
}

// ============================================================================
// GO PACKAGE RESOLUTION
// ============================================================================

/**
 * Resolve a Go internal package import to all .go files in the package directory.
 * Returns an array of file paths.
 */
function resolveGoPackage(
  importPath: string,
  goModule: GoModuleConfig,
  normalizedFileList: string[],
  allFileList: string[],
): string[] {
  if (!importPath.startsWith(goModule.modulePath)) return [];

  // Strip module path to get relative package path
  const relativePkg = importPath.slice(goModule.modulePath.length + 1); // e.g., "internal/auth"
  if (!relativePkg) return [];

  const pkgSuffix = '/' + relativePkg + '/';
  const matches: string[] = [];

  for (let i = 0; i < normalizedFileList.length; i++) {
    const normalized = normalizedFileList[i];
    // File must be directly in the package directory (not a subdirectory)
    if (normalized.includes(pkgSuffix) && normalized.endsWith('.go') && !normalized.endsWith('_test.go')) {
      const afterPkg = normalized.substring(normalized.indexOf(pkgSuffix) + pkgSuffix.length);
      if (!afterPkg.includes('/')) {
        matches.push(allFileList[i]);
      }
    }
  }

  return matches;
}

// ============================================================================
// MAIN IMPORT PROCESSOR
// ============================================================================

export const processImports = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
  onProgress?: (current: number, total: number) => void,
  repoRoot?: string,
) => {
  // Create a Set of all file paths for fast lookup during resolution
  const allFilePaths = new Set(files.map(f => f.path));
  const parser = await loadParser();
  const resolveCache = new Map<string, string | null>();
  const allFileList = files.map(f => f.path);
  // Pre-compute normalized file list once (forward slashes)
  const normalizedFileList = allFileList.map(p => p.replace(/\\/g, '/'));
  // Build suffix index for O(1) lookups
  const index = buildSuffixIndex(normalizedFileList, allFileList);

  // Track import statistics
  let totalImportsFound = 0;
  let totalImportsResolved = 0;

  // Load language-specific configs once before the file loop
  const effectiveRoot = repoRoot || '';
  const tsconfigPaths = await loadTsconfigPaths(effectiveRoot);
  const goModule = await loadGoModulePath(effectiveRoot);
  const composerJsonFiles = new Set(allFileList.filter(p => p.endsWith('composer.json')));
  const composerPsr4Cache = new Map<string, ComposerPsr4Config | null>();
  const composerJsonForFileCache = new Map<string, string | null>();

  // Helper: add an IMPORTS edge + update import map
  const addImportEdge = (filePath: string, resolvedPath: string) => {
    const sourceId = generateId('File', filePath);
    const targetId = generateId('File', resolvedPath);
    const relId = generateId('IMPORTS', `${filePath}->${resolvedPath}`);

    totalImportsResolved++;

    graph.addRelationship({
      id: relId,
      sourceId,
      targetId,
      type: 'IMPORTS',
      confidence: 1.0,
      reason: '',
    });

    if (!importMap.has(filePath)) {
      importMap.set(filePath, new Set());
    }
    importMap.get(filePath)!.add(resolvedPath);
  };

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress?.(i + 1, files.length);
    if (i % 20 === 0) await yieldToEventLoop();

    // 1. Check language support first
    const language = getLanguageFromFilename(file.path);
    if (!language) continue;

    const queryStr = LANGUAGE_QUERIES[language];
    if (!queryStr) continue;

    // PHP: Load nearest Composer PSR-4 config (package-level composer.json supported)
    let composerPsr4: ComposerPsr4Config | null = null;
    if (language === SupportedLanguages.PHP && composerJsonFiles.size > 0) {
      let composerJsonPath = composerJsonForFileCache.get(file.path);
      if (composerJsonPath === undefined) {
        composerJsonPath = findNearestComposerJson(file.path, composerJsonFiles);
        composerJsonForFileCache.set(file.path, composerJsonPath);
      }

      if (composerJsonPath) {
        composerPsr4 = await loadComposerPsr4Config(effectiveRoot, composerJsonPath, composerPsr4Cache);
      }
    }

    // 2. ALWAYS load the language before querying (parser is stateful)
    await loadLanguage(language, file.path);

    // 3. Get AST (Try Cache First)
    let tree = astCache.get(file.path);
    let wasReparsed = false;

    if (!tree) {
      try {
        const content = getParseableContent(file.path, file.content);
        tree = parser.parse(content, undefined, { bufferSize: 1024 * 256 });
      } catch (parseError) {
        continue;
      }
      wasReparsed = true;
      // Cache re-parsed tree so call/heritage phases get hits
      astCache.set(file.path, tree);
    }

    let query;
    let matches;
    try {
      const lang = parser.getLanguage();
      query = new Parser.Query(lang, queryStr);
      matches = query.matches(tree.rootNode);
    } catch (queryError: any) {
      if (isDev) {
        console.group(`🔴 Query Error: ${file.path}`);
        console.log('Language:', language);
        console.log('Query (first 200 chars):', queryStr.substring(0, 200) + '...');
        console.log('Error:', queryError?.message || queryError);
        console.log('File content (first 300 chars):', file.content.substring(0, 300));
        console.log('AST root type:', tree.rootNode?.type);
        console.log('AST has errors:', tree.rootNode?.hasError);
        console.groupEnd();
      }

      if (wasReparsed) (tree as any).delete?.();
      continue;
    }

    matches.forEach(match => {
      const captureMap: Record<string, any> = {};
      match.captures.forEach(c => captureMap[c.name] = c.node);

      if (captureMap['import']) {
        const sourceNode = captureMap['import.source'];
        if (!sourceNode) {
          if (isDev) {
            console.log(`⚠️ Import captured but no source node in ${file.path}`);
          }
          return;
        }

        // Clean path (remove quotes and angle brackets for C/C++ includes)
        const rawImportPath = sourceNode.text.replace(/['"<>]/g, '');
        const importPaths = language === SupportedLanguages.PHP
          ? expandPhpUseDeclaration(rawImportPath)
          : [rawImportPath];

        if (language === SupportedLanguages.PHP) {
          const aliases = extractPhpUseAliases(rawImportPath);
          if (aliases.size > 0) {
            let fileAliases = phpUseAliases.get(file.path);
            if (!fileAliases) {
              fileAliases = new Map<string, string>();
              phpUseAliases.set(file.path, fileAliases);
            }
            for (const [alias, imported] of aliases) {
              fileAliases.set(alias, imported);
            }
          }
        }

        for (const importPath of importPaths) {
          totalImportsFound++;

          // ---- Java: handle wildcards and static imports specially ----
          if (language === SupportedLanguages.Java) {
            if (importPath.endsWith('.*')) {
              const matchedFiles = resolveJavaWildcard(importPath, normalizedFileList, allFileList, index);
              for (const matchedFile of matchedFiles) {
                addImportEdge(file.path, matchedFile);
              }
              continue; // skip single-file resolution
            }

            // Try static import resolution (strip member name)
            const staticResolved = resolveJavaStaticImport(importPath, normalizedFileList, allFileList, index);
            if (staticResolved) {
              addImportEdge(file.path, staticResolved);
              continue;
            }
            // Fall through to normal resolution for regular Java imports
          }

          // ---- Go: handle package-level imports ----
          if (language === SupportedLanguages.Go && goModule && importPath.startsWith(goModule.modulePath)) {
            const pkgFiles = resolveGoPackage(importPath, goModule, normalizedFileList, allFileList);
            if (pkgFiles.length > 0) {
              for (const pkgFile of pkgFiles) {
                addImportEdge(file.path, pkgFile);
              }
              continue; // skip single-file resolution
            }
            // Fall through if no files found (package might be external)
          }

          // ---- Standard single-file resolution ----
          const resolvedPath = resolveImportPath(
            file.path,
            importPath,
            allFilePaths,
            allFileList,
            normalizedFileList,
            resolveCache,
            language,
            tsconfigPaths,
            composerPsr4,
            index,
          );

          if (resolvedPath) {
            addImportEdge(file.path, resolvedPath);
          }
        }
      }
    });

    // Tree is now owned by the LRU cache — no manual delete needed
  }

  if (isDev) {
    console.log(`📊 Import processing complete: ${totalImportsResolved}/${totalImportsFound} imports resolved to graph edges`);
  }
};

// ============================================================================
// FAST PATH: Resolve pre-extracted imports (no parsing needed)
// ============================================================================

export const processImportsFromExtracted = async (
  graph: KnowledgeGraph,
  files: Array<{ path: string; content?: string }> | string[],
  extractedImports: ExtractedImport[],
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
  onProgress?: (current: number, total: number) => void,
  repoRoot?: string,
) => {
  const resolveFilePaths = (): string[] => {
    if (files.length === 0) return [];
    if (typeof (files as any)[0] === 'string') return files as string[];
    return (files as Array<{ path: string }>).map(f => f.path);
  };
  const allFileList = resolveFilePaths();
  const allFilePaths = new Set(allFileList);
  const resolveCache = new Map<string, string | null>();
  const normalizedFileList = allFileList.map(p => p.replace(/\\/g, '/'));
  // Build suffix index for O(1) lookups
  const index = buildSuffixIndex(normalizedFileList, allFileList);

  let totalImportsFound = 0;
  let totalImportsResolved = 0;

  const effectiveRoot = repoRoot || '';
  const tsconfigPaths = await loadTsconfigPaths(effectiveRoot);
  const goModule = await loadGoModulePath(effectiveRoot);
  const composerJsonFiles = new Set(allFileList.filter(p => p.endsWith('composer.json')));
  const composerPsr4Cache = new Map<string, ComposerPsr4Config | null>();
  const composerJsonForFileCache = new Map<string, string | null>();

  const addImportEdge = (filePath: string, resolvedPath: string) => {
    const sourceId = generateId('File', filePath);
    const targetId = generateId('File', resolvedPath);
    const relId = generateId('IMPORTS', `${filePath}->${resolvedPath}`);

    totalImportsResolved++;

    graph.addRelationship({
      id: relId,
      sourceId,
      targetId,
      type: 'IMPORTS',
      confidence: 1.0,
      reason: '',
    });

    if (!importMap.has(filePath)) {
      importMap.set(filePath, new Set());
    }
    importMap.get(filePath)!.add(resolvedPath);
  };

  // Group by file for progress reporting (users see file count, not import count)
  const importsByFile = new Map<string, ExtractedImport[]>();
  for (const imp of extractedImports) {
    let list = importsByFile.get(imp.filePath);
    if (!list) {
      list = [];
      importsByFile.set(imp.filePath, list);
    }
    list.push(imp);
  }

  const totalFiles = importsByFile.size;
  let filesProcessed = 0;

  // Pre-build a suffix index for O(1) suffix lookups instead of O(n) linear scans
  const suffixIndex = new Map<string, string[]>();
  for (let i = 0; i < normalizedFileList.length; i++) {
    const normalized = normalizedFileList[i];
    // Index by last path segment (filename) for fast suffix matching
    const lastSlash = normalized.lastIndexOf('/');
    const filename = lastSlash >= 0 ? normalized.substring(lastSlash + 1) : normalized;
    let list = suffixIndex.get(filename);
    if (!list) {
      list = [];
      suffixIndex.set(filename, list);
    }
    list.push(allFileList[i]);
  }

  for (const [filePath, fileImports] of importsByFile) {
    filesProcessed++;
    if (filesProcessed % 100 === 0) {
      onProgress?.(filesProcessed, totalFiles);
      await yieldToEventLoop();
    }

    // PHP: Load nearest Composer PSR-4 config once per file
    let composerPsr4: ComposerPsr4Config | null = null;
    if (composerJsonFiles.size > 0 && fileImports.some(imp => imp.language === SupportedLanguages.PHP)) {
      let composerJsonPath = composerJsonForFileCache.get(filePath);
      if (composerJsonPath === undefined) {
        composerJsonPath = findNearestComposerJson(filePath, composerJsonFiles);
        composerJsonForFileCache.set(filePath, composerJsonPath);
      }

      if (composerJsonPath) {
        composerPsr4 = await loadComposerPsr4Config(effectiveRoot, composerJsonPath, composerPsr4Cache);
      }
    }

    for (const { rawImportPath, language } of fileImports) {
      if (language === SupportedLanguages.PHP) {
        const aliases = extractPhpUseAliases(rawImportPath);
        if (aliases.size > 0) {
          let fileAliases = phpUseAliases.get(filePath);
          if (!fileAliases) {
            fileAliases = new Map<string, string>();
            phpUseAliases.set(filePath, fileAliases);
          }
          for (const [alias, imported] of aliases) {
            fileAliases.set(alias, imported);
          }
        }
      }

      const importPaths = language === SupportedLanguages.PHP
        ? expandPhpUseDeclaration(rawImportPath)
        : [rawImportPath];

      for (const importPath of importPaths) {
        totalImportsFound++;

        // Check resolve cache first
        const cacheKey = `${filePath}::${importPath}`;
        if (resolveCache.has(cacheKey)) {
          const cached = resolveCache.get(cacheKey);
          if (cached) addImportEdge(filePath, cached);
          continue;
        }

        // Java: handle wildcards and static imports
        if (language === SupportedLanguages.Java) {
          if (importPath.endsWith('.*')) {
            const matchedFiles = resolveJavaWildcard(importPath, normalizedFileList, allFileList, index);
            for (const matchedFile of matchedFiles) {
              addImportEdge(filePath, matchedFile);
            }
            continue;
          }

          const staticResolved = resolveJavaStaticImport(importPath, normalizedFileList, allFileList, index);
          if (staticResolved) {
            resolveCache.set(cacheKey, staticResolved);
            addImportEdge(filePath, staticResolved);
            continue;
          }
        }

        // Go: handle package-level imports
        if (language === SupportedLanguages.Go && goModule && importPath.startsWith(goModule.modulePath)) {
          const pkgFiles = resolveGoPackage(importPath, goModule, normalizedFileList, allFileList);
          if (pkgFiles.length > 0) {
            for (const pkgFile of pkgFiles) {
              addImportEdge(filePath, pkgFile);
            }
            continue;
          }
        }

        // Standard resolution (has its own internal cache)
        const resolvedPath = resolveImportPath(
          filePath,
          importPath,
          allFilePaths,
          allFileList,
          normalizedFileList,
          resolveCache,
          language as SupportedLanguages,
          tsconfigPaths,
          composerPsr4,
          index,
        );

        if (resolvedPath) {
          addImportEdge(filePath, resolvedPath);
        }
      }
    }
  }

  onProgress?.(totalFiles, totalFiles);

  if (isDev) {
    console.log(`📊 Import processing (fast path): ${totalImportsResolved}/${totalImportsFound} imports resolved to graph edges`);
  }
};
