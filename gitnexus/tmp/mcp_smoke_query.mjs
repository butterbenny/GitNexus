import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const CLI_ENTRY = new URL('../dist/cli/index.js', import.meta.url).pathname;

const transport = new StdioClientTransport({
  command: 'node',
  args: [CLI_ENTRY, 'mcp'],
  stderr: 'pipe',
});

const stderr = transport.stderr;
if (stderr) {
  stderr.on('data', chunk => process.stderr.write(chunk));
}

const client = new Client({ name: 'gitnexus-mcp-smoke', version: '0.0.0' });

await client.connect(transport);

await client.callTool({
  name: 'list_repos',
  arguments: {},
});

const result = await client.callTool({
  name: 'query',
  arguments: {
    repo: '/Users/benny/code/GitNexus',
    query: 'LocalBackend callTool',
    limit: 2,
    max_symbols: 5,
  },
});

const text = result?.content?.find(item => item.type === 'text')?.text || '';
console.log(text.slice(0, 400));

await transport.close();
