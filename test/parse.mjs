import JSONTag from '@muze-nl/jsontag'
import {isChanged, source, getBuffer, getIndex, isProxy, proxyType, previous} from '../src/symbols.mjs'
import Parser from '../src/parse.mjs'
import serialize, {stringify} from '../src/serialize.mjs'
import tap from 'tap'
import {closeSync, openSync, writeFileSync} from 'node:fs'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const parser = new Parser()

function stringToSAB(strData) {
	const buffer = encoder.encode(strData)
	const sab = new SharedArrayBuffer(buffer.length)
	let uint8sab = new Uint8Array(sab)
	uint8sab.set(buffer,0)
	return uint8sab
}

function lineIndex(strData) {
	const buffer = encoder.encode(strData)
	let result = []
	let start = 0
	for (let i=0; i<buffer.length; i++) {
		if (buffer[i]===10) {
			result.push([start, i])
			start = i+1
		}
	}
	if (start<buffer.length) {
		result.push([start, buffer.length])
	}
	return result
}

tap.test('Parse', t => {
	let s = `(23){"foo":[~1],"bar":[~2]}
(64)<object class="foo" id="1">{"name":"Foo",#"nonEnumerable":"bar"}
(57)<object class="bar" id="2">{"name":"Bar","children":[~1]}`
	let root = parser.parse(s)
	t.equal(root.foo[0].name, 'Foo')
	t.equal(root.foo[0], root.bar[0].children[0])
	t.equal(JSONTag.getAttribute(root.foo[0], 'class'), 'foo')
	t.end()
})

tap.test('ParseLargeArrays', t => {
	let s = `(25){"foo":[~1-3],"bar":[~2]}
(64)<object class="foo" id="1">{"name":"Foo",#"nonEnumerable":"bar"}
(57)<object class="bar" id="2">{"name":"Bar","children":[~1]}
(57)<object class="baz" id="3">{"name":"Baz","children":[~1]}
`
	let root = parser.parse(s)
	t.equal(root.foo.length, 3)
	t.end()
})

tap.test('parseSAB', t => {
	let strData = `(23){"foo":[~1],"bar":[~2]}
(64)<object class="foo" id="1">{"name":"Foo",#"nonEnumerable":"bar"}
(57)<object class="bar" id="2">{"name":"Bar","children":[~1]}`
	let sab = stringToSAB(strData)
	let root = parser.parse(sab)
	t.equal(root.foo[0].name, 'Foo')
	t.equal(root.bar[0].name, 'Bar')
	t.end()
})

tap.test('parseSAB with line index', t => {
	let strData = `(12){"foo":[~1]}
(30){"name":"Foo","children":[~2]}
(14){"name":"Bar"}`
	let indexedParser = new Parser()
	let root = indexedParser.parse(stringToSAB(strData), JSON.stringify(lineIndex(strData)))

	let foo = root.foo
	t.equal(indexedParser.meta.resultArray[1], undefined)
	t.equal(foo[0][getIndex], 1)
	t.equal(indexedParser.meta.resultArray[2], undefined)
	t.equal(foo[0].children[0].name, 'Bar')
	t.equal(foo[0].children[0], indexedParser.meta.resultArray[2])
	t.end()
})

tap.test('parse file descriptor with line index', t => {
	let strData = `(12){"foo":[~1]}
(30){"name":"Foo","children":[~2]}
(14){"name":"Bar"}`
	let path = `/tmp/od-jsontag-indexed-${process.pid}.odjt`
	let indexPath = `/tmp/od-jsontag-indexed-${process.pid}.json`
	writeFileSync(path, strData)
	writeFileSync(indexPath, JSON.stringify(lineIndex(strData)))
	let fd = openSync(path, 'r')
	let indexedParser = new Parser()
	let root
	try {
		root = indexedParser.parse(fd, indexPath)
		let foo = root.foo
		t.equal(indexedParser.meta.resultArray[1], undefined)
		t.equal(foo[0].name, 'Foo')
		t.equal(indexedParser.meta.resultArray[2], undefined)
		t.equal(foo[0].children[0].name, 'Bar')
		t.equal(foo[0].children[0], indexedParser.meta.resultArray[2])
	} finally {
		closeSync(fd)
	}
	t.end()
})

