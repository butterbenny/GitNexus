/**
 * MCP stdio guard
 *
 * MCP uses newline-delimited JSON-RPC messages over stdout. Any non-protocol
 * output written to stdout (console.log, native library logs, progress bars, etc.)
 * can corrupt the transport and surface as client-side errors like:
 *   "tools/call failed: Transport closed"
 *
 * This guard redirects non-JSON-RPC stdout writes to stderr while allowing
 * JSON-RPC messages through unchanged.
 */

const looksLikeJsonRpcMessage = (chunk: unknown): boolean => {
  const text = typeof chunk === 'string'
    ? chunk
    : Buffer.isBuffer(chunk)
      ? chunk.toString('utf8')
      : String(chunk ?? '');

  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{')) return false;
  if (!trimmed.includes('"jsonrpc":"2.0"')) return false;

  // JSON-RPC messages always have one of: method (request/notification),
  // result (success response), error (error response).
  if (trimmed.includes('"method"')) return true;
  if (trimmed.includes('"result"')) return true;
  if (trimmed.includes('"error"')) return true;
  return false;
};

export const installMcpStdioGuard = (): void => {
  const stdout = process.stdout;
  const stderr = process.stderr;

  // Avoid double-wrapping if the CLI is invoked multiple times in-process.
  if ((stdout as any).__gitnexus_mcp_stdio_guard_installed) return;
  (stdout as any).__gitnexus_mcp_stdio_guard_installed = true;

  const origStdoutWrite = stdout.write.bind(stdout);
  const origStderrWrite = stderr.write.bind(stderr);

  let redirectedCount = 0;

  stdout.write = ((chunk: any, encoding?: any, cb?: any) => {
    if (looksLikeJsonRpcMessage(chunk)) {
      return origStdoutWrite(chunk, encoding, cb);
    }

    redirectedCount += 1;
    if (redirectedCount === 1) {
      origStderrWrite(
        'GitNexus MCP: detected non-protocol stdout output; redirecting to stderr to protect MCP transport.\n',
      );
    }

    try {
      // Preserve raw bytes when possible.
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
        origStderrWrite(chunk as any);
        if (typeof chunk === 'string' && !chunk.endsWith('\n')) {
          origStderrWrite('\n');
        }
      } else {
        origStderrWrite(String(chunk ?? ''));
        origStderrWrite('\n');
      }
    } catch {}

    if (typeof cb === 'function') {
      try { cb(); } catch {}
    }

    // Return true to indicate the write was "handled".
    return true;
  }) as any;
};

