import JSONTag from '@muze-nl/jsontag'
import {isChanged, source, getBuffer, getIndex} from '../src/symbols.mjs'
import Parser from '../src/parse.mjs'
import serialize, {stringify} from '../src/serialize.mjs'
import tap from 'tap'

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