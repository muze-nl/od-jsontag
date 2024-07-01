# od-jsontag: On Demand JSONTag

This library implements a parser and stringifier for a variant of [JSONTag](https://github.com/muze-nl/jsontag/) which is optimized so that you only need to parse objects that you use and skip parsing any other objects.
This is especially useful to share data between threads or other workers using sharedArrayBuffers, the only shared memory option in javascript currently.

The parse function creates in memory Proxy objects that trigger parsing only when accessed. You can use the data as normal objects for most use-cases. The format supports non-enumerable 
properties, which aren't part of the normal JSONTag format. The parse function expects an ArrayBuffer a input.

The stringify function creates a sharedArrayBuffer, which represents a file with one object per line. Each line is prefixed with a byte counter that indicates the length of the line. References to other objects are encoded as ~n, where n is the line number (starting at 0).

The parse function doesn't build an id index, because that requires parsing all objects. Instead the stringify function builds or updates the id index. It isn't included in the string result.

In addition to the normal meta options, as defined in the [JSONTag library](https://github.com/muze-nl/jsontag/), od-jsontag adds the `meta.access` option. This must be a function like:

```
meta.access = (object, property, method) => true | false
```

If meta.access returns true, access to that property is allowed. Otherwise access is disallowed and the property value returned is `undefined`.

The `method` parameter is one of `set`,`get`,`has`,`deleteProperty`,`defineProperty`.

Add the access function in the meta parameter of the `parse` method:

```
import parse from 'od-jsontag'
meta = {
	access: (object, property, method) => {
		return property=='name'
	}
}
const root = parse(string, meta)
```