tap.test('parse JSON index document variants', t => {
	let strData = `(12){"foo":[~1]}
(14){"name":"Foo"}`
	let index = JSON.stringify(lineIndex(strData))
	let uint8Index = encoder.encode(index)
	let indexedParser = new Parser()
	let root = indexedParser.parse(stringToSAB(strData), uint8Index)
	t.equal(root.foo[0].name, 'Foo')

	let path = `/tmp/od-jsontag-index-object-${process.pid}.json`
	writeFileSync(path, index)
	let fd = openSync(path, 'r')
	try {
		indexedParser = new Parser()
		root = indexedParser.parse(stringToSAB(strData), {fd})
		t.equal(root.foo[0].name, 'Foo')
	} finally {
		closeSync(fd)
	}
	t.end()
})

tap.test('parse indexed ranges lazily', t => {
	let strData = `(14){"foo":[~1-2]}
(14){"name":"Foo"}
(14){"name":"Bar"}`
	let indexedParser = new Parser()
	let root = indexedParser.parse(stringToSAB(strData), JSON.stringify(lineIndex(strData)))
	let foo = root.foo
	t.equal(indexedParser.meta.resultArray[1], undefined)
	t.equal(indexedParser.meta.resultArray[2], undefined)
	t.equal(Array.isArray(foo), true)
	t.equal(foo.length, 2)
	t.equal(0 in foo, true)
	t.equal(foo[0].name, 'Foo')
	t.equal(indexedParser.meta.resultArray[2], undefined)
	t.equal(foo[1].name, 'Bar')
	t.same(Object.keys(foo), ['0', '1'])
	t.end()
})

tap.test('parse indexed ranges lazily falls back when mutable', t => {
	let strData = `(14){"foo":[~1-2]}
(14){"name":"Foo"}
(14){"name":"Bar"}`
	let indexedParser = new Parser(undefined, false)
	let root = indexedParser.parse(stringToSAB(strData), JSON.stringify(lineIndex(strData)))
	let foo = root.foo
	t.equal(indexedParser.meta.resultArray[1], undefined)
	t.equal(indexedParser.meta.resultArray[2], undefined)
	t.equal(foo.length, 2)
	t.equal(foo[0].name, 'Foo')
	t.equal(indexedParser.meta.resultArray[2], undefined)
	foo.push({name: 'Baz'})
	t.equal(foo[2].name, 'Baz')
	t.end()
})

tap.test('parse indexed mixed ranges lazily', t => {
	let strData = `{"foo":[0,~1-2,3]}
{"name":"Foo"}
{"name":"Bar"}`
	let indexedParser = new Parser()
	let root = indexedParser.parse(stringToSAB(strData), JSON.stringify(lineIndex(strData)))
	let foo = root.foo
	t.equal(foo.length, 4)
	t.equal(indexedParser.meta.resultArray[1], undefined)
	t.equal(indexedParser.meta.resultArray[2], undefined)
	t.equal(foo[0], 0)
	t.equal(foo[1].name, 'Foo')
	t.equal(indexedParser.meta.resultArray[2], undefined)
	t.equal(foo[2].name, 'Bar')
	t.equal(foo[3], 3)
	t.end()
})

tap.test('parse indexed array single references lazily', t => {
	let strData = `{"foo":[~1,~3]}
{"name":"Foo"}
{"name":"Unused"}
{"name":"Bar"}`
	let indexedParser = new Parser()
	let root = indexedParser.parse(stringToSAB(strData), JSON.stringify(lineIndex(strData)))
	let foo = root.foo
	t.equal(foo.length, 2)
	t.equal(indexedParser.meta.resultArray[1], undefined)
	t.equal(indexedParser.meta.resultArray[3], undefined)
	t.equal(foo[1].name, 'Bar')
	t.equal(indexedParser.meta.resultArray[1], undefined)
	t.equal(foo[0].name, 'Foo')
	t.end()
})

