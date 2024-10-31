import JSONTag from '@muze-nl/jsontag';
import {source,isProxy, isChanged, getIndex, getBuffer, resultSet} from './symbols.mjs'
import * as odJSONTag from './jsontag.mjs'

// faststringify function for a fast parseable arraybuffer output
// 
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const realJSON = JSON // in case someone redefines JSON as JSONTag later

function stringToSAB(strData) {
    const buffer = encoder.encode(strData)
    const sab = new SharedArrayBuffer(buffer.length)
    let uint8sab = new Uint8Array(sab)
    uint8sab.set(buffer,0)
    return uint8sab
}

export default function serialize(value, options={}) {
	let resultArray = false
	let references = new WeakMap()

	if (options.meta) {
		if (!options.meta.index) {
			options.meta.index = {}
		}
		if (!options.meta.index.id) {
			options.meta.index.id = new Map()
		}
		if (options.meta.resultArray) {
			resultArray = options.meta.resultArray
		}
	}
	if (!resultArray) {
		resultArray = value?.[resultSet]
	}
	if (!resultArray) {
		resultArray = []
	}

	function stringifyValue(value, inarray=false, current) {
		let prop
		let typeString = odJSONTag.getTypeString(value)
		let type = odJSONTag.getType(value)
		switch (type) {
			case 'string':
			case 'decimal':
			case 'money':
			case 'link':
			case 'text':
			case 'blob':
			case 'color':
			case 'email':
			case 'hash':
			case 'duration':
			case 'phone':
			case 'url':
			case 'uuid':
			case 'date':
			case 'time':
			case 'datetime':
				if (odJSONTag.isNull(value)) {
					value = 'null'
				} else {
					value = realJSON.stringify(''+value)
				}
				prop = typeString + value
			break
			case 'int':
			case 'uint':
			case 'int8':
			case 'uint8':
			case 'int16':
			case 'uint16':
			case 'int32':
			case 'uint32':
			case 'int64':
			case 'uint64':
			case 'float':
			case 'float32':
			case 'float64':
			case 'timestamp':
			case 'number':
			case 'boolean':
				if (odJSONTag.isNull(value)) {
					value = 'null'
				} else {
					value = realJSON.stringify(value)
				}
				prop = typeString + value
			break
			case 'array': 
				let entries = value.map(e => stringifyValue(e, true, current))
				let mergedEntries = []
				let previousIndex = null
				let startSlice = null
				entries.forEach(e => {
					if (e[0]=='~') {
						let currIndex = parseInt(e.substr(1))
						if (startSlice && currIndex === (previousIndex + 1)) {
							mergedEntries.pop()
							mergedEntries.push('~' + startSlice + '-' + currIndex)
							previousIndex = currIndex
						} else {
							mergedEntries.push(e)
							previousIndex = currIndex
							startSlice = currIndex
						}
					} else {
						mergedEntries.push(e)
						previousIndex = null
						startSlice = null
					}
				})
				entries = mergedEntries.join(',')
				prop = typeString + '[' + entries + ']'
			break
			case 'object':
				if (!value) {
					prop = 'null'
				} else if (value[isProxy]) {
					if (inarray) {
						prop = '~'+value[getIndex]
					} else {
						prop = decoder.decode(value[getBuffer](current))
					}
				} else {
					if (!references.has(value)) {
						references.set(value, resultArray.length)
						resultArray.push(value)
					}
					prop = '~'+references.get(value)
				}
			break
			default:
				throw new Error(JSONTag.getType(value)+' type not yet implemented')
			break
		}
		return prop
	}

	const encoder = new TextEncoder()
	const decoder = new TextDecoder()

	// is only ever called on object values
	// and should always return a stringified object, not a reference (~n)
	const innerStringify = (current) => {
		let object = resultArray[current]
		let result 

		// if value is a valueProxy, just copy the input slice
		if (object && !odJSONTag.isNull(object) && object[isProxy] && !object[isChanged]) {
			return decoder.decode(object[getBuffer](current))
		}
		if (typeof object === 'undefined' || object === null) {
			return 'null'
		}
		
		let props = []
		for (let key of Object.getOwnPropertyNames(object)) {
			let value = object[key]
			let prop = stringifyValue(value, false, current)
			let enumerable = object.propertyIsEnumerable(key) ? '' : '#'
			props.push(enumerable+realJSON.stringify(key)+':'+prop) //FIXME: how does key get escaped?
		}
		result = odJSONTag.getTypeString(object)+'{'+props.join(',')+'}'
		return result
	}
		
	const encode = (s) => {
		if (typeof s == 'string' || s instanceof String) {
			s = encoder.encode(s)
		}
		if (s[0]==43 || options.skipLength) {
			return new Uint8Array(s)
		}
		let length = encoder.encode('('+s.length+')')
		let u8arr = new Uint8Array(length.length+s.length)
		u8arr.set(length, 0)
		u8arr.set(s, length.length)
		return u8arr
	}

	if (!value?.[resultSet]) {
		resultArray.push(value)
	}
	let currentSource = 0
	let currentResult = 0
	let skipCount = 0
	let result = []
	while(currentSource<resultArray.length) {
		if (!resultArray[currentSource]) {
			//FIXME: should not happen, this means that there is no complete
			//od-jsontag file, only patches?
			skipCount++
		} else if (resultArray[currentSource][isChanged] || !resultArray[currentSource][isProxy]) {
			if (skipCount) {
				result[currentResult] = encoder.encode('+'+skipCount)
				skipCount = 0
				currentResult++
			}
			result[currentResult] = encoder.encode(innerStringify(currentSource))
			if (options.meta) {
				const id=odJSONTag.getAttribute(resultArray[currentSource],'id')
				if (id) {
					options.meta.index.id.set(id, currentSource)
				}
			}
			currentResult++
		} else if (!options.changes) {
			result[currentResult] = resultArray[currentSource][getBuffer](currentSource)
			if (options.meta) {
				const id=odJSONTag.getAttribute(resultArray[currentSource],'id')
				if (id) {
					options.meta.index.id.set(id, currentSource)
				}
			}
			currentResult++
		} else {
			skipCount++
		}

		currentSource++
	}
	let arr = result.map(encode)
	let length = 0
	for (let line of arr) {
		length += line.length+1
	}
	if (length) {
		length -= 1 // skip last newline
	}
	let sab = new SharedArrayBuffer(length)
	let u8arr = new Uint8Array(sab)
	let offset = 0
	for(let line of arr) {
		u8arr.set(line, offset)
		offset+=line.length
		if (offset<length) {
			u8arr.set([10], offset)
			offset++
		}
	}
	return u8arr
}

export function stringify(buf) {
	return decoder.decode(buf)
}