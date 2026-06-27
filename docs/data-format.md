# The od-jsontag Data Format

This document explains the serialized data format in simple terms.

The short version:

- the file is text;
- each line contains one value;
- line `0` is the root;
- references point to other line numbers;
- each line says how many bytes its value uses;
- an optional JSON index can map line numbers to byte offsets.

## A tiny example

```text
(23){"foo":[~1],"bar":[~2]}
(57)<object class="foo" id="1">{"name":"Foo",#"hidden":"bar"}
(57)<object class="bar" id="2">{"name":"Bar","children":[~1]}
```

There are three lines.

Line `0` is the root:

```text
(23){"foo":[~1],"bar":[~2]}
```

The root has two properties:

- `foo` is an array containing a reference to line `1`.
- `bar` is an array containing a reference to line `2`.

Line `1` is an object named `Foo`.

Line `2` is an object named `Bar`, and its `children` array points back to line
`1`.

That means these two paths refer to the same object:

```js
root.foo[0]
root.bar[0].children[0]
```

## Line numbers

Lines are zero-based:

```text
line 0: root
line 1: first referenced object
line 2: second referenced object
line 3: third referenced object
```

References use `~` followed by the line number:

```text
~1
```

This means "the value at line 1".

## Length prefixes

Every normal line starts with a byte length:

```text
(23){"foo":[~1],"bar":[~2]}
```

`(23)` means the JSONTag value after the prefix is 23 bytes long.

The length counts bytes, not JavaScript string characters. This matters for
Unicode values.

For example, characters outside ASCII may use more than one byte in UTF-8. The
serializer handles this for you.

## Values after the prefix

After the length prefix, the rest of the line is JSONTag-like data:

```text
{"name":"Foo"}
```

Tagged values and attributes use JSONTag syntax:

```text
<object class="foo" id="1">{"name":"Foo"}
<date>"1972-09-20"
<int>255
```

od-jsontag relies on `@muze-nl/jsontag` for JSONTag type and attribute handling.

## Object references

References replace nested objects.

Instead of serializing this as one deeply nested JSON tree:

```js
{
  foo: [
    {name: 'Foo'}
  ]
}
```

od-jsontag stores the root and the object separately:

```text
(10){"foo":~1}
(14){"name":"Foo"}
```

When the parser sees `~1`, it returns the object for line `1`. With lazy parsing,
that line may not be parsed until a property is accessed:

```js
const root = parser.parse(buffer)

// Accessing this parses line 1 if needed.
console.log(root.foo.name)
```

Arrays usually contain references:

```text
(12){"foo":[~1]}
(14){"name":"Foo"}
```

## Reference ranges

Arrays can use a compact range syntax:

```text
~1-3
```

Inside an array, this means:

```text
~1,~2,~3
```

Example:

```text
(14){"foo":[~1-3]}
(14){"name":"One"}
(14){"name":"Two"}
(16){"name":"Three"}
```

Without an offset index, or when mutable parsing is enabled, the parser expands
the range into an array with three references. With immutable indexed parsing,
array references can stay lazy even inside mixed arrays. The array stores lazy
metadata for ranges and single references, and each referenced entry creates its
line proxy only when that entry is read.

## Non-enumerable properties

JavaScript objects can have properties that do not appear in `Object.keys()`.
od-jsontag supports this by prefixing the property with `#`:

```text
(33){"name":"Foo",#"hidden":"secret"}
```

After parsing:

```js
Object.keys(obj)
// ["name"]

Object.getOwnPropertyNames(obj)
// ["name", "hidden"]
```

This `#` prefix is an od-jsontag extension and is not part of normal JSON.

## Patch lines

When serializing only changes, output can contain skip lines:

```text
+2
(49)<object id="2">{"name":"Changed","children":[~1]}
```

`+2` means "skip two existing lines".

This is useful for patch-style output where only changed lines need to be sent
or stored.

## The optional line index

The data file itself does not have to include an index. You can keep an index as
a separate JSON document:

```json
[
  [0, 28],
  [29, 98],
  [99, 161]
]
```

Each array entry maps a line number to byte offsets:

```text
index[0] = [start byte for line 0, end byte for line 0]
index[1] = [start byte for line 1, end byte for line 1]
index[2] = [start byte for line 2, end byte for line 2]
```

The end offset is exclusive, following JavaScript `slice(start, end)` behavior.

For example:

```js
const lineBytes = data.slice(start, end)
```

With this index, `parser.parse(input, index)` can skip scanning the file. It can
read line `0`, parse the root, and defer every other line until a reference is
actually accessed.

## File-backed parsing

When you pass a file descriptor as `input` together with an index, od-jsontag
does not load the full data file into memory.

Instead, it reads the byte range for each line as needed:

```js
const root = parser.parse(dataFd, 'data.odjt.index.json')

// Reads and parses only line 1 if root.foo points to ~1.
root.foo.name
```

This can reduce memory use for very large files. The tradeoff is that each newly
accessed line needs a file read.

## SharedArrayBuffer-backed parsing

`serialize()` returns a `Uint8Array` backed by a `SharedArrayBuffer`.

That means the same byte data can be shared between Node.js workers. Each worker
can create its own parser and lazy proxy graph over the same bytes.

```js
const buffer = serialize(data)
const root = parser.parse(buffer)
```

With a `SharedArrayBuffer`, reading a referenced line is just a byte slice from
memory. With a file descriptor, it is a file read.

## What is stored and what is not

Stored in the data:

- JSONTag values;
- JSONTag types and attributes;
- object references as line numbers;
- non-enumerable properties using `#`;
- changed-line skips in patch output.

Not stored in the main data:

- the line index;
- the id index;
- parser access-control rules;
- JavaScript proxy state;
- change-tracking metadata such as previous values.

The id index is built or updated during serialization when metadata is supplied.
The line index is a separate JSON document that you can generate and store next
to the data file.

## Why the format is text

The format is text because it is easy to inspect, debug, diff, and generate. The
length prefix makes it fast to find the end of a line body once a line starts,
and the optional index makes random access possible without scanning the file.

This is not a compressed or columnar format. It is optimized for lazy access to
object-shaped data through JavaScript proxies.

## Limitations

- The format is object-oriented, not column-oriented.
- The main data file does not include its line index.
- Lazy parsing means some errors are discovered only when a referenced line is
  accessed.
- Root arrays are not the primary use case; the root is usually an object that
  references arrays or other objects.
- Patch output with `+N` skip lines is intended to be applied with parser
  metadata from an existing parse.