tap.test('parse indexed lazy array references respect access policy', t => {
	let strData = `{"foo":[~1]}
{"name":"Foo"}`
	let indexedParser = new Parser()
	indexedParser.meta.access = (object, property, method) => property !== '0' || method !== 'get'
	let root = indexedParser.parse(stringToSAB(strData), JSON.stringify(lineIndex(strData)))
	t.equal(root.foo[0], undefined)
	t.equal(indexedParser.meta.resultArray[1], undefined)
	t.end()
})

tap.test('parse indexed arrays with multiple lazy segments', t => {
	let strData = `{"foo":[~1-2,"middle",~4,~5-6]}
{"name":"One"}
{"name":"Two"}
{"name":"Unused"}
{"name":"Four"}
{"name":"Five"}
{"name":"Six"}`
	let indexedParser = new Parser()
	let root = indexedParser.parse(stringToSAB(strData), JSON.stringify(lineIndex(strData)))
	let foo = root.foo
	t.equal(foo.length, 6)
	t.equal(indexedParser.meta.resultArray[1], undefined)
	t.equal(indexedParser.meta.resultArray[6], undefined)
	t.same(Object.keys(foo), ['0', '1', '2', '3', '4', '5'])
	t.same(foo.map(item => item.name || item), ['One', 'Two', 'middle', 'Four', 'Five', 'Six'])
	t.equal(foo[0], indexedParser.meta.resultArray[1])
	t.equal(foo[3], indexedParser.meta.resultArray[4])
	t.end()
})

tap.test('parse indexed arrays reuse repeated lazy references', t => {
	let strData = `{"foo":[~1,~1]}
{"name":"Foo"}`
	let indexedParser = new Parser()
	let root = indexedParser.parse(stringToSAB(strData), JSON.stringify(lineIndex(strData)))
	let foo = root.foo
	t.equal(indexedParser.meta.resultArray[1], undefined)
	t.equal(foo[0].name, 'Foo')
	t.equal(foo[1], foo[0])
	t.equal(foo[1], indexedParser.meta.resultArray[1])
	t.end()
})

tap.test('parse invalid public inputs', t => {
	t.throws(() => new Parser().parse(12))
	t.throws(() => new Parser().parse('(2]{}'))
	t.throws(() => Object.keys(new Parser().parse('(15){"__proto__":1}')))
	t.throws(() => Object.keys(new Parser().parse('(6){"a":1')))
	t.throws(() => Object.keys(new Parser().parse('(6){"a":"')))
	t.throws(() => new Parser().parse('(2)[]', '{}'))
	t.throws(() => new Parser().parse(stringToSAB('(8){"foo":~1}'), JSON.stringify([[0, 12]])))
	t.throws(() => new Parser().parse(stringToSAB('(8){"foo":~1}(8]{"x":1}'), JSON.stringify([[0, 12], [12, 20]])).foo)
	t.end()
})

tap.test('parse typed and numeric edge values', t => {
	let data = new Parser().parse('(13){"value":-3}')
	t.equal(data.value, -3)
	t.throws(() => Object.keys(new Parser().parse('(10)<array>{}')))
	t.throws(() => Object.keys(new Parser().parse('(10)<object>[]')))
	t.end()
})

tap.test('empty containers and tagged nulls', t => {
	let emptyObject = new Parser().parse('(11){"ob":{}}')
	t.same(Object.keys(emptyObject.ob), [])
	let emptyArray = new Parser().parse('(10){"arr":[]}')
	t.same(emptyArray.arr.length, 0)
	let taggedNull = new Parser().parse('(13)<object>null')
	t.same(JSONTag.getType(taggedNull), 'object')
	t.end()
})

