import JSONTag from '@muze-nl/jsontag'
import {isChanged, getBuffer, getIndex} from '../src/symbols.mjs'
import parse from '../src/parse.mjs'
import tap from 'tap'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

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
	let root = parse(s)
	t.equal(root.foo[0].name, 'Foo')
	t.equal(root.foo[0], root.bar[0].children[0])
	t.end()
})


tap.test('parseSAB', t => {
	let strData = `(23){"foo":[~1],"bar":[~2]}
(64)<object class="foo" id="1">{"name":"Foo",#"nonEnumerable":"bar"}
(57)<object class="bar" id="2">{"name":"Bar","children":[~1]}`
	let sab = stringToSAB(strData)
	let root = parse(sab)
	t.equal(root.foo[0].name, 'Foo')
	t.equal(root.bar[0].name, 'Bar')
	t.end()
})

tap.test('immutable', t => {
	let strData = `(23){"foo":[~1],"bar":[~2]}
(64)<object class="foo" id="1">{"name":"Foo",#"nonEnumerable":"bar"}
(57)<object class="bar" id="2">{"name":"Bar","children":[~1]}`
	let root = parse(strData, {}, true) // immutable
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
	let sab = stringToSAB(strData)
	let padme = parse(sab)
	t.equal(padme.name, "Padmé Amidala")
	t.end()
})

tap.test('entries', t => {
	let strData = `(64)<object class="foo" id="1">{"name":"Foo",#"nonEnumerable":"bar"}	`
	let root = parse(strData)
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
	let root = parse(sab)
	t.equal(root.foo, '𠮷a')
	t.end()
})

tap.test('accss', t => {
	let strData = `(64)<object class="foo" id="1">{"name":"Foo",#"nonEnumerable":"bar"}	`
	let access = (entity, property) => {
		if (property=='name') {
			return true
		}
		return false
	}
	let root = parse(strData, { access })
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
	let root = parse(strData, meta)

	let strData2 = `+1
(64)<object class="foo" id="1">{"name":"Baz",#"nonEnumerable":"bar"}`
	let root2 = parse(strData2, meta)

	t.equal(root2.foo[0], root.foo[0])
	t.equal(root.foo[0].name, 'Baz')
	t.equal(meta.resultArray[1].name, 'Baz')
	t.end()
})