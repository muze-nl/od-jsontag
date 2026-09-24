# Portable parsing and Node file access

The default entry point and serializer have no Node imports. Indexed parsing
uses an explicit byte source, so an embedding can supply file bytes without
exposing a filesystem API to the parser's JavaScript environment.

## Byte source contract

```js
import Parser from '@muze-nl/od-jsontag'

const source = {
  byteLength: dataSize,
  read(start, end) {
    return readApprovedBytes(start, end)
  }
}
const parser = new Parser()
const root = parser.parse(source, offsets)
```

`byteLength` is a non-negative safe integer. `read(start, end)` is synchronous
and must return a `Uint8Array` containing exactly the requested bytes. The end
is exclusive. The adapter must complete short reads itself, or throw. Promises,
other return types and incomplete/oversized results are rejected. Read errors
propagate to the caller; the parser does not substitute empty data.

Supply an offset index as a parsed array/object, JSON string or UTF-8 bytes.
The portable parser never interprets a string as a path. Index ranges are
checked against the source size before installing them. Both framed record
ranges and payload-only ranges retain their existing meaning.

The source remains available and its bytes unchanged for the lifetime of the
parser and its proxies. Returned byte views must also remain stable; do not
reuse their backing memory as a scratch buffer. The parser reads only on demand,
may reread records after cache eviction, and does not close sources. Sparse
patches can reference separate sources while unchanged records keep the old
source. Independently retained snapshots need separate parsers.

`Uint8Array` and string inputs continue to work. An index is required for a
custom source; the parser does not scan it to reconstruct offsets.

## Node integration and migration

Existing callers of `parse(fd, index)` or `parse(bytes, indexPath)` should change
their parser import to:

```js
import Parser from '@muze-nl/od-jsontag/src/node.mjs'
```

This subclass retains the descriptor/path conveniences. It accepts numeric
file descriptors or `{fd}` for data and index files. Index descriptors are read
from their current position, as with Node's `readFileSync`.

Alternatively, use the portable parser with explicit Node adapters:

```js
import Parser from '@muze-nl/od-jsontag'
import {fileSource, loadLineIndex} from '@muze-nl/od-jsontag/src/node.mjs'

const parser = new Parser()
const root = parser.parse(fileSource(dataFd), loadLineIndex(indexPath))
```

`fileSource(fd)` captures the file size and completes positional reads.
`loadLineIndex(input)` loads Node index-file inputs or decodes an in-memory
index. Neither helper closes caller-owned descriptors. Keep all data descriptors
open until the proxies are no longer needed; index descriptors can be closed
after loading.

The data format and indexes are unchanged. Downstream packages using a pinned
older revision need the import change when they adopt this revision.

## Runtime requirements

The portable library uses modern ECMAScript facilities, including `Proxy`,
`WeakMap`, `WeakRef`, symbols and typed arrays. It also requires UTF-8
`TextEncoder` and `TextDecoder`; JSONTag URL validation uses `URL`. An embedding
must supply these Web APIs where they are absent. No Node shims are needed.

String parsing uses ordinary encoded bytes. Serialization continues to use
`SharedArrayBuffer` when available and falls back to `ArrayBuffer` otherwise.
Callers that require sharing must check their environment; the library does
not emulate shared memory.

The Node adapter and development tools retain the package's Node 20+ requirement.

## QuickJS verification

`npm test` includes `test/quickjs.mjs`, using the pinned development dependencies
`quickjs-emscripten` and esbuild. The test bundles the actual portable modules
without Node aliases, loads them inside QuickJS, and reads indexed ranges from
host-owned files through an explicit callback. The embedding converts returned
bytes to guest-owned `Uint8Array` values.

It verifies lazy reads, Unicode, array methods, cyclic/shared identity, JSONTag
attributes, read-only behavior, property access rules, sparse overlays and
serialization without `SharedArrayBuffer`. The test supplies text encoding
through copying host callbacks; a production embedding can choose guest
implementations instead. URL-dependent parsing is not covered by this test.

The callback only accepts its test sources and indexed ranges. This is a
compatibility test, not a production sandbox or a performance benchmark. The
application still owns grants, source authorization, resource limits and worker
lifetime. No QuickJS dependency is added to the published runtime library.