tap.test('object operators and access policies', t => {
	let mutableParser = new Parser()
	mutableParser.immutable = false
	let root = mutableParser.parse('(29){"name":"Foo","arr":["a","b"]}')
	t.equal('name' in root, true)
	t.equal('missing' in root, false)
	t.equal(delete root.missing, true)
	t.equal(delete root.name, true)
	t.equal(root.name, undefined)
	t.throws(() => Object.setPrototypeOf(root, {}))
	Object.defineProperty(root, 'hidden', {
		value: 'secret',
		enumerable: false,
		configurable: true,
		writable: true
	})
	t.equal(root.hidden, 'secret')
	t.same(Object.getOwnPropertyDescriptor(root, 'hidden').enumerable, false)

	let deniedParser = new Parser()
	deniedParser.immutable = false
	deniedParser.meta.access = (object, property, method) => method !== 'set'
	let deniedRoot = deniedParser.parse('(14){"name":"Foo"}')
	t.equal(Reflect.set(deniedRoot, 'name', 'Bar'), false)
	t.equal(deniedRoot.name, 'Foo')

	deniedParser = new Parser()
	deniedParser.immutable = false
	deniedParser.meta.access = (object, property, method) => method !== 'deleteProperty'
	deniedRoot = deniedParser.parse('(14){"name":"Foo"}')
	t.equal(Reflect.deleteProperty(deniedRoot, 'name'), false)
	t.equal(deniedRoot.name, 'Foo')

	deniedParser = new Parser()
	deniedParser.immutable = false
	deniedParser.meta.access = (object, property, method) => method !== 'defineProperty'
	deniedRoot = deniedParser.parse('(14){"name":"Foo"}')
	t.equal(Reflect.defineProperty(deniedRoot, 'hidden', {value: true}), false)

	deniedParser = new Parser()
	deniedParser.meta.access = (object, property, method) => method !== 'has'
	deniedRoot = deniedParser.parse('(14){"name":"Foo"}')
	t.equal('name' in deniedRoot, false)

	let immutableRoot = new Parser().parse('(14){"name":"Foo"}')
	t.throws(() => {
		delete immutableRoot.name
	})
	t.throws(() => {
		Object.defineProperty(immutableRoot, 'hidden', {value: true})
	})
	t.end()
})

tap.test('array operators and access policies', t => {
	let mutableParser = new Parser()
	mutableParser.immutable = false
	let root = mutableParser.parse('(19){"arr":["a","b"]}')
	t.equal(root.arr[source][0], 'a')
	t.equal(delete root.arr[99], true)
	t.equal(delete root.arr[0], true)
	t.equal(root.arr[0], undefined)

	let deniedParser = new Parser()
	deniedParser.immutable = false
	deniedParser.meta.access = (object, property, method) => property !== '0'
	root = deniedParser.parse('(19){"arr":["a","b"]}')
	t.equal(root.arr[0], undefined)
	t.equal(Reflect.set(root.arr, '0', 'x'), false)
	t.equal(Reflect.deleteProperty(root.arr, '0'), false)

	let immutableParser = new Parser()
	root = immutableParser.parse('(19){"arr":["a","b"]}')
	t.throws(() => root.arr.reverse())
	t.throws(() => {
		root.arr[0] = 'x'
	})
	t.throws(() => {
		delete root.arr[0]
	})
	t.end()
})

tap.test('immutable', t => {
	let strData = `(23){"foo":[~1],"bar":[~2]}
(64)<object class="foo" id="1">{"name":"Foo",#"nonEnumerable":"bar"}
(57)<object class="bar" id="2">{"name":"Bar","children":[~1]}`
	parser.immutable = true
	let root = parser.parse(strData)
	try {
		root.foo[0].name='Baz'
		t.ok(false)
	} catch(e) {
		t.ok(true)
	}
	t.equal(root.foo[0].name, 'Foo')
	t.end()
})

tap.test('encoding', t => {
	let strData = `(24){"name":"Padmé Amidala"}`
	//let sab = stringToSAB(strData)
	let padme = parser.parse(strData)
	t.equal(padme.name, "Padmé Amidala")
	t.end()
})

tap.test('entries', t => {
	let strData = `(64)<object class="foo" id="1">{"name":"Foo",#"nonEnumerable":"bar"}	`
	let root = parser.parse(strData)
	let keys = Object.keys(root)
	t.same(keys, ['name'])
	let ownKeys = Object.getOwnPropertyNames(root)
	t.same(ownKeys, ['name','nonEnumerable'])
	let descr = Object.getOwnPropertyDescriptor(root, 'nonEnumerable')
	t.equal(descr.enumerable, false)
	t.end()
})

tap.test('unicode', t => {
	let strData = `(13){"foo":"𠮷a"}` // >16bit unicode characters 
	let sab = stringToSAB(strData)
	let root = parser.parse(sab)
	t.equal(root.foo, '𠮷a')
	t.end()
})

