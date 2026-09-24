# API Reference

This document describes the public functionality provided by `od-jsontag`.

The package is ESM-only. The default parser is portable; filesystem integration
is available through `src/node.mjs`. See [runtime requirements](portability.md).

```js
import Parser from '@muze-nl/od-jsontag'
import serialize, {stringify} from '@muze-nl/od-jsontag/src/serialize.mjs'
```

## `Parser`

```js
const parser = new Parser(baseURL, immutable)
```

`Parser` extends `JSONTag.Parser` from `@muze-nl/jsontag`.

Arguments:

- `baseURL`: optional base URL passed to the underlying JSONTag parser.
- `immutable`: optional boolean. Defaults to `true`.

When `immutable` is `true`, writes through parsed proxies throw an error. When
`false`, object and array updates are tracked and can be serialized.

```js
const readonly = new Parser()
const mutable = new Parser(undefined, false)
```

You can also change mutability after construction:

```js
parser.immutable = false
```

## `parser.parse(input, lineIndex)`

```js
const root = parser.parse(input)
const root = parser.parse(input, lineIndex)
```

Parses od-jsontag data and returns the root proxy.

### Without `lineIndex`

`input` may be:

- a string;
- a `Uint8Array`.

The parser scans the full input once and creates a proxy for every line. The
objects themselves are still parsed lazily when accessed.

```js
const root = parser.parse(buffer)
console.log(root.items[0].name)
```

### With `lineIndex`

When `lineIndex` is provided, the parser does not scan the full input. It creates
and parses only the root line at first. Other referenced lines are turned into
proxies when a reference is accessed.

`input` may be:

- a string;
- a `Uint8Array`;
- a byte source with `byteLength` and synchronous `read(start, end)`.

`lineIndex` may be:

- an already parsed JavaScript array or object keyed by record number;
- a JSON string;
- a `Uint8Array` containing JSON.

`read(start, end)` must return exactly `end - start` bytes as a `Uint8Array`,
with an exclusive end, or throw. Sources require an index and must remain
readable with unchanged bytes while any proxy can use them. The parser does
not close sources. See the [source contract](portability.md).

The parsed line index can be an array:

```json
[
  [0, 28],
  [29, 98],
  [99, 161]
]
```

Each entry is `[start, end]` byte offsets for the matching line number.

```js
const root = parser.parse(buffer, JSON.stringify(index))
```

The Node entry point additionally accepts numeric file descriptors and `{fd}`
data inputs. Indexes may also be file paths, descriptors or `{fd}` objects.
Change the parser import when migrating existing descriptor/path callers:

File-backed example:

```js
import Parser from '@muze-nl/od-jsontag/src/node.mjs'
import {openSync, closeSync} from 'node:fs'

const parser = new Parser()
const fd = openSync('data.odjt', 'r')

try {
  const root = parser.parse(fd, 'data.odjt.index.json')
  console.log(root.items[0].name)
}
finally {
  closeSync(fd)
}
```

## Lazy proxy behavior

The root value returned by `parse()` is a proxy. Referenced objects are proxies
too. Accessing a proxy parses the underlying line if it has not been parsed yet.

Operations that may trigger parsing include:

- property reads;
- property writes;
- `delete`;
- `in`;
- `Object.keys()`;
- `Object.getOwnPropertyNames()`;
- `Object.getOwnPropertyDescriptor()`;
- `Object.defineProperty()`;
- serialization of changed objects.

Array properties are also wrapped in proxies so mutations can be tracked.

In immutable indexed parsing, references inside arrays are stored as lazy array
metadata. This applies to ranges such as `[~1-100000]` and to single references
inside mixed arrays such as `[0,~1-10,"middle",~42]`. Reading `items[0]` creates
or reuses the matching line proxy only then. Mutable parsing currently
materializes line-reference placeholders so existing mutation tracking semantics
remain intact.

## Mutability and change tracking

By default the parser is immutable:

```js
const parser = new Parser()
const root = parser.parse(buffer)

root.name = 'new' // throws
```

