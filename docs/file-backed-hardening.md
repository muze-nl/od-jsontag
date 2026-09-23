# File-backed hardening

The maintainer accepted this work after the 2026-09-23 readiness review.
Branch: `fix/file-backed-readiness`, based on indexedParsing at `aa415fb`.
The goal is a trustworthy file-backed od-jsontag dependency before SimplyStore
migration, followed by client-visible version metadata and audit trails.
This continues the accepted roadmap with a revised priority ahead of rebuild.

The review reproduced record-number collisions, incomplete serialization,
broken patch layering, unbounded retention, access-policy bypasses, unchecked
file reads and stale previous-value snapshots. Existing tests passed 168
assertions but did not cover these behaviors.

Keep the current file format and lazy proxy API. Separate the complete record
catalog (record number to source and byte range) from materialized proxies.
Overlay indexed files and byte-buffer patches by stable record number; retain
untouched source locations. Callers own open descriptors and must preserve the
source bytes while a parser uses them. A parser is a live view advanced explicitly
by parse calls; independent historical snapshots use independent parsers.

Bound the clean read-only parsed-record cache, retain live proxy identity and
reload evicted bodies from their record source. Mutable edit sessions retain
touched records so array handles and uncommitted edits cannot be evicted; their
lifetime is a caller-controlled transaction boundary. Index metadata, externally
retained values and uncommitted edits are not claimed to have constant memory.
Provide streaming serialization alongside the existing buffered API.

Enforce property policy through reflection as well as direct reads. Validate
indexed byte ranges, complete reads and length prefixes. Refresh the local
before-edit snapshot after applying a record update; persistent audit history
remains subsequent work.

Acceptance evidence: regression tests must first reproduce the reviewed defects,
then pass alongside existing tests; exercise overlays, Unicode offsets, sparse
records, serialization, read failures, access policy and cache eviction. Establish
an explicit passing test/lint baseline and recheck partial-read performance and
cumulative cache retention. No SimplyStore migration, release, production data
operation or audit-trail implementation is included.
