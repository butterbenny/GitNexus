# AI Agent Rules

<!-- gitnexus:start -->
# GitNexus MCP

This project is indexed by GitNexus as **GitnexusV2** (1295 symbols, 3262 relationships, 99 execution flows).

GitNexus provides a knowledge graph over this codebase — call chains, blast radius, execution flows, and semantic search.

## Always Start Here

For any task involving code understanding, debugging, impact analysis, or refactoring, you must:

1. **Read `gitnexus://repo/{name}/context`** — codebase overview + check index freshness
2. **Match your task to a skill below** and **read that skill file**
3. **Follow the skill's workflow and checklist**

> If step 1 warns the index is stale, refresh via the local build (avoid `npx gitnexus@...` which won’t include this fork’s monorepo/PHP features):
> - `CODEX_HOME="${CODEX_HOME:-$HOME/.codex}" "$CODEX_HOME/skills/nexus-maintenance/scripts/refresh_index.sh" /path/to/repo`

## Skills

Core-only policy: use only the 4 kernel-head skills below. Legacy wrapper skills are deprecated.

| Task | Read this skill file |
|------|---------------------|
| Query kernel head (`query_mode`) | `.claude/skills/gitnexus/query/SKILL.md` |
| Implement kernel head (`implement_mode`) | `.claude/skills/gitnexus/implement/SKILL.md` |
| Review kernel head (`review_mode`) | `.claude/skills/gitnexus/review/SKILL.md` |
| Debug kernel head (`debug_mode`) | `.claude/skills/gitnexus/debug/SKILL.md` |

## Tools Reference

| Tool | What it gives you |
|------|-------------------|
| `query` | Process-grouped code intelligence — execution flows related to a concept |
| `context` | 360-degree symbol view — categorized refs, processes it participates in |
| `impact` | Symbol blast radius — what breaks at depth 1/2/3 with confidence |
| `detect_changes` | Git-diff impact — what do your current changes affect |
| `rename` | Multi-file coordinated rename with confidence-tagged edits |
| `cypher` | Raw graph queries (read `gitnexus://repo/{name}/schema` first) |
| `list_repos` | Discover indexed repos |

## Resources Reference

Lightweight reads (~100-500 tokens) for navigation:

| Resource | Content |
|----------|---------|
| `gitnexus://repo/{name}/context` | Stats, staleness check |
| `gitnexus://repo/{name}/clusters` | All functional areas with cohesion scores |
| `gitnexus://repo/{name}/cluster/{clusterName}` | Area members |
| `gitnexus://repo/{name}/processes` | All execution flows |
| `gitnexus://repo/{name}/process/{processName}` | Step-by-step trace |
| `gitnexus://repo/{name}/schema` | Graph schema for Cypher |

## Graph Schema

**Nodes:** File, Function, Class, Interface, Method, Community, Process
**Edges (via CodeRelation.type):** CALLS, IMPORTS, EXTENDS, IMPLEMENTS, DEFINES, MEMBER_OF, STEP_IN_PROCESS

```cypher
MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(f:Function {name: "myFunc"})
RETURN caller.name, caller.filePath
```

<!-- gitnexus:end -->