tap.test('encoded unicode', t => {
	let strData = `(13){"foo":"\\u20aca"}` // >16bit unicode characters 
	let sab = stringToSAB(strData)
	let root = parser.parse(sab)
	t.equal(root.foo, '€a')
	t.end()
})

tap.test('access', t => {
	let strData = `(64)<object class="foo" id="1">{"name":"Foo",#"nonEnumerable":"bar"}	`
	let access = (entity, property) => {
		if (property=='name') {
			return true
		}
		return false
	}
	let accessParser = new Parser()
	accessParser.meta.access = access
	let root = accessParser.parse(strData)
	let name = root.name
	let ne = root.nonEnumerable
	t.equal(name, 'Foo')
	t.equal(ne, undefined)
	t.end()
})

tap.test('merge', t => {
	let meta = {}
	let strData = `(23){"foo":[~1],"bar":[~2]}
(64)<object class="foo" id="1">{"name":"Foo",#"nonEnumerable":"bar"}
(57)<object class="bar" id="2">{"name":"Bar","children":[~1]}`
	let root = parser.parse(strData)

	let strData2 = `+1
(64)<object class="foo" id="1">{"name":"Baz",#"nonEnumerable":"bar"}`
	let root2 = parser.parse(strData2)

	t.equal(root2.foo[0], root.foo[0])
	t.equal(root.foo[0].name, 'Baz')
	t.equal(parser.meta.resultArray[1].name, 'Baz')
	t.end()
})

tap.test('defineProperty', t => {
	let data = {
		examenprogrammaDomein: [
			{
				title: "Een domein"
			}
		],
		examenprogrammaEindterm: [
			{
				title: "Een eindterm"
			}
		]
	}
	data.examenprogrammaDomein.examenprogrammaEindterm = [
		data.examenprogrammaEindterm[0]
	]
	let strData = serialize(data)
	let mutableParser = new Parser() //'https://example.com',false)
	mutableParser.immutable = false
	let parsed = mutableParser.parse(strData)
	Object.defineProperty(parsed.examenprogrammaEindterm[0], 
		'examenprogrammaDomein', {
			value: [],
			enumerable: false,
			writable: true,
			configurable: true
		}
	);
	parsed.examenprogrammaEindterm[0].examenprogrammaDomein
	.push(parsed.examenprogrammaDomein[0])
	t.equal(parsed.examenprogrammaEindterm[0].examenprogrammaDomein[0], 
			parsed.examenprogrammaDomein[0])
	t.end()
})

tap.test('parseNull', t => {
	let data = {
		foo: null
	}
	let s = serialize(data)
	let mutableParser = new Parser('https://example.com/',false)
	let d = mutableParser.parse(s)
	t.same(d.foo, data.foo)
	d.bar = null
	let s2 = serialize(d)
	let d2 = mutableParser.parse(s2)
	t.same(d2.foo, data.foo)	
	t.end()
})

tap.test('regression check', t => {
	const dataStr = `{
    "foo":[
        <object id="bar">{
            "bar":"baz"
        }
    ]
}`
	const data = JSONTag.parse(dataStr)
	const odDataBuf = serialize(data)
	const odData = parser.parse(odDataBuf)

	let foo = odData
    t.same(JSONTag.stringify(foo, null, 4), dataStr)
    t.end()
})

tap.test('JSONTag compatibility', t => {
	const dataStr = `{
    "foo":[
        <object id="bar">{
            "bar":"baz"
        }
    ]
}`
	const data = JSONTag.parse(dataStr)
	const odDataBuf = serialize(data)
	parser.immutable = false
	const odData = parser.parse(odDataBuf)
	JSONTag.setAttribute(odData.foo[0], 'class', 'bar')
	t.same(JSONTag.getAttribute(odData.foo[0], 'class'), 'bar')
	t.same(JSONTag.getAttribute(odData.foo[0][source], 'class'), 'bar')
	t.end()
})

