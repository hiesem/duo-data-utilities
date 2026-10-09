# Using duo-data-utilities from Claude over MCP

**Cost:** `tools/list` is free. Each `tools/call` costs $0.05, paid in USDC on Base (x402 v2). An unpaid call charges nothing.

Nothing in this file runs in CI. Keep your wallet key in an environment variable, such as `DUO_PAYER_KEY`, and never in a config file you commit.

## Add the server to Claude Code

```sh
claude mcp add --transport http duo-data-utilities https://api.duoleads.com/mcp
```

Then ask Claude to list the tools. The listing is free. A tool call needs a client that can pay x402. Claude Code's own payment support is not verified here, so check your client's documentation before you rely on it. See [mcp/README.md](../mcp/README.md) for the other clients and for the tool names.
