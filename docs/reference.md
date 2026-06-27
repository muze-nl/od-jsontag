# API Reference

This document describes the public functionality provided by `od-jsontag`.

The package is ESM-only and targets Node.js.

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
- a numeric file descriptor;
- an object with an integer `.fd` property.

`lineIndex` may be:

- an already parsed JavaScript array;
- a JSON string;
- a `Uint8Array` containing JSON;
- a path to a JSON index file;
- a numeric file descriptor for a JSON index file;
- an object with an integer `.fd` property for a JSON index file.

The parsed line index must be an array:

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

File-backed example:

```js
import {openSync, closeSync} from 'node:fs'

const parser = new Parser()
const fd = openSync('data.odjt', 'r')

try {
  const root = parser.parse(fd, 'data.odjt.index.json')
  console.log(root.items[0].name)
} finally {
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

- `meta.resultArray`: array of line proxies and new values.
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

Returns a `Uint8Array` backed by a `SharedArrayBuffer`.

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
- `previous`: clone of the previous value, set when mutable objects are changed.

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
