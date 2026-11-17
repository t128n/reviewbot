---
name: code-review
description: Two-axis standards and specification review for Reviewbot
---

# Code review

Review changes on two independent axes:

- **Specification:** does the change implement the originating issue and preserve
  the repository's documented architecture and security invariants?
- **Standards:** does the change follow the repository's conventions, and does it
  introduce avoidable duplication, speculative generality, or unclear boundaries?

Inspect the complete diff and the relevant surrounding code. Report only actionable
findings supported by the diff or repository evidence, ordered by severity. Do not
invent findings, rewrite code, or claim that tests passed unless they were run.
Check security boundaries and regression risk before style concerns.

> Adapted from Matt Pocock's `mattpocock/skills` code-review skill.
