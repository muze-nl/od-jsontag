import JSONTag from '@muze-nl/jsontag';
import {isProxy, isChanged, getIndex, getBuffer, resultSet, recordStore} from './symbols.mjs'

// faststringify function for a fast parseable arraybuffer output
// 
const decoder = new TextDecoder()
const realJSON = JSON // in case someone redefines JSON as JSONTag later

export function* serializeChunks(value, options={}) {
    const records = value?.[recordStore]
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

    function stringifyValue(value) {
        let prop
        let typeString = JSONTag.getTypeString(value)
        let type = JSONTag.getType(value)
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
                if (JSONTag.isNull(value)) {
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
                if (JSONTag.isNull(value)) {
                    value = 'null'
                } else {
                    value = realJSON.stringify(value)
                }
                prop = typeString + value
            break
            case 'array': {
                let entries = value.map(e => stringifyValue(e))
                let mergedEntries = []
                let previousIndex = null
                let startSlice = null
                entries.forEach(e => {
                    if (e[0]=='~') {
                        let currIndex = parseInt(e.substr(1))
                        if (startSlice !== null && currIndex === (previousIndex + 1)) {
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
            }
            case 'object':
                if (!value) {
                    prop = 'null'
                } else if (value[isProxy]) {
                    prop = '~' + value[getIndex]
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
        }
        return prop
    }

    const encoder = new TextEncoder()
    const decoder = new TextDecoder()

    // is only ever called on object values
    // and should always return a stringified object, not a reference (~n)
    const innerStringify = (current) => {
        let object = records ? records.value(current) : resultArray[current]
        let result 

        // if value is a valueProxy, just copy the input slice
        if (object && !JSONTag.isNull(object) && object[isProxy] && !object[isChanged]) {
            return decoder.decode(object[getBuffer](current))
        }
        if (typeof object === 'undefined' || object === null) {
            return 'null'
        }
        
        let props = []
        for (let key of Object.getOwnPropertyNames(object)) {
            let value = object[key]
            let prop = stringifyValue(value)
            let enumerable = Object.prototype.propertyIsEnumerable.call(object, key) ? '' : '#'
            props.push(enumerable+realJSON.stringify(key)+':'+prop) //FIXME: how does key get escaped?
        }
        result = JSONTag.getTypeString(object)+'{'+props.join(',')+'}'
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
        if (value && typeof value === 'object') {
            references.set(value, resultArray.length)
        }
        resultArray.push(value)
    }
    let skipCount = 0
    let first = true
    const count = () => Math.max(resultArray.length, records?.length || 0)
    for (let current = 0; current < count(); current++) {
        const object = resultArray[current]
        const persisted = records?.has(current)
        if ((!object && !persisted) ||
            (options.changes && persisted && !object?.[isChanged])) {
            skipCount++
            continue
        }
        if (!first) {
            yield new Uint8Array([10])
        }
        if (skipCount) {
            yield encoder.encode('+' + skipCount)
            yield new Uint8Array([10])
            skipCount = 0
        }
        let bytes
        if (persisted && !object?.[isChanged]) {
            bytes = records.read(current)
        }
        else if (object?.[isProxy] && !object[isChanged]) {
            bytes = object[getBuffer](current)
        }
        else {
            bytes = encoder.encode(innerStringify(current))
        }
        yield encode(bytes)
        if (options.meta) {
            const entry = records ? records.value(current) : object
            const id = JSONTag.getAttribute(entry, 'id')
            if (id) {
                options.meta.index.id.set(id, current)
            }
        }
        first = false
    }
}

export default function serialize(value, options={}) {
    const chunks = [...serializeChunks(value, options)]
    const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
    const bytes = new Uint8Array(new SharedArrayBuffer(length))
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.length
    }
    return bytes
}

export function stringify(buf) {
    return decoder.decode(buf)
}