tap.test('handle JSONTag links', t => {
	const dataStr = `{
    "foo":[
        <object id="bar">{
            "bar":"baz"
        }
    ]
}`
	const data = JSONTag.parse(dataStr)
	const odDataBuf = serialize(data)
	const parser = new Parser()
	parser.immutable = false
	const odData = parser.parse(odDataBuf)
	// create index
	let sab = serialize(odData, {meta:parser.meta})

	const l = new JSONTag.Link('bar')
	odData.foo.push(l)
	t.same(odData.foo[0], odData.foo[1])
	t.end()
})

tap.test('handle nested JSONTag links', t => {
	const dataStr = `{
    "foo":[
        <object id="bar">{
            "bar":"baz"
        }
    ]
}`
	const data = JSONTag.parse(dataStr)
	const odDataBuf = serialize(data)
	const parser = new Parser()
	parser.immutable = false
	const odData = parser.parse(odDataBuf)
	// create index
	let sab = serialize(odData, {meta:parser.meta})

	const addedDataStr = `
<object id="baz">{
	"foo": <link>"bar"
}`
	const addedData = JSONTag.parse(addedDataStr)
	odData.baz = addedData
	t.same(odData.foo[0], odData.baz.foo)
	t.end()
})

tap.test('access array in object', t => {
	const dataStr = `{
    "foo":[
        <object id="bar">{
			"name":"bar",
            "arr":[
				<object id="baz">{
					"name":"Baz"
				}
            ]
        }
    ]
}`
	const data = JSONTag.parse(dataStr)
	const odDataBuf = serialize(data)
	const parser = new Parser()
	const odData = parser.parse(odDataBuf)
	t.ok(Array.isArray(odData.foo[0].arr))
	t.same(odData.foo[0].arr[0].name, 'Baz')
	t.end()
})

tap.test('set value in new array', t => {
	const dataStr = `
        <object id="bar">{
			"name":"bar"
	    }
`
	const data = JSONTag.parse(dataStr)
	const odDataBuf = serialize(data)
	const parser = new Parser()
	parser.immutable = false
	const odData = parser.parse(odDataBuf)
	odData.foo = {
		arr: []
	}
	odData.foo.arr[0] = 'bar'
	odData.foo.bar = 'also bar'
	t.same(odData.foo.arr[0], 'bar')
	t.end()
})

tap.test('previous value', t => {
	const dataStr = `
        <object id="bar">{
			"name":"bar"
	    }
`
	const data = JSONTag.parse(dataStr)
	const odDataBuf = serialize(data)
	const parser = new Parser()
	parser.immutable = false
	const odData = parser.parse(odDataBuf)
	odData.name = 'baz'
	odData.foo = 'bar'
	t.same(odData.name, 'baz')
	t.same(odData[previous].name, 'bar')
	t.same(odData[previous].foo, undefined)
	t.end()
})

tap.test('types', t => {
	const dataStr = `{
		"uuid": <uuid>"9408e2c7-8f6d-4c7a-8733-6fd50b791c86",
		"time": <time>"12:30:45",
		"date": <date>"1972-09-20",
		"datetime": <datetime>"1972-09-20 12:30:45",
		"datetime2": <datetime>"1972-09-20T12:30:45.10Z",
		"datetime3": <datetime>"1972-09-20t12:30:45.10z",
		"datetime3": <datetime>"1972-09-20 12:30",
		"decimal": <decimal>"1.0000001",
		"money": <money>"EUR$123.99",
		"link": <link>"https://www.muze.nl/",
		"url": <url>"https://www.example.org/",
		"text": <text>"This is a longer text",
		"blob": <blob>"Should probably be base64 encoded, but hey",
		"color": <color>"hsl(360, 100%, 50%)",
		"email": <email>"auke@muze.nl",
		"hash": <hash>"Qmbq6Su7LzgYYgfQBzJUdXjgDUZZKxt4NSs4tbYwvfH8Wd",
		"phone": <phone>"+31612345678",
		"int": <int>255,
		"uint": <uint>255
	}`
	const data = JSONTag.parse(dataStr)
	const odDataBuf = serialize(data)
	const parser = new Parser()
	const odData = parser.parse(odDataBuf)
	t.same(odData.url, "https://www.example.org/")
	t.end()
})
