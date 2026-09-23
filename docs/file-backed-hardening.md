# File-backed hardening

The maintainer confirmed this hardening goal after the 2026-09-23 readiness review.
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

## Evaluation

Status: implementation complete, ready for human review. Outcome acceptance and
integration remain pending. Baseline commit `87647d2` preserves the regression
cases before product changes: 25 failed assertions among the first 40 assertions
reached. Existing tests had previously passed 168 assertions.

The implementation separates `Records` source locations from cached proxies,
uses the complete record span for allocation/serialization, overlays sources by
record number, bounds read-only decoded records, and provides `serializeChunks`.
Index JSON objects and arrays both preserve sparse numbering. Read loops handle
short reads and reject EOF; indexed framing is checked. Reflection policies and
read-only definitions are enforced. Applied records refresh before-edit snapshots.
Graph identity and escaped surrogate pairs are covered. Replacing metadata resets
the record session, preserving SimplyStore's reused command-worker behavior.

Validation on Node v24.7.0 with JSONTag 0.10.4 and tap 21.1.6:

- `npm test`: 267 assertions pass (168 existing plus 99 new), no failures.
  Statement/line coverage 91.37%; branch coverage 89.75%. Coverage remains
  incomplete and is reported explicitly rather than making the default test
  command fail independently of assertions.
- `npm run lint` and `git diff --check`: pass. Node globals are configured;
  dead breaks and unused test variables were removed. One old Unicode fixture
  had an incorrect byte count, now corrected without changing its assertion.
- A disposable SimplyStore checkout of `dbb0703`, using this dependency, passes
  all 118 runtime/startup/conversion/command-offset/ACID/handler/crash/storage/
  recovery/power-loss-baseline regression tests. This does not rerun the separate
  QEMU block-level power-cut campaign or establish a new filesystem envelope.
- The downstream suite first caught retained record numbering across reused
  command-worker metadata. Its regression is now included and the full suite
  passes after the correction.
- Real curriculum base: 181,724 records / 77,952,430 bytes. Compared 1,000 sampled
  object signatures with the installed 0.4.6 buffered reader. Streamed every
  record and obtained the exact original SHA-256. Source hash before and after
  the read-only probe matched; no source/index file was edited.
- `benchmark/retention.mjs` with a 48 MB V8 heap limit scanned 20,000 records in a
  328,328,915-byte file, verified the checksum, and held the clean cache at 256
  records. It sampled approximately 14.44 MB retained heap after the full scan,
  and 10.16 MB after clearing the cache. This is a larger-than-JavaScript-heap
  test, not a larger-than-physical-RAM or cold-storage test.
- `npm pack --dry-run`: includes the new source module and documentation; no
  package was published and the version was not bumped.

The original prototype's partial-read benchmark became slower at startup because
registration now validates the full index and creates a source catalog. A single
100,000-record/1,000-read run measured approximately 44 ms open + 28 ms access for
files, versus 46 ms + 26 ms for indexed SharedArrayBuffer input. Both checksums
matched. `docs/performance.md` distinguishes these measurements from historical
prototype results.

Remaining boundaries: descriptors and source bytes are caller-owned; parser
updates are explicit live-view changes, not transactional or historical snapshots;
mutable sessions retain touched data; record metadata and caller-retained values
are outside the clean-record cache bound. `previous` is shallow local state, not
an audit trail. Stored property definitions must be configurable data properties.
The trusted internal symbols do not constitute a sandbox security boundary.

SimplyStore's file-only migration remains the next integration task: worker
source lifetime/ownership, index loading, integrity checks and command snapshots
still need to be adapted there. No SimplyStore code or dependency was changed by
this cycle. Version metadata and client audit trails remain subsequent work.
