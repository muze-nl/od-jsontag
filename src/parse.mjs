import JSONTag from '@muze-nl/jsontag';
import Null from '@muze-nl/jsontag/src/lib/Null.mjs'
import serialize from './serialize.mjs'
import {source,isProxy,proxyType,getBuffer,getIndex,isChanged,isParsed,position,parent,resultSet} from './symbols.mjs'

const decoder = new TextDecoder()
const encoder = new TextEncoder()
const arrayProxies = new WeakMap()

function stringToSAB(strData) {
    const buffer = encoder.encode(strData)
    const sab = new SharedArrayBuffer(buffer.length)
    let uint8sab = new Uint8Array(sab)
    uint8sab.set(buffer,0)
    return uint8sab
}

function SABtoString(arr) {
    let string = '';
    for (let c of arr) {
        string+= String.fromCharCode(c)
    }
    return string
}

class Slice {
    constructor(start, end) {
        this.start = start;
        this.end = end;
    }
}

const isSlice = function(r) {
    return r instanceof Slice
}

export default function parse(input, meta, immutable=true)
{
    if (!meta) {
        meta = {}
    }
    if (!meta.unresolved) {
        meta.unresolved = new Map()
    }
    if (!meta.baseURL) {
        meta.baseURL = 'http://localhost/'
    }
    let at, ch, value, result;
    let escapee = {
        '"': '"',
        "\\":"\\",
        '/': '/',
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t"
    }
    let offsetArray = []
    if (!meta.resultArray) {
        meta.resultArray = []
    }

    at = 0
    ch = " "

    let error = function(m)
    {
        let context
        try {
            context = decoder.decode(input.slice(at-100,at+100));
        } catch(err) {}
        throw {
            name: 'SyntaxError',
            message: m,
            at: at,
            input: context
        }
    }

    if (typeof input == 'string' || input instanceof String) {
        input = stringToSAB(input)
    }
    if (!(input instanceof Uint8Array)) {
        error('parse only accepts Uint8Array or String as input')
    }

    let next = function(c)
    {
        if (c && c!==ch) {
            let source = SABtoString(input)
            error("Expected '"+c+"' instead of '"+ch+"': "+at+':'+source)
        }
        ch = String.fromCharCode(input.at(at))
        at+=1
        return ch
    }
    
    let number = function(tagName)
    {
        let numString = ''
        if (ch==='-') {
            numString = '-'
            next('-')
        }
        while(ch>='0' && ch<='9') {
            numString += ch
            next()
        }
        if (ch==='.') {
            numString+='.'
            while(next() && ch >= '0' && ch <= '9') {
                numString += ch
            }
        }
        if (ch === 'e' || ch === 'E') {
            numString += ch
            next()
            if (ch === '-' || ch === '+') {
                numString += ch
                next()
            }
            while (ch >= '0' && ch <= '9') {
                numString += ch
                next()
            }
        }
        let result = new Number(numString).valueOf()
        if (tagName) {
            switch(tagName) {
                case "int":
                    isInt(numString)
                    break
                case "uint":
                    isInt(numString, [0,Infinity])
                    break
                case "int8":
                    isInt(numString, [-128,127])
                    break
                case "uint8":
                    isInt(numString, [0,255])
                    break
                case "int16":
                    isInt(numString, [-32768,32767])
                    break
                case "uint16":
                    isInt(numString, [0,65535])
                    break
                case "int32":
                    isInt(numString, [-2147483648, 2147483647])
                    break
                case "uint32":
                    isInt(numString, [0,4294967295])
                    break
                case "timestamp":
                case "int64":
                    isInt(numString, [-9223372036854775808,9223372036854775807])
                    break
                case "uint64":
                    isInt(numString, [0,18446744073709551615])
                    break
                case "float":
                    isFloat(numString)
                    break
                case "float32":
                    isFloat(numString, [-3.4e+38,3.4e+38])
                    break
                case "float64":
                    isFloat(numString, [-1.7e+308,+1.7e+308])
                    break
                case "number":
                    //FIXME: what to check? should already be covered by JSON parsing rules?
                    break
                default:
                    isTypeError(tagName, numString)
                    break
            }
        }
        return result
    }

    let isTypeError = function(type, value)
    {
        error('Syntax error, expected '+type+', got: '+value)
    }

    const regexes = {
        color: /^(rgb|hsl)a?\((\d+%?(deg|rad|grad|turn)?[,\s]+){2,3}[\s\/]*[\d\.]+%?\)$/i,
        email: /^[A-Za-z0-9_!#$%&'*+\/=?`{|}~^.-]+@[A-Za-z0-9.-]+$/,
        uuid:  /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/,
        decimal: /^\d*\.?\d*$/,
        money: /^[A-Z]+\$\d*\.?\d*$/,
        duration: /^(-?)P(?=\d|T\d)(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)([DW]))?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/,
        phone: /^[+]?(?:\(\d+(?:\.\d+)?\)|\d+(?:\.\d+)?)(?:[ -]?(?:\(\d+(?:\.\d+)?\)|\d+(?:\.\d+)?))*(?:[ ]?(?:x|ext)\.?[ ]?\d{1,5})?$/,
        time: /^(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/,
        date: /^-?[1-9][0-9]{3,}-([0][1-9]|[1][0-2])-([1-2][0-9]|[0][1-9]|[3][0-1])$/,
        datetime: /^(\d{4,})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/,
        range: /^\[-?(\d+\.)?\d+\,-?(\d+\.)?\d+\]$/
    }

    let isFloat = function(float, range)
    {
        let test = new Number(parseFloat(float))
        let str = test.toString()
        if (float!==str) {
            error('Syntax Error: expected float value')
        }
        if (range) {
            if (typeof range[0] === 'number') {
                if (test<range[0]) {
                    error('Syntax Error: float value out of range')
                }
            }
            if (typeof range[1] === 'number') {
                if (test>range[1]) {
                    error('Syntax Error: float value out of range')    
                }
            }
        }
    }
    
    let isInt = function(int, range)
    {
        let test = new Number(parseInt(int))
        let str = test.toString()
        if (int!==str) {
            error('Syntax Error: expected integer value')
        }
        if (range) {
            if (typeof range[0] === 'number') {
                if (test<range[0]) {
                    error('Syntax Error: integer value out of range')
                }
            }
            if (typeof range[1] === 'number') {
                if (test>range[1]) {
                    error('Syntax Error: integer value out of range')    
                }
            }
        }
    }

    let isColor = function(color)
    {
        let result = false
        if (color.charAt(0) === "#") {
            color = color.substring(1)
            result = ([3, 4, 6, 8].indexOf(color.length) > -1) && !isNaN(parseInt(color, 16))
            if (result.toString(16)!==color) {
                isTypeError('color', color)
            }
        } else {
            result = regexes.color.test(color)
        }
        if (!result) {
            isTypeError('color',color)
        }
        return true
    }

    let isEmail = function(email)
    {
        let result = regexes.email.test(email)
        if (!result) {
            isTypeError('email',email)
        }
        return true
    }

    let isUuid = function(uuid)
    {
        let result = regexes.uuid.test(uuid)
        if (!result) {
            isTypeError('uuid',uuid)
        }
        return true
    }

    let isDecimal = function(decimal)
    {
        let result = regexes.decimal.test(decimal)
        if (!result) {
            isTypeError('decimal',decimal)
        }
        return true
    }

    let isMoney = function(money)
    {
        let result = regexes.money.test(money)
        if (!result) {
            isTypeError('money',money)
        }
        return true
    }
    
    let isUrl = function(url)
    {
        try {
            return Boolean(new URL(url, meta.baseURL))
        } catch(e) {
            isTypeError('url',url)
        }
    }
    
    let isDuration = function(duration)
    {
        let result = regexes.duration.test(duration)
        if (!result) {
            isTypeError('duration',duration)
        }
        return true
    }
    
    let isPhone = function(phone)
    {
        let result = regexes.phone.test(phone)
        if (!result) {
            isTypeError('phone',phone)
        }
        return true
    }
    
    let isRange = function(range)
    {
        let result = regexes.range.test(range)
        if (!result) {
            isTypeError('range',range)
        }
        return true
    }
    
    let isTime = function(time)
    {
        let result = regexes.time.test(time)
        if (!result) {
            isTypeError('time',time)
        }
        return true
    }
    
    let isDate = function(date)
    {
        let result = regexes.date.test(date)
        if (!result) {
            isTypeError('date',date)
        }
        return true
    }
    
    let isDatetime = function(datetime)
    {
        let result = regexes.datetime.test(datetime)
        if (!result) {
            isTypeError('datetime',datetime)
        }
        return true
    }

    let checkStringType = function(tagName, value)
    {
        if (!tagName) {
            return
        }
        switch(tagName){
            case "object":
            case "array":
            case "int8":
            case "uint8":
            case "int16":
            case "uint16":
            case "int32":
            case "uint32":
            case "int64":
            case "uint64":
            case "int":
            case "uint":
            case "float32":
            case "float64":
            case "float":
            case "timestamp":
                isTypeError(tagName, value)
                break
            case "uuid":
                return isUuid(value)
            case "decimal":
                return isDecimal(value)
            case "money":
                return isMoney(value)
            case "url":
                return isUrl(value)
            case "link":
            case "string":
            case "text":
            case "blob":
            case "hash":
                //anything goes
                return true
            case "color":
                return isColor(value)
            case "email":
                return isEmail(value)
            case "duration":
                return isDuration(value)
            case "phone":
                return isPhone(value)
            case "range":
                return isRange(value)
            case "time":
                return isTime(value)
            case "date":
                return isDate(value)
            case "datetime":
                return isDatetime(value)
        }
        error('Syntax error: unknown tagName '+tagName)
    }    

    let string = function(tagName)
    {
        let value = [], hex, i, uffff;
        if (ch !== '"') {
            error("Syntax Error")
        }
        next('"')
        while(ch) {
            if (ch==='"') {
                next()
                let bytes = new Uint8Array(value)
                value = decoder.decode(bytes)
                checkStringType(tagName, value)
                return value
            }
            if (ch==='\\') {
                next()
                if (ch==='u') {
                    for (i=0; i<4; i++) {
                        hex = parseInt(next(), 16)
                        if (!isFinite(hex)) {
                            break
                        }
                        uffff = uffff * 16 + hex
                    }
                    let str = String.fromCharCode(uffff) 
                    let bytes = encoder.encode(str)
                    value.push.apply(value, bytes)
                    next()
                } else if (typeof escapee[ch] === 'string') {
                    value.push(escapee[ch].charCodeAt(0))
                    next()
                } else {
                    break
                }
            } else {
                value.push(ch.charCodeAt(0))
                next()
            }
        }
        error("Syntax error: incomplete string")
    }

    let tag = function()
    {
        let key, val, tagOb={
            attributes: {}
        }
        if (ch !== '<') {
            error("Syntax Error")
        }
        next('<')
        key = word()
        if (!key) {
            error('Syntax Error: expected tag name')
        }
        tagOb.tagName = key
        whitespace()
        while(ch) {
            if (ch==='>') {
                next('>')
                return tagOb
            }
            key = word()
            if (!key) {
                error('Syntax Error: expected attribute name')
            }
            whitespace()
            next('=')
            whitespace()
            val = string()
            tagOb.attributes[key] = val
            whitespace()
        }
        error('Syntax Error: unexpected end of input')
    }

    let whitespace = function()
    {
        while (ch) {
            switch(ch) {
                case ' ':
                case "\t":
                case "\r":
                case "\n":
                    next()
                break
                default:
                    return
                break
            }
        }
    }

    let word = function()
    {
        //[a-z][a-z0-9_]*
        let val='';
        if ((ch>='a' && ch<='z') || (ch>='A' && ch<='Z')) {
            val += ch
            next()
        } else {
            error('Syntax Error: expected word')
        }
        while((ch>='a' && ch<='z') || (ch>='A' && ch<='Z') || (ch>='0' && ch<='9') || ch=='_') {
            val += ch
            next()
        }
        return val
    }

    let boolOrNull = function(tagName)
    {
        let w = word()
        if (!w || typeof w !== 'string') {
            error('Syntax error: expected boolean or null, got "'+w+'"')
        }
        switch(w.toLowerCase()) {
            case 'true':
                if (tagName && tagName!=='boolean') {
                    isTypeError(tagName,w)
                }
                return true
            break
            case 'false':
                if (tagName && tagName!=='boolean') {
                    isTypeError(tagName,w)
                }
                return false 
            break
            case 'null':
                return null
            break
            default:
                error('Syntax error: expected boolean or null, got "'+w+'"')
            break
        }
    }

    let checkUnresolved = function(item, object, key)
    {
        if (JSONTag.getType(item)==='link') {
            let link = ''+item
            let links = meta.unresolved.get(link)
            if (typeof links === 'undefined') {
                meta.unresolved.set(link,[])
                links = meta.unresolved.get(link)
            }
            let count = links.push({
                src: new WeakRef(object),
                key: key
            })
        }
    }

    let array = function()
    {
        let item, array = []
        if (ch !== '[') {
            error("Syntax error")
        }
        next('[')
        whitespace()
        if (ch===']') {
            next(']')
            return array
        }
        while(ch) {
            item = value()
            checkUnresolved(item, array, array.length)
            if (isSlice(item)) {
                array = array.concat(meta.resultArray.slice(item.start, item.end))
            } else {
                array.push(item)
            }
            whitespace()
            if (ch===']') {
                next(']')
                return array
            }
            next(',')
            whitespace()
        }
        error("Input stopped early")
    }

    let object = function(object={})
    {
        let key, val
        if (ch !== '{') {
            error("Syntax Error")
        }
        next('{')
        whitespace()
        if (ch==='}') {
            next('}')
            return object
        }
        let enumerable = true
        while(ch) {
            if (ch==='#') {
                enumerable = false
                next()
            } else {
                enumerable = true
            }
            key = string()
            if (key==='__proto__') {
                error("Attempt at prototype pollution")
            }
            whitespace()
            next(':')
            val = value()
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
            checkUnresolved(val, object, key)
            whitespace()
            if (ch==='}') {
                next('}')
                return object
            }
            next(',')
            whitespace()
        }
        error("Input stopped early")
    }

    let length = function()
    {
        whitespace()
        next('(')
        let numString=''
        while(ch>='0' && ch<='9') {
            numString += ch
            next()
        }
        if (ch!==')') {
            error('Syntax error: not a length')
        }
        next()
        return parseInt(numString)
    }

    let offset = function()
    {
        next('~')
        let numString = ''
        while(ch>='0' && ch<='9') {
            numString += ch
            next()
        }
        if (ch=='-') {
            next('-')
            let endString = ''
            while(ch>='0' && ch<='9') {
                endString += ch
                next()
            }
            return new Slice(parseInt(numString),parseInt(endString)+1) // +1 because array.slice(start,end) slices upto but not including end
        }
        return parseInt(numString)
    }

    let parseValue = function(position, ob={}) {
        input = position.input
        at = position.start
        next()
        return value(ob)
    }

    const makeChildProxies = function(parent) {
        Object.entries(parent).forEach(([key,entry]) => {
            if (Array.isArray(entry)) {
                makeChildProxies(entry)
            } else if (JSONTag.getType(entry)==='object') {
                if (entry[isProxy]) {
                    // do nothing
                } else {
                    parent[key] = getNewValueProxy(entry)
                }
            }
        })
    }

    const getArrayProxy = (arr, par, handler) => {
        if (!handler) {
            handler = handlers.arrayHandler
        }
        if (!arrayProxies.has(arr)) {
            arrayProxies.set(arr, new Proxy(arr, handler))
        }
        let aProxy = arrayProxies.get(arr)
        aProxy[parent] = par
        return aProxy
    }

    const handlers = {
        newArrayHandler: {
            get(target, prop) {
                if (target[prop] instanceof Function) {
                    return (...args) => {
                        args = args.map(arg => {
                            if (JSONTag.getType(arg)==='object' && !arg[isProxy]) {
                                arg = getNewValueProxy(arg)
                            }
                            return arg
                        })
                        return target[prop].apply(target, args)
                    }
                } else if (prop===isChanged) {
                    return true
                } else {
                    if (meta.access && !meta.access(target, prop)) {
                        return undefined
                    }
                    if (Array.isArray(target[prop])) {
                        return getArrayProxy(target[prop], target, handlers.newArrayHandler)
                    }
                    return target[prop]
                }
            },
            set(target, prop, value) {
                if (prop === isChanged || prop === parent) {
                    // prevent infinite loops, parent is only needed to mark it isChanged
                    // but this is a new array proxy, parent is already dirty
                    return true
                }
                if (meta.access && !meta.access(target, prop)) {
                    return undefined
                }
                if (JSONTag.getType(value)==='object' && !value[isProxy]) {
                    value = getNewValueProxy(value)
                } 
                target[prop] = value
                return true
            }
        },
        newValueHandler: {
            get(target, prop, receiver) {
                switch(prop) {
                    case resultSet:
                        return meta.resultArray
                    break;
                    case source:
                        return target
                    break
                    case isProxy:
                        return true
                    break
                    case proxyType:
                        return 'new'
                    break
                    case getBuffer:
                        return (i) => {
                            let index = target[getIndex]
                            if (i != index) {
                                return encoder.encode('~'+index)
                            }
                            return serialize(target, {meta, skipLength:true})
                        }
                    break
                    case getIndex:
                        return target[getIndex]
                    break
                    case isChanged:
                        return true
                    break
                    default:
                        if (meta.access && !meta.access(target, prop, 'get')) {
                            return undefined
                        }
                        if (Array.isArray(target[prop])) {
                            return getArrayProxy(target[prop], target, handlers.newArrayHandler)
                        }
                        return target[prop]
                    break
                } 
            },
            set(target, prop, value) {
                if (meta.access && !meta.access(target, prop, 'set')) {
                    return undefined
                }
                if (JSONTag.getType(value)==='object' && !value[isProxy]) {
                    value = getNewValueProxy(value)
                }
                target[prop] = value
                return true                    
            }
        },
        arrayHandler: {
            get(target, prop) {
                if (target[prop] instanceof Function) {
                    if (['copyWithin','fill','pop','push','reverse','shift','sort','splice','unshift'].indexOf(prop)!==-1) {
                        if (immutable) {
                            throw new Error('dataspace is immutable')
                        }
                    }
                    return (...args) => {
                        args = args.map(arg => {
                            if (JSONTag.getType(arg)==='object' && !arg[isProxy]) {
                                arg = getNewValueProxy(arg)
                            }
                            return arg
                        })
                        target[parent][isChanged] = true // incorrect target for isChanged...
                        let result = target[prop].apply(target, args)
                        return result
                    }
                } else if (prop===isChanged) {
                    return target[isChanged] || target[parent][isChanged]
                } else if (prop===source) {
                    return target
                } else {
                    if (meta.access && !meta.access(target, prop, 'get')) {
                        return undefined
                    }
                    if (Array.isArray(target[prop])) {
                        return getArrayProxy(target[prop], target)
                    }
                    return target[prop]
                }
            },
            set(target, prop, value) {
                if (prop == parent) {
                    target[parent] = value
                    return true
                }
                if (immutable) {
                    throw new Error('dataspace is immutable')
                }
                if (meta.access && !meta.access(target, prop, 'set')) {
                    return undefined
                }
                if (JSONTag.getType(value)==='object' && !value[isProxy]) {
                    value = getNewValueProxy(value)
                } 
                target[prop] = value
                target[isChanged] = true
                target[parent][isChanged] = true
                return true
            },
            deleteProperty(target, prop) {
                if (immutable) {
                    throw new Error('dataspace is immutable')
                }
                if (meta.access && !meta.access(target, prop, 'deleteProperty')) {
                    return undefined
                }
                //FIXME: if target[prop] was the last reference to an object
                //that object should be deleted so that its line will become empty
                //when stringifying resultArray again
                delete target[prop]
                target[isChanged] = true
                target[parent][isChanged] = true
                return true
            }
        },
        handler: {
            get(target, prop, receiver) {
                switch(prop) {
                    case resultSet:
                        return meta.resultArray
                    break;
                    case isProxy:
                        return true
                    break
                    case proxyType:
                        return 'parse'
                    break
                    case getBuffer:
                        return (i) => {
                            let index = target[getIndex]
                            if (i != index) {
                                return encoder.encode('~'+index)
                            }
                            if (target[isChanged]) {
                                return serialize(target, {skipLength: true})
                            }
                            return target[position].input.slice(target[position].start,target[position].end)
                        }
                    break
                    case getIndex:
                        return target[getIndex]
                    break
                    case isChanged:
                        return target[isChanged]
                    break
                }
                firstParse(target, receiver)
                switch(prop) {
                    case source:
                        if (meta.access && !meta.access(target, prop, 'get')) {
                            return undefined
                        }
                        return target
                    break
                    default:
                        if (meta.access && !meta.access(target, prop, 'get')) {
                            return undefined
                        }
                        if (Array.isArray(target[prop])) {
                            return getArrayProxy(target[prop], target)
                        }
                        return target[prop]
                    break
                }
            },
            set(target, prop, value, receiver) {
                if (immutable && prop!==resultSet && prop!==source && prop!==isChanged) {
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
                        return true
                        break
                    case resultSet:
                        break
                }
                firstParse(target, receiver)
                if (meta.access && !meta.access(target, prop, 'set')) {
                    return undefined
                }
                if (JSONTag.getType(value)==='object' && !value[isProxy]) {
                    value = getNewValueProxy(value)
                }
                target[prop] = value
                target[isChanged] = true
                return true
            },
            deleteProperty(target, prop) {
                if (immutable) {
                    throw new Error('dataspace is immutable')
                }
                if (meta.access && !meta.access(target, prop, 'deleteProperty')) {
                    return undefined
                }
                firstParse(target)
                delete target[prop]
                target[isChanged] = true
                return true
            },
            ownKeys(target) {
                firstParse(target)
                return Reflect.ownKeys(target)
            },
            getOwnPropertyDescriptor(target, prop) {
                firstParse(target)
                return Reflect.getOwnPropertyDescriptor(target, prop)
            },
            defineProperty(target, prop, descriptor) {
                if (immutable) {
                    throw new Error('dataspace is immutable')
                }
                if (meta.access && !meta.access(target, prop, 'defineProperty')) {
                    return undefined
                }
                firstParse(target)
                return Object.defineProperty(target, prop, descriptor)
            },
            has(target, prop) {
                if (meta.access && !meta.access(target, prop, 'has')) {
                    return false
                }
                firstParse()
                return prop in target
            },
            setPrototypeOf(target,proto) {
                throw new Error('changing prototypes is not supported')
            }
        }
    }

    const firstParse = function(target, receiver) {
        if (!target[isParsed]) {
            parseValue(target[position], target)
            target[isParsed] = true
            if (receiver) {
                let tag = JSONTag.getType(target)
                if (tag) {
                    JSONTag.setType(receiver, tag)
                }
                let attributes = JSONTag.getAttributes(target)
                if (attributes) {
                    JSONTag.setAttributes(receiver, attributes)
                }
            }
        }
    }

    function resetObject(ob) {
        for (let prop of Object.getOwnPropertyNames(ob)) {
            delete ob[prop]
        }
    }

    const getNewValueProxy = function(value) {
        let index = meta.resultArray.length
        meta.resultArray.push('')
        value[getIndex] = index
        makeChildProxies(value)
        let result = new Proxy(value, handlers.newValueHandler)
        meta.resultArray[index] = result
        return result
    }

    let valueProxy = function(length, index)
    {
        let cache = {}
        cache[getIndex] = index
        cache[isChanged] = false
        cache[isParsed] = false
        // current offset + length contains jsontag of this value
        cache[position] = {
            input,
            start: at-1,
            end: at-1+length
        }
        at += length
        next()
        // newValueHandler makes sure that value[getBuffer] runs stringify
        // arrayHandler makes sure that changes in the array set targetIsChanged to true
        return new Proxy(cache, handlers.handler)
    }

    value = function(ob={})
    {
        let tagOb, result, tagName;
        whitespace()
        if (ch==='~') {
            let vOffset = offset()
            if (isSlice(vOffset)) {
                return vOffset
            }
            return meta.resultArray[vOffset]
        }
        if (ch==='<') {
            tagOb = tag()
            tagName = tagOb.tagName
            whitespace()
        }
        switch(ch) {
            case '{':
                if (tagName && tagName!=='object') {
                    isTypeError(tagName, ch)
                }
                result = object(ob)
            break
            case '[':
                if (tagName && tagName!=='array') {
                    isTypeError(tagName, ch)
                }
                result = array()
            break
            case '"':
                result = string(tagName)
            break
            case '-':
                result = number(tagName)
            break
            default:
                if (ch>='0' && ch<='9') {
                    result = number(tagName)
                } else {
                    result = boolOrNull(tagName)
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
                        error('Syntax Error: unexpected type '+(typeof result))
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

    function jump() {
        next('+')
        return number()
    }

    function lengthValue(i) {
        whitespace()
        if (!ch) {
            next()
        }
        let l, v
        if (ch=='+') {
            i += jump()
        } else {
            l = length()
            v = valueProxy(l,i)
        }
        return [l, v, i]
    }

    let line = 0
    while(ch && at<input.length) {
        result = lengthValue(line) // needs to return current line nr
        whitespace()
        offsetArray.push(at)
        line = result[2]
        if (result[1]) {
            if (!meta.resultArray[line] || meta.resultArray[line][proxyType]=='new') {
                meta.resultArray[line] = result[1]
            } else {
                meta.resultArray[line][source] = result[1]
            }
            line++
        }
    }
    return meta.resultArray[0]
}