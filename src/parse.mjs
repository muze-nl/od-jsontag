import JSONTag from '@muze-nl/jsontag';
import Null from '@muze-nl/jsontag/src/lib/Null.mjs'
import Records, {fileDescriptor, parseLineIndex} from './records.mjs'
import serialize from './serialize.mjs'
import {source,isProxy,proxyType,getBuffer,getIndex,isChanged,isParsed,position,parent,resultSet, previous, recordStore} from './symbols.mjs'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function stringToSAB(strData)
{
    const buffer = encoder.encode(strData)
    const sab = new SharedArrayBuffer(buffer.length)
    let uint8sab = new Uint8Array(sab)
    uint8sab.set(buffer,0)
    return uint8sab
}

function SABtoString(arr)
{
    let string = '';
    for (let c of arr) {
        string+= String.fromCharCode(c)
    }
    return string
}

class Slice 
{
    constructor(start, end)
    {
        this.start = start;
        this.end = end;
    }
}

const isSlice = function(r) 
{
    return r instanceof Slice
}

class LineReference
{
    constructor(index)
    {
        this.index = index
    }
}

const isLineReference = function(r)
{
    return r instanceof LineReference
}

const lazyItems = Symbol('lazyItems')

const resetObject = function(ob)
{
    delete ob[Symbol['JSONTag:Type']]
    delete ob[Symbol['JSONTag:Attributes']]
    for (let prop of Object.getOwnPropertyNames(ob)) {
        delete ob[prop]
    }
}

export default class Parser extends JSONTag.Parser
{    

    handlers

    constructor(baseURL, immutable=true)
    {
        super(baseURL)
        this.cacheSize = 256
        this.resetRecords()
        this.immutable = immutable
        this.handlers = {
            newValueHandler: {
                get: (target, prop) => {
                    switch(prop) {
                        case recordStore:
                            return this.records
                        case resultSet:
                            return this.meta.resultArray
                        case source:
                            return this.allowed(target, prop, 'get') ? target : undefined
                        case isProxy:
                            return true
                        case proxyType:
                            return 'new'
                        case getBuffer:
                            return (i) => {
                                let index = target[getIndex]
                                if (i != index) {
                                    return encoder.encode('~'+index)
                                }
                                return serialize(target, {meta:this.meta, skipLength:true})
                            }
                        case getIndex:
                            return target[getIndex]
                        case isChanged:
                            return true
                        default:
                            if (this.meta.access && !this.meta.access(target, prop, 'get')) {
                                return undefined
                            }
                            if (Array.isArray(target[prop])) {
                                return this.getArrayProxy(target[prop], target)
                            }
                            return target[prop]
                    } 
                },
                set: (target, prop, value) => {
                    if (this.immutable) {
                        throw new Error('dataspace is immutable')
                    }
                    if (this.meta.access && !this.meta.access(target, prop, 'set')) {
                        return undefined
                    }
                    const type = JSONTag.getType(value)
                    if ((type==='object' || type==='link')
                        && typeof prop !== 'symbol'
                    ) {
                        value = this.getNewValueProxy(value)
                    }
                    target[prop] = value
                    return true                    
                },
                ownKeys: target => this.visibleKeys(target),
                getOwnPropertyDescriptor: (target, prop) => {
                    return this.propertyDescriptor(target, prop)
                },
                defineProperty: (target, prop, descriptor) => {
                    return this.defineValue(target, prop, descriptor)
                },
                deleteProperty: (target, prop) => {
                    if (this.immutable) {
                        throw new Error('dataspace is immutable')
                    }
                    if (!this.allowed(target, prop, 'deleteProperty')) {
                        return false
                    }
                    return Reflect.deleteProperty(target, prop)
                },
                has: (target, prop) => {
                    return this.allowed(target, prop, 'has') && prop in target
                },
                setPrototypeOf: () => {
                    throw new Error('changing prototypes is not supported')
                },
                preventExtensions: () => {
                    throw new Error('preventExtensions is not supported')
                }
            },
            arrayHandler: {
                get: (target, prop, receiver) => {
                    if (!this.allowed(target, prop, 'get') &&
                        ![isProxy, proxyType, isChanged].includes(prop)) {
                        return undefined
                    }
                    switch(prop) {
                        case source:
                            return this.allowed(target, prop, 'get') ? target : undefined
                        case isProxy:
                            return true
                        case proxyType:
                            return 'array'
                    }
                    if (this.hasLazyArrayItems(target) && this.isArrayIndex(prop)) {
                        if (!Object.hasOwn(target, prop) && this.getLazyArrayLine(target, Number(prop)) !== undefined) {
                            if (this.meta.access && !this.meta.access(target, prop, 'get')) {
                                return undefined
                            }
                            return this.getLazyArrayValue(target, prop)
                        }
                    }
                    const value = target?.[prop]
                    if (value instanceof Function) {
                        if (['copyWithin','fill','pop','push','reverse','shift','sort','splice','unshift'].indexOf(prop)!==-1) {
                            if (this.immutable) {
                                throw new Error('dataspace is immutable')
                            }
                        }
                        return (...args) => {
                            return value.apply(receiver, args)
                        }
                    } else if (prop===isChanged) {
                        return target[isChanged] || target[parent][isChanged]
                    } else if (prop===source) {
                        return target
                    } else {
                        if (this.meta.access && !this.meta.access(target, prop, 'get')) {
                            return undefined
                        }
                        if (isLineReference(value)) {
                            return this.getLineProxy(value.index)
                        }
                        if (Array.isArray(value)) {
                            return this.getArrayProxy(value, target)
                        }
                        return value
                    }
                },
                set: (target, prop, value) => {
                    if (prop == parent) {
                        target[parent] = value
                        return true
                    }
                    if (this.immutable) {
                        throw new Error('dataspace is immutable')
                    }
                    if (this.meta.access && !this.meta.access(target, prop, 'set')) {
                        return undefined
                    }
                    const type = JSONTag.getType(value)
                    if ((type==='object' || type==='link') //FIXME: check if other types need handling
                        && typeof prop !== 'symbol'
                    ) {
                        value = this.getNewValueProxy(value)
                    }
                    if (target[prop] === value) {
                        return true
                    }
                    if (!target[previous]) {
                        target[previous] = this.snapshot(target)
                    }
                    target[prop] = value
                    target[isChanged] = true
                    target[parent][isChanged] = true
                    return true
                },
                deleteProperty: (target, prop) => {
                    if (this.immutable) {
                        throw new Error('dataspace is immutable')
                    }
                    if (this.meta.access && !this.meta.access(target, prop, 'deleteProperty')) {
                        return undefined
                    }
                    //FIXME: if target[prop] was the last reference to an object
                    //that object should be deleted so that its line will become empty
                    //when stringifying resultArray again
                    if (typeof target[prop] === 'undefined') {
                        return true
                    }
                    if (!target[previous]) {
                        target[previous] = this.snapshot(target)
                    }
                    delete target[prop]
                    target[isChanged] = true
                    target[parent][isChanged] = true
                    return true
                },
                defineProperty: (target, prop, descriptor) => {
                    return this.defineValue(target, prop, descriptor)
                },
                has: (target, prop) => {
                    if (!this.allowed(target, prop, 'has')) {
                        return false
                    }
                    return prop in target ||
                        (this.isArrayIndex(prop) &&
                         this.getLazyArrayLine(target, Number(prop)) !== undefined)
                },
                ownKeys: target => this.visibleKeys(target),
                getOwnPropertyDescriptor: (target, prop) => {
                    return this.propertyDescriptor(target, prop)
                },
                setPrototypeOf: () => {
                    throw new Error('changing prototypes is not supported')
                },
                preventExtensions: () => {
                    throw new Error('preventExtensions is not supported')
                }
            },
            defaultHandler: {
                get: (target, prop, receiver) => {
                    switch(prop) {
                        case recordStore:
                            return this.records
                        case resultSet:
                            return this.meta.resultArray
                        case isProxy:
                            return true
                        case proxyType:
                            return 'parse'
                        case getBuffer:
                            return (i) => {
                                let index = target[getIndex]
                                if (i != index) {
                                    return encoder.encode('~'+index)
                                }
                                if (target[isChanged]) {
                                    return serialize(target, {skipLength: true})
                                }
                                return this.records.read(index)
                            }
                        case getIndex:
                            return target[getIndex]
                        case isChanged:
                            return target[isChanged]
                    }
                    this.firstParse(target, receiver)
                    switch(prop) {
                        case source:
                            if (this.meta.access && !this.meta.access(target, prop, 'get')) {
                                return undefined
                            }
                            return target
                        default:
                            if (this.meta.access && !this.meta.access(target, prop, 'get')) {
                                return undefined
                            }
                            if (isLineReference(target[prop])) {
                                return this.getLineProxy(target[prop].index)
                            }
                            if (Array.isArray(target[prop])) {
                                return this.getArrayProxy(target[prop], target)
                            }
                            return target[prop]
                    }
                },
                set: (target, prop, value, receiver) => {
                    if (this.immutable && prop!==resultSet && prop!==source && prop!==isChanged) {
                        throw new Error('dataspace is immutable')
                    }
                    switch(prop) {
                        case isChanged:
                            break
                        case source:
                            resetObject(target)
                            target[position] = value[position]
                            target[isParsed] = false
                            target[isChanged] = false
                            delete target[previous]
                            return true
                        case resultSet:
                            break
                    }
                    this.firstParse(target, receiver)
                    if (this.meta.access && !this.meta.access(target, prop, 'set')) {
                        return undefined
                    }
                    const type = JSONTag.getType(value)
                    if ((type==='object' || type==='link') //FIXME: check if other types need handling
                        && typeof prop !== 'symbol'
                    ) {
                        value = this.getNewValueProxy(value)
                    }
                    if (target[prop] === value) {
                        return true
                    }
                    if (!target[previous]) {
                        target[previous] = this.snapshot(target)
                    }
                    target[prop] = value
                    target[isChanged] = true
                    return true
                },
                deleteProperty: (target, prop) => {
                    if (this.immutable) {
                        throw new Error('dataspace is immutable')
                    }
                    if (this.meta.access && !this.meta.access(target, prop, 'deleteProperty')) {
                        return undefined
                    }
                    this.firstParse(target)
                    if (typeof target[prop] === 'undefined') {
                        return true
                    }
                    if (!target[previous]) {
                        target[previous] = this.snapshot(target)
                    }
                    delete target[prop]
                    target[isChanged] = true
                    return true
                },
                ownKeys: (target) => {
                    this.firstParse(target)
                    return this.visibleKeys(target)
                },
                getOwnPropertyDescriptor: (target, prop) => {
                    this.firstParse(target)
                    return this.propertyDescriptor(target, prop)
                },
                defineProperty: (target, prop, descriptor) => {
                    this.firstParse(target)
                    return this.defineValue(target, prop, descriptor)
                },
                has: (target, prop) => {
                    this.firstParse(target)
                    return this.allowed(target, prop, 'has') && prop in target
                },
                setPrototypeOf: () => {
                    throw new Error('changing prototypes is not supported')
                },
                preventExtensions: () => {
                    throw new Error('preventExtensions is not supported')
                }
            }
        }
    }