Mutable parser:

```js
const parser = new Parser(undefined, false)
const root = parser.parse(buffer)

root.name = 'new'
root.items.push({name: 'added'})
```

Changed proxies are reserialized by `serialize()`. Unchanged proxies can reuse
their original byte range.

## `parser.meta`

`parser.meta` is inherited from JSONTag parser metadata and is also used by
od-jsontag for lazy parsing state.

Important fields:

- `meta.resultArray`: sparse view of materialized proxies and new values. Its
  length spans the logical record space; an unread indexed entry may be absent.
  Do not use this cache to enumerate the complete stored dataset. Serialization
  and `parser.getLineProxy(recordNumber)` use the complete record catalog.
- `meta.index.id`: `Map` from JSONTag `id` attributes to line numbers.
- `meta.access`: optional access-control function.

Most callers only need `meta.access` and occasionally pass `meta` into
`serialize()` so indexes are updated.

## `parser.meta.access`

```js
parser.meta.access = (object, property, method) => true
```

Controls whether a proxy operation is allowed.

Arguments:

- `object`: the target object or array.
- `property`: the property being accessed.
- `method`: the operation, such as `get`, `set`, `has`, `deleteProperty`, or
  `defineProperty`.

If the function returns false:

- reads return `undefined`;
- `in` returns `false`;
- `Reflect.set`, `Reflect.deleteProperty`, and `Reflect.defineProperty` return
  `false`;
- direct assignments may fail according to normal JavaScript strict-mode proxy
  behavior.

Example:

```js
const parser = new Parser()

parser.meta.access = (object, property, method) => {
  return property === 'name'
}

const root = parser.parse(buffer)

console.log(root.name)
console.log(root.secret) // undefined
```

## `serialize(value, options)`

```js
const buffer = serialize(value)
```

Serializes a JavaScript/JSONTag value into od-jsontag format.

Returns a `Uint8Array` backed by a `SharedArrayBuffer` when available, or an
`ArrayBuffer` otherwise. Shared memory is not required for parsing or serialization.

### `options.meta`

Pass parser metadata when serializing parsed data or when you want id indexes to
be updated:

```js
const buffer = serialize(root, {meta: parser.meta})
```

When `options.meta.index.id` exists, objects with JSONTag `id` attributes are
recorded in that map.

### `options.changes`

Serialize only changed lines:

```js
const patch = serialize(root, {
  meta: parser.meta,
  changes: true
})
```

Patch output may contain skip lines such as `+3`, meaning "skip three existing
lines".

### `options.skipLength`

Internal option used when serializing one line body without the `(N)` length
prefix. Most callers should not use it directly.

## `serializeChunks(value, options)`

```js
import {serializeChunks} from '@muze-nl/od-jsontag/src/serialize.mjs'

for (const chunk of serializeChunks(root)) {
  // Pass the chunk to a writer that handles backpressure and partial writes.
}
```

This synchronous generator uses the same options and produces the same bytes as
`serialize()`, one record/marker/separator chunk at a time. It avoids a full-output
SharedArrayBuffer. Consume it without changing the parser, its inputs, or the
dataset until iteration completes. The application owns destination publication,
durability and cleanup of partial output. Passing `meta` updates its ID index as
records are consumed. Full serialization preserves unread records; it is not a
full semantic validation of every untouched record body.

## `stringify(buffer)`

```js
const text = stringify(buffer)
```

Decodes a `Uint8Array`, `ArrayBuffer`, or `SharedArrayBuffer` view into a string.
This is mostly useful for debugging and tests.

```js
console.log(stringify(serialize(data)))
```

## Symbols

The package exposes internal state symbols from `src/symbols.mjs`.

```js
import {
  source,
  isProxy,
  proxyType,
  getBuffer,
  getIndex,
  isChanged,
  isParsed,
  position,
  parent,
  resultSet,
  previous
} from '@muze-nl/od-jsontag/src/symbols.mjs'
```

These are primarily for tests, tooling, and advanced integrations.

