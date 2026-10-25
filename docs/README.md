# Pi-Less-Durable Documentation

This directory is an orientation layer for Pi-Less-Durable development.

## Documentation contract

**Code is the single source of truth for understanding how Pi-Less-Durable works.** Types, signatures, defaults, supported values, ordering details, and edge-case behavior must be verified in current source code and focused tests. If a document conflicts with code, trust the code and correct the document.

Documentation exists to help a reader quickly form a broad mental model and find the next source files to inspect. It should contain only:

- high-level concepts and invariants
- ownership and lifecycle boundaries
- subsystem responsibilities
- event and data-flow diagrams
- supported extension points and decision guidance
- stable source-entry points

Documentation should not duplicate:

- TypeScript interfaces or complete API references
- exhaustive operational catalogs of commands, tools, options, or environment variables
- implementation walkthroughs that mirror functions line by line
- exact defaults, retry counts, timeouts, or provider-specific details
- historical review evidence, migration proof, release notes, or completed implementation plans
- large catalogs of files or bundled extensions

Small architectural inventories—such as built-in components, prompt sections, or Pi-Less-Durable-owned lifecycle events—are appropriate when they explain ownership or guide extension decisions. Keep signatures, payload shapes, defaults, and edge behavior in source.

Put exact contracts in types, validation code, and tests. In docs, link to those sources.

## How to use these docs

1. Read this page.
2. Read only the topic document relevant to the task.
3. Follow its **Source entry points** into current code.
4. Inspect nearby tests and sibling implementations.
5. Base conclusions and changes on code, not prose.

Do not read every document by default. Cross-references are navigation aids, not a requirement to load the whole documentation set.

## Topic map

- `extensions.md` — extension materialization and deterministic runtime ordering

## Maintenance rules

When changing documentation:

1. Inspect current source and relevant tests first.
2. Update a document only when a high-level concept, boundary, responsibility, event flow, invariant, or source-navigation path changed.
3. Do not add low-level behavior merely because a source change occurred.
4. Prefer replacing stale text over appending another exception or chronology.
5. Keep diagrams conceptual and stable; avoid function-by-function traces.
6. Keep each fact in one topic document and link to it rather than duplicating it.
7. End topic documents with a small **Source entry points** section.

When changing source, documentation does not need an update unless one of the high-level concerns above changed.
