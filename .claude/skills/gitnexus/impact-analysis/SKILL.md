---
name: gitnexus-impact-analysis
description: "DEPRECATED wrapper. Use core GitNexus kernel-head skills only."
---

# Deprecated: `gitnexus-impact-analysis`

This skill is phased out.

Use core skills instead:

1. `review` (`review_mode`) for diff-aware blast radius and suggested tests.
2. `query` (`query_mode`) when you need additional architecture context.
3. `implement` (`implement_mode`) only if edits are required.

Mandatory chain for code changes:

- `review/query -> implement -> review`