Commonly useful symbols:

- `isProxy`: true for od-jsontag proxies.
- `proxyType`: proxy kind, such as `parse`, `array`, or `new`.
- `getIndex`: line number of a proxy.
- `isChanged`: whether a parsed value has been changed.
- `source`: underlying target object for a proxy.
- `resultSet`: access to the parser result array.
- `previous`: shallow before-edit snapshot, refreshed after an applied record
  update. It is not a persistent version chain; referenced objects remain live.

## JSONTag links

When adding new JSONTag links to mutable parsed data, od-jsontag resolves them
through `parser.meta.index.id` when possible.

```js
const link = new JSONTag.Link('some-id')
root.items.push(link)
```

For this to work reliably, serialize with parser metadata or otherwise ensure
that `parser.meta.index.id` contains the needed id-to-line mapping.

## Non-enumerable properties

od-jsontag supports non-enumerable object properties in its serialized format.
They are written with `#` before the property name:

```text
(33){"name":"Foo",#"hidden":"secret"}
```

The property remains visible through `Object.getOwnPropertyNames()` but not
through `Object.keys()`.

## Error behavior

Parsing is lazy, so malformed data inside a referenced line may not throw until
that line is accessed.

```js
const root = parser.parse(buffer, index)

// May be fine.
root

// May throw if the referenced line is malformed.
root.items[0].name
```

This is expected: od-jsontag only parses the line needed for the current
operation.

## Indexed view lifetime and cache

Indexes may be sparse objects such as `{"0":[4,20],"7":[25,40]}`. Missing/null
entries do not replace existing records. Ranges may cover a complete framed line
or just its payload. Byte offsets refer to the supplied file, not a combined
virtual file. Every overlay keeps its own source; incoming records replace the
same record numbers and new values are allocated beyond the complete record span.

The first indexed input must supply record 0. Later indexed inputs and ordinary
buffer patches update the existing view; they are not independent snapshots.
A held object proxy observes an applied update for its record. References to
embedded arrays obtained before an update are views of the old array value;
re-read the object property after an update. Use separate parsers to retain
independent versions. Replacing `parser.meta` (or its `resultArray`) starts a new
session on the next parse, supporting reused command workers. Discard handles
from the old session.

Callers own file descriptors and must keep them open with stable contents for
the entire view lifetime. Closing, truncating or editing a source while it is
in use invalidates that contract. Offsets are copied and checked at registration.
Short reads are completed; unexpected EOF and I/O errors propagate. Framing and
JSONTag syntax are checked when a record is read/parsed. Invalid indexes are
rejected before applying their entries, but parsing a batch is not a transaction:
after a malformed parse, discard that parser rather than treating it as rolled
back. Hash verification, writer ownership and durable publication belong to the
host application.

`parser.cacheSize` is a positive integer, default 256. It limits clean decoded
record bodies retained by a read-only parser. Access evicts least recently used
bodies; their live record proxies remain usable and reload on demand. This is a
record-count limit, not a byte limit. A single record can be large. The record
catalog and weak-reference metadata grow with record count. Arrays or values
explicitly retained by callers have their own lifetimes.

`parser.cacheInfo()` reports `residentRecords` and `records` (the logical record
span, including sparse holes). `parser.clearCache()` releases cached decoded
bodies; it refuses mutable sessions or uncommitted edits. Mutable parsers retain
touched records to preserve edit/array semantics; keep them scoped to a command
or other bounded edit session. Switching an edited parser to read-only does not
make its edits evictable. Internal `source`, `resultSet` and `recordStore` symbols
are trusted integration facilities, not a security boundary for untrusted code.

Reflection respects `meta.access` for property values and `has`; immutable array
writes through `defineProperty` are rejected. Stored definitions must be
configurable data properties so record updates can replace them. Accessors,
nonconfigurable definitions, prototype changes and preventing extensions are
unsupported. JavaScript's nonconfigurable array `length` cannot be hidden from
`ownKeys`; a denied descriptor request for it throws.
