---
name: gitnexus-exploring
description: Navigate unfamiliar code using GitNexus knowledge graph
---

# Exploring Codebases with GitNexus

## When to Use
- "How does authentication work?"
- "What's the project structure?"
- "Show me the main components"
- "Where is the database logic?"
- Understanding code you haven't seen before

## Workflow

```
1. READ gitnexus://repos                           → Discover indexed repos
2. READ (mcp_uri_context from gitnexus://repos)     → Codebase overview, check staleness (worktree-safe)
3. (Optional) READ gitnexus://repo/{name}/archetypes → Find common flow signatures + exemplars ("more than a map")
4. query({query: "<what you want to understand>"})  → Find related execution flows
5. context({name: "<symbol>"})                      → Deep dive on specific symbol
6. READ gitnexus://repo/{name}/process/{name}       → Trace full execution flow
```

> If step 2 says "Index is stale" → run `gitnexus analyze` in terminal.
>
> Worktrees: repo names can collide across worktrees. Prefer the path-encoded URIs shown in `gitnexus://repos` (see `mcp_uri_context`).

## Checklist

```
- [ ] READ gitnexus://repo/{name}/context
- [ ] (Optional) READ gitnexus://repo/{name}/archetypes to find a proven template shape
- [ ] query for the concept you want to understand
- [ ] Review returned processes (execution flows)
- [ ] context on key symbols for callers/callees
- [ ] READ process resource for full execution traces
- [ ] Read source files for implementation details
```

## Resources

| Resource | What you get |
|----------|-------------|
| `gitnexus://repo/{name}/context` | Stats, staleness warning (~150 tokens). `{name}` may be a URL-encoded absolute repo path. |
| `gitnexus://repo/{name}/clusters` | All functional areas with cohesion scores (~300 tokens) |
| `gitnexus://repo/{name}/cluster/{name}` | Area members with file paths (~500 tokens) |
| `gitnexus://repo/{name}/process/{name}` | Step-by-step execution trace (~200 tokens) |

## Tools

**query** — find execution flows related to a concept:
```
query({query: "payment processing"})
→ Processes: CheckoutFlow, RefundFlow, WebhookHandler
→ Symbols grouped by flow with file locations
```

**context** — 360-degree view of a symbol:
```
context({name: "validateUser"})
→ Incoming calls: loginHandler, apiMiddleware
→ Outgoing calls: checkToken, getUserById
→ Processes: LoginFlow (step 2/5), TokenRefresh (step 1/3)
```

## Example: "How does payment processing work?"

```
1. READ gitnexus://repo/my-app/context       → 918 symbols, 45 processes
2. (Optional) READ gitnexus://repo/my-app/archetypes
3. query({query: "payment processing"})
   → CheckoutFlow: processPayment → validateCard → chargeStripe
   → RefundFlow: initiateRefund → calculateRefund → processRefund
4. context({name: "processPayment"})
   → Incoming: checkoutHandler, webhookHandler
   → Outgoing: validateCard, chargeStripe, saveTransaction
5. Read src/payments/processor.ts for implementation details
```