    resetRecords()
    {
        this.cachedProxies = new WeakMap()
        this.records = new Records()
        this.resident = new Map()
        this.targets = new Map()
        this.proxyRefs = []
        this.resultArray = new Proxy(this.proxyRefs, {
            get: (target, prop, receiver) => {
                const value = Reflect.get(target, prop, receiver)
                if (value instanceof WeakRef) {
                    return value.deref() || this.getLineProxy(Number(prop))
                }
                return value
            },
            set: (target, prop, value) => {
                if (this.isArrayIndex(prop) && value?.[isProxy]) {
                    target[prop] = new WeakRef(value)
                }
                else {
                    target[prop] = value
                }
                return true
            }
        })
        this.records.value = index => this.getLineProxy(index)
        this.sessionMeta = this.meta
    }

    allowed(target, prop, method)
    {
        return !this.meta.access || this.meta.access(target, prop, method)
    }

    propertyValue(target, prop)
    {
        let value = target[prop]
        if (Array.isArray(target) && !Object.hasOwn(target, prop) &&
            this.isArrayIndex(prop)) {
            value = this.getLazyArrayValue(target, prop)
        }
        if (isLineReference(value)) {
            return this.getLineProxy(value.index)
        }
        if (Array.isArray(value)) {
            return this.getArrayProxy(value, target)
        }
        return value
    }

