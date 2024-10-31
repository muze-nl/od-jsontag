import JSONTag from '@muze-nl/jsontag'
import * as odJSONTag from '../src/jsontag.mjs'
import serialize, {stringify} from '../src/serialize.mjs'
import {source, isChanged, getBuffer, getIndex, isProxy} from '../src/symbols.mjs'
import parse from '../src/parse.mjs'
import tap from 'tap'

tap.test('Links', t => {
 	let jsont=`{
    "foo":[
        <object class="foo" id="1">{
            "name":"Foo"
        }
    ],
    "bar":[
        <object class="bar" id="2">{
            "name":"Bar",
            "children":[
                <link>"1"
            ]
        }
    ]
}`
	let expect = `(23){"foo":[~1],"bar":[~2]}
(64)<object class="foo" id="1">{"name":"Foo",#"nonEnumerable":"bar"}
(57)<object class="bar" id="2">{"name":"Bar","children":[~1]}`
	let o = JSONTag.parse(jsont);
	Object.defineProperty(o.foo[0], 'nonEnumerable', {
		value: 'bar',
		enumerable: false
	})
	let b = serialize(o)
	let s = stringify(b)
	t.equal(s, expect)
	t.end()
})

tap.test('identity', t => {
	let strData = `(23){"foo":[~1],"bar":[~2]}
(64)<object class="foo" id="1">{"name":"Foo",#"nonEnumerable":"bar"}
(57)<object class="bar" id="2">{"name":"Bar","children":[~1]}`
	let root = parse(strData);
	t.equal(odJSONTag.getAttribute(root.foo[0], 'id'), '1')
	let meta = {}
	let sab = serialize(root, {meta})
	t.equal(meta.index.id.get('1'),1)
	t.end()
})

tap.test('update', async t => {
	let strData = `(23){"foo":[~1],"bar":[~2]}
(64)<object class="foo" id="1">{"name":"Foo",#"nonEnumerable":"bar"}
(57)<object class="bar" id="2">{"name":"Bar","children":[~1]}`
	let expect = `(23){"foo":[~1],"bar":[~2]}
(64)<object class="foo" id="1">{"name":"Baz",#"nonEnumerable":"bar"}
(57)<object class="bar" id="2">{"name":"Bar","children":[~1]}`
	
	let root = parse(strData, {}, false)
	root.foo[0].name='Baz'
	t.equal(root.foo[0].name, 'Baz')
	let b = serialize(root)
	strData = stringify(b)
	t.equal(strData, expect)
	t.end()

})

tap.test('append', t => {
	let strData = `(23){"foo":[~1],"bar":[~2]}
(64)<object class="foo" id="1">{"name":"Foo",#"nonEnumerable":"bar"}
(57)<object class="bar" id="2">{"name":"Bar","children":[~1]}`
	let expect = `(26){"foo":[~1,~3],"bar":[~2]}
(64)<object class="foo" id="1">{"name":"Foo",#"nonEnumerable":"bar"}
(57)<object class="bar" id="2">{"name":"Bar","children":[~1]}
(30){"name":"Baz","children":[~1]}`
	let root = parse(strData, {}, false)
	root.foo.push({
		name: 'Baz',
		children: [
			root.foo[0]
		]
	})
	//globalThis.meer = true
	let sab = serialize(root) // infinite loop...
	strData = stringify(sab)
	t.equal(strData, expect)
	t.end()

})

tap.test('appendChild', t => {
	let strData = `(23){"foo":[~1],"bar":[~2]}
(64)<object class="foo" id="1">{"name":"Foo",#"nonEnumerable":"bar"}
(57)<object class="bar" id="2">{"name":"Bar","children":[~1]}`
	let expect = `(26){"foo":[~1,~3],"bar":[~2]}
(64)<object class="foo" id="1">{"name":"Foo",#"nonEnumerable":"bar"}
(57)<object class="bar" id="2">{"name":"Bar","children":[~1]}
(30){"name":"Baz","children":[~4]}
(16){"name":"Child"}`
	
	let root = parse(strData, {}, false)
	root.foo.push({
		name: 'Baz',
		children: [
			{
				name: 'Child'				
			}
		]
	})
	strData = stringify(serialize(root))
	t.equal(strData, expect)
	t.end()

})

tap.test('delete', t => {
	let strData = `(23){"foo":[~1],"bar":[~2]}
(64)<object class="foo" id="1">{"name":"Foo",#"nonEnumerable":"bar"}
(57)<object class="bar" id="2">{"name":"Bar","children":[~1]}`
	let expect = `(21){"foo":[],"bar":[~2]}
(64)<object class="foo" id="1">{"name":"Foo",#"nonEnumerable":"bar"}
(57)<object class="bar" id="2">{"name":"Bar","children":[~1]}`
	
	let root = parse(strData, {}, false)
	root.foo.pop()
	strData = stringify(serialize(root))
	t.equal(root.foo[isChanged], true)
	t.equal(strData, expect)
	t.end()

})

tap.test('circular', t => {
	let strData =`{
	"foo":[
		<object id="1">{"name":"Foo","children":[<link>"2"]}
	],"bar":[
		<object id="2">{"name":"Bar","children":[<link>"1"]}
	]
}`
	let expect = `(23){"foo":[~1],"bar":[~2]}
(45)<object id="1">{"name":"Foo","children":[~2]}
(45)<object id="2">{"name":"Bar","children":[~1]}`
	let data = JSONTag.parse(strData)
	let result = stringify(serialize(data))
	t.equal(result,expect)
	t.end()
})

tap.test('nonEnumerableArrayProxy', t => {
	let strData = `(64)<object class="foo" id="1">{"name":"Foo",#"arr":["foo","bar"]}`
	let root = parse(strData) // immutable
	try {
		root.arr.push('baz')
		t.ok(false)
	} catch(e) {
		t.ok(true)
	}
	root = parse(strData, {}, false) // mutable
	root.arr.push('baz')
	t.same(root.arr[2], 'baz')
	t.end()
})

tap.test('nonEnumerableArrayLink', t => {
	let strData = `(53)<object class="foo" id="1">{"name":"Foo",#"arr":[~0]}`
	let root = parse(strData, {}, false)
	root.name = 'Bar' // force change
	let buf = serialize(root)
	let str = stringify(buf)
	t.same(str, `(53)<object class="foo" id="1">{"name":"Bar",#"arr":[~0]}`)
	t.end()
})

tap.test('changes-only', t => {
	let strData = `(23){"foo":[~1],"bar":[~2]}
(45)<object id="1">{"name":"Foo","children":[~2]}
(45)<object id="2">{"name":"Bar","children":[~1]}`
	let data = parse(strData, {}, false)
	data.bar[0].name = 'Baz'
	let result = stringify(serialize(data, {changes: true}))
	t.same(result, `+2
(45)<object id="2">{"name":"Baz","children":[~1]}`)
	t.end()
})

tap.test('changes-only-update', t => {
	let strData = `(23){"foo":[~1],"bar":[~2]}
(45)<object id="1">{"name":"Foo","children":[~2]}
(45)<object id="2">{"name":"Bar","children":[~1]}`
	let meta = {}
	let data = parse(strData, meta, false)
	data.bar[0].name = 'Baz'
	let result = stringify(serialize(data, {changes: true}))
	parse(result, meta, false)
	data.foo[0].name = 'Fooz'
	let result2 = stringify(serialize(data, {changes: true}))
	t.same(result2, `+1
(46)<object id="1">{"name":"Fooz","children":[~2]}`)
	t.end()
})

tap.test('changes-only-additions', t => {
	let strData = `(23){"foo":[~1],"bar":[~2]}
(45)<object id="1">{"name":"Foo","children":[~2]}
(45)<object id="2">{"name":"Bar","children":[~1]}`
	let meta = {}
	let data = parse(strData, meta, false)
	
	data.bar.push({name: 'FooBar'})
	let result = stringify(serialize(data, {meta, changes: true}))
	parse(result, meta, false)

	t.ok(!meta.resultArray[3][isChanged])
	let fooz = {name: 'Fooz'}
	JSONTag.setAttribute(fooz, 'id', 'fooz')
	data.bar.push(fooz)
	let result2 = stringify(serialize(data, {meta, changes: true}))
	t.same(result2, `(25){"foo":[~1],"bar":[~2-4]}
+3
(33)<object id="fooz">{"name":"Fooz"}`)
	t.same(meta.index.id.get('fooz'), 4)
	t.end()
})

tap.test('stringify keys', t => {
	const ob = {
		"\\": 'slash',
		"\n": 'enter',
		"\"": 'quote',
		"\t": 'tab',
		"€": 'unicode'
	}
	const result = stringify(serialize(ob))
	const expect = "(67){\"\\\\\":\"slash\",\"\\n\":\"enter\",\"\\\"\":\"quote\",\"\\t\":\"tab\",\"€\":\"unicode\"}"
	console.log(result)
	t.same(result, expect)
	t.end()
})

tap.test('undefined', t => {
	const ob = {}
	const result = stringify(serialize(ob.foo))
	const expect = ''
	t.same(result, expect)
	t.end()
})

tap.test('<undefined>', t => {
	const ob = {
		Doelniveau: [
			{
				name: 'test entity'
			}
		]
	}
	const buff = serialize(ob)
	let meta = {}
	const data = parse(buff, meta, false)

	odJSONTag.setAttribute(data.Doelniveau[0], 'foo', 'bar')
	t.same(data.Doelniveau[0][isChanged], true)
	let s = stringify(serialize(data))
	t.same(s, `(19){"Doelniveau":[~1]}
(40)<object foo="bar">{"name":"test entity"}`)

	odJSONTag.setAttribute(data.Doelniveau, 'foo', 'bar')
	t.equal(data, meta.resultArray[data[getIndex]])
	t.equal(data[isProxy], true)
	t.same(data[isChanged], true)
	t.same(data.Doelniveau[isChanged], true)
	s = stringify(serialize(data))
	t.same(s, `(36){"Doelniveau":<array foo="bar">[~1]}
(40)<object foo="bar">{"name":"test entity"}`)
	t.end()
})