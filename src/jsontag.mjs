import JSONTag from '@muze-nl/jsontag'
import {source, isChanged} from './symbols.mjs'

export function getType(obj) {
    return JSONTag.getType(obj?.[source] ?? obj)
}

export function getAttribute(obj, attr) {
    return JSONTag.getAttribute(obj?.[source] ?? obj, attr)
}

export function getAttributes(obj) {
    return JSONTag.getAttributes(obj?.[source] ?? obj)
}

export function getAttributeString(obj) {
    return JSONTag.getAttributesString(obj?.[source] ?? obj)
}

export function getTypeString(obj) {
    return JSONTag.getTypeString(obj?.[source] ?? obj)
}

export function isNull(obj) {
    return JSONTag.isNull(obj?.[source] ?? obj)
}

export function setAttribute(obj, attr, value) {
    if (obj?.[source]) {
        obj[isChanged] = true
    }
    return JSONTag.setAttribute(obj?.[source] ?? obj, attr, value)
}

export function setAttributes(obj, attr) {
    if (obj?.[source]) {
        obj[isChanged] = true
    }
    return JSONTag.setAttribute(obj?.[source] ?? obj, attr)
}

export function setType(obj, type) {
    if (obj?.[source]) {
        obj[isChanged] = true
    }
    return JSONTag.setType(obj?.[source] ?? obj, type)
}

export function addAttribute(obj, attr, value) {
    if (obj?.[source]) {
        obj[isChanged] = true
    }
    return JSONTag.addAttribute(obj?.[source] ?? obj, attr, value)
}

export function removeAttribute(obj, attr) {
    if (obj?.[source]) {
        obj[isChanged] = true
    }
    return JSONTag.removeAttribute(obj?.[source] ?? obj, attr)
}