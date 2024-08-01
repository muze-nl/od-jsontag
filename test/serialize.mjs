import JSONTag from '@muze-nl/jsontag'
import serialize, {stringify} from '../src/serialize.mjs'
import {isChanged, getBuffer, getIndex} from '../src/symbols.mjs'
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
	strData = stringify(serialize(root))
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