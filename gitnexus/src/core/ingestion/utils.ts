import { SupportedLanguages } from '../../config/supported-languages.js';

/**
 * Yield control to the event loop so spinners/progress can render.
 * Call periodically in hot loops to prevent UI freezes.
 */
export const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

export const isSvelteFile = (filename: string): boolean => filename.endsWith('.svelte');

/**
 * Extract the contents of <script> blocks from a .svelte file, preserving
 * line numbers by replacing non-script lines with blanks.
 *
 * This allows us to parse Svelte component scripts using the existing
 * JS/TS tree-sitter grammars without introducing new schema shapes.
 */
export const extractSvelteScriptForParsing = (source: string): string => {
  const lines = source.split(/\r?\n/);
  const output = new Array(lines.length).fill('');

  type State = 'outside' | 'in_open_tag' | 'in_script';
  let state: State = 'outside';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (state === 'outside') {
      const openIdx = line.indexOf('<script');
      if (openIdx === -1) continue;

      const gtIdx = line.indexOf('>', openIdx);
      if (gtIdx === -1) {
        state = 'in_open_tag';
        continue;
      }

      const after = line.slice(gtIdx + 1);
      const closeIdx = after.indexOf('</script>');
      if (closeIdx !== -1) {
        output[i] = after.slice(0, closeIdx);
        state = 'outside';
        continue;
      }

      output[i] = after;
      state = 'in_script';
      continue;
    }

    if (state === 'in_open_tag') {
      const gtIdx = line.indexOf('>');
      if (gtIdx === -1) continue;

      const after = line.slice(gtIdx + 1);
      const closeIdx = after.indexOf('</script>');
      if (closeIdx !== -1) {
        output[i] = after.slice(0, closeIdx);
        state = 'outside';
        continue;
      }

      output[i] = after;
      state = 'in_script';
      continue;
    }

    // state === 'in_script'
    const closeIdx = line.indexOf('</script>');
    if (closeIdx !== -1) {
      output[i] = line.slice(0, closeIdx);
      state = 'outside';
      continue;
    }

    output[i] = line;
  }

  return output.join('\n');
};

export const getParseableContent = (filePath: string, content: string): string => {
  return isSvelteFile(filePath)
    ? extractSvelteScriptForParsing(content)
    : content;
};

const MIN_TREE_SITTER_BUFFER_SIZE = 1024 * 256; // 256 KB
// If a string is <= 64k chars, even worst-case UTF-8 expansion (4 bytes/char)
// stays strictly under the 256KB buffer (4 * 65535 = 262140 < 262144).
// This avoids an O(n) Buffer.byteLength scan for the vast majority of files.
const TREE_SITTER_FAST_PATH_MAX_CHARS = 65535;

const getAdaptiveTreeSitterBufferSize = (content: string): number => {
  if (content.length <= TREE_SITTER_FAST_PATH_MAX_CHARS) {
    return MIN_TREE_SITTER_BUFFER_SIZE;
  }
  const byteLength = Buffer.byteLength(content, 'utf8');
  let bufferSize = MIN_TREE_SITTER_BUFFER_SIZE;
  while (bufferSize <= byteLength) {
    bufferSize *= 2;
  }
  return bufferSize;
};

export const parseWithAdaptiveBuffer = (
  parser: { parse: (input: string, oldTree?: unknown, options?: { bufferSize?: number }) => unknown },
  content: string,
): unknown => {
  const bufferSize = getAdaptiveTreeSitterBufferSize(content);
  return parser.parse(content, undefined, { bufferSize });
};

/**
 * Map file extension to SupportedLanguage enum
 */
export const getLanguageFromFilename = (filename: string): SupportedLanguages | null => {
  // Blade templates (Laravel): excluded from PHP AST parsing (indexed separately as Template nodes)
  if (filename.endsWith('.blade.php')) return null;
  // TypeScript (including TSX)
  if (filename.endsWith('.tsx')) return SupportedLanguages.TypeScript;
  if (filename.endsWith('.ts')) return SupportedLanguages.TypeScript;
  // JavaScript (including JSX)
  if (filename.endsWith('.jsx')) return SupportedLanguages.JavaScript;
  if (filename.endsWith('.js')) return SupportedLanguages.JavaScript;
  // Svelte (parse <script> blocks with TypeScript grammar)
  if (isSvelteFile(filename)) return SupportedLanguages.TypeScript;
  // Python
  if (filename.endsWith('.py')) return SupportedLanguages.Python;
  // PHP
  if (filename.endsWith('.php')) return SupportedLanguages.PHP;
  // Java
  if (filename.endsWith('.java')) return SupportedLanguages.Java;
  // C (source and headers)
  if (filename.endsWith('.c') || filename.endsWith('.h')) return SupportedLanguages.C;
  // C++ (all common extensions)
  if (filename.endsWith('.cpp') || filename.endsWith('.cc') || filename.endsWith('.cxx') ||
      filename.endsWith('.hpp') || filename.endsWith('.hxx') || filename.endsWith('.hh')) return SupportedLanguages.CPlusPlus;
  // C#
  if (filename.endsWith('.cs')) return SupportedLanguages.CSharp;
  // Go
  if (filename.endsWith('.go')) return SupportedLanguages.Go;
  // Rust
  if (filename.endsWith('.rs')) return SupportedLanguages.Rust;
  return null;
};