    propertyDescriptor(target, prop)
    {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, prop)
        if (!this.allowed(target, prop, 'get')) {
            if (descriptor && !descriptor.configurable) {
                throw new Error('Access denied to property descriptor')
            }
            return undefined
        }
        if (descriptor) {
            if ('value' in descriptor && descriptor.configurable) {
                return {...descriptor, value: this.propertyValue(target, prop)}
            }
            return descriptor
        }
        if (Array.isArray(target) && this.isArrayIndex(prop) &&
            this.getLazyArrayLine(target, Number(prop)) !== undefined) {
            return {
                configurable: true, enumerable: true, writable: !this.immutable,
                value: this.propertyValue(target, prop)
            }
        }
        return undefined
    }

    visibleKeys(target)
    {
        const keys = new Set(Reflect.ownKeys(target))
        if (Array.isArray(target) && this.hasLazyArrayItems(target)) {
            for (let index = 0; index < target.length; index++) {
                keys.add(String(index))
            }
        }
        const ordered = [...keys]
        if (Array.isArray(target)) {
            ordered.sort((left, right) => {
                const a = this.isArrayIndex(left)
                const b = this.isArrayIndex(right)
                if (a && b) {
                    return Number(left) - Number(right)
                }
                if (a !== b) {
                    return a ? -1 : 1
                }
                return 0
            })
        }
        return ordered.filter(key => {
            const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
            return descriptor?.configurable === false ||
                this.allowed(target, key, 'get')
        })
    }

    snapshot(target)
    {
        const copy = JSONTag.clone(target)
        for (const key of Object.keys(copy)) {
            copy[key] = this.propertyValue(target, key)
        }
        return copy
    }

    markChanged(target)
    {
        if (!target[previous]) {
            target[previous] = this.snapshot(target)
        }
        target[isChanged] = true
        const owner = target[parent]
        if (owner) {
            this.markChanged(owner)
        }
    }

    defineValue(target, prop, descriptor)
    {
        if (this.immutable) {
            throw new Error('dataspace is immutable')
        }
        if (!this.allowed(target, prop, 'defineProperty')) {
            return false
        }
        if (descriptor.get || descriptor.set || descriptor.configurable !== true) {
            throw new TypeError('Stored properties must be configurable data properties')
        }
        descriptor = {...descriptor}
        if ('value' in descriptor && typeof prop !== 'symbol') {
            const type = JSONTag.getType(descriptor.value)
            if (type === 'object' || type === 'link') {
                descriptor.value = this.getNewValueProxy(descriptor.value)
            }
        }
        this.markChanged(target)
        return Reflect.defineProperty(target, prop, descriptor)
    }

    next(c)
    {
        if (c && c!==this.ch) {
            let source = SABtoString(this.input)
            this.error("Expected '"+c+"' instead of '"+this.ch+"':"+this.at+':'+source)
        }
        let code = this.input.at(this.at)
        this.ch = typeof code === 'undefined' ? '' : String.fromCharCode(code)
        this.at+=1
        return this.ch
    }

    error(m)
    {
        let context
        try {
            context = decoder.decode(this.input.slice(this.at,this.at+100));
        } catch {
            // The source may be unavailable when reporting an I/O failure.
        }
        throw {
            name: 'SyntaxError',
            message: m,
            at: this.at,
            input: context
        }
    }

    array()
    {
        let item, array = []
        if (this.ch !== '[') {
            this.error("Syntax error")
        }
        this.next('[')
        this.whitespace()
        if (this.ch===']') {
            this.next(']')
            return array
        }
        while(this.ch) {
            item = this.value()
            this.checkUnresolved(item, array, array.length)
            if (isSlice(item)) {
                if (this.meta.lineIndex && this.immutable) {
                    this.addLazyArrayRange(array, item.start, item.end)
                } else {
                    array = array.concat(this.getLineSlice(item.start, item.end))
                }
            } else if (isLineReference(item) && this.meta.lineIndex && this.immutable) {
                this.addLazyArrayReference(array, item.index)
            } else {
                array.push(item)
            }
            this.whitespace()
            if (this.ch===']') {
                this.next(']')
                return array
            }
            this.next(',')
            this.whitespace()
        }
        this.error("Input stopped early")
    }


    object(object={})
    {
        let key, val
        if (this.ch !== '{') {
            this.error("Syntax Error")
        }
        this.next('{')
        this.whitespace()
        resetObject(object)
        if (this.ch==='}') {
            this.next('}')
            return object
        }
        let enumerable = true
        while(this.ch) {
            if (this.ch==='#') {
                enumerable = false
                this.next()
            } else {
                enumerable = true
            }
            key = this.string()
            if (key==='__proto__') {
                this.error("Attempt at prototype pollution")
            }
            this.whitespace()
            this.next(':')
            val = this.value()
            if (!enumerable) {
                Object.defineProperty(object, key, {
                    configurable: true, //important, must be true, otherwise Proxies cannot use it
                    writable: true, // handle immutability in the Proxy traps
                    enumerable: false,
                    value: val
                })
            } else {
                object[key] = val
            }
            this.checkUnresolved()
            this.whitespace()
            if (this.ch==='}') {
                this.next('}')
                return object
            }
            this.next(',')
            this.whitespace()
        }
        this.error("Input stopped early")
    }

    string(tagName)
    {
        if (this.ch !== '"') {
            this.error('Expected a string')
        }
        const bytes = [34]
        this.next('"')
        let escaped = false
        while (this.ch) {
            const character = this.ch
            bytes.push(character.charCodeAt(0))
            this.next()
            if (character === '"' && !escaped) {
                let value
                try {
                    value = JSON.parse(decoder.decode(new Uint8Array(bytes)))
                }
                catch {
                    this.error('Invalid string escape or character')
                }
                this.checkStringType(tagName, value)
                return value
            }
            if (character === '\\' && !escaped) {
                escaped = true
            }
            else {
                escaped = false
            }
        }
        this.error('Syntax error: incomplete string')
    }

    length()
    {
        this.whitespace()
        this.next('(')
        let numString=''
        while(this.ch>='0' && this.ch<='9') {
            numString += this.ch
            this.next()
        }
        if (this.ch!==')') {
            this.error('Syntax error: not a length')
        }
        this.next()
        return parseInt(numString)
    }

    offset()
    {
        this.next('~')
        let numString = ''
        while(this.ch>='0' && this.ch<='9') {
            numString += this.ch
            this.next()
        }
        if (this.ch=='-') {
            this.next('-')
            let endString = ''
            while(this.ch>='0' && this.ch<='9') {
                endString += this.ch
                this.next()
            }
            return new Slice(parseInt(numString),parseInt(endString)+1) // +1 because array.slice(start,end) slices upto but not including end
        }
        return parseInt(numString)
    }

    parseValue(position, ob={})
    {
        this.input = position.input
        this.at = position.start
        this.next()
        let result = this.value(ob)
        if (result instanceof JSONTag.Link) {
            result = this.handleLink(result)
        }
        return result
    }

    handleLink(link)
    {
        let id = ''+link
        let links = this.meta.unresolved.get(id)
        if (links.length) {
            throw Error('nyi')            
        }
    }

    value = function(ob={})
    {
        let tagOb, result, tagName;
        this.whitespace()
        if (this.ch==='~') {
            let vOffset = this.offset()
            if (isSlice(vOffset)) {
                return vOffset
            }
            if (this.meta.lineIndex) {
                return new LineReference(vOffset)
            }
            return this.getLineProxy(vOffset)
        }
        if (this.ch==='<') {
            tagOb = this.tag()
            tagName = tagOb.tagName
            this.whitespace()
        }
        switch(this.ch) {
            case '{':
                if (tagName && tagName!=='object') {
                    this.typeError(tagName, this.ch)
                }
                result = this.object(ob)
            break
            case '[':
                if (tagName && tagName!=='array') {
                    this.typeError(tagName, this.ch)
                }
                result = this.array()
            break
            case '"':
                result = this.string(tagName)
            break
            case '-':
                result = this.number(tagName)
            break
            default:
                if (this.ch>='0' && this.ch<='9') {
                    result = this.number(tagName)
                } else {
                    result = this.boolOrNull(tagName)
                }
            break
        }
        if (tagOb) {
            if (result === null) {
                result = new Null()
            }
            if (typeof result !== 'object') {
                switch(typeof result) {
                    case 'string':
                        result = new String(result)
                        break
                    case 'number':
                        result = new Number(result)
                        break
                    default:
                        this.error('Syntax Error: unexpected type '+(typeof result))
                        break
                }
            }
            if (tagOb.tagName) {
                JSONTag.setType(result, tagOb.tagName)
            }
            if (tagOb.attributes) {
                JSONTag.setAttributes(result, tagOb.attributes)
            }
        }
        return result
    }
    
    jump()
    {
        this.next('+')
        return this.number()
    }

    lengthValue(i)
    {
        this.whitespace()
        if (!this.ch) {
            this.next()
        }
        let l, v
        if (this.ch=='+') {
            i += this.jump()
        } else {
            l = this.length()
            v = this.valueProxy(l,i)
        }
        return [l, v, i]
    }

    valueProxy(length, index)
    {
        const location = {
            input: this.input,
            start: this.at - 1,
            end: this.at - 1 + length
        }
        this.at += length
        this.next()
        this.installRecord(index, location)
        return this.getLineProxy(index)
    }

    indexedValueProxy(index)
    {
        const location = this.records.positions.get(index)
        if (!location) {
            throw new RangeError('Missing indexed position for line ' + index)
        }
        const target = {
            [getIndex]: index,
            [isChanged]: false,
            [isParsed]: false,
            [position]: location
        }
        const proxy = new Proxy(target, this.handlers.defaultHandler)
        this.cachedProxies.set(target, proxy)
        this.targets.set(index, new WeakRef(target))
        this.resultArray[index] = proxy
        return proxy
    }

    getLineProxy(index)
    {
        const cached = this.proxyRefs[index]
        const result = cached instanceof WeakRef ? cached.deref() : cached
        if (result) {
            return result
        }
        if (this.records.has(index)) {
            return this.indexedValueProxy(index)
        }
        if (this.meta.lineIndex) {
            throw new RangeError('Missing indexed position for line ' + index)
        }
        return undefined
    }

    installRecord(index, location)
    {
        this.records.set(index, location)
        this.proxyRefs.length = Math.max(this.proxyRefs.length, index + 1)
        const target = this.targets.get(index)?.deref()
        if (target) {
            resetObject(target)
            target[position] = location
            target[isParsed] = false
            target[isChanged] = false
            delete target[previous]
        }
        this.resident.delete(index)
        // New values use a different handler. Once persisted, replace them
        // with the ordinary source-backed record proxy, as in buffer parsing.
        const cached = this.proxyRefs[index]
        const proxy = cached instanceof WeakRef ? cached.deref() : cached
        if (proxy?.[proxyType] === 'new') {
            delete this.proxyRefs[index]
        }
    }

    cacheInfo()
    {
        return {residentRecords: this.resident.size, records: this.records.length}
    }

    clearCache()
    {
        if (!this.immutable) {
            throw new Error('Cannot evict a mutable edit session')
        }
        for (const target of this.resident.values()) {
            if (target[isChanged] || !target[position]) {
                throw new Error('Cannot evict uncommitted edits')
            }
        }
        for (const target of this.resident.values()) {
            resetObject(target)
            target[isParsed] = false
        }
        this.resident.clear()
        this.input = undefined
    }

    remember(target)
    {
        const index = target[getIndex]
        this.resident.delete(index)
        this.resident.set(index, target)
        if (this.immutable) {
            if (!Number.isInteger(this.cacheSize) || this.cacheSize < 1) {
                throw new RangeError('cacheSize must be a positive integer')
            }
            if (this.resident.size <= this.cacheSize) {
                return
            }
            let clean = [...this.resident.values()].filter(value => {
                return value[position] && !value[isChanged]
            }).length
            for (const [oldIndex, oldTarget] of this.resident) {
                if (clean <= this.cacheSize) {
                    break
                }
                if (oldTarget[isChanged] || !oldTarget[position]) {
                    continue
                }
                resetObject(oldTarget)
                oldTarget[isParsed] = false
                this.resident.delete(oldIndex)
                clean--
            }
        }
    }

    getLineSlice(start, end)
    {
        if (!this.meta.lineIndex) {
            return this.meta.resultArray.slice(start, end)
        }
        if (this.immutable) {
            return this.getLazyRangeArray(start, end)
        }
        let result = []
        for (let line=start; line<end; line++) {
            result.push(new LineReference(line))
        }
        return result
    }

    getLazyRangeArray(start, end)
    {
        let arr = []
        this.addLazyArrayRange(arr, start, end)
        return arr
    }

    addLazyArrayReference(arr, line)
    {
        this.addLazyArrayRange(arr, line, line+1)
    }

    addLazyArrayRange(arr, start, end)
    {
        if (!arr[lazyItems]) {
            arr[lazyItems] = []
        }
        arr[lazyItems].push({
            arrayStart: arr.length,
            arrayEnd: arr.length + end - start,
            lineStart: start
        })
        arr.length += end - start
    }

    isArrayIndex(prop)
    {
        if (typeof prop === 'symbol') {
            return false
        }
        let index = Number(prop)
        return Number.isInteger(index) && index >= 0 && index < 0xffffffff && String(index) === String(prop)
    }

    hasLazyArrayItems(target)
    {
        return !!target[lazyItems]?.length
    }

    getLazyArrayLine(target, index)
    {
        if (index >= target.length) {
            return undefined
        }
        let ranges = target[lazyItems] || []
        for (let range of ranges) {
            if (index >= range.arrayStart && index < range.arrayEnd) {
                return range.lineStart + index - range.arrayStart
            }
        }
        return undefined
    }

    getLazyArrayValue(target, prop)
    {
        let index = Number(prop)
        let line = this.getLazyArrayLine(target, index)
        if (line === undefined) {
            return undefined
        }
        let value
        if (Object.hasOwn(target, prop)) {
            value = target[index]
        } else {
            value = this.getLineProxy(line)
        }
        return value
    }

    makeChildProxies(parent)
    {
        Object.entries(parent).forEach(([key,entry]) => {
            if (Array.isArray(entry)) {
                this.makeChildProxies(entry)
            } else if (entry && !entry[isProxy]) {
                let type = JSONTag.getType(entry)
                if (type==='object' || type==='link') {//FIXME: check for other types
                    parent[key] = this.getNewValueProxy(entry)
                }
            }
        })
    }

    getArrayProxy(arr, par, handler)
    {
        if (!handler) {
            handler = this.handlers.arrayHandler
        }
        if (!this.cachedProxies.has(arr)) {
            this.cachedProxies.set(arr, new Proxy(arr, handler))
        }
        arr[parent] = par
        return this.cachedProxies.get(arr)
    }

    firstParse(target)
    {
        if (!target[isParsed]) {
            const saved = {input: this.input, at: this.at, ch: this.ch}
            try {
                const location = target[position]
                if (location.indexed) {
                    const input = this.records.read(target[getIndex])
                    this.parseValue({input, start: 0, end: input.length}, target)
                    this.whitespace()
                    if (this.ch) {
                        this.error('Unexpected bytes after indexed value')
                    }
                }
                else {
                    this.parseValue(location, target)
                }
                target[isParsed] = true
            }
            finally {
                Object.assign(this, saved)
            }
        }
        this.remember(target)
    }

    getNewValueProxy(value)
    {
        if (value === null) {
            return null
        }
        if (value[isProxy]) {
            return value
        }
        if (this.cachedProxies.has(value)) {
            return this.cachedProxies.get(value)
        }
        if (JSONTag.getType(value)=='link') {
            let index = this.meta.index.id.get(''+value)
            if (typeof index != 'undefined') {
                return this.getLineProxy(index)
            }
        }
        let index = this.records.allocate()
        this.proxyRefs.length = Math.max(this.proxyRefs.length, index + 1)
        value[getIndex] = index
        const result = new Proxy(value, this.handlers.newValueHandler)
        this.cachedProxies.set(value, result)
        this.proxyRefs[index] = result
        this.resident.set(index, value)
        this.makeChildProxies(value)
        return result
    }

    parse(input, lineIndex)
    {
        if (typeof input == 'string' || input instanceof String) {
            input = stringToSAB(input)
        }
        let inputIsReadable = input instanceof Uint8Array || typeof fileDescriptor(input) !== 'undefined'
        if (!(input instanceof Uint8Array) && !(lineIndex && inputIsReadable)) {
            this.error('parse only accepts Uint8Array or String as input')
        }
        if (this.meta !== this.sessionMeta ||
            (this.meta.resultArray && this.meta.resultArray !== this.resultArray)) {
            this.resetRecords()
        }
        this.meta.resultArray = this.resultArray

        this.ch = ' '
        this.at = 0
        this.input = input

        if (lineIndex) {
            const index = parseLineIndex(lineIndex)
            const entries = this.records.indexedPositions(input, index)
            // Preserve this mode when applying subsequent buffer patches.
            this.meta.lineIndex = true
            for (const [number, location] of entries) {
                this.installRecord(number, location)
            }
            const root = this.getLineProxy(0)
            if (!root) {
                throw new RangeError('Missing root record 0')
            }
            this.firstParse(this.targets.get(0).deref())
            this.input = undefined
            return root
        }

        let line = 0
        while(this.ch && this.at<this.input.length) {
            let result = this.lengthValue(line) // needs to return current line nr
            this.whitespace()
            line = result[2]
            if (result[1]) {
                line++
            }
        }
        return this.getLineProxy(0)
    }

    checkUnresolved() {
        // TODO:
        // for now assume there are no <link> objects in od-jsontag
        // JSONTag Parser.checkUnresolved triggers firstParse, 
        // while parsing the current object
        // incorrect: when adding a new object from a JSONTag string
        // it may contain links which cannot yet be resolved... these need to be handled
    }
}
