# mcp-rxnorm

RxNorm MCP — wraps the NLM RxNav REST API (free, no auth)

Part of the [Pipeworx](https://pipeworx.io) open MCP gateway.

## Tools

| Tool | Description |
|------|-------------|

## Quick Start

Add to your MCP client config:

```json
{
  "mcpServers": {
    "rxnorm": {
      "url": "https://gateway.pipeworx.io/rxnorm/mcp"
    }
  }
}
```

Or use the CLI:

```bash
npx pipeworx use rxnorm
```

## License

MIT
