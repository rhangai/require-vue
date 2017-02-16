(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
"use strict";

// rawAsap provides everything we need except exception management.
var rawAsap = require("./raw");
// RawTasks are recycled to reduce GC churn.
var freeTasks = [];
// We queue errors to ensure they are thrown in right order (FIFO).
// Array-as-queue is good enough here, since we are just dealing with exceptions.
var pendingErrors = [];
var requestErrorThrow = rawAsap.makeRequestCallFromTimer(throwFirstError);

function throwFirstError() {
    if (pendingErrors.length) {
        throw pendingErrors.shift();
    }
}

/**
 * Calls a task as soon as possible after returning, in its own event, with priority
 * over other events like animation, reflow, and repaint. An error thrown from an
 * event will not interrupt, nor even substantially slow down the processing of
 * other events, but will be rather postponed to a lower priority event.
 * @param {{call}} task A callable object, typically a function that takes no
 * arguments.
 */
module.exports = asap;
function asap(task) {
    var rawTask;
    if (freeTasks.length) {
        rawTask = freeTasks.pop();
    } else {
        rawTask = new RawTask();
    }
    rawTask.task = task;
    rawAsap(rawTask);
}

// We wrap tasks with recyclable task objects.  A task object implements
// `call`, just like a function.
function RawTask() {
    this.task = null;
}

// The sole purpose of wrapping the task is to catch the exception and recycle
// the task object after its single use.
RawTask.prototype.call = function () {
    try {
        this.task.call();
    } catch (error) {
        if (asap.onerror) {
            // This hook exists purely for testing purposes.
            // Its name will be periodically randomized to break any code that
            // depends on its existence.
            asap.onerror(error);
        } else {
            // In a web browser, exceptions are not fatal. However, to avoid
            // slowing down the queue of pending tasks, we rethrow the error in a
            // lower priority turn.
            pendingErrors.push(error);
            requestErrorThrow();
        }
    } finally {
        this.task = null;
        freeTasks[freeTasks.length] = this;
    }
};

},{"./raw":2}],2:[function(require,module,exports){
(function (global){
"use strict";

// Use the fastest means possible to execute a task in its own turn, with
// priority over other events including IO, animation, reflow, and redraw
// events in browsers.
//
// An exception thrown by a task will permanently interrupt the processing of
// subsequent tasks. The higher level `asap` function ensures that if an
// exception is thrown by a task, that the task queue will continue flushing as
// soon as possible, but if you use `rawAsap` directly, you are responsible to
// either ensure that no exceptions are thrown from your task, or to manually
// call `rawAsap.requestFlush` if an exception is thrown.
module.exports = rawAsap;
function rawAsap(task) {
    if (!queue.length) {
        requestFlush();
        flushing = true;
    }
    // Equivalent to push, but avoids a function call.
    queue[queue.length] = task;
}

var queue = [];
// Once a flush has been requested, no further calls to `requestFlush` are
// necessary until the next `flush` completes.
var flushing = false;
// `requestFlush` is an implementation-specific method that attempts to kick
// off a `flush` event as quickly as possible. `flush` will attempt to exhaust
// the event queue before yielding to the browser's own event loop.
var requestFlush;
// The position of the next task to execute in the task queue. This is
// preserved between calls to `flush` so that it can be resumed if
// a task throws an exception.
var index = 0;
// If a task schedules additional tasks recursively, the task queue can grow
// unbounded. To prevent memory exhaustion, the task queue will periodically
// truncate already-completed tasks.
var capacity = 1024;

// The flush function processes all tasks that have been scheduled with
// `rawAsap` unless and until one of those tasks throws an exception.
// If a task throws an exception, `flush` ensures that its state will remain
// consistent and will resume where it left off when called again.
// However, `flush` does not make any arrangements to be called again if an
// exception is thrown.
function flush() {
    while (index < queue.length) {
        var currentIndex = index;
        // Advance the index before calling the task. This ensures that we will
        // begin flushing on the next task the task throws an error.
        index = index + 1;
        queue[currentIndex].call();
        // Prevent leaking memory for long chains of recursive calls to `asap`.
        // If we call `asap` within tasks scheduled by `asap`, the queue will
        // grow, but to avoid an O(n) walk for every task we execute, we don't
        // shift tasks off the queue after they have been executed.
        // Instead, we periodically shift 1024 tasks off the queue.
        if (index > capacity) {
            // Manually shift all values starting at the index back to the
            // beginning of the queue.
            for (var scan = 0, newLength = queue.length - index; scan < newLength; scan++) {
                queue[scan] = queue[scan + index];
            }
            queue.length -= index;
            index = 0;
        }
    }
    queue.length = 0;
    index = 0;
    flushing = false;
}

// `requestFlush` is implemented using a strategy based on data collected from
// every available SauceLabs Selenium web driver worker at time of writing.
// https://docs.google.com/spreadsheets/d/1mG-5UYGup5qxGdEMWkhP6BWCz053NUb2E1QoUTU16uA/edit#gid=783724593

// Safari 6 and 6.1 for desktop, iPad, and iPhone are the only browsers that
// have WebKitMutationObserver but not un-prefixed MutationObserver.
// Must use `global` or `self` instead of `window` to work in both frames and web
// workers. `global` is a provision of Browserify, Mr, Mrs, or Mop.

/* globals self */
var scope = typeof global !== "undefined" ? global : self;
var BrowserMutationObserver = scope.MutationObserver || scope.WebKitMutationObserver;

// MutationObservers are desirable because they have high priority and work
// reliably everywhere they are implemented.
// They are implemented in all modern browsers.
//
// - Android 4-4.3
// - Chrome 26-34
// - Firefox 14-29
// - Internet Explorer 11
// - iPad Safari 6-7.1
// - iPhone Safari 7-7.1
// - Safari 6-7
if (typeof BrowserMutationObserver === "function") {
    requestFlush = makeRequestCallFromMutationObserver(flush);

// MessageChannels are desirable because they give direct access to the HTML
// task queue, are implemented in Internet Explorer 10, Safari 5.0-1, and Opera
// 11-12, and in web workers in many engines.
// Although message channels yield to any queued rendering and IO tasks, they
// would be better than imposing the 4ms delay of timers.
// However, they do not work reliably in Internet Explorer or Safari.

// Internet Explorer 10 is the only browser that has setImmediate but does
// not have MutationObservers.
// Although setImmediate yields to the browser's renderer, it would be
// preferrable to falling back to setTimeout since it does not have
// the minimum 4ms penalty.
// Unfortunately there appears to be a bug in Internet Explorer 10 Mobile (and
// Desktop to a lesser extent) that renders both setImmediate and
// MessageChannel useless for the purposes of ASAP.
// https://github.com/kriskowal/q/issues/396

// Timers are implemented universally.
// We fall back to timers in workers in most engines, and in foreground
// contexts in the following browsers.
// However, note that even this simple case requires nuances to operate in a
// broad spectrum of browsers.
//
// - Firefox 3-13
// - Internet Explorer 6-9
// - iPad Safari 4.3
// - Lynx 2.8.7
} else {
    requestFlush = makeRequestCallFromTimer(flush);
}

// `requestFlush` requests that the high priority event queue be flushed as
// soon as possible.
// This is useful to prevent an error thrown in a task from stalling the event
// queue if the exception handled by Node.js’s
// `process.on("uncaughtException")` or by a domain.
rawAsap.requestFlush = requestFlush;

// To request a high priority event, we induce a mutation observer by toggling
// the text of a text node between "1" and "-1".
function makeRequestCallFromMutationObserver(callback) {
    var toggle = 1;
    var observer = new BrowserMutationObserver(callback);
    var node = document.createTextNode("");
    observer.observe(node, {characterData: true});
    return function requestCall() {
        toggle = -toggle;
        node.data = toggle;
    };
}

// The message channel technique was discovered by Malte Ubl and was the
// original foundation for this library.
// http://www.nonblocking.io/2011/06/windownexttick.html

// Safari 6.0.5 (at least) intermittently fails to create message ports on a
// page's first load. Thankfully, this version of Safari supports
// MutationObservers, so we don't need to fall back in that case.

// function makeRequestCallFromMessageChannel(callback) {
//     var channel = new MessageChannel();
//     channel.port1.onmessage = callback;
//     return function requestCall() {
//         channel.port2.postMessage(0);
//     };
// }

// For reasons explained above, we are also unable to use `setImmediate`
// under any circumstances.
// Even if we were, there is another bug in Internet Explorer 10.
// It is not sufficient to assign `setImmediate` to `requestFlush` because
// `setImmediate` must be called *by name* and therefore must be wrapped in a
// closure.
// Never forget.

// function makeRequestCallFromSetImmediate(callback) {
//     return function requestCall() {
//         setImmediate(callback);
//     };
// }

// Safari 6.0 has a problem where timers will get lost while the user is
// scrolling. This problem does not impact ASAP because Safari 6.0 supports
// mutation observers, so that implementation is used instead.
// However, if we ever elect to use timers in Safari, the prevalent work-around
// is to add a scroll event listener that calls for a flush.

// `setTimeout` does not call the passed callback if the delay is less than
// approximately 7 in web workers in Firefox 8 through 18, and sometimes not
// even then.

function makeRequestCallFromTimer(callback) {
    return function requestCall() {
        // We dispatch a timeout with a specified delay of 0 for engines that
        // can reliably accommodate that request. This will usually be snapped
        // to a 4 milisecond delay, but once we're flushing, there's no delay
        // between events.
        var timeoutHandle = setTimeout(handleTimer, 0);
        // However, since this timer gets frequently dropped in Firefox
        // workers, we enlist an interval handle that will try to fire
        // an event 20 times per second until it succeeds.
        var intervalHandle = setInterval(handleTimer, 50);

        function handleTimer() {
            // Whichever timer succeeds will cancel both timers and
            // execute the callback.
            clearTimeout(timeoutHandle);
            clearInterval(intervalHandle);
            callback();
        }
    };
}

// This is for `asap.js` only.
// Its name will be periodically randomized to break any code that depends on
// its existence.
rawAsap.makeRequestCallFromTimer = makeRequestCallFromTimer;

// ASAP was originally a nextTick shim included in Q. This was factored out
// into this ASAP package. It was later adapted to RSVP which made further
// amendments. These decisions, particularly to marginalize MessageChannel and
// to capture the MutationObserver implementation in a closure, were integrated
// back into ASAP proper.
// https://github.com/tildeio/rsvp.js/blob/cddf7232546a9cf858524b75cde6f9edf72620a7/lib/rsvp/asap.js

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],3:[function(require,module,exports){
'use strict'

exports.byteLength = byteLength
exports.toByteArray = toByteArray
exports.fromByteArray = fromByteArray

var lookup = []
var revLookup = []
var Arr = typeof Uint8Array !== 'undefined' ? Uint8Array : Array

var code = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
for (var i = 0, len = code.length; i < len; ++i) {
  lookup[i] = code[i]
  revLookup[code.charCodeAt(i)] = i
}

revLookup['-'.charCodeAt(0)] = 62
revLookup['_'.charCodeAt(0)] = 63

function placeHoldersCount (b64) {
  var len = b64.length
  if (len % 4 > 0) {
    throw new Error('Invalid string. Length must be a multiple of 4')
  }

  // the number of equal signs (place holders)
  // if there are two placeholders, than the two characters before it
  // represent one byte
  // if there is only one, then the three characters before it represent 2 bytes
  // this is just a cheap hack to not do indexOf twice
  return b64[len - 2] === '=' ? 2 : b64[len - 1] === '=' ? 1 : 0
}

function byteLength (b64) {
  // base64 is 4/3 + up to two characters of the original data
  return b64.length * 3 / 4 - placeHoldersCount(b64)
}

function toByteArray (b64) {
  var i, j, l, tmp, placeHolders, arr
  var len = b64.length
  placeHolders = placeHoldersCount(b64)

  arr = new Arr(len * 3 / 4 - placeHolders)

  // if there are placeholders, only get up to the last complete 4 chars
  l = placeHolders > 0 ? len - 4 : len

  var L = 0

  for (i = 0, j = 0; i < l; i += 4, j += 3) {
    tmp = (revLookup[b64.charCodeAt(i)] << 18) | (revLookup[b64.charCodeAt(i + 1)] << 12) | (revLookup[b64.charCodeAt(i + 2)] << 6) | revLookup[b64.charCodeAt(i + 3)]
    arr[L++] = (tmp >> 16) & 0xFF
    arr[L++] = (tmp >> 8) & 0xFF
    arr[L++] = tmp & 0xFF
  }

  if (placeHolders === 2) {
    tmp = (revLookup[b64.charCodeAt(i)] << 2) | (revLookup[b64.charCodeAt(i + 1)] >> 4)
    arr[L++] = tmp & 0xFF
  } else if (placeHolders === 1) {
    tmp = (revLookup[b64.charCodeAt(i)] << 10) | (revLookup[b64.charCodeAt(i + 1)] << 4) | (revLookup[b64.charCodeAt(i + 2)] >> 2)
    arr[L++] = (tmp >> 8) & 0xFF
    arr[L++] = tmp & 0xFF
  }

  return arr
}

function tripletToBase64 (num) {
  return lookup[num >> 18 & 0x3F] + lookup[num >> 12 & 0x3F] + lookup[num >> 6 & 0x3F] + lookup[num & 0x3F]
}

function encodeChunk (uint8, start, end) {
  var tmp
  var output = []
  for (var i = start; i < end; i += 3) {
    tmp = (uint8[i] << 16) + (uint8[i + 1] << 8) + (uint8[i + 2])
    output.push(tripletToBase64(tmp))
  }
  return output.join('')
}

function fromByteArray (uint8) {
  var tmp
  var len = uint8.length
  var extraBytes = len % 3 // if we have 1 byte left, pad 2 bytes
  var output = ''
  var parts = []
  var maxChunkLength = 16383 // must be multiple of 3

  // go through the array every three bytes, we'll deal with trailing stuff later
  for (var i = 0, len2 = len - extraBytes; i < len2; i += maxChunkLength) {
    parts.push(encodeChunk(uint8, i, (i + maxChunkLength) > len2 ? len2 : (i + maxChunkLength)))
  }

  // pad the end with zeros, but make sure to not forget the extra bytes
  if (extraBytes === 1) {
    tmp = uint8[len - 1]
    output += lookup[tmp >> 2]
    output += lookup[(tmp << 4) & 0x3F]
    output += '=='
  } else if (extraBytes === 2) {
    tmp = (uint8[len - 2] << 8) + (uint8[len - 1])
    output += lookup[tmp >> 10]
    output += lookup[(tmp >> 4) & 0x3F]
    output += lookup[(tmp << 2) & 0x3F]
    output += '='
  }

  parts.push(output)

  return parts.join('')
}

},{}],4:[function(require,module,exports){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <feross@feross.org> <http://feross.org>
 * @license  MIT
 */
/* eslint-disable no-proto */

'use strict'

var base64 = require('base64-js')
var ieee754 = require('ieee754')

exports.Buffer = Buffer
exports.SlowBuffer = SlowBuffer
exports.INSPECT_MAX_BYTES = 50

var K_MAX_LENGTH = 0x7fffffff
exports.kMaxLength = K_MAX_LENGTH

/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Print warning and recommend using `buffer` v4.x which has an Object
 *               implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * We report that the browser does not support typed arrays if the are not subclassable
 * using __proto__. Firefox 4-29 lacks support for adding new properties to `Uint8Array`
 * (See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438). IE 10 lacks support
 * for __proto__ and has a buggy typed array implementation.
 */
Buffer.TYPED_ARRAY_SUPPORT = typedArraySupport()

if (!Buffer.TYPED_ARRAY_SUPPORT && typeof console !== 'undefined' &&
    typeof console.error === 'function') {
  console.error(
    'This browser lacks typed array (Uint8Array) support which is required by ' +
    '`buffer` v5.x. Use `buffer` v4.x if you require old browser support.'
  )
}

function typedArraySupport () {
  // Can typed array instances can be augmented?
  try {
    var arr = new Uint8Array(1)
    arr.__proto__ = {__proto__: Uint8Array.prototype, foo: function () { return 42 }}
    return arr.foo() === 42
  } catch (e) {
    return false
  }
}

function createBuffer (length) {
  if (length > K_MAX_LENGTH) {
    throw new RangeError('Invalid typed array length')
  }
  // Return an augmented `Uint8Array` instance
  var buf = new Uint8Array(length)
  buf.__proto__ = Buffer.prototype
  return buf
}

/**
 * The Buffer constructor returns instances of `Uint8Array` that have their
 * prototype changed to `Buffer.prototype`. Furthermore, `Buffer` is a subclass of
 * `Uint8Array`, so the returned instances will have all the node `Buffer` methods
 * and the `Uint8Array` methods. Square bracket notation works as expected -- it
 * returns a single octet.
 *
 * The `Uint8Array` prototype remains unmodified.
 */

function Buffer (arg, encodingOrOffset, length) {
  // Common case.
  if (typeof arg === 'number') {
    if (typeof encodingOrOffset === 'string') {
      throw new Error(
        'If encoding is specified then the first argument must be a string'
      )
    }
    return allocUnsafe(arg)
  }
  return from(arg, encodingOrOffset, length)
}

// Fix subarray() in ES2016. See: https://github.com/feross/buffer/pull/97
if (typeof Symbol !== 'undefined' && Symbol.species &&
    Buffer[Symbol.species] === Buffer) {
  Object.defineProperty(Buffer, Symbol.species, {
    value: null,
    configurable: true,
    enumerable: false,
    writable: false
  })
}

Buffer.poolSize = 8192 // not used by this implementation

function from (value, encodingOrOffset, length) {
  if (typeof value === 'number') {
    throw new TypeError('"value" argument must not be a number')
  }

  if (value instanceof ArrayBuffer) {
    return fromArrayBuffer(value, encodingOrOffset, length)
  }

  if (typeof value === 'string') {
    return fromString(value, encodingOrOffset)
  }

  return fromObject(value)
}

/**
 * Functionally equivalent to Buffer(arg, encoding) but throws a TypeError
 * if value is a number.
 * Buffer.from(str[, encoding])
 * Buffer.from(array)
 * Buffer.from(buffer)
 * Buffer.from(arrayBuffer[, byteOffset[, length]])
 **/
Buffer.from = function (value, encodingOrOffset, length) {
  return from(value, encodingOrOffset, length)
}

// Note: Change prototype *after* Buffer.from is defined to workaround Chrome bug:
// https://github.com/feross/buffer/pull/148
Buffer.prototype.__proto__ = Uint8Array.prototype
Buffer.__proto__ = Uint8Array

function assertSize (size) {
  if (typeof size !== 'number') {
    throw new TypeError('"size" argument must be a number')
  } else if (size < 0) {
    throw new RangeError('"size" argument must not be negative')
  }
}

function alloc (size, fill, encoding) {
  assertSize(size)
  if (size <= 0) {
    return createBuffer(size)
  }
  if (fill !== undefined) {
    // Only pay attention to encoding if it's a string. This
    // prevents accidentally sending in a number that would
    // be interpretted as a start offset.
    return typeof encoding === 'string'
      ? createBuffer(size).fill(fill, encoding)
      : createBuffer(size).fill(fill)
  }
  return createBuffer(size)
}

/**
 * Creates a new filled Buffer instance.
 * alloc(size[, fill[, encoding]])
 **/
Buffer.alloc = function (size, fill, encoding) {
  return alloc(size, fill, encoding)
}

function allocUnsafe (size) {
  assertSize(size)
  return createBuffer(size < 0 ? 0 : checked(size) | 0)
}

/**
 * Equivalent to Buffer(num), by default creates a non-zero-filled Buffer instance.
 * */
Buffer.allocUnsafe = function (size) {
  return allocUnsafe(size)
}
/**
 * Equivalent to SlowBuffer(num), by default creates a non-zero-filled Buffer instance.
 */
Buffer.allocUnsafeSlow = function (size) {
  return allocUnsafe(size)
}

function fromString (string, encoding) {
  if (typeof encoding !== 'string' || encoding === '') {
    encoding = 'utf8'
  }

  if (!Buffer.isEncoding(encoding)) {
    throw new TypeError('"encoding" must be a valid string encoding')
  }

  var length = byteLength(string, encoding) | 0
  var buf = createBuffer(length)

  var actual = buf.write(string, encoding)

  if (actual !== length) {
    // Writing a hex string, for example, that contains invalid characters will
    // cause everything after the first invalid character to be ignored. (e.g.
    // 'abxxcd' will be treated as 'ab')
    buf = buf.slice(0, actual)
  }

  return buf
}

function fromArrayLike (array) {
  var length = array.length < 0 ? 0 : checked(array.length) | 0
  var buf = createBuffer(length)
  for (var i = 0; i < length; i += 1) {
    buf[i] = array[i] & 255
  }
  return buf
}

function fromArrayBuffer (array, byteOffset, length) {
  if (byteOffset < 0 || array.byteLength < byteOffset) {
    throw new RangeError('\'offset\' is out of bounds')
  }

  if (array.byteLength < byteOffset + (length || 0)) {
    throw new RangeError('\'length\' is out of bounds')
  }

  var buf
  if (byteOffset === undefined && length === undefined) {
    buf = new Uint8Array(array)
  } else if (length === undefined) {
    buf = new Uint8Array(array, byteOffset)
  } else {
    buf = new Uint8Array(array, byteOffset, length)
  }

  // Return an augmented `Uint8Array` instance
  buf.__proto__ = Buffer.prototype
  return buf
}

function fromObject (obj) {
  if (Buffer.isBuffer(obj)) {
    var len = checked(obj.length) | 0
    var buf = createBuffer(len)

    if (buf.length === 0) {
      return buf
    }

    obj.copy(buf, 0, 0, len)
    return buf
  }

  if (obj) {
    if (ArrayBuffer.isView(obj) || 'length' in obj) {
      if (typeof obj.length !== 'number' || isnan(obj.length)) {
        return createBuffer(0)
      }
      return fromArrayLike(obj)
    }

    if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
      return fromArrayLike(obj.data)
    }
  }

  throw new TypeError('First argument must be a string, Buffer, ArrayBuffer, Array, or array-like object.')
}

function checked (length) {
  // Note: cannot use `length < K_MAX_LENGTH` here because that fails when
  // length is NaN (which is otherwise coerced to zero.)
  if (length >= K_MAX_LENGTH) {
    throw new RangeError('Attempt to allocate Buffer larger than maximum ' +
                         'size: 0x' + K_MAX_LENGTH.toString(16) + ' bytes')
  }
  return length | 0
}

function SlowBuffer (length) {
  if (+length != length) { // eslint-disable-line eqeqeq
    length = 0
  }
  return Buffer.alloc(+length)
}

Buffer.isBuffer = function isBuffer (b) {
  return b != null && b._isBuffer === true
}

Buffer.compare = function compare (a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    throw new TypeError('Arguments must be Buffers')
  }

  if (a === b) return 0

  var x = a.length
  var y = b.length

  for (var i = 0, len = Math.min(x, y); i < len; ++i) {
    if (a[i] !== b[i]) {
      x = a[i]
      y = b[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

Buffer.isEncoding = function isEncoding (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'latin1':
    case 'binary':
    case 'base64':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.concat = function concat (list, length) {
  if (!Array.isArray(list)) {
    throw new TypeError('"list" argument must be an Array of Buffers')
  }

  if (list.length === 0) {
    return Buffer.alloc(0)
  }

  var i
  if (length === undefined) {
    length = 0
    for (i = 0; i < list.length; ++i) {
      length += list[i].length
    }
  }

  var buffer = Buffer.allocUnsafe(length)
  var pos = 0
  for (i = 0; i < list.length; ++i) {
    var buf = list[i]
    if (!Buffer.isBuffer(buf)) {
      throw new TypeError('"list" argument must be an Array of Buffers')
    }
    buf.copy(buffer, pos)
    pos += buf.length
  }
  return buffer
}

function byteLength (string, encoding) {
  if (Buffer.isBuffer(string)) {
    return string.length
  }
  if (ArrayBuffer.isView(string) || string instanceof ArrayBuffer) {
    return string.byteLength
  }
  if (typeof string !== 'string') {
    string = '' + string
  }

  var len = string.length
  if (len === 0) return 0

  // Use a for loop to avoid recursion
  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'ascii':
      case 'latin1':
      case 'binary':
        return len
      case 'utf8':
      case 'utf-8':
      case undefined:
        return utf8ToBytes(string).length
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return len * 2
      case 'hex':
        return len >>> 1
      case 'base64':
        return base64ToBytes(string).length
      default:
        if (loweredCase) return utf8ToBytes(string).length // assume utf8
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}
Buffer.byteLength = byteLength

function slowToString (encoding, start, end) {
  var loweredCase = false

  // No need to verify that "this.length <= MAX_UINT32" since it's a read-only
  // property of a typed array.

  // This behaves neither like String nor Uint8Array in that we set start/end
  // to their upper/lower bounds if the value passed is out of range.
  // undefined is handled specially as per ECMA-262 6th Edition,
  // Section 13.3.3.7 Runtime Semantics: KeyedBindingInitialization.
  if (start === undefined || start < 0) {
    start = 0
  }
  // Return early if start > this.length. Done here to prevent potential uint32
  // coercion fail below.
  if (start > this.length) {
    return ''
  }

  if (end === undefined || end > this.length) {
    end = this.length
  }

  if (end <= 0) {
    return ''
  }

  // Force coersion to uint32. This will also coerce falsey/NaN values to 0.
  end >>>= 0
  start >>>= 0

  if (end <= start) {
    return ''
  }

  if (!encoding) encoding = 'utf8'

  while (true) {
    switch (encoding) {
      case 'hex':
        return hexSlice(this, start, end)

      case 'utf8':
      case 'utf-8':
        return utf8Slice(this, start, end)

      case 'ascii':
        return asciiSlice(this, start, end)

      case 'latin1':
      case 'binary':
        return latin1Slice(this, start, end)

      case 'base64':
        return base64Slice(this, start, end)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return utf16leSlice(this, start, end)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = (encoding + '').toLowerCase()
        loweredCase = true
    }
  }
}

// This property is used by `Buffer.isBuffer` (and the `is-buffer` npm package)
// to detect a Buffer instance. It's not possible to use `instanceof Buffer`
// reliably in a browserify context because there could be multiple different
// copies of the 'buffer' package in use. This method works even for Buffer
// instances that were created from another copy of the `buffer` package.
// See: https://github.com/feross/buffer/issues/154
Buffer.prototype._isBuffer = true

function swap (b, n, m) {
  var i = b[n]
  b[n] = b[m]
  b[m] = i
}

Buffer.prototype.swap16 = function swap16 () {
  var len = this.length
  if (len % 2 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 16-bits')
  }
  for (var i = 0; i < len; i += 2) {
    swap(this, i, i + 1)
  }
  return this
}

Buffer.prototype.swap32 = function swap32 () {
  var len = this.length
  if (len % 4 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 32-bits')
  }
  for (var i = 0; i < len; i += 4) {
    swap(this, i, i + 3)
    swap(this, i + 1, i + 2)
  }
  return this
}

Buffer.prototype.swap64 = function swap64 () {
  var len = this.length
  if (len % 8 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 64-bits')
  }
  for (var i = 0; i < len; i += 8) {
    swap(this, i, i + 7)
    swap(this, i + 1, i + 6)
    swap(this, i + 2, i + 5)
    swap(this, i + 3, i + 4)
  }
  return this
}

Buffer.prototype.toString = function toString () {
  var length = this.length
  if (length === 0) return ''
  if (arguments.length === 0) return utf8Slice(this, 0, length)
  return slowToString.apply(this, arguments)
}

Buffer.prototype.equals = function equals (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return true
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.inspect = function inspect () {
  var str = ''
  var max = exports.INSPECT_MAX_BYTES
  if (this.length > 0) {
    str = this.toString('hex', 0, max).match(/.{2}/g).join(' ')
    if (this.length > max) str += ' ... '
  }
  return '<Buffer ' + str + '>'
}

Buffer.prototype.compare = function compare (target, start, end, thisStart, thisEnd) {
  if (!Buffer.isBuffer(target)) {
    throw new TypeError('Argument must be a Buffer')
  }

  if (start === undefined) {
    start = 0
  }
  if (end === undefined) {
    end = target ? target.length : 0
  }
  if (thisStart === undefined) {
    thisStart = 0
  }
  if (thisEnd === undefined) {
    thisEnd = this.length
  }

  if (start < 0 || end > target.length || thisStart < 0 || thisEnd > this.length) {
    throw new RangeError('out of range index')
  }

  if (thisStart >= thisEnd && start >= end) {
    return 0
  }
  if (thisStart >= thisEnd) {
    return -1
  }
  if (start >= end) {
    return 1
  }

  start >>>= 0
  end >>>= 0
  thisStart >>>= 0
  thisEnd >>>= 0

  if (this === target) return 0

  var x = thisEnd - thisStart
  var y = end - start
  var len = Math.min(x, y)

  var thisCopy = this.slice(thisStart, thisEnd)
  var targetCopy = target.slice(start, end)

  for (var i = 0; i < len; ++i) {
    if (thisCopy[i] !== targetCopy[i]) {
      x = thisCopy[i]
      y = targetCopy[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

// Finds either the first index of `val` in `buffer` at offset >= `byteOffset`,
// OR the last index of `val` in `buffer` at offset <= `byteOffset`.
//
// Arguments:
// - buffer - a Buffer to search
// - val - a string, Buffer, or number
// - byteOffset - an index into `buffer`; will be clamped to an int32
// - encoding - an optional encoding, relevant is val is a string
// - dir - true for indexOf, false for lastIndexOf
function bidirectionalIndexOf (buffer, val, byteOffset, encoding, dir) {
  // Empty buffer means no match
  if (buffer.length === 0) return -1

  // Normalize byteOffset
  if (typeof byteOffset === 'string') {
    encoding = byteOffset
    byteOffset = 0
  } else if (byteOffset > 0x7fffffff) {
    byteOffset = 0x7fffffff
  } else if (byteOffset < -0x80000000) {
    byteOffset = -0x80000000
  }
  byteOffset = +byteOffset  // Coerce to Number.
  if (isNaN(byteOffset)) {
    // byteOffset: it it's undefined, null, NaN, "foo", etc, search whole buffer
    byteOffset = dir ? 0 : (buffer.length - 1)
  }

  // Normalize byteOffset: negative offsets start from the end of the buffer
  if (byteOffset < 0) byteOffset = buffer.length + byteOffset
  if (byteOffset >= buffer.length) {
    if (dir) return -1
    else byteOffset = buffer.length - 1
  } else if (byteOffset < 0) {
    if (dir) byteOffset = 0
    else return -1
  }

  // Normalize val
  if (typeof val === 'string') {
    val = Buffer.from(val, encoding)
  }

  // Finally, search either indexOf (if dir is true) or lastIndexOf
  if (Buffer.isBuffer(val)) {
    // Special case: looking for empty string/buffer always fails
    if (val.length === 0) {
      return -1
    }
    return arrayIndexOf(buffer, val, byteOffset, encoding, dir)
  } else if (typeof val === 'number') {
    val = val & 0xFF // Search for a byte value [0-255]
    if (typeof Uint8Array.prototype.indexOf === 'function') {
      if (dir) {
        return Uint8Array.prototype.indexOf.call(buffer, val, byteOffset)
      } else {
        return Uint8Array.prototype.lastIndexOf.call(buffer, val, byteOffset)
      }
    }
    return arrayIndexOf(buffer, [ val ], byteOffset, encoding, dir)
  }

  throw new TypeError('val must be string, number or Buffer')
}

function arrayIndexOf (arr, val, byteOffset, encoding, dir) {
  var indexSize = 1
  var arrLength = arr.length
  var valLength = val.length

  if (encoding !== undefined) {
    encoding = String(encoding).toLowerCase()
    if (encoding === 'ucs2' || encoding === 'ucs-2' ||
        encoding === 'utf16le' || encoding === 'utf-16le') {
      if (arr.length < 2 || val.length < 2) {
        return -1
      }
      indexSize = 2
      arrLength /= 2
      valLength /= 2
      byteOffset /= 2
    }
  }

  function read (buf, i) {
    if (indexSize === 1) {
      return buf[i]
    } else {
      return buf.readUInt16BE(i * indexSize)
    }
  }

  var i
  if (dir) {
    var foundIndex = -1
    for (i = byteOffset; i < arrLength; i++) {
      if (read(arr, i) === read(val, foundIndex === -1 ? 0 : i - foundIndex)) {
        if (foundIndex === -1) foundIndex = i
        if (i - foundIndex + 1 === valLength) return foundIndex * indexSize
      } else {
        if (foundIndex !== -1) i -= i - foundIndex
        foundIndex = -1
      }
    }
  } else {
    if (byteOffset + valLength > arrLength) byteOffset = arrLength - valLength
    for (i = byteOffset; i >= 0; i--) {
      var found = true
      for (var j = 0; j < valLength; j++) {
        if (read(arr, i + j) !== read(val, j)) {
          found = false
          break
        }
      }
      if (found) return i
    }
  }

  return -1
}

Buffer.prototype.includes = function includes (val, byteOffset, encoding) {
  return this.indexOf(val, byteOffset, encoding) !== -1
}

Buffer.prototype.indexOf = function indexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, true)
}

Buffer.prototype.lastIndexOf = function lastIndexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, false)
}

function hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  // must be an even number of digits
  var strLen = string.length
  if (strLen % 2 !== 0) throw new TypeError('Invalid hex string')

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; ++i) {
    var parsed = parseInt(string.substr(i * 2, 2), 16)
    if (isNaN(parsed)) return i
    buf[offset + i] = parsed
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length)
}

function asciiWrite (buf, string, offset, length) {
  return blitBuffer(asciiToBytes(string), buf, offset, length)
}

function latin1Write (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  return blitBuffer(base64ToBytes(string), buf, offset, length)
}

function ucs2Write (buf, string, offset, length) {
  return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length)
}

Buffer.prototype.write = function write (string, offset, length, encoding) {
  // Buffer#write(string)
  if (offset === undefined) {
    encoding = 'utf8'
    length = this.length
    offset = 0
  // Buffer#write(string, encoding)
  } else if (length === undefined && typeof offset === 'string') {
    encoding = offset
    length = this.length
    offset = 0
  // Buffer#write(string, offset[, length][, encoding])
  } else if (isFinite(offset)) {
    offset = offset >>> 0
    if (isFinite(length)) {
      length = length >>> 0
      if (encoding === undefined) encoding = 'utf8'
    } else {
      encoding = length
      length = undefined
    }
  } else {
    throw new Error(
      'Buffer.write(string, encoding, offset[, length]) is no longer supported'
    )
  }

  var remaining = this.length - offset
  if (length === undefined || length > remaining) length = remaining

  if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
    throw new RangeError('Attempt to write outside buffer bounds')
  }

  if (!encoding) encoding = 'utf8'

  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'hex':
        return hexWrite(this, string, offset, length)

      case 'utf8':
      case 'utf-8':
        return utf8Write(this, string, offset, length)

      case 'ascii':
        return asciiWrite(this, string, offset, length)

      case 'latin1':
      case 'binary':
        return latin1Write(this, string, offset, length)

      case 'base64':
        // Warning: maxLength not taken into account in base64Write
        return base64Write(this, string, offset, length)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return ucs2Write(this, string, offset, length)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.toJSON = function toJSON () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

function base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function utf8Slice (buf, start, end) {
  end = Math.min(buf.length, end)
  var res = []

  var i = start
  while (i < end) {
    var firstByte = buf[i]
    var codePoint = null
    var bytesPerSequence = (firstByte > 0xEF) ? 4
      : (firstByte > 0xDF) ? 3
      : (firstByte > 0xBF) ? 2
      : 1

    if (i + bytesPerSequence <= end) {
      var secondByte, thirdByte, fourthByte, tempCodePoint

      switch (bytesPerSequence) {
        case 1:
          if (firstByte < 0x80) {
            codePoint = firstByte
          }
          break
        case 2:
          secondByte = buf[i + 1]
          if ((secondByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0x1F) << 0x6 | (secondByte & 0x3F)
            if (tempCodePoint > 0x7F) {
              codePoint = tempCodePoint
            }
          }
          break
        case 3:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | (thirdByte & 0x3F)
            if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
              codePoint = tempCodePoint
            }
          }
          break
        case 4:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          fourthByte = buf[i + 3]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | (fourthByte & 0x3F)
            if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
              codePoint = tempCodePoint
            }
          }
      }
    }

    if (codePoint === null) {
      // we did not generate a valid codePoint so insert a
      // replacement char (U+FFFD) and advance only 1 byte
      codePoint = 0xFFFD
      bytesPerSequence = 1
    } else if (codePoint > 0xFFFF) {
      // encode to utf16 (surrogate pair dance)
      codePoint -= 0x10000
      res.push(codePoint >>> 10 & 0x3FF | 0xD800)
      codePoint = 0xDC00 | codePoint & 0x3FF
    }

    res.push(codePoint)
    i += bytesPerSequence
  }

  return decodeCodePointsArray(res)
}

// Based on http://stackoverflow.com/a/22747272/680742, the browser with
// the lowest limit is Chrome, with 0x10000 args.
// We go 1 magnitude less, for safety
var MAX_ARGUMENTS_LENGTH = 0x1000

function decodeCodePointsArray (codePoints) {
  var len = codePoints.length
  if (len <= MAX_ARGUMENTS_LENGTH) {
    return String.fromCharCode.apply(String, codePoints) // avoid extra slice()
  }

  // Decode in chunks to avoid "call stack size exceeded".
  var res = ''
  var i = 0
  while (i < len) {
    res += String.fromCharCode.apply(
      String,
      codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH)
    )
  }
  return res
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i] & 0x7F)
  }
  return ret
}

function latin1Slice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; ++i) {
    out += toHex(buf[i])
  }
  return out
}

function utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + (bytes[i + 1] * 256))
  }
  return res
}

Buffer.prototype.slice = function slice (start, end) {
  var len = this.length
  start = ~~start
  end = end === undefined ? len : ~~end

  if (start < 0) {
    start += len
    if (start < 0) start = 0
  } else if (start > len) {
    start = len
  }

  if (end < 0) {
    end += len
    if (end < 0) end = 0
  } else if (end > len) {
    end = len
  }

  if (end < start) end = start

  var newBuf = this.subarray(start, end)
  // Return an augmented `Uint8Array` instance
  newBuf.__proto__ = Buffer.prototype
  return newBuf
}

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset (offset, ext, length) {
  if ((offset % 1) !== 0 || offset < 0) throw new RangeError('offset is not uint')
  if (offset + ext > length) throw new RangeError('Trying to access beyond buffer length')
}

Buffer.prototype.readUIntLE = function readUIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }

  return val
}

Buffer.prototype.readUIntBE = function readUIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    checkOffset(offset, byteLength, this.length)
  }

  var val = this[offset + --byteLength]
  var mul = 1
  while (byteLength > 0 && (mul *= 0x100)) {
    val += this[offset + --byteLength] * mul
  }

  return val
}

Buffer.prototype.readUInt8 = function readUInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  return this[offset]
}

Buffer.prototype.readUInt16LE = function readUInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return this[offset] | (this[offset + 1] << 8)
}

Buffer.prototype.readUInt16BE = function readUInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return (this[offset] << 8) | this[offset + 1]
}

Buffer.prototype.readUInt32LE = function readUInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return ((this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16)) +
      (this[offset + 3] * 0x1000000)
}

Buffer.prototype.readUInt32BE = function readUInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] * 0x1000000) +
    ((this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    this[offset + 3])
}

Buffer.prototype.readIntLE = function readIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readIntBE = function readIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var i = byteLength
  var mul = 1
  var val = this[offset + --i]
  while (i > 0 && (mul *= 0x100)) {
    val += this[offset + --i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readInt8 = function readInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  if (!(this[offset] & 0x80)) return (this[offset])
  return ((0xff - this[offset] + 1) * -1)
}

Buffer.prototype.readInt16LE = function readInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset] | (this[offset + 1] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt16BE = function readInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset + 1] | (this[offset] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt32LE = function readInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset]) |
    (this[offset + 1] << 8) |
    (this[offset + 2] << 16) |
    (this[offset + 3] << 24)
}

Buffer.prototype.readInt32BE = function readInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] << 24) |
    (this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    (this[offset + 3])
}

Buffer.prototype.readFloatLE = function readFloatLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, true, 23, 4)
}

Buffer.prototype.readFloatBE = function readFloatBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, false, 23, 4)
}

Buffer.prototype.readDoubleLE = function readDoubleLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, true, 52, 8)
}

Buffer.prototype.readDoubleBE = function readDoubleBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, false, 52, 8)
}

function checkInt (buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('"buffer" argument must be a Buffer instance')
  if (value > max || value < min) throw new RangeError('"value" argument is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
}

Buffer.prototype.writeUIntLE = function writeUIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var mul = 1
  var i = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUIntBE = function writeUIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var i = byteLength - 1
  var mul = 1
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUInt8 = function writeUInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0xff, 0)
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeUInt16LE = function writeUInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeUInt16BE = function writeUInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeUInt32LE = function writeUInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset + 3] = (value >>> 24)
  this[offset + 2] = (value >>> 16)
  this[offset + 1] = (value >>> 8)
  this[offset] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeUInt32BE = function writeUInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeIntLE = function writeIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = 0
  var mul = 1
  var sub = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i - 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeIntBE = function writeIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = byteLength - 1
  var mul = 1
  var sub = 0
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i + 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeInt8 = function writeInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0x7f, -0x80)
  if (value < 0) value = 0xff + value + 1
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeInt16LE = function writeInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeInt16BE = function writeInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeInt32LE = function writeInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  this[offset + 2] = (value >>> 16)
  this[offset + 3] = (value >>> 24)
  return offset + 4
}

Buffer.prototype.writeInt32BE = function writeInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (value < 0) value = 0xffffffff + value + 1
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

function checkIEEE754 (buf, value, offset, ext, max, min) {
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
  if (offset < 0) throw new RangeError('Index out of range')
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
  }
  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function writeFloatLE (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function writeFloatBE (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
  }
  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function writeDoubleLE (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function writeDoubleBE (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function copy (target, targetStart, start, end) {
  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (targetStart >= target.length) targetStart = target.length
  if (!targetStart) targetStart = 0
  if (end > 0 && end < start) end = start

  // Copy 0 bytes; we're done
  if (end === start) return 0
  if (target.length === 0 || this.length === 0) return 0

  // Fatal error conditions
  if (targetStart < 0) {
    throw new RangeError('targetStart out of bounds')
  }
  if (start < 0 || start >= this.length) throw new RangeError('sourceStart out of bounds')
  if (end < 0) throw new RangeError('sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length) end = this.length
  if (target.length - targetStart < end - start) {
    end = target.length - targetStart + start
  }

  var len = end - start
  var i

  if (this === target && start < targetStart && targetStart < end) {
    // descending copy from end
    for (i = len - 1; i >= 0; --i) {
      target[i + targetStart] = this[i + start]
    }
  } else if (len < 1000) {
    // ascending copy from start
    for (i = 0; i < len; ++i) {
      target[i + targetStart] = this[i + start]
    }
  } else {
    Uint8Array.prototype.set.call(
      target,
      this.subarray(start, start + len),
      targetStart
    )
  }

  return len
}

// Usage:
//    buffer.fill(number[, offset[, end]])
//    buffer.fill(buffer[, offset[, end]])
//    buffer.fill(string[, offset[, end]][, encoding])
Buffer.prototype.fill = function fill (val, start, end, encoding) {
  // Handle string cases:
  if (typeof val === 'string') {
    if (typeof start === 'string') {
      encoding = start
      start = 0
      end = this.length
    } else if (typeof end === 'string') {
      encoding = end
      end = this.length
    }
    if (val.length === 1) {
      var code = val.charCodeAt(0)
      if (code < 256) {
        val = code
      }
    }
    if (encoding !== undefined && typeof encoding !== 'string') {
      throw new TypeError('encoding must be a string')
    }
    if (typeof encoding === 'string' && !Buffer.isEncoding(encoding)) {
      throw new TypeError('Unknown encoding: ' + encoding)
    }
  } else if (typeof val === 'number') {
    val = val & 255
  }

  // Invalid ranges are not set to a default, so can range check early.
  if (start < 0 || this.length < start || this.length < end) {
    throw new RangeError('Out of range index')
  }

  if (end <= start) {
    return this
  }

  start = start >>> 0
  end = end === undefined ? this.length : end >>> 0

  if (!val) val = 0

  var i
  if (typeof val === 'number') {
    for (i = start; i < end; ++i) {
      this[i] = val
    }
  } else {
    var bytes = Buffer.isBuffer(val)
      ? val
      : new Buffer(val, encoding)
    var len = bytes.length
    for (i = 0; i < end - start; ++i) {
      this[i + start] = bytes[i % len]
    }
  }

  return this
}

// HELPER FUNCTIONS
// ================

var INVALID_BASE64_RE = /[^+/0-9A-Za-z-_]/g

function base64clean (str) {
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = stringtrim(str).replace(INVALID_BASE64_RE, '')
  // Node converts strings with length < 2 to ''
  if (str.length < 2) return ''
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + '='
  }
  return str
}

function stringtrim (str) {
  if (str.trim) return str.trim()
  return str.replace(/^\s+|\s+$/g, '')
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (string, units) {
  units = units || Infinity
  var codePoint
  var length = string.length
  var leadSurrogate = null
  var bytes = []

  for (var i = 0; i < length; ++i) {
    codePoint = string.charCodeAt(i)

    // is surrogate component
    if (codePoint > 0xD7FF && codePoint < 0xE000) {
      // last char was a lead
      if (!leadSurrogate) {
        // no lead yet
        if (codePoint > 0xDBFF) {
          // unexpected trail
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        } else if (i + 1 === length) {
          // unpaired lead
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        }

        // valid lead
        leadSurrogate = codePoint

        continue
      }

      // 2 leads in a row
      if (codePoint < 0xDC00) {
        if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
        leadSurrogate = codePoint
        continue
      }

      // valid surrogate pair
      codePoint = (leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00) + 0x10000
    } else if (leadSurrogate) {
      // valid bmp char, but last char was a lead
      if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
    }

    leadSurrogate = null

    // encode utf8
    if (codePoint < 0x80) {
      if ((units -= 1) < 0) break
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      if ((units -= 2) < 0) break
      bytes.push(
        codePoint >> 0x6 | 0xC0,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x10000) {
      if ((units -= 3) < 0) break
      bytes.push(
        codePoint >> 0xC | 0xE0,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x110000) {
      if ((units -= 4) < 0) break
      bytes.push(
        codePoint >> 0x12 | 0xF0,
        codePoint >> 0xC & 0x3F | 0x80,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else {
      throw new Error('Invalid code point')
    }
  }

  return bytes
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str, units) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    if ((units -= 2) < 0) break

    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(base64clean(str))
}

function blitBuffer (src, dst, offset, length) {
  for (var i = 0; i < length; ++i) {
    if ((i + offset >= dst.length) || (i >= src.length)) break
    dst[i + offset] = src[i]
  }
  return i
}

function isnan (val) {
  return val !== val // eslint-disable-line no-self-compare
}

},{"base64-js":3,"ieee754":5}],5:[function(require,module,exports){
exports.read = function (buffer, offset, isLE, mLen, nBytes) {
  var e, m
  var eLen = nBytes * 8 - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var nBits = -7
  var i = isLE ? (nBytes - 1) : 0
  var d = isLE ? -1 : 1
  var s = buffer[offset + i]

  i += d

  e = s & ((1 << (-nBits)) - 1)
  s >>= (-nBits)
  nBits += eLen
  for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8) {}

  m = e & ((1 << (-nBits)) - 1)
  e >>= (-nBits)
  nBits += mLen
  for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8) {}

  if (e === 0) {
    e = 1 - eBias
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity)
  } else {
    m = m + Math.pow(2, mLen)
    e = e - eBias
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen)
}

exports.write = function (buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c
  var eLen = nBytes * 8 - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0)
  var i = isLE ? 0 : (nBytes - 1)
  var d = isLE ? 1 : -1
  var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0

  value = Math.abs(value)

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0
    e = eMax
  } else {
    e = Math.floor(Math.log(value) / Math.LN2)
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--
      c *= 2
    }
    if (e + eBias >= 1) {
      value += rt / c
    } else {
      value += rt * Math.pow(2, 1 - eBias)
    }
    if (value * c >= 2) {
      e++
      c /= 2
    }

    if (e + eBias >= eMax) {
      m = 0
      e = eMax
    } else if (e + eBias >= 1) {
      m = (value * c - 1) * Math.pow(2, mLen)
      e = e + eBias
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen)
      e = 0
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}

  e = (e << mLen) | m
  eLen += mLen
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}

  buffer[offset + i - d] |= s * 128
}

},{}],6:[function(require,module,exports){
var addDataAttr = require("./utils").addDataAttr,
    browser = require("./browser");

module.exports = function(window, options) {

    // use options from the current script tag data attribues
    addDataAttr(options, browser.currentScript(window));

    if (options.isFileProtocol === undefined) {
        options.isFileProtocol = /^(file|(chrome|safari)(-extension)?|resource|qrc|app):/.test(window.location.protocol);
    }

    // Load styles asynchronously (default: false)
    //
    // This is set to `false` by default, so that the body
    // doesn't start loading before the stylesheets are parsed.
    // Setting this to `true` can result in flickering.
    //
    options.async = options.async || false;
    options.fileAsync = options.fileAsync || false;

    // Interval between watch polls
    options.poll = options.poll || (options.isFileProtocol ? 1000 : 1500);

    options.env = options.env || (window.location.hostname == '127.0.0.1' ||
        window.location.hostname == '0.0.0.0'   ||
        window.location.hostname == 'localhost' ||
        (window.location.port &&
            window.location.port.length > 0)      ||
        options.isFileProtocol                   ? 'development'
        : 'production');

    var dumpLineNumbers = /!dumpLineNumbers:(comments|mediaquery|all)/.exec(window.location.hash);
    if (dumpLineNumbers) {
        options.dumpLineNumbers = dumpLineNumbers[1];
    }

    if (options.useFileCache === undefined) {
        options.useFileCache = true;
    }

    if (options.onReady === undefined) {
        options.onReady = true;
    }

};

},{"./browser":8,"./utils":15}],7:[function(require,module,exports){
/**
 * Kicks off less and compiles any stylesheets
 * used in the browser distributed version of less
 * to kick-start less using the browser api
 */
/*global window, document */

// shim Promise if required
require('promise/polyfill.js');

var options = window.less || {};
require("./add-default-options")(window, options);

var less = module.exports = require("./index")(window, options);

window.less = less;

var css, head, style;

// Always restore page visibility
function resolveOrReject(data) {
    if (data.filename) {
        console.warn(data);
    }
    if (!options.async) {
        head.removeChild(style);
    }
}

if (options.onReady) {
    if (/!watch/.test(window.location.hash)) {
        less.watch();
    }
    // Simulate synchronous stylesheet loading by blocking page rendering
    if (!options.async) {
        css = 'body { display: none !important }';
        head = document.head || document.getElementsByTagName('head')[0];
        style = document.createElement('style');

        style.type = 'text/css';
        if (style.styleSheet) {
            style.styleSheet.cssText = css;
        } else {
            style.appendChild(document.createTextNode(css));
        }

        head.appendChild(style);
    }
    less.registerStylesheetsImmediately();
    less.pageLoadFinished = less.refresh(less.env === 'development').then(resolveOrReject, resolveOrReject);
}

},{"./add-default-options":6,"./index":13,"promise/polyfill.js":106}],8:[function(require,module,exports){
var utils = require("./utils");
module.exports = {
    createCSS: function (document, styles, sheet) {
        // Strip the query-string
        var href = sheet.href || '';

        // If there is no title set, use the filename, minus the extension
        var id = 'less:' + (sheet.title || utils.extractId(href));

        // If this has already been inserted into the DOM, we may need to replace it
        var oldStyleNode = document.getElementById(id);
        var keepOldStyleNode = false;

        // Create a new stylesheet node for insertion or (if necessary) replacement
        var styleNode = document.createElement('style');
        styleNode.setAttribute('type', 'text/css');
        if (sheet.media) {
            styleNode.setAttribute('media', sheet.media);
        }
        styleNode.id = id;

        if (!styleNode.styleSheet) {
            styleNode.appendChild(document.createTextNode(styles));

            // If new contents match contents of oldStyleNode, don't replace oldStyleNode
            keepOldStyleNode = (oldStyleNode !== null && oldStyleNode.childNodes.length > 0 && styleNode.childNodes.length > 0 &&
                oldStyleNode.firstChild.nodeValue === styleNode.firstChild.nodeValue);
        }

        var head = document.getElementsByTagName('head')[0];

        // If there is no oldStyleNode, just append; otherwise, only append if we need
        // to replace oldStyleNode with an updated stylesheet
        if (oldStyleNode === null || keepOldStyleNode === false) {
            var nextEl = sheet && sheet.nextSibling || null;
            if (nextEl) {
                nextEl.parentNode.insertBefore(styleNode, nextEl);
            } else {
                head.appendChild(styleNode);
            }
        }
        if (oldStyleNode && keepOldStyleNode === false) {
            oldStyleNode.parentNode.removeChild(oldStyleNode);
        }

        // For IE.
        // This needs to happen *after* the style element is added to the DOM, otherwise IE 7 and 8 may crash.
        // See http://social.msdn.microsoft.com/Forums/en-US/7e081b65-878a-4c22-8e68-c10d39c2ed32/internet-explorer-crashes-appending-style-element-to-head
        if (styleNode.styleSheet) {
            try {
                styleNode.styleSheet.cssText = styles;
            } catch (e) {
                throw new Error("Couldn't reassign styleSheet.cssText.");
            }
        }
    },
    currentScript: function(window) {
        var document = window.document;
        return document.currentScript || (function() {
            var scripts = document.getElementsByTagName("script");
            return scripts[scripts.length - 1];
        })();
    }
};

},{"./utils":15}],9:[function(require,module,exports){
// Cache system is a bit outdated and could do with work

module.exports = function(window, options, logger) {
    var cache = null;
    if (options.env !== 'development') {
        try {
            cache = (typeof window.localStorage === 'undefined') ? null : window.localStorage;
        } catch (_) {}
    }
    return {
        setCSS: function(path, lastModified, modifyVars, styles) {
            if (cache) {
                logger.info('saving ' + path + ' to cache.');
                try {
                    cache.setItem(path, styles);
                    cache.setItem(path + ':timestamp', lastModified);
                    if (modifyVars) {
                        cache.setItem(path + ':vars', JSON.stringify(modifyVars));
                    }
                } catch(e) {
                    //TODO - could do with adding more robust error handling
                    logger.error('failed to save "' + path + '" to local storage for caching.');
                }
            }
        },
        getCSS: function(path, webInfo, modifyVars) {
            var css       = cache && cache.getItem(path),
                timestamp = cache && cache.getItem(path + ':timestamp'),
                vars      = cache && cache.getItem(path + ':vars');

            modifyVars = modifyVars || {};

            if (timestamp && webInfo.lastModified &&
                (new Date(webInfo.lastModified).valueOf() ===
                    new Date(timestamp).valueOf()) &&
                (!modifyVars && !vars || JSON.stringify(modifyVars) === vars)) {
                // Use local copy
                return css;
            }
        }
    };
};

},{}],10:[function(require,module,exports){
var utils = require("./utils"),
    browser = require("./browser");

module.exports = function(window, less, options) {

    function errorHTML(e, rootHref) {
        var id = 'less-error-message:' + utils.extractId(rootHref || "");
        var template = '<li><label>{line}</label><pre class="{class}">{content}</pre></li>';
        var elem = window.document.createElement('div'), timer, content, errors = [];
        var filename = e.filename || rootHref;
        var filenameNoPath = filename.match(/([^\/]+(\?.*)?)$/)[1];

        elem.id        = id;
        elem.className = "less-error-message";

        content = '<h3>'  + (e.type || "Syntax") + "Error: " + (e.message || 'There is an error in your .less file') +
            '</h3>' + '<p>in <a href="' + filename   + '">' + filenameNoPath + "</a> ";

        var errorline = function (e, i, classname) {
            if (e.extract[i] !== undefined) {
                errors.push(template.replace(/\{line\}/, (parseInt(e.line, 10) || 0) + (i - 1))
                    .replace(/\{class\}/, classname)
                    .replace(/\{content\}/, e.extract[i]));
            }
        };

        if (e.extract) {
            errorline(e, 0, '');
            errorline(e, 1, 'line');
            errorline(e, 2, '');
            content += 'on line ' + e.line + ', column ' + (e.column + 1) + ':</p>' +
                '<ul>' + errors.join('') + '</ul>';
        }
        if (e.stack && (e.extract || options.logLevel >= 4)) {
            content += '<br/>Stack Trace</br />' + e.stack.split('\n').slice(1).join('<br/>');
        }
        elem.innerHTML = content;

        // CSS for error messages
        browser.createCSS(window.document, [
            '.less-error-message ul, .less-error-message li {',
            'list-style-type: none;',
            'margin-right: 15px;',
            'padding: 4px 0;',
            'margin: 0;',
            '}',
            '.less-error-message label {',
            'font-size: 12px;',
            'margin-right: 15px;',
            'padding: 4px 0;',
            'color: #cc7777;',
            '}',
            '.less-error-message pre {',
            'color: #dd6666;',
            'padding: 4px 0;',
            'margin: 0;',
            'display: inline-block;',
            '}',
            '.less-error-message pre.line {',
            'color: #ff0000;',
            '}',
            '.less-error-message h3 {',
            'font-size: 20px;',
            'font-weight: bold;',
            'padding: 15px 0 5px 0;',
            'margin: 0;',
            '}',
            '.less-error-message a {',
            'color: #10a',
            '}',
            '.less-error-message .error {',
            'color: red;',
            'font-weight: bold;',
            'padding-bottom: 2px;',
            'border-bottom: 1px dashed red;',
            '}'
        ].join('\n'), { title: 'error-message' });

        elem.style.cssText = [
            "font-family: Arial, sans-serif",
            "border: 1px solid #e00",
            "background-color: #eee",
            "border-radius: 5px",
            "-webkit-border-radius: 5px",
            "-moz-border-radius: 5px",
            "color: #e00",
            "padding: 15px",
            "margin-bottom: 15px"
        ].join(';');

        if (options.env === 'development') {
            timer = setInterval(function () {
                var document = window.document,
                    body = document.body;
                if (body) {
                    if (document.getElementById(id)) {
                        body.replaceChild(elem, document.getElementById(id));
                    } else {
                        body.insertBefore(elem, body.firstChild);
                    }
                    clearInterval(timer);
                }
            }, 10);
        }
    }

    function removeErrorHTML(path) {
        var node = window.document.getElementById('less-error-message:' + utils.extractId(path));
        if (node) {
            node.parentNode.removeChild(node);
        }
    }

    function removeErrorConsole(path) {
        //no action
    }

    function removeError(path) {
        if (!options.errorReporting || options.errorReporting === "html") {
            removeErrorHTML(path);
        } else if (options.errorReporting === "console") {
            removeErrorConsole(path);
        } else if (typeof options.errorReporting === 'function') {
            options.errorReporting("remove", path);
        }
    }

    function errorConsole(e, rootHref) {
        var template = '{line} {content}';
        var filename = e.filename || rootHref;
        var errors = [];
        var content = (e.type || "Syntax") + "Error: " + (e.message || 'There is an error in your .less file') +
            " in " + filename + " ";

        var errorline = function (e, i, classname) {
            if (e.extract[i] !== undefined) {
                errors.push(template.replace(/\{line\}/, (parseInt(e.line, 10) || 0) + (i - 1))
                    .replace(/\{class\}/, classname)
                    .replace(/\{content\}/, e.extract[i]));
            }
        };

        if (e.extract) {
            errorline(e, 0, '');
            errorline(e, 1, 'line');
            errorline(e, 2, '');
            content += 'on line ' + e.line + ', column ' + (e.column + 1) + ':\n' +
                errors.join('\n');
        }
        if (e.stack && (e.extract || options.logLevel >= 4)) {
            content += '\nStack Trace\n' + e.stack;
        }
        less.logger.error(content);
    }

    function error(e, rootHref) {
        if (!options.errorReporting || options.errorReporting === "html") {
            errorHTML(e, rootHref);
        } else if (options.errorReporting === "console") {
            errorConsole(e, rootHref);
        } else if (typeof options.errorReporting === 'function') {
            options.errorReporting("add", e, rootHref);
        }
    }

    return {
        add: error,
        remove: removeError
    };
};

},{"./browser":8,"./utils":15}],11:[function(require,module,exports){
/*global window, XMLHttpRequest */

module.exports = function(options, logger) {

    var AbstractFileManager = require("../less/environment/abstract-file-manager.js");

    var fileCache = {};

    //TODOS - move log somewhere. pathDiff and doing something similar in node. use pathDiff in the other browser file for the initial load

    function getXMLHttpRequest() {
        if (window.XMLHttpRequest && (window.location.protocol !== "file:" || !("ActiveXObject" in window))) {
            return new XMLHttpRequest();
        } else {
            try {
                /*global ActiveXObject */
                return new ActiveXObject("Microsoft.XMLHTTP");
            } catch (e) {
                logger.error("browser doesn't support AJAX.");
                return null;
            }
        }
    }

    var FileManager = function() {
    };

    FileManager.prototype = new AbstractFileManager();

    FileManager.prototype.alwaysMakePathsAbsolute = function alwaysMakePathsAbsolute() {
        return true;
    };
    FileManager.prototype.join = function join(basePath, laterPath) {
        if (!basePath) {
            return laterPath;
        }
        return this.extractUrlParts(laterPath, basePath).path;
    };
    FileManager.prototype.doXHR = function doXHR(url, type, callback, errback) {

        var xhr = getXMLHttpRequest();
        var async = options.isFileProtocol ? options.fileAsync : true;

        if (typeof xhr.overrideMimeType === 'function') {
            xhr.overrideMimeType('text/css');
        }
        logger.debug("XHR: Getting '" + url + "'");
        xhr.open('GET', url, async);
        xhr.setRequestHeader('Accept', type || 'text/x-less, text/css; q=0.9, */*; q=0.5');
        xhr.send(null);

        function handleResponse(xhr, callback, errback) {
            if (xhr.status >= 200 && xhr.status < 300) {
                callback(xhr.responseText,
                    xhr.getResponseHeader("Last-Modified"));
            } else if (typeof errback === 'function') {
                errback(xhr.status, url);
            }
        }

        if (options.isFileProtocol && !options.fileAsync) {
            if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) {
                callback(xhr.responseText);
            } else {
                errback(xhr.status, url);
            }
        } else if (async) {
            xhr.onreadystatechange = function () {
                if (xhr.readyState == 4) {
                    handleResponse(xhr, callback, errback);
                }
            };
        } else {
            handleResponse(xhr, callback, errback);
        }
    };
    FileManager.prototype.supports = function(filename, currentDirectory, options, environment) {
        return true;
    };

    FileManager.prototype.clearFileCache = function() {
        fileCache = {};
    };

    FileManager.prototype.loadFile = function loadFile(filename, currentDirectory, options, environment, callback) {
        if (currentDirectory && !this.isPathAbsolute(filename)) {
            filename = currentDirectory + filename;
        }

        options = options || {};

        // sheet may be set to the stylesheet for the initial load or a collection of properties including
        // some context variables for imports
        var hrefParts = this.extractUrlParts(filename, window.location.href);
        var href      = hrefParts.url;

        if (options.useFileCache && fileCache[href]) {
            try {
                var lessText = fileCache[href];
                callback(null, { contents: lessText, filename: href, webInfo: { lastModified: new Date() }});
            } catch (e) {
                callback({filename: href, message: "Error loading file " + href + " error was " + e.message});
            }
            return;
        }

        this.doXHR(href, options.mime, function doXHRCallback(data, lastModified) {
            // per file cache
            fileCache[href] = data;

            // Use remote copy (re-parse)
            callback(null, { contents: data, filename: href, webInfo: { lastModified: lastModified }});
        }, function doXHRError(status, url) {
            callback({ type: 'File', message: "'" + url + "' wasn't found (" + status + ")", href: href });
        });
    };

    return FileManager;
};

},{"../less/environment/abstract-file-manager.js":20}],12:[function(require,module,exports){
module.exports = function() {

    var functionRegistry = require("./../less/functions/function-registry");

    function imageSize() {
        throw {
            type: "Runtime",
            message: "Image size functions are not supported in browser version of less"
        };
    }

    var imageFunctions = {
        "image-size": function(filePathNode) {
            imageSize(this, filePathNode);
            return -1;
        },
        "image-width": function(filePathNode) {
            imageSize(this, filePathNode);
            return -1;
        },
        "image-height": function(filePathNode) {
            imageSize(this, filePathNode);
            return -1;
        }
    };

    functionRegistry.addMultiple(imageFunctions);
};

},{"./../less/functions/function-registry":27}],13:[function(require,module,exports){
//
// index.js
// Should expose the additional browser functions on to the less object
//
var addDataAttr = require("./utils").addDataAttr,
    browser = require("./browser");

module.exports = function(window, options) {
    var document = window.document;
    var less = require('../less')();

    //module.exports = less;
    less.options = options;
    var environment = less.environment,
        FileManager = require("./file-manager")(options, less.logger),
        fileManager = new FileManager();
    environment.addFileManager(fileManager);
    less.FileManager = FileManager;

    require("./log-listener")(less, options);
    var errors = require("./error-reporting")(window, less, options);
    var cache = less.cache = options.cache || require("./cache")(window, options, less.logger);
    require('./image-size')(less.environment);

    //Setup user functions
    if (options.functions) {
        less.functions.functionRegistry.addMultiple(options.functions);
    }

    var typePattern = /^text\/(x-)?less$/;

    function postProcessCSS(styles) { // deprecated, use a plugin for postprocesstasks
        if (options.postProcessor && typeof options.postProcessor === 'function') {
            styles = options.postProcessor.call(styles, styles) || styles;
        }
        return styles;
    }

    function clone(obj) {
        var cloned = {};
        for (var prop in obj) {
            if (obj.hasOwnProperty(prop)) {
                cloned[prop] = obj[prop];
            }
        }
        return cloned;
    }

    // only really needed for phantom
    function bind(func, thisArg) {
        var curryArgs = Array.prototype.slice.call(arguments, 2);
        return function() {
            var args = curryArgs.concat(Array.prototype.slice.call(arguments, 0));
            return func.apply(thisArg, args);
        };
    }

    function loadStyles(modifyVars) {
        var styles = document.getElementsByTagName('style'),
            style;

        for (var i = 0; i < styles.length; i++) {
            style = styles[i];
            if (style.type.match(typePattern)) {
                var instanceOptions = clone(options);
                instanceOptions.modifyVars = modifyVars;
                var lessText = style.innerHTML || '';
                instanceOptions.filename = document.location.href.replace(/#.*$/, '');

                /*jshint loopfunc:true */
                // use closure to store current style
                less.render(lessText, instanceOptions,
                        bind(function(style, e, result) {
                            if (e) {
                                errors.add(e, "inline");
                            } else {
                                style.type = 'text/css';
                                if (style.styleSheet) {
                                    style.styleSheet.cssText = result.css;
                                } else {
                                    style.innerHTML = result.css;
                                }
                            }
                        }, null, style));
            }
        }
    }

    function loadStyleSheet(sheet, callback, reload, remaining, modifyVars) {

        var instanceOptions = clone(options);
        addDataAttr(instanceOptions, sheet);
        instanceOptions.mime = sheet.type;

        if (modifyVars) {
            instanceOptions.modifyVars = modifyVars;
        }

        function loadInitialFileCallback(loadedFile) {

            var data = loadedFile.contents,
                path = loadedFile.filename,
                webInfo = loadedFile.webInfo;

            var newFileInfo = {
                currentDirectory: fileManager.getPath(path),
                filename: path,
                rootFilename: path,
                relativeUrls: instanceOptions.relativeUrls};

            newFileInfo.entryPath = newFileInfo.currentDirectory;
            newFileInfo.rootpath = instanceOptions.rootpath || newFileInfo.currentDirectory;

            if (webInfo) {
                webInfo.remaining = remaining;

                var css = cache.getCSS(path, webInfo, instanceOptions.modifyVars);
                if (!reload && css) {
                    webInfo.local = true;
                    callback(null, css, data, sheet, webInfo, path);
                    return;
                }

            }

            //TODO add tests around how this behaves when reloading
            errors.remove(path);

            instanceOptions.rootFileInfo = newFileInfo;
            less.render(data, instanceOptions, function(e, result) {
                if (e) {
                    e.href = path;
                    callback(e);
                } else {
                    result.css = postProcessCSS(result.css);
                    cache.setCSS(sheet.href, webInfo.lastModified, instanceOptions.modifyVars, result.css);
                    callback(null, result.css, data, sheet, webInfo, path);
                }
            });
        }

        fileManager.loadFile(sheet.href, null, instanceOptions, environment, function(e, loadedFile) {
            if (e) {
                callback(e);
                return;
            }
            loadInitialFileCallback(loadedFile);
        });
    }

    function loadStyleSheets(callback, reload, modifyVars) {
        for (var i = 0; i < less.sheets.length; i++) {
            loadStyleSheet(less.sheets[i], callback, reload, less.sheets.length - (i + 1), modifyVars);
        }
    }

    function initRunningMode() {
        if (less.env === 'development') {
            less.watchTimer = setInterval(function () {
                if (less.watchMode) {
                    fileManager.clearFileCache();
                    loadStyleSheets(function (e, css, _, sheet, webInfo) {
                        if (e) {
                            errors.add(e, e.href || sheet.href);
                        } else if (css) {
                            browser.createCSS(window.document, css, sheet);
                        }
                    });
                }
            }, options.poll);
        }
    }

    //
    // Watch mode
    //
    less.watch   = function () {
        if (!less.watchMode ) {
            less.env = 'development';
            initRunningMode();
        }
        this.watchMode = true;
        return true;
    };

    less.unwatch = function () {clearInterval(less.watchTimer); this.watchMode = false; return false; };

    //
    // Synchronously get all <link> tags with the 'rel' attribute set to
    // "stylesheet/less".
    //
    less.registerStylesheetsImmediately = function() {
        var links = document.getElementsByTagName('link');
        less.sheets = [];

        for (var i = 0; i < links.length; i++) {
            if (links[i].rel === 'stylesheet/less' || (links[i].rel.match(/stylesheet/) &&
                (links[i].type.match(typePattern)))) {
                less.sheets.push(links[i]);
            }
        }
    };

    //
    // Asynchronously get all <link> tags with the 'rel' attribute set to
    // "stylesheet/less", returning a Promise.
    //
    less.registerStylesheets = function() {
        return new Promise(function(resolve, reject) {
            less.registerStylesheetsImmediately();
            resolve();
        });
    };

    //
    // With this function, it's possible to alter variables and re-render
    // CSS without reloading less-files
    //
    less.modifyVars = function(record) {
        return less.refresh(true, record, false);
    };

    less.refresh = function (reload, modifyVars, clearFileCache) {
        if ((reload || clearFileCache) && clearFileCache !== false) {
            fileManager.clearFileCache();
        }
        return new Promise(function (resolve, reject) {
            var startTime, endTime, totalMilliseconds, remainingSheets;
            startTime = endTime = new Date();

            // Set counter for remaining unprocessed sheets
            remainingSheets = less.sheets.length;

            if (remainingSheets === 0) {

                endTime = new Date();
                totalMilliseconds = endTime - startTime;
                less.logger.info("Less has finished and no sheets were loaded.");
                resolve({
                    startTime: startTime,
                    endTime: endTime,
                    totalMilliseconds: totalMilliseconds,
                    sheets: less.sheets.length
                });

            } else {
                // Relies on less.sheets array, callback seems to be guaranteed to be called for every element of the array
                loadStyleSheets(function (e, css, _, sheet, webInfo) {
                    if (e) {
                        errors.add(e, e.href || sheet.href);
                        reject(e);
                        return;
                    }
                    if (webInfo.local) {
                        less.logger.info("Loading " + sheet.href + " from cache.");
                    } else {
                        less.logger.info("Rendered " + sheet.href + " successfully.");
                    }
                    browser.createCSS(window.document, css, sheet);
                    less.logger.info("CSS for " + sheet.href + " generated in " + (new Date() - endTime) + 'ms');

                    // Count completed sheet
                    remainingSheets--;

                    // Check if the last remaining sheet was processed and then call the promise
                    if (remainingSheets === 0) {
                        totalMilliseconds = new Date() - startTime;
                        less.logger.info("Less has finished. CSS generated in " + totalMilliseconds + 'ms');
                        resolve({
                            startTime: startTime,
                            endTime: endTime,
                            totalMilliseconds: totalMilliseconds,
                            sheets: less.sheets.length
                        });
                    }
                    endTime = new Date();
                }, reload, modifyVars);
            }

            loadStyles(modifyVars);
        });
    };

    less.refreshStyles = loadStyles;
    return less;
};

},{"../less":36,"./browser":8,"./cache":9,"./error-reporting":10,"./file-manager":11,"./image-size":12,"./log-listener":14,"./utils":15}],14:[function(require,module,exports){
module.exports = function(less, options) {

    var logLevel_debug = 4,
        logLevel_info = 3,
        logLevel_warn = 2,
        logLevel_error = 1;

    // The amount of logging in the javascript console.
    // 3 - Debug, information and errors
    // 2 - Information and errors
    // 1 - Errors
    // 0 - None
    // Defaults to 2
    options.logLevel = typeof options.logLevel !== 'undefined' ? options.logLevel : (options.env === 'development' ?  logLevel_info : logLevel_error);

    if (!options.loggers) {
        options.loggers = [{
            debug: function(msg) {
                if (options.logLevel >= logLevel_debug) {
                    console.log(msg);
                }
            },
            info: function(msg) {
                if (options.logLevel >= logLevel_info) {
                    console.log(msg);
                }
            },
            warn: function(msg) {
                if (options.logLevel >= logLevel_warn) {
                    console.warn(msg);
                }
            },
            error: function(msg) {
                if (options.logLevel >= logLevel_error) {
                    console.error(msg);
                }
            }
        }];
    }
    for (var i = 0; i < options.loggers.length; i++) {
        less.logger.addListener(options.loggers[i]);
    }
};

},{}],15:[function(require,module,exports){
module.exports = {
    extractId: function(href) {
        return href.replace(/^[a-z-]+:\/+?[^\/]+/, '')  // Remove protocol & domain
            .replace(/[\?\&]livereload=\w+/, '')        // Remove LiveReload cachebuster
            .replace(/^\//, '')                         // Remove root /
            .replace(/\.[a-zA-Z]+$/, '')                // Remove simple extension
            .replace(/[^\.\w-]+/g, '-')                 // Replace illegal characters
            .replace(/\./g, ':');                       // Replace dots with colons(for valid id)
    },
    addDataAttr: function(options, tag) {
        for (var opt in tag.dataset) {
            if (tag.dataset.hasOwnProperty(opt)) {
                if (opt === "env" || opt === "dumpLineNumbers" || opt === "rootpath" || opt === "errorReporting") {
                    options[opt] = tag.dataset[opt];
                } else {
                    try {
                        options[opt] = JSON.parse(tag.dataset[opt]);
                    }
                    catch(_) {}
                }
            }
        }
    }
};

},{}],16:[function(require,module,exports){
var contexts = {};
module.exports = contexts;

var copyFromOriginal = function copyFromOriginal(original, destination, propertiesToCopy) {
    if (!original) { return; }

    for (var i = 0; i < propertiesToCopy.length; i++) {
        if (original.hasOwnProperty(propertiesToCopy[i])) {
            destination[propertiesToCopy[i]] = original[propertiesToCopy[i]];
        }
    }
};

/*
 parse is used whilst parsing
 */
var parseCopyProperties = [
    // options
    'paths',            // option - unmodified - paths to search for imports on
    'relativeUrls',     // option - whether to adjust URL's to be relative
    'rootpath',         // option - rootpath to append to URL's
    'strictImports',    // option -
    'insecure',         // option - whether to allow imports from insecure ssl hosts
    'dumpLineNumbers',  // option - whether to dump line numbers
    'compress',         // option - whether to compress
    'syncImport',       // option - whether to import synchronously
    'chunkInput',       // option - whether to chunk input. more performant but causes parse issues.
    'mime',             // browser only - mime type for sheet import
    'useFileCache',     // browser only - whether to use the per file session cache
    // context
    'processImports',   // option & context - whether to process imports. if false then imports will not be imported.
                        // Used by the import manager to stop multiple import visitors being created.
    'pluginManager'     // Used as the plugin manager for the session
];

contexts.Parse = function(options) {
    copyFromOriginal(options, this, parseCopyProperties);

    if (typeof this.paths === "string") { this.paths = [this.paths]; }
};

var evalCopyProperties = [
    'paths',          // additional include paths
    'compress',       // whether to compress
    'ieCompat',       // whether to enforce IE compatibility (IE8 data-uri)
    'strictMath',     // whether math has to be within parenthesis
    'strictUnits',    // whether units need to evaluate correctly
    'sourceMap',      // whether to output a source map
    'importMultiple', // whether we are currently importing multiple copies
    'urlArgs',        // whether to add args into url tokens
    'javascriptEnabled',// option - whether JavaScript is enabled. if undefined, defaults to true
    'pluginManager',  // Used as the plugin manager for the session
    'importantScope'  // used to bubble up !important statements
    ];

contexts.Eval = function(options, frames) {
    copyFromOriginal(options, this, evalCopyProperties);

    if (typeof this.paths === "string") { this.paths = [this.paths]; }

    this.frames = frames || [];
    this.importantScope = this.importantScope || [];
};

contexts.Eval.prototype.inParenthesis = function () {
    if (!this.parensStack) {
        this.parensStack = [];
    }
    this.parensStack.push(true);
};

contexts.Eval.prototype.outOfParenthesis = function () {
    this.parensStack.pop();
};

contexts.Eval.prototype.isMathOn = function () {
    return this.strictMath ? (this.parensStack && this.parensStack.length) : true;
};

contexts.Eval.prototype.isPathRelative = function (path) {
    return !/^(?:[a-z-]+:|\/|#)/i.test(path);
};

contexts.Eval.prototype.normalizePath = function( path ) {
    var
      segments = path.split("/").reverse(),
      segment;

    path = [];
    while (segments.length !== 0 ) {
        segment = segments.pop();
        switch( segment ) {
            case ".":
                break;
            case "..":
                if ((path.length === 0) || (path[path.length - 1] === "..")) {
                    path.push( segment );
                } else {
                    path.pop();
                }
                break;
            default:
                path.push( segment );
                break;
        }
    }

    return path.join("/");
};

//todo - do the same for the toCSS ?

},{}],17:[function(require,module,exports){
module.exports = {
    'aliceblue':'#f0f8ff',
    'antiquewhite':'#faebd7',
    'aqua':'#00ffff',
    'aquamarine':'#7fffd4',
    'azure':'#f0ffff',
    'beige':'#f5f5dc',
    'bisque':'#ffe4c4',
    'black':'#000000',
    'blanchedalmond':'#ffebcd',
    'blue':'#0000ff',
    'blueviolet':'#8a2be2',
    'brown':'#a52a2a',
    'burlywood':'#deb887',
    'cadetblue':'#5f9ea0',
    'chartreuse':'#7fff00',
    'chocolate':'#d2691e',
    'coral':'#ff7f50',
    'cornflowerblue':'#6495ed',
    'cornsilk':'#fff8dc',
    'crimson':'#dc143c',
    'cyan':'#00ffff',
    'darkblue':'#00008b',
    'darkcyan':'#008b8b',
    'darkgoldenrod':'#b8860b',
    'darkgray':'#a9a9a9',
    'darkgrey':'#a9a9a9',
    'darkgreen':'#006400',
    'darkkhaki':'#bdb76b',
    'darkmagenta':'#8b008b',
    'darkolivegreen':'#556b2f',
    'darkorange':'#ff8c00',
    'darkorchid':'#9932cc',
    'darkred':'#8b0000',
    'darksalmon':'#e9967a',
    'darkseagreen':'#8fbc8f',
    'darkslateblue':'#483d8b',
    'darkslategray':'#2f4f4f',
    'darkslategrey':'#2f4f4f',
    'darkturquoise':'#00ced1',
    'darkviolet':'#9400d3',
    'deeppink':'#ff1493',
    'deepskyblue':'#00bfff',
    'dimgray':'#696969',
    'dimgrey':'#696969',
    'dodgerblue':'#1e90ff',
    'firebrick':'#b22222',
    'floralwhite':'#fffaf0',
    'forestgreen':'#228b22',
    'fuchsia':'#ff00ff',
    'gainsboro':'#dcdcdc',
    'ghostwhite':'#f8f8ff',
    'gold':'#ffd700',
    'goldenrod':'#daa520',
    'gray':'#808080',
    'grey':'#808080',
    'green':'#008000',
    'greenyellow':'#adff2f',
    'honeydew':'#f0fff0',
    'hotpink':'#ff69b4',
    'indianred':'#cd5c5c',
    'indigo':'#4b0082',
    'ivory':'#fffff0',
    'khaki':'#f0e68c',
    'lavender':'#e6e6fa',
    'lavenderblush':'#fff0f5',
    'lawngreen':'#7cfc00',
    'lemonchiffon':'#fffacd',
    'lightblue':'#add8e6',
    'lightcoral':'#f08080',
    'lightcyan':'#e0ffff',
    'lightgoldenrodyellow':'#fafad2',
    'lightgray':'#d3d3d3',
    'lightgrey':'#d3d3d3',
    'lightgreen':'#90ee90',
    'lightpink':'#ffb6c1',
    'lightsalmon':'#ffa07a',
    'lightseagreen':'#20b2aa',
    'lightskyblue':'#87cefa',
    'lightslategray':'#778899',
    'lightslategrey':'#778899',
    'lightsteelblue':'#b0c4de',
    'lightyellow':'#ffffe0',
    'lime':'#00ff00',
    'limegreen':'#32cd32',
    'linen':'#faf0e6',
    'magenta':'#ff00ff',
    'maroon':'#800000',
    'mediumaquamarine':'#66cdaa',
    'mediumblue':'#0000cd',
    'mediumorchid':'#ba55d3',
    'mediumpurple':'#9370d8',
    'mediumseagreen':'#3cb371',
    'mediumslateblue':'#7b68ee',
    'mediumspringgreen':'#00fa9a',
    'mediumturquoise':'#48d1cc',
    'mediumvioletred':'#c71585',
    'midnightblue':'#191970',
    'mintcream':'#f5fffa',
    'mistyrose':'#ffe4e1',
    'moccasin':'#ffe4b5',
    'navajowhite':'#ffdead',
    'navy':'#000080',
    'oldlace':'#fdf5e6',
    'olive':'#808000',
    'olivedrab':'#6b8e23',
    'orange':'#ffa500',
    'orangered':'#ff4500',
    'orchid':'#da70d6',
    'palegoldenrod':'#eee8aa',
    'palegreen':'#98fb98',
    'paleturquoise':'#afeeee',
    'palevioletred':'#d87093',
    'papayawhip':'#ffefd5',
    'peachpuff':'#ffdab9',
    'peru':'#cd853f',
    'pink':'#ffc0cb',
    'plum':'#dda0dd',
    'powderblue':'#b0e0e6',
    'purple':'#800080',
    'rebeccapurple':'#663399',
    'red':'#ff0000',
    'rosybrown':'#bc8f8f',
    'royalblue':'#4169e1',
    'saddlebrown':'#8b4513',
    'salmon':'#fa8072',
    'sandybrown':'#f4a460',
    'seagreen':'#2e8b57',
    'seashell':'#fff5ee',
    'sienna':'#a0522d',
    'silver':'#c0c0c0',
    'skyblue':'#87ceeb',
    'slateblue':'#6a5acd',
    'slategray':'#708090',
    'slategrey':'#708090',
    'snow':'#fffafa',
    'springgreen':'#00ff7f',
    'steelblue':'#4682b4',
    'tan':'#d2b48c',
    'teal':'#008080',
    'thistle':'#d8bfd8',
    'tomato':'#ff6347',
    'turquoise':'#40e0d0',
    'violet':'#ee82ee',
    'wheat':'#f5deb3',
    'white':'#ffffff',
    'whitesmoke':'#f5f5f5',
    'yellow':'#ffff00',
    'yellowgreen':'#9acd32'
};
},{}],18:[function(require,module,exports){
module.exports = {
    colors: require("./colors"),
    unitConversions: require("./unit-conversions")
};

},{"./colors":17,"./unit-conversions":19}],19:[function(require,module,exports){
module.exports = {
    length: {
        'm': 1,
        'cm': 0.01,
        'mm': 0.001,
        'in': 0.0254,
        'px': 0.0254 / 96,
        'pt': 0.0254 / 72,
        'pc': 0.0254 / 72 * 12
    },
    duration: {
        's': 1,
        'ms': 0.001
    },
    angle: {
        'rad': 1 / (2 * Math.PI),
        'deg': 1 / 360,
        'grad': 1 / 400,
        'turn': 1
    }
};
},{}],20:[function(require,module,exports){
var abstractFileManager = function() {
};

abstractFileManager.prototype.getPath = function (filename) {
    var j = filename.lastIndexOf('?');
    if (j > 0) {
        filename = filename.slice(0, j);
    }
    j = filename.lastIndexOf('/');
    if (j < 0) {
        j = filename.lastIndexOf('\\');
    }
    if (j < 0) {
        return "";
    }
    return filename.slice(0, j + 1);
};

abstractFileManager.prototype.tryAppendExtension = function(path, ext) {
    return /(\.[a-z]*$)|([\?;].*)$/.test(path) ? path : path + ext;
};

abstractFileManager.prototype.tryAppendLessExtension = function(path) {
    return this.tryAppendExtension(path, '.less');
};

abstractFileManager.prototype.supportsSync = function() {
    return false;
};

abstractFileManager.prototype.alwaysMakePathsAbsolute = function() {
    return false;
};

abstractFileManager.prototype.isPathAbsolute = function(filename) {
    return (/^(?:[a-z-]+:|\/|\\|#)/i).test(filename);
};

abstractFileManager.prototype.join = function(basePath, laterPath) {
    if (!basePath) {
        return laterPath;
    }
    return basePath + laterPath;
};
abstractFileManager.prototype.pathDiff = function pathDiff(url, baseUrl) {
    // diff between two paths to create a relative path

    var urlParts = this.extractUrlParts(url),
        baseUrlParts = this.extractUrlParts(baseUrl),
        i, max, urlDirectories, baseUrlDirectories, diff = "";
    if (urlParts.hostPart !== baseUrlParts.hostPart) {
        return "";
    }
    max = Math.max(baseUrlParts.directories.length, urlParts.directories.length);
    for (i = 0; i < max; i++) {
        if (baseUrlParts.directories[i] !== urlParts.directories[i]) { break; }
    }
    baseUrlDirectories = baseUrlParts.directories.slice(i);
    urlDirectories = urlParts.directories.slice(i);
    for (i = 0; i < baseUrlDirectories.length - 1; i++) {
        diff += "../";
    }
    for (i = 0; i < urlDirectories.length - 1; i++) {
        diff += urlDirectories[i] + "/";
    }
    return diff;
};
// helper function, not part of API
abstractFileManager.prototype.extractUrlParts = function extractUrlParts(url, baseUrl) {
    // urlParts[1] = protocol://hostname/ OR /
    // urlParts[2] = / if path relative to host base
    // urlParts[3] = directories
    // urlParts[4] = filename
    // urlParts[5] = parameters

    var urlPartsRegex = /^((?:[a-z-]+:)?\/{2}(?:[^\/\?#]*\/)|([\/\\]))?((?:[^\/\\\?#]*[\/\\])*)([^\/\\\?#]*)([#\?].*)?$/i,
        urlParts = url.match(urlPartsRegex),
        returner = {}, directories = [], i, baseUrlParts;

    if (!urlParts) {
        throw new Error("Could not parse sheet href - '" + url + "'");
    }

    // Stylesheets in IE don't always return the full path
    if (baseUrl && (!urlParts[1] || urlParts[2])) {
        baseUrlParts = baseUrl.match(urlPartsRegex);
        if (!baseUrlParts) {
            throw new Error("Could not parse page url - '" + baseUrl + "'");
        }
        urlParts[1] = urlParts[1] || baseUrlParts[1] || "";
        if (!urlParts[2]) {
            urlParts[3] = baseUrlParts[3] + urlParts[3];
        }
    }

    if (urlParts[3]) {
        directories = urlParts[3].replace(/\\/g, "/").split("/");

        // extract out . before .. so .. doesn't absorb a non-directory
        for (i = 0; i < directories.length; i++) {
            if (directories[i] === ".") {
                directories.splice(i, 1);
                i -= 1;
            }
        }

        for (i = 0; i < directories.length; i++) {
            if (directories[i] === ".." && i > 0) {
                directories.splice(i - 1, 2);
                i -= 2;
            }
        }
    }

    returner.hostPart = urlParts[1];
    returner.directories = directories;
    returner.path = (urlParts[1] || "") + directories.join("/");
    returner.fileUrl = returner.path + (urlParts[4] || "");
    returner.url = returner.fileUrl + (urlParts[5] || "");
    return returner;
};

module.exports = abstractFileManager;

},{}],21:[function(require,module,exports){
var logger = require("../logger");
var environment = function(externalEnvironment, fileManagers) {
    this.fileManagers = fileManagers || [];
    externalEnvironment = externalEnvironment || {};

    var optionalFunctions = ["encodeBase64", "mimeLookup", "charsetLookup", "getSourceMapGenerator"],
        requiredFunctions = [],
        functions = requiredFunctions.concat(optionalFunctions);

    for (var i = 0; i < functions.length; i++) {
        var propName = functions[i],
            environmentFunc = externalEnvironment[propName];
        if (environmentFunc) {
            this[propName] = environmentFunc.bind(externalEnvironment);
        } else if (i < requiredFunctions.length) {
            this.warn("missing required function in environment - " + propName);
        }
    }
};

environment.prototype.getFileManager = function (filename, currentDirectory, options, environment, isSync) {

    if (!filename) {
        logger.warn("getFileManager called with no filename.. Please report this issue. continuing.");
    }
    if (currentDirectory == null) {
        logger.warn("getFileManager called with null directory.. Please report this issue. continuing.");
    }

    var fileManagers = this.fileManagers;
    if (options.pluginManager) {
        fileManagers = [].concat(fileManagers).concat(options.pluginManager.getFileManagers());
    }
    for (var i = fileManagers.length - 1; i >= 0 ; i--) {
        var fileManager = fileManagers[i];
        if (fileManager[isSync ? "supportsSync" : "supports"](filename, currentDirectory, options, environment)) {
            return fileManager;
        }
    }
    return null;
};

environment.prototype.addFileManager = function (fileManager) {
    this.fileManagers.push(fileManager);
};

environment.prototype.clearFileManagers = function () {
    this.fileManagers = [];
};

module.exports = environment;

},{"../logger":38}],22:[function(require,module,exports){
var Color = require("../tree/color"),
    functionRegistry = require("./function-registry");

// Color Blending
// ref: http://www.w3.org/TR/compositing-1

function colorBlend(mode, color1, color2) {
    var ab = color1.alpha, cb, // backdrop
        as = color2.alpha, cs, // source
        ar, cr, r = [];        // result

    ar = as + ab * (1 - as);
    for (var i = 0; i < 3; i++) {
        cb = color1.rgb[i] / 255;
        cs = color2.rgb[i] / 255;
        cr = mode(cb, cs);
        if (ar) {
            cr = (as * cs + ab * (cb -
                  as * (cb + cs - cr))) / ar;
        }
        r[i] = cr * 255;
    }

    return new Color(r, ar);
}

var colorBlendModeFunctions = {
    multiply: function(cb, cs) {
        return cb * cs;
    },
    screen: function(cb, cs) {
        return cb + cs - cb * cs;
    },
    overlay: function(cb, cs) {
        cb *= 2;
        return (cb <= 1) ?
            colorBlendModeFunctions.multiply(cb, cs) :
            colorBlendModeFunctions.screen(cb - 1, cs);
    },
    softlight: function(cb, cs) {
        var d = 1, e = cb;
        if (cs > 0.5) {
            e = 1;
            d = (cb > 0.25) ? Math.sqrt(cb)
                : ((16 * cb - 12) * cb + 4) * cb;
        }
        return cb - (1 - 2 * cs) * e * (d - cb);
    },
    hardlight: function(cb, cs) {
        return colorBlendModeFunctions.overlay(cs, cb);
    },
    difference: function(cb, cs) {
        return Math.abs(cb - cs);
    },
    exclusion: function(cb, cs) {
        return cb + cs - 2 * cb * cs;
    },

    // non-w3c functions:
    average: function(cb, cs) {
        return (cb + cs) / 2;
    },
    negation: function(cb, cs) {
        return 1 - Math.abs(cb + cs - 1);
    }
};

for (var f in colorBlendModeFunctions) {
    if (colorBlendModeFunctions.hasOwnProperty(f)) {
        colorBlend[f] = colorBlend.bind(null, colorBlendModeFunctions[f]);
    }
}

functionRegistry.addMultiple(colorBlend);

},{"../tree/color":55,"./function-registry":27}],23:[function(require,module,exports){
var Dimension = require("../tree/dimension"),
    Color = require("../tree/color"),
    Quoted = require("../tree/quoted"),
    Anonymous = require("../tree/anonymous"),
    functionRegistry = require("./function-registry"),
    colorFunctions;

function clamp(val) {
    return Math.min(1, Math.max(0, val));
}
function hsla(color) {
    return colorFunctions.hsla(color.h, color.s, color.l, color.a);
}
function number(n) {
    if (n instanceof Dimension) {
        return parseFloat(n.unit.is('%') ? n.value / 100 : n.value);
    } else if (typeof n === 'number') {
        return n;
    } else {
        throw {
            type: "Argument",
            message: "color functions take numbers as parameters"
        };
    }
}
function scaled(n, size) {
    if (n instanceof Dimension && n.unit.is('%')) {
        return parseFloat(n.value * size / 100);
    } else {
        return number(n);
    }
}
colorFunctions = {
    rgb: function (r, g, b) {
        return colorFunctions.rgba(r, g, b, 1.0);
    },
    rgba: function (r, g, b, a) {
        var rgb = [r, g, b].map(function (c) { return scaled(c, 255); });
        a = number(a);
        return new Color(rgb, a);
    },
    hsl: function (h, s, l) {
        return colorFunctions.hsla(h, s, l, 1.0);
    },
    hsla: function (h, s, l, a) {

        var m1, m2;

        function hue(h) {
            h = h < 0 ? h + 1 : (h > 1 ? h - 1 : h);
            if (h * 6 < 1) {
                return m1 + (m2 - m1) * h * 6;
            }
            else if (h * 2 < 1) {
                return m2;
            }
            else if (h * 3 < 2) {
                return m1 + (m2 - m1) * (2 / 3 - h) * 6;
            }
            else {
                return m1;
            }
        }

        h = (number(h) % 360) / 360;
        s = clamp(number(s)); l = clamp(number(l)); a = clamp(number(a));

        m2 = l <= 0.5 ? l * (s + 1) : l + s - l * s;
        m1 = l * 2 - m2;

        return colorFunctions.rgba(hue(h + 1 / 3) * 255,
            hue(h)       * 255,
            hue(h - 1 / 3) * 255,
            a);
    },

    hsv: function(h, s, v) {
        return colorFunctions.hsva(h, s, v, 1.0);
    },

    hsva: function(h, s, v, a) {
        h = ((number(h) % 360) / 360) * 360;
        s = number(s); v = number(v); a = number(a);

        var i, f;
        i = Math.floor((h / 60) % 6);
        f = (h / 60) - i;

        var vs = [v,
            v * (1 - s),
            v * (1 - f * s),
            v * (1 - (1 - f) * s)];
        var perm = [[0, 3, 1],
            [2, 0, 1],
            [1, 0, 3],
            [1, 2, 0],
            [3, 1, 0],
            [0, 1, 2]];

        return colorFunctions.rgba(vs[perm[i][0]] * 255,
            vs[perm[i][1]] * 255,
            vs[perm[i][2]] * 255,
            a);
    },

    hue: function (color) {
        return new Dimension(color.toHSL().h);
    },
    saturation: function (color) {
        return new Dimension(color.toHSL().s * 100, '%');
    },
    lightness: function (color) {
        return new Dimension(color.toHSL().l * 100, '%');
    },
    hsvhue: function(color) {
        return new Dimension(color.toHSV().h);
    },
    hsvsaturation: function (color) {
        return new Dimension(color.toHSV().s * 100, '%');
    },
    hsvvalue: function (color) {
        return new Dimension(color.toHSV().v * 100, '%');
    },
    red: function (color) {
        return new Dimension(color.rgb[0]);
    },
    green: function (color) {
        return new Dimension(color.rgb[1]);
    },
    blue: function (color) {
        return new Dimension(color.rgb[2]);
    },
    alpha: function (color) {
        return new Dimension(color.toHSL().a);
    },
    luma: function (color) {
        return new Dimension(color.luma() * color.alpha * 100, '%');
    },
    luminance: function (color) {
        var luminance =
            (0.2126 * color.rgb[0] / 255) +
                (0.7152 * color.rgb[1] / 255) +
                (0.0722 * color.rgb[2] / 255);

        return new Dimension(luminance * color.alpha * 100, '%');
    },
    saturate: function (color, amount, method) {
        // filter: saturate(3.2);
        // should be kept as is, so check for color
        if (!color.rgb) {
            return null;
        }
        var hsl = color.toHSL();

        if (typeof method !== "undefined" && method.value === "relative") {
            hsl.s +=  hsl.s * amount.value / 100;
        }
        else {
            hsl.s += amount.value / 100;
        }
        hsl.s = clamp(hsl.s);
        return hsla(hsl);
    },
    desaturate: function (color, amount, method) {
        var hsl = color.toHSL();

        if (typeof method !== "undefined" && method.value === "relative") {
            hsl.s -=  hsl.s * amount.value / 100;
        }
        else {
            hsl.s -= amount.value / 100;
        }
        hsl.s = clamp(hsl.s);
        return hsla(hsl);
    },
    lighten: function (color, amount, method) {
        var hsl = color.toHSL();

        if (typeof method !== "undefined" && method.value === "relative") {
            hsl.l +=  hsl.l * amount.value / 100;
        }
        else {
            hsl.l += amount.value / 100;
        }
        hsl.l = clamp(hsl.l);
        return hsla(hsl);
    },
    darken: function (color, amount, method) {
        var hsl = color.toHSL();

        if (typeof method !== "undefined" && method.value === "relative") {
            hsl.l -=  hsl.l * amount.value / 100;
        }
        else {
            hsl.l -= amount.value / 100;
        }
        hsl.l = clamp(hsl.l);
        return hsla(hsl);
    },
    fadein: function (color, amount, method) {
        var hsl = color.toHSL();

        if (typeof method !== "undefined" && method.value === "relative") {
            hsl.a +=  hsl.a * amount.value / 100;
        }
        else {
            hsl.a += amount.value / 100;
        }
        hsl.a = clamp(hsl.a);
        return hsla(hsl);
    },
    fadeout: function (color, amount, method) {
        var hsl = color.toHSL();

        if (typeof method !== "undefined" && method.value === "relative") {
            hsl.a -=  hsl.a * amount.value / 100;
        }
        else {
            hsl.a -= amount.value / 100;
        }
        hsl.a = clamp(hsl.a);
        return hsla(hsl);
    },
    fade: function (color, amount) {
        var hsl = color.toHSL();

        hsl.a = amount.value / 100;
        hsl.a = clamp(hsl.a);
        return hsla(hsl);
    },
    spin: function (color, amount) {
        var hsl = color.toHSL();
        var hue = (hsl.h + amount.value) % 360;

        hsl.h = hue < 0 ? 360 + hue : hue;

        return hsla(hsl);
    },
    //
    // Copyright (c) 2006-2009 Hampton Catlin, Natalie Weizenbaum, and Chris Eppstein
    // http://sass-lang.com
    //
    mix: function (color1, color2, weight) {
        if (!color1.toHSL || !color2.toHSL) {
            console.log(color2.type);
            console.dir(color2);
        }
        if (!weight) {
            weight = new Dimension(50);
        }
        var p = weight.value / 100.0;
        var w = p * 2 - 1;
        var a = color1.toHSL().a - color2.toHSL().a;

        var w1 = (((w * a == -1) ? w : (w + a) / (1 + w * a)) + 1) / 2.0;
        var w2 = 1 - w1;

        var rgb = [color1.rgb[0] * w1 + color2.rgb[0] * w2,
            color1.rgb[1] * w1 + color2.rgb[1] * w2,
            color1.rgb[2] * w1 + color2.rgb[2] * w2];

        var alpha = color1.alpha * p + color2.alpha * (1 - p);

        return new Color(rgb, alpha);
    },
    greyscale: function (color) {
        return colorFunctions.desaturate(color, new Dimension(100));
    },
    contrast: function (color, dark, light, threshold) {
        // filter: contrast(3.2);
        // should be kept as is, so check for color
        if (!color.rgb) {
            return null;
        }
        if (typeof light === 'undefined') {
            light = colorFunctions.rgba(255, 255, 255, 1.0);
        }
        if (typeof dark === 'undefined') {
            dark = colorFunctions.rgba(0, 0, 0, 1.0);
        }
        //Figure out which is actually light and dark!
        if (dark.luma() > light.luma()) {
            var t = light;
            light = dark;
            dark = t;
        }
        if (typeof threshold === 'undefined') {
            threshold = 0.43;
        } else {
            threshold = number(threshold);
        }
        if (color.luma() < threshold) {
            return light;
        } else {
            return dark;
        }
    },
    argb: function (color) {
        return new Anonymous(color.toARGB());
    },
    color: function(c) {
        if ((c instanceof Quoted) &&
            (/^#([a-f0-9]{6}|[a-f0-9]{3})$/i.test(c.value))) {
            return new Color(c.value.slice(1));
        }
        if ((c instanceof Color) || (c = Color.fromKeyword(c.value))) {
            c.value = undefined;
            return c;
        }
        throw {
            type:    "Argument",
            message: "argument must be a color keyword or 3/6 digit hex e.g. #FFF"
        };
    },
    tint: function(color, amount) {
        return colorFunctions.mix(colorFunctions.rgb(255, 255, 255), color, amount);
    },
    shade: function(color, amount) {
        return colorFunctions.mix(colorFunctions.rgb(0, 0, 0), color, amount);
    }
};
functionRegistry.addMultiple(colorFunctions);

},{"../tree/anonymous":51,"../tree/color":55,"../tree/dimension":61,"../tree/quoted":78,"./function-registry":27}],24:[function(require,module,exports){
module.exports = function(environment) {
    var Quoted = require("../tree/quoted"),
        URL = require("../tree/url"),
        functionRegistry = require("./function-registry"),
        fallback = function(functionThis, node) {
            return new URL(node, functionThis.index, functionThis.currentFileInfo).eval(functionThis.context);
        },
        logger = require('../logger');

    functionRegistry.add("data-uri", function(mimetypeNode, filePathNode) {

        if (!filePathNode) {
            filePathNode = mimetypeNode;
            mimetypeNode = null;
        }

        var mimetype = mimetypeNode && mimetypeNode.value;
        var filePath = filePathNode.value;
        var currentFileInfo = this.currentFileInfo;
        var currentDirectory = currentFileInfo.relativeUrls ?
            currentFileInfo.currentDirectory : currentFileInfo.entryPath;

        var fragmentStart = filePath.indexOf('#');
        var fragment = '';
        if (fragmentStart !== -1) {
            fragment = filePath.slice(fragmentStart);
            filePath = filePath.slice(0, fragmentStart);
        }

        var fileManager = environment.getFileManager(filePath, currentDirectory, this.context, environment, true);

        if (!fileManager) {
            return fallback(this, filePathNode);
        }

        var useBase64 = false;

        // detect the mimetype if not given
        if (!mimetypeNode) {

            mimetype = environment.mimeLookup(filePath);

            if (mimetype === "image/svg+xml") {
                useBase64 = false;
            } else {
                // use base 64 unless it's an ASCII or UTF-8 format
                var charset = environment.charsetLookup(mimetype);
                useBase64 = ['US-ASCII', 'UTF-8'].indexOf(charset) < 0;
            }
            if (useBase64) { mimetype += ';base64'; }
        }
        else {
            useBase64 = /;base64$/.test(mimetype);
        }

        var fileSync = fileManager.loadFileSync(filePath, currentDirectory, this.context, environment);
        if (!fileSync.contents) {
            logger.warn("Skipped data-uri embedding of " + filePath + " because file not found");
            return fallback(this, filePathNode || mimetypeNode);
        }
        var buf = fileSync.contents;
        if (useBase64 && !environment.encodeBase64) {
            return fallback(this, filePathNode);
        }

        buf = useBase64 ? environment.encodeBase64(buf) : encodeURIComponent(buf);

        var uri = "data:" + mimetype + ',' + buf + fragment;

        // IE8 cannot handle a data-uri larger than 32,768 characters. If this is exceeded
        // and the --ieCompat flag is enabled, return a normal url() instead.
        var DATA_URI_MAX = 32768;
        if (uri.length >= DATA_URI_MAX) {

            if (this.context.ieCompat !== false) {
                logger.warn("Skipped data-uri embedding of " + filePath + " because its size (" + uri.length +
                    " characters) exceeds IE8-safe " + DATA_URI_MAX + " characters!");

                return fallback(this, filePathNode || mimetypeNode);
            }
        }

        return new URL(new Quoted('"' + uri + '"', uri, false, this.index, this.currentFileInfo), this.index, this.currentFileInfo);
    });
};

},{"../logger":38,"../tree/quoted":78,"../tree/url":85,"./function-registry":27}],25:[function(require,module,exports){
var Keyword = require("../tree/keyword"),
    functionRegistry = require("./function-registry");

var defaultFunc = {
    eval: function () {
        var v = this.value_, e = this.error_;
        if (e) {
            throw e;
        }
        if (v != null) {
            return v ? Keyword.True : Keyword.False;
        }
    },
    value: function (v) {
        this.value_ = v;
    },
    error: function (e) {
        this.error_ = e;
    },
    reset: function () {
        this.value_ = this.error_ = null;
    }
};

functionRegistry.add("default", defaultFunc.eval.bind(defaultFunc));

module.exports = defaultFunc;

},{"../tree/keyword":70,"./function-registry":27}],26:[function(require,module,exports){
var Expression = require("../tree/expression");

var functionCaller = function(name, context, index, currentFileInfo) {
    this.name = name.toLowerCase();
    this.index = index;
    this.context = context;
    this.currentFileInfo = currentFileInfo;

    this.func = context.frames[0].functionRegistry.get(this.name);
};
functionCaller.prototype.isValid = function() {
    return Boolean(this.func);
};
functionCaller.prototype.call = function(args) {

    // This code is terrible and should be replaced as per this issue...
    // https://github.com/less/less.js/issues/2477
    if (Array.isArray(args)) {
        args = args.filter(function (item) {
            if (item.type === "Comment") {
                return false;
            }
            return true;
        })
        .map(function(item) {
            if (item.type === "Expression") {
                var subNodes = item.value.filter(function (item) {
                    if (item.type === "Comment") {
                        return false;
                    }
                    return true;
                });
                if (subNodes.length === 1) {
                    return subNodes[0];
                } else {
                    return new Expression(subNodes);
                }
            }
            return item;
        });
    }

    return this.func.apply(this, args);
};

module.exports = functionCaller;

},{"../tree/expression":64}],27:[function(require,module,exports){
function makeRegistry( base ) {
    return {
        _data: {},
        add: function(name, func) {
            // precautionary case conversion, as later querying of
            // the registry by function-caller uses lower case as well.
            name = name.toLowerCase();

            if (this._data.hasOwnProperty(name)) {
                //TODO warn
            }
            this._data[name] = func;
        },
        addMultiple: function(functions) {
            Object.keys(functions).forEach(
                function(name) {
                    this.add(name, functions[name]);
                }.bind(this));
        },
        get: function(name) {
            return this._data[name] || ( base && base.get( name ));
        },
        inherit : function() {
            return makeRegistry( this );
        }
    };
}

module.exports = makeRegistry( null );
},{}],28:[function(require,module,exports){
module.exports = function(environment) {
    var functions = {
        functionRegistry: require("./function-registry"),
        functionCaller: require("./function-caller")
    };

    //register functions
    require("./default");
    require("./color");
    require("./color-blending");
    require("./data-uri")(environment);
    require("./math");
    require("./number");
    require("./string");
    require("./svg")(environment);
    require("./types");

    return functions;
};

},{"./color":23,"./color-blending":22,"./data-uri":24,"./default":25,"./function-caller":26,"./function-registry":27,"./math":30,"./number":31,"./string":32,"./svg":33,"./types":34}],29:[function(require,module,exports){
var Dimension = require("../tree/dimension");

var MathHelper = function() {
};
MathHelper._math = function (fn, unit, n) {
    if (!(n instanceof Dimension)) {
        throw { type: "Argument", message: "argument must be a number" };
    }
    if (unit == null) {
        unit = n.unit;
    } else {
        n = n.unify();
    }
    return new Dimension(fn(parseFloat(n.value)), unit);
};
module.exports = MathHelper;
},{"../tree/dimension":61}],30:[function(require,module,exports){
var functionRegistry = require("./function-registry"),
    mathHelper = require("./math-helper.js");

var mathFunctions = {
    // name,  unit
    ceil:  null,
    floor: null,
    sqrt:  null,
    abs:   null,
    tan:   "",
    sin:   "",
    cos:   "",
    atan:  "rad",
    asin:  "rad",
    acos:  "rad"
};

for (var f in mathFunctions) {
    if (mathFunctions.hasOwnProperty(f)) {
        mathFunctions[f] = mathHelper._math.bind(null, Math[f], mathFunctions[f]);
    }
}

mathFunctions.round = function (n, f) {
    var fraction = typeof f === "undefined" ? 0 : f.value;
    return mathHelper._math(function(num) { return num.toFixed(fraction); }, null, n);
};

functionRegistry.addMultiple(mathFunctions);

},{"./function-registry":27,"./math-helper.js":29}],31:[function(require,module,exports){
var Dimension = require("../tree/dimension"),
    Anonymous = require("../tree/anonymous"),
    functionRegistry = require("./function-registry"),
    mathHelper = require("./math-helper.js");

var minMax = function (isMin, args) {
    args = Array.prototype.slice.call(args);
    switch(args.length) {
        case 0: throw { type: "Argument", message: "one or more arguments required" };
    }
    var i, j, current, currentUnified, referenceUnified, unit, unitStatic, unitClone,
        order  = [], // elems only contains original argument values.
        values = {}; // key is the unit.toString() for unified Dimension values,
    // value is the index into the order array.
    for (i = 0; i < args.length; i++) {
        current = args[i];
        if (!(current instanceof Dimension)) {
            if (Array.isArray(args[i].value)) {
                Array.prototype.push.apply(args, Array.prototype.slice.call(args[i].value));
            }
            continue;
        }
        currentUnified = current.unit.toString() === "" && unitClone !== undefined ? new Dimension(current.value, unitClone).unify() : current.unify();
        unit = currentUnified.unit.toString() === "" && unitStatic !== undefined ? unitStatic : currentUnified.unit.toString();
        unitStatic = unit !== "" && unitStatic === undefined || unit !== "" && order[0].unify().unit.toString() === "" ? unit : unitStatic;
        unitClone = unit !== "" && unitClone === undefined ? current.unit.toString() : unitClone;
        j = values[""] !== undefined && unit !== "" && unit === unitStatic ? values[""] : values[unit];
        if (j === undefined) {
            if (unitStatic !== undefined && unit !== unitStatic) {
                throw{ type: "Argument", message: "incompatible types" };
            }
            values[unit] = order.length;
            order.push(current);
            continue;
        }
        referenceUnified = order[j].unit.toString() === "" && unitClone !== undefined ? new Dimension(order[j].value, unitClone).unify() : order[j].unify();
        if ( isMin && currentUnified.value < referenceUnified.value ||
            !isMin && currentUnified.value > referenceUnified.value) {
            order[j] = current;
        }
    }
    if (order.length == 1) {
        return order[0];
    }
    args = order.map(function (a) { return a.toCSS(this.context); }).join(this.context.compress ? "," : ", ");
    return new Anonymous((isMin ? "min" : "max") + "(" + args + ")");
};
functionRegistry.addMultiple({
    min: function () {
        return minMax(true, arguments);
    },
    max: function () {
        return minMax(false, arguments);
    },
    convert: function (val, unit) {
        return val.convertTo(unit.value);
    },
    pi: function () {
        return new Dimension(Math.PI);
    },
    mod: function(a, b) {
        return new Dimension(a.value % b.value, a.unit);
    },
    pow: function(x, y) {
        if (typeof x === "number" && typeof y === "number") {
            x = new Dimension(x);
            y = new Dimension(y);
        } else if (!(x instanceof Dimension) || !(y instanceof Dimension)) {
            throw { type: "Argument", message: "arguments must be numbers" };
        }

        return new Dimension(Math.pow(x.value, y.value), x.unit);
    },
    percentage: function (n) {
        var result = mathHelper._math(function(num) {
            return num * 100;
        }, '%', n);

        return result;
    }
});

},{"../tree/anonymous":51,"../tree/dimension":61,"./function-registry":27,"./math-helper.js":29}],32:[function(require,module,exports){
var Quoted = require("../tree/quoted"),
    Anonymous = require("../tree/anonymous"),
    JavaScript = require("../tree/javascript"),
    functionRegistry = require("./function-registry");

functionRegistry.addMultiple({
    e: function (str) {
        return new Anonymous(str instanceof JavaScript ? str.evaluated : str.value);
    },
    escape: function (str) {
        return new Anonymous(
            encodeURI(str.value).replace(/=/g, "%3D").replace(/:/g, "%3A").replace(/#/g, "%23").replace(/;/g, "%3B")
                .replace(/\(/g, "%28").replace(/\)/g, "%29"));
    },
    replace: function (string, pattern, replacement, flags) {
        var result = string.value;
        replacement = (replacement.type === "Quoted") ?
            replacement.value : replacement.toCSS();
        result = result.replace(new RegExp(pattern.value, flags ? flags.value : ''), replacement);
        return new Quoted(string.quote || '', result, string.escaped);
    },
    '%': function (string /* arg, arg, ...*/) {
        var args = Array.prototype.slice.call(arguments, 1),
            result = string.value;

        for (var i = 0; i < args.length; i++) {
            /*jshint loopfunc:true */
            result = result.replace(/%[sda]/i, function(token) {
                var value = ((args[i].type === "Quoted") &&
                    token.match(/s/i)) ? args[i].value : args[i].toCSS();
                return token.match(/[A-Z]$/) ? encodeURIComponent(value) : value;
            });
        }
        result = result.replace(/%%/g, '%');
        return new Quoted(string.quote || '', result, string.escaped);
    }
});

},{"../tree/anonymous":51,"../tree/javascript":68,"../tree/quoted":78,"./function-registry":27}],33:[function(require,module,exports){
module.exports = function(environment) {
    var Dimension = require("../tree/dimension"),
        Color = require("../tree/color"),
        Expression = require("../tree/expression"),
        Quoted = require("../tree/quoted"),
        URL = require("../tree/url"),
        functionRegistry = require("./function-registry");

    functionRegistry.add("svg-gradient", function(direction) {

        var stops,
            gradientDirectionSvg,
            gradientType = "linear",
            rectangleDimension = 'x="0" y="0" width="1" height="1"',
            renderEnv = {compress: false},
            returner,
            directionValue = direction.toCSS(renderEnv),
			i, color, position, positionValue, alpha;

        function throwArgumentDescriptor() {
            throw { type: "Argument",
					message: "svg-gradient expects direction, start_color [start_position], [color position,]...," +
							" end_color [end_position] or direction, color list" };
        }

        if (arguments.length == 2) {
            if (arguments[1].value.length < 2) {
                throwArgumentDescriptor();
            }
            stops = arguments[1].value;
        } else if (arguments.length < 3) {
            throwArgumentDescriptor();
        } else {
            stops = Array.prototype.slice.call(arguments, 1);
        }

        switch (directionValue) {
            case "to bottom":
                gradientDirectionSvg = 'x1="0%" y1="0%" x2="0%" y2="100%"';
                break;
            case "to right":
                gradientDirectionSvg = 'x1="0%" y1="0%" x2="100%" y2="0%"';
                break;
            case "to bottom right":
                gradientDirectionSvg = 'x1="0%" y1="0%" x2="100%" y2="100%"';
                break;
            case "to top right":
                gradientDirectionSvg = 'x1="0%" y1="100%" x2="100%" y2="0%"';
                break;
            case "ellipse":
            case "ellipse at center":
                gradientType = "radial";
                gradientDirectionSvg = 'cx="50%" cy="50%" r="75%"';
                rectangleDimension = 'x="-50" y="-50" width="101" height="101"';
                break;
            default:
                throw { type: "Argument", message: "svg-gradient direction must be 'to bottom', 'to right'," +
                    " 'to bottom right', 'to top right' or 'ellipse at center'" };
        }
        returner = '<?xml version="1.0" ?>' +
            '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="100%" height="100%" viewBox="0 0 1 1" preserveAspectRatio="none">' +
            '<' + gradientType + 'Gradient id="gradient" gradientUnits="userSpaceOnUse" ' + gradientDirectionSvg + '>';

        for (i = 0; i < stops.length; i+= 1) {
            if (stops[i] instanceof Expression) {
                color = stops[i].value[0];
                position = stops[i].value[1];
            } else {
                color = stops[i];
                position = undefined;
            }

            if (!(color instanceof Color) || (!((i === 0 || i + 1 === stops.length) && position === undefined) && !(position instanceof Dimension))) {
                throwArgumentDescriptor();
            }
            positionValue = position ? position.toCSS(renderEnv) : i === 0 ? "0%" : "100%";
            alpha = color.alpha;
            returner += '<stop offset="' + positionValue + '" stop-color="' + color.toRGB() + '"' + (alpha < 1 ? ' stop-opacity="' + alpha + '"' : '') + '/>';
        }
        returner += '</' + gradientType + 'Gradient>' +
            '<rect ' + rectangleDimension + ' fill="url(#gradient)" /></svg>';

        returner = encodeURIComponent(returner);

        returner = "data:image/svg+xml," + returner;
        return new URL(new Quoted("'" + returner + "'", returner, false, this.index, this.currentFileInfo), this.index, this.currentFileInfo);
    });
};

},{"../tree/color":55,"../tree/dimension":61,"../tree/expression":64,"../tree/quoted":78,"../tree/url":85,"./function-registry":27}],34:[function(require,module,exports){
var Keyword = require("../tree/keyword"),
    DetachedRuleset = require("../tree/detached-ruleset"),
    Dimension = require("../tree/dimension"),
    Color = require("../tree/color"),
    Quoted = require("../tree/quoted"),
    Anonymous = require("../tree/anonymous"),
    URL = require("../tree/url"),
    Operation = require("../tree/operation"),
    functionRegistry = require("./function-registry");

var isa = function (n, Type) {
        return (n instanceof Type) ? Keyword.True : Keyword.False;
    },
    isunit = function (n, unit) {
        if (unit === undefined) {
            throw { type: "Argument", message: "missing the required second argument to isunit." };
        }
        unit = typeof unit.value === "string" ? unit.value : unit;
        if (typeof unit !== "string") {
            throw { type: "Argument", message: "Second argument to isunit should be a unit or a string." };
        }
        return (n instanceof Dimension) && n.unit.is(unit) ? Keyword.True : Keyword.False;
    },
    getItemsFromNode = function(node) {
        // handle non-array values as an array of length 1
        // return 'undefined' if index is invalid
        var items = Array.isArray(node.value) ?
            node.value : Array(node);

        return items;
    };
functionRegistry.addMultiple({
    isruleset: function (n) {
        return isa(n, DetachedRuleset);
    },
    iscolor: function (n) {
        return isa(n, Color);
    },
    isnumber: function (n) {
        return isa(n, Dimension);
    },
    isstring: function (n) {
        return isa(n, Quoted);
    },
    iskeyword: function (n) {
        return isa(n, Keyword);
    },
    isurl: function (n) {
        return isa(n, URL);
    },
    ispixel: function (n) {
        return isunit(n, 'px');
    },
    ispercentage: function (n) {
        return isunit(n, '%');
    },
    isem: function (n) {
        return isunit(n, 'em');
    },
    isunit: isunit,
    unit: function (val, unit) {
        if (!(val instanceof Dimension)) {
            throw { type: "Argument",
                message: "the first argument to unit must be a number" +
                    (val instanceof Operation ? ". Have you forgotten parenthesis?" : "") };
        }
        if (unit) {
            if (unit instanceof Keyword) {
                unit = unit.value;
            } else {
                unit = unit.toCSS();
            }
        } else {
            unit = "";
        }
        return new Dimension(val.value, unit);
    },
    "get-unit": function (n) {
        return new Anonymous(n.unit);
    },
    extract: function(values, index) {
        index = index.value - 1; // (1-based index)

        return getItemsFromNode(values)[index];
    },
    length: function(values) {
        return new Dimension(getItemsFromNode(values).length);
    }
});

},{"../tree/anonymous":51,"../tree/color":55,"../tree/detached-ruleset":60,"../tree/dimension":61,"../tree/keyword":70,"../tree/operation":76,"../tree/quoted":78,"../tree/url":85,"./function-registry":27}],35:[function(require,module,exports){
var contexts = require("./contexts"),
    Parser = require('./parser/parser'),
    FunctionImporter = require('./plugins/function-importer');

module.exports = function(environment) {

    // FileInfo = {
    //  'relativeUrls' - option - whether to adjust URL's to be relative
    //  'filename' - full resolved filename of current file
    //  'rootpath' - path to append to normal URLs for this node
    //  'currentDirectory' - path to the current file, absolute
    //  'rootFilename' - filename of the base file
    //  'entryPath' - absolute path to the entry file
    //  'reference' - whether the file should not be output and only output parts that are referenced

    var ImportManager = function(context, rootFileInfo) {
        this.rootFilename = rootFileInfo.filename;
        this.paths = context.paths || [];  // Search paths, when importing
        this.contents = {};             // map - filename to contents of all the files
        this.contentsIgnoredChars = {}; // map - filename to lines at the beginning of each file to ignore
        this.mime = context.mime;
        this.error = null;
        this.context = context;
        // Deprecated? Unused outside of here, could be useful.
        this.queue = [];        // Files which haven't been imported yet
        this.files = {};        // Holds the imported parse trees.
    };
    /**
     * Add an import to be imported
     * @param path - the raw path
     * @param tryAppendLessExtension - whether to try appending the less extension (if the path has no extension)
     * @param currentFileInfo - the current file info (used for instance to work out relative paths)
     * @param importOptions - import options
     * @param callback - callback for when it is imported
     */
    ImportManager.prototype.push = function (path, tryAppendLessExtension, currentFileInfo, importOptions, callback) {
        var importManager = this;
        this.queue.push(path);

        var fileParsedFunc = function (e, root, fullPath) {
            importManager.queue.splice(importManager.queue.indexOf(path), 1); // Remove the path from the queue

            var importedEqualsRoot = fullPath === importManager.rootFilename;
            if (importOptions.optional && e) {
                callback(null, {rules:[]}, false, null);
            }
            else {
                importManager.files[fullPath] = root;
                if (e && !importManager.error) { importManager.error = e; }
                callback(e, root, importedEqualsRoot, fullPath);
            }
        };

        var newFileInfo = {
            relativeUrls: this.context.relativeUrls,
            entryPath: currentFileInfo.entryPath,
            rootpath: currentFileInfo.rootpath,
            rootFilename: currentFileInfo.rootFilename
        };

        var fileManager = environment.getFileManager(path, currentFileInfo.currentDirectory, this.context, environment);

        if (!fileManager) {
            fileParsedFunc({ message: "Could not find a file-manager for " + path });
            return;
        }

        if (tryAppendLessExtension) {
            path = fileManager.tryAppendExtension(path, importOptions.plugin ? ".js" : ".less");
        }

        var loadFileCallback = function(loadedFile) {
            var resolvedFilename = loadedFile.filename,
                contents = loadedFile.contents.replace(/^\uFEFF/, '');

            // Pass on an updated rootpath if path of imported file is relative and file
            // is in a (sub|sup) directory
            //
            // Examples:
            // - If path of imported file is 'module/nav/nav.less' and rootpath is 'less/',
            //   then rootpath should become 'less/module/nav/'
            // - If path of imported file is '../mixins.less' and rootpath is 'less/',
            //   then rootpath should become 'less/../'
            newFileInfo.currentDirectory = fileManager.getPath(resolvedFilename);
            if (newFileInfo.relativeUrls) {
                newFileInfo.rootpath = fileManager.join(
                    (importManager.context.rootpath || ""),
                    fileManager.pathDiff(newFileInfo.currentDirectory, newFileInfo.entryPath));

                if (!fileManager.isPathAbsolute(newFileInfo.rootpath) && fileManager.alwaysMakePathsAbsolute()) {
                    newFileInfo.rootpath = fileManager.join(newFileInfo.entryPath, newFileInfo.rootpath);
                }
            }
            newFileInfo.filename = resolvedFilename;

            var newEnv = new contexts.Parse(importManager.context);

            newEnv.processImports = false;
            importManager.contents[resolvedFilename] = contents;

            if (currentFileInfo.reference || importOptions.reference) {
                newFileInfo.reference = true;
            }

            if (importOptions.plugin) {
                new FunctionImporter(newEnv, newFileInfo).eval(contents, function (e, root) {
                    fileParsedFunc(e, root, resolvedFilename);
                });
            } else if (importOptions.inline) {
                fileParsedFunc(null, contents, resolvedFilename);
            } else {
                new Parser(newEnv, importManager, newFileInfo).parse(contents, function (e, root) {
                    fileParsedFunc(e, root, resolvedFilename);
                });
            }
        };

        var promise = fileManager.loadFile(path, currentFileInfo.currentDirectory, this.context, environment,
            function(err, loadedFile) {
            if (err) {
                fileParsedFunc(err);
            } else {
                loadFileCallback(loadedFile);
            }
        });
        if (promise) {
            promise.then(loadFileCallback, fileParsedFunc);
        }
    };
    return ImportManager;
};

},{"./contexts":16,"./parser/parser":43,"./plugins/function-importer":45}],36:[function(require,module,exports){
module.exports = function(environment, fileManagers) {
    var SourceMapOutput, SourceMapBuilder, ParseTree, ImportManager, Environment;

    var less = {
        version: [2, 7, 2],
        data: require('./data'),
        tree: require('./tree'),
        Environment: (Environment = require("./environment/environment")),
        AbstractFileManager: require("./environment/abstract-file-manager"),
        environment: (environment = new Environment(environment, fileManagers)),
        visitors: require('./visitors'),
        Parser: require('./parser/parser'),
        functions: require('./functions')(environment),
        contexts: require("./contexts"),
        SourceMapOutput: (SourceMapOutput = require('./source-map-output')(environment)),
        SourceMapBuilder: (SourceMapBuilder = require('./source-map-builder')(SourceMapOutput, environment)),
        ParseTree: (ParseTree = require('./parse-tree')(SourceMapBuilder)),
        ImportManager: (ImportManager = require('./import-manager')(environment)),
        render: require("./render")(environment, ParseTree, ImportManager),
        parse: require("./parse")(environment, ParseTree, ImportManager),
        LessError: require('./less-error'),
        transformTree: require('./transform-tree'),
        utils: require('./utils'),
        PluginManager: require('./plugin-manager'),
        logger: require('./logger')
    };

    return less;
};

},{"./contexts":16,"./data":18,"./environment/abstract-file-manager":20,"./environment/environment":21,"./functions":28,"./import-manager":35,"./less-error":37,"./logger":38,"./parse":40,"./parse-tree":39,"./parser/parser":43,"./plugin-manager":44,"./render":46,"./source-map-builder":47,"./source-map-output":48,"./transform-tree":49,"./tree":67,"./utils":88,"./visitors":92}],37:[function(require,module,exports){
var utils = require("./utils");

var LessError = module.exports = function LessError(e, importManager, currentFilename) {

    Error.call(this);

    var filename = e.filename || currentFilename;

    if (importManager && filename) {
        var input = importManager.contents[filename],
            loc = utils.getLocation(e.index, input),
            line = loc.line,
            col  = loc.column,
            callLine = e.call && utils.getLocation(e.call, input).line,
            lines = input.split('\n');

        this.type = e.type || 'Syntax';
        this.filename = filename;
        this.index = e.index;
        this.line = typeof line === 'number' ? line + 1 : null;
        this.callLine = callLine + 1;
        this.callExtract = lines[callLine];
        this.column = col;
        this.extract = [
            lines[line - 1],
            lines[line],
            lines[line + 1]
        ];
    }
    this.message = e.message;
    this.stack = e.stack;
};

if (typeof Object.create === 'undefined') {
    var F = function () {};
    F.prototype = Error.prototype;
    LessError.prototype = new F();
} else {
    LessError.prototype = Object.create(Error.prototype);
}

LessError.prototype.constructor = LessError;

},{"./utils":88}],38:[function(require,module,exports){
module.exports = {
    error: function(msg) {
        this._fireEvent("error", msg);
    },
    warn: function(msg) {
        this._fireEvent("warn", msg);
    },
    info: function(msg) {
        this._fireEvent("info", msg);
    },
    debug: function(msg) {
        this._fireEvent("debug", msg);
    },
    addListener: function(listener) {
        this._listeners.push(listener);
    },
    removeListener: function(listener) {
        for (var i = 0; i < this._listeners.length; i++) {
            if (this._listeners[i] === listener) {
                this._listeners.splice(i, 1);
                return;
            }
        }
    },
    _fireEvent: function(type, msg) {
        for (var i = 0; i < this._listeners.length; i++) {
            var logFunction = this._listeners[i][type];
            if (logFunction) {
                logFunction(msg);
            }
        }
    },
    _listeners: []
};

},{}],39:[function(require,module,exports){
var LessError = require('./less-error'),
    transformTree = require("./transform-tree"),
    logger = require("./logger");

module.exports = function(SourceMapBuilder) {
    var ParseTree = function(root, imports) {
        this.root = root;
        this.imports = imports;
    };

    ParseTree.prototype.toCSS = function(options) {
        var evaldRoot, result = {}, sourceMapBuilder;
        try {
            evaldRoot = transformTree(this.root, options);
        } catch (e) {
            throw new LessError(e, this.imports);
        }

        try {
            var compress = Boolean(options.compress);
            if (compress) {
                logger.warn("The compress option has been deprecated. We recommend you use a dedicated css minifier, for instance see less-plugin-clean-css.");
            }

            var toCSSOptions = {
                compress: compress,
                dumpLineNumbers: options.dumpLineNumbers,
                strictUnits: Boolean(options.strictUnits),
                numPrecision: 8};

            if (options.sourceMap) {
                sourceMapBuilder = new SourceMapBuilder(options.sourceMap);
                result.css = sourceMapBuilder.toCSS(evaldRoot, toCSSOptions, this.imports);
            } else {
                result.css = evaldRoot.toCSS(toCSSOptions);
            }
        } catch (e) {
            throw new LessError(e, this.imports);
        }

        if (options.pluginManager) {
            var postProcessors = options.pluginManager.getPostProcessors();
            for (var i = 0; i < postProcessors.length; i++) {
                result.css = postProcessors[i].process(result.css, { sourceMap: sourceMapBuilder, options: options, imports: this.imports });
            }
        }
        if (options.sourceMap) {
            result.map = sourceMapBuilder.getExternalSourceMap();
        }

        result.imports = [];
        for (var file in this.imports.files) {
            if (this.imports.files.hasOwnProperty(file) && file !== this.imports.rootFilename) {
                result.imports.push(file);
            }
        }
        return result;
    };
    return ParseTree;
};

},{"./less-error":37,"./logger":38,"./transform-tree":49}],40:[function(require,module,exports){
var PromiseConstructor,
    contexts = require("./contexts"),
    Parser = require('./parser/parser'),
    PluginManager = require('./plugin-manager');

module.exports = function(environment, ParseTree, ImportManager) {
    var parse = function (input, options, callback) {
        options = options || {};

        if (typeof options === 'function') {
            callback = options;
            options = {};
        }

        if (!callback) {
            if (!PromiseConstructor) {
                PromiseConstructor = typeof Promise === 'undefined' ? require('promise') : Promise;
            }
            var self = this;
            return new PromiseConstructor(function (resolve, reject) {
                parse.call(self, input, options, function(err, output) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(output);
                    }
                });
            });
        } else {
            var context,
                rootFileInfo,
                pluginManager = new PluginManager(this);

            pluginManager.addPlugins(options.plugins);
            options.pluginManager = pluginManager;

            context = new contexts.Parse(options);

            if (options.rootFileInfo) {
                rootFileInfo = options.rootFileInfo;
            } else {
                var filename = options.filename || "input";
                var entryPath = filename.replace(/[^\/\\]*$/, "");
                rootFileInfo = {
                    filename: filename,
                    relativeUrls: context.relativeUrls,
                    rootpath: context.rootpath || "",
                    currentDirectory: entryPath,
                    entryPath: entryPath,
                    rootFilename: filename
                };
                // add in a missing trailing slash
                if (rootFileInfo.rootpath && rootFileInfo.rootpath.slice(-1) !== "/") {
                    rootFileInfo.rootpath += "/";
                }
            }

            var imports = new ImportManager(context, rootFileInfo);

            new Parser(context, imports, rootFileInfo)
                .parse(input, function (e, root) {
                if (e) { return callback(e); }
                callback(null, root, imports, options);
            }, options);
        }
    };
    return parse;
};

},{"./contexts":16,"./parser/parser":43,"./plugin-manager":44,"promise":97}],41:[function(require,module,exports){
// Split the input into chunks.
module.exports = function (input, fail) {
    var len = input.length, level = 0, parenLevel = 0,
        lastOpening, lastOpeningParen, lastMultiComment, lastMultiCommentEndBrace,
        chunks = [], emitFrom = 0,
        chunkerCurrentIndex, currentChunkStartIndex, cc, cc2, matched;

    function emitChunk(force) {
        var len = chunkerCurrentIndex - emitFrom;
        if (((len < 512) && !force) || !len) {
            return;
        }
        chunks.push(input.slice(emitFrom, chunkerCurrentIndex + 1));
        emitFrom = chunkerCurrentIndex + 1;
    }

    for (chunkerCurrentIndex = 0; chunkerCurrentIndex < len; chunkerCurrentIndex++) {
        cc = input.charCodeAt(chunkerCurrentIndex);
        if (((cc >= 97) && (cc <= 122)) || (cc < 34)) {
            // a-z or whitespace
            continue;
        }

        switch (cc) {
            case 40:                        // (
                parenLevel++;
                lastOpeningParen = chunkerCurrentIndex;
                continue;
            case 41:                        // )
                if (--parenLevel < 0) {
                    return fail("missing opening `(`", chunkerCurrentIndex);
                }
                continue;
            case 59:                        // ;
                if (!parenLevel) { emitChunk(); }
                continue;
            case 123:                       // {
                level++;
                lastOpening = chunkerCurrentIndex;
                continue;
            case 125:                       // }
                if (--level < 0) {
                    return fail("missing opening `{`", chunkerCurrentIndex);
                }
                if (!level && !parenLevel) { emitChunk(); }
                continue;
            case 92:                        // \
                if (chunkerCurrentIndex < len - 1) { chunkerCurrentIndex++; continue; }
                return fail("unescaped `\\`", chunkerCurrentIndex);
            case 34:
            case 39:
            case 96:                        // ", ' and `
                matched = 0;
                currentChunkStartIndex = chunkerCurrentIndex;
                for (chunkerCurrentIndex = chunkerCurrentIndex + 1; chunkerCurrentIndex < len; chunkerCurrentIndex++) {
                    cc2 = input.charCodeAt(chunkerCurrentIndex);
                    if (cc2 > 96) { continue; }
                    if (cc2 == cc) { matched = 1; break; }
                    if (cc2 == 92) {        // \
                        if (chunkerCurrentIndex == len - 1) {
                            return fail("unescaped `\\`", chunkerCurrentIndex);
                        }
                        chunkerCurrentIndex++;
                    }
                }
                if (matched) { continue; }
                return fail("unmatched `" + String.fromCharCode(cc) + "`", currentChunkStartIndex);
            case 47:                        // /, check for comment
                if (parenLevel || (chunkerCurrentIndex == len - 1)) { continue; }
                cc2 = input.charCodeAt(chunkerCurrentIndex + 1);
                if (cc2 == 47) {
                    // //, find lnfeed
                    for (chunkerCurrentIndex = chunkerCurrentIndex + 2; chunkerCurrentIndex < len; chunkerCurrentIndex++) {
                        cc2 = input.charCodeAt(chunkerCurrentIndex);
                        if ((cc2 <= 13) && ((cc2 == 10) || (cc2 == 13))) { break; }
                    }
                } else if (cc2 == 42) {
                    // /*, find */
                    lastMultiComment = currentChunkStartIndex = chunkerCurrentIndex;
                    for (chunkerCurrentIndex = chunkerCurrentIndex + 2; chunkerCurrentIndex < len - 1; chunkerCurrentIndex++) {
                        cc2 = input.charCodeAt(chunkerCurrentIndex);
                        if (cc2 == 125) { lastMultiCommentEndBrace = chunkerCurrentIndex; }
                        if (cc2 != 42) { continue; }
                        if (input.charCodeAt(chunkerCurrentIndex + 1) == 47) { break; }
                    }
                    if (chunkerCurrentIndex == len - 1) {
                        return fail("missing closing `*/`", currentChunkStartIndex);
                    }
                    chunkerCurrentIndex++;
                }
                continue;
            case 42:                       // *, check for unmatched */
                if ((chunkerCurrentIndex < len - 1) && (input.charCodeAt(chunkerCurrentIndex + 1) == 47)) {
                    return fail("unmatched `/*`", chunkerCurrentIndex);
                }
                continue;
        }
    }

    if (level !== 0) {
        if ((lastMultiComment > lastOpening) && (lastMultiCommentEndBrace > lastMultiComment)) {
            return fail("missing closing `}` or `*/`", lastOpening);
        } else {
            return fail("missing closing `}`", lastOpening);
        }
    } else if (parenLevel !== 0) {
        return fail("missing closing `)`", lastOpeningParen);
    }

    emitChunk(true);
    return chunks;
};

},{}],42:[function(require,module,exports){
var chunker = require('./chunker');

module.exports = function() {
    var input,       // LeSS input string
        j,           // current chunk
        saveStack = [],   // holds state for backtracking
        furthest,    // furthest index the parser has gone to
        furthestPossibleErrorMessage,// if this is furthest we got to, this is the probably cause
        chunks,      // chunkified input
        current,     // current chunk
        currentPos,  // index of current chunk, in `input`
        parserInput = {};

    var CHARCODE_SPACE = 32,
        CHARCODE_TAB = 9,
        CHARCODE_LF = 10,
        CHARCODE_CR = 13,
        CHARCODE_PLUS = 43,
        CHARCODE_COMMA = 44,
        CHARCODE_FORWARD_SLASH = 47,
        CHARCODE_9 = 57;

    function skipWhitespace(length) {
        var oldi = parserInput.i, oldj = j,
            curr = parserInput.i - currentPos,
            endIndex = parserInput.i + current.length - curr,
            mem = (parserInput.i += length),
            inp = input,
            c, nextChar, comment;

        for (; parserInput.i < endIndex; parserInput.i++) {
            c = inp.charCodeAt(parserInput.i);

            if (parserInput.autoCommentAbsorb && c === CHARCODE_FORWARD_SLASH) {
                nextChar = inp.charAt(parserInput.i + 1);
                if (nextChar === '/') {
                    comment = {index: parserInput.i, isLineComment: true};
                    var nextNewLine = inp.indexOf("\n", parserInput.i + 2);
                    if (nextNewLine < 0) {
                        nextNewLine = endIndex;
                    }
                    parserInput.i = nextNewLine;
                    comment.text = inp.substr(comment.index, parserInput.i - comment.index);
                    parserInput.commentStore.push(comment);
                    continue;
                } else if (nextChar === '*') {
                    var nextStarSlash = inp.indexOf("*/", parserInput.i + 2);
                    if (nextStarSlash >= 0) {
                        comment = {
                            index: parserInput.i,
                            text: inp.substr(parserInput.i, nextStarSlash + 2 - parserInput.i),
                            isLineComment: false
                        };
                        parserInput.i += comment.text.length - 1;
                        parserInput.commentStore.push(comment);
                        continue;
                    }
                }
                break;
            }

            if ((c !== CHARCODE_SPACE) && (c !== CHARCODE_LF) && (c !== CHARCODE_TAB) && (c !== CHARCODE_CR)) {
                break;
            }
        }

        current = current.slice(length + parserInput.i - mem + curr);
        currentPos = parserInput.i;

        if (!current.length) {
            if (j < chunks.length - 1) {
                current = chunks[++j];
                skipWhitespace(0); // skip space at the beginning of a chunk
                return true; // things changed
            }
            parserInput.finished = true;
        }

        return oldi !== parserInput.i || oldj !== j;
    }

    parserInput.save = function() {
        currentPos = parserInput.i;
        saveStack.push( { current: current, i: parserInput.i, j: j });
    };
    parserInput.restore = function(possibleErrorMessage) {

        if (parserInput.i > furthest || (parserInput.i === furthest && possibleErrorMessage && !furthestPossibleErrorMessage)) {
            furthest = parserInput.i;
            furthestPossibleErrorMessage = possibleErrorMessage;
        }
        var state = saveStack.pop();
        current = state.current;
        currentPos = parserInput.i = state.i;
        j = state.j;
    };
    parserInput.forget = function() {
        saveStack.pop();
    };
    parserInput.isWhitespace = function (offset) {
        var pos = parserInput.i + (offset || 0),
            code = input.charCodeAt(pos);
        return (code === CHARCODE_SPACE || code === CHARCODE_CR || code === CHARCODE_TAB || code === CHARCODE_LF);
    };

    // Specialization of $(tok)
    parserInput.$re = function(tok) {
        if (parserInput.i > currentPos) {
            current = current.slice(parserInput.i - currentPos);
            currentPos = parserInput.i;
        }

        var m = tok.exec(current);
        if (!m) {
            return null;
        }

        skipWhitespace(m[0].length);
        if (typeof m === "string") {
            return m;
        }

        return m.length === 1 ? m[0] : m;
    };

    parserInput.$char = function(tok) {
        if (input.charAt(parserInput.i) !== tok) {
            return null;
        }
        skipWhitespace(1);
        return tok;
    };

    parserInput.$str = function(tok) {
        var tokLength = tok.length;

        // https://jsperf.com/string-startswith/21
        for (var i = 0; i < tokLength; i++) {
            if (input.charAt(parserInput.i + i) !== tok.charAt(i)) {
                return null;
            }
        }

        skipWhitespace(tokLength);
        return tok;
    };

    parserInput.$quoted = function() {

        var startChar = input.charAt(parserInput.i);
        if (startChar !== "'" && startChar !== '"') {
            return;
        }
        var length = input.length,
            currentPosition = parserInput.i;

        for (var i = 1; i + currentPosition < length; i++) {
            var nextChar = input.charAt(i + currentPosition);
            switch(nextChar) {
                case "\\":
                    i++;
                    continue;
                case "\r":
                case "\n":
                    break;
                case startChar:
                    var str = input.substr(currentPosition, i + 1);
                    skipWhitespace(i + 1);
                    return str;
                default:
            }
        }
        return null;
    };

    parserInput.autoCommentAbsorb = true;
    parserInput.commentStore = [];
    parserInput.finished = false;

    // Same as $(), but don't change the state of the parser,
    // just return the match.
    parserInput.peek = function(tok) {
        if (typeof tok === 'string') {
            // https://jsperf.com/string-startswith/21
            for (var i = 0; i < tok.length; i++) {
                if (input.charAt(parserInput.i + i) !== tok.charAt(i)) {
                    return false;
                }
            }
            return true;
        } else {
            return tok.test(current);
        }
    };

    // Specialization of peek()
    // TODO remove or change some currentChar calls to peekChar
    parserInput.peekChar = function(tok) {
        return input.charAt(parserInput.i) === tok;
    };

    parserInput.currentChar = function() {
        return input.charAt(parserInput.i);
    };

    parserInput.getInput = function() {
        return input;
    };

    parserInput.peekNotNumeric = function() {
        var c = input.charCodeAt(parserInput.i);
        //Is the first char of the dimension 0-9, '.', '+' or '-'
        return (c > CHARCODE_9 || c < CHARCODE_PLUS) || c === CHARCODE_FORWARD_SLASH || c === CHARCODE_COMMA;
    };

    parserInput.start = function(str, chunkInput, failFunction) {
        input = str;
        parserInput.i = j = currentPos = furthest = 0;

        // chunking apparently makes things quicker (but my tests indicate
        // it might actually make things slower in node at least)
        // and it is a non-perfect parse - it can't recognise
        // unquoted urls, meaning it can't distinguish comments
        // meaning comments with quotes or {}() in them get 'counted'
        // and then lead to parse errors.
        // In addition if the chunking chunks in the wrong place we might
        // not be able to parse a parser statement in one go
        // this is officially deprecated but can be switched on via an option
        // in the case it causes too much performance issues.
        if (chunkInput) {
            chunks = chunker(str, failFunction);
        } else {
            chunks = [str];
        }

        current = chunks[0];

        skipWhitespace(0);
    };

    parserInput.end = function() {
        var message,
            isFinished = parserInput.i >= input.length;

        if (parserInput.i < furthest) {
            message = furthestPossibleErrorMessage;
            parserInput.i = furthest;
        }
        return {
            isFinished: isFinished,
            furthest: parserInput.i,
            furthestPossibleErrorMessage: message,
            furthestReachedEnd: parserInput.i >= input.length - 1,
            furthestChar: input[parserInput.i]
        };
    };

    return parserInput;
};

},{"./chunker":41}],43:[function(require,module,exports){
var LessError = require('../less-error'),
    tree = require("../tree"),
    visitors = require("../visitors"),
    getParserInput = require("./parser-input"),
    utils = require("../utils");

//
// less.js - parser
//
//    A relatively straight-forward predictive parser.
//    There is no tokenization/lexing stage, the input is parsed
//    in one sweep.
//
//    To make the parser fast enough to run in the browser, several
//    optimization had to be made:
//
//    - Matching and slicing on a huge input is often cause of slowdowns.
//      The solution is to chunkify the input into smaller strings.
//      The chunks are stored in the `chunks` var,
//      `j` holds the current chunk index, and `currentPos` holds
//      the index of the current chunk in relation to `input`.
//      This gives us an almost 4x speed-up.
//
//    - In many cases, we don't need to match individual tokens;
//      for example, if a value doesn't hold any variables, operations
//      or dynamic references, the parser can effectively 'skip' it,
//      treating it as a literal.
//      An example would be '1px solid #000' - which evaluates to itself,
//      we don't need to know what the individual components are.
//      The drawback, of course is that you don't get the benefits of
//      syntax-checking on the CSS. This gives us a 50% speed-up in the parser,
//      and a smaller speed-up in the code-gen.
//
//
//    Token matching is done with the `$` function, which either takes
//    a terminal string or regexp, or a non-terminal function to call.
//    It also takes care of moving all the indices forwards.
//`
//
var Parser = function Parser(context, imports, fileInfo) {
    var parsers,
        parserInput = getParserInput();

    function error(msg, type) {
        throw new LessError(
            {
                index: parserInput.i,
                filename: fileInfo.filename,
                type: type || 'Syntax',
                message: msg
            },
            imports
        );
    }

    function expect(arg, msg, index) {
        // some older browsers return typeof 'function' for RegExp
        var result = (arg instanceof Function) ? arg.call(parsers) : parserInput.$re(arg);
        if (result) {
            return result;
        }
        error(msg || (typeof arg === 'string' ? "expected '" + arg + "' got '" + parserInput.currentChar() + "'"
                                               : "unexpected token"));
    }

    // Specialization of expect()
    function expectChar(arg, msg) {
        if (parserInput.$char(arg)) {
            return arg;
        }
        error(msg || "expected '" + arg + "' got '" + parserInput.currentChar() + "'");
    }

    function getDebugInfo(index) {
        var filename = fileInfo.filename;

        return {
            lineNumber: utils.getLocation(index, parserInput.getInput()).line + 1,
            fileName: filename
        };
    }

    //
    // The Parser
    //
    return {

        //
        // Parse an input string into an abstract syntax tree,
        // @param str A string containing 'less' markup
        // @param callback call `callback` when done.
        // @param [additionalData] An optional map which can contains vars - a map (key, value) of variables to apply
        //
        parse: function (str, callback, additionalData) {
            var root, error = null, globalVars, modifyVars, ignored, preText = "";

            globalVars = (additionalData && additionalData.globalVars) ? Parser.serializeVars(additionalData.globalVars) + '\n' : '';
            modifyVars = (additionalData && additionalData.modifyVars) ? '\n' + Parser.serializeVars(additionalData.modifyVars) : '';

            if (context.pluginManager) {
                var preProcessors = context.pluginManager.getPreProcessors();
                for (var i = 0; i < preProcessors.length; i++) {
                    str = preProcessors[i].process(str, { context: context, imports: imports, fileInfo: fileInfo });
                }
            }

            if (globalVars || (additionalData && additionalData.banner)) {
                preText = ((additionalData && additionalData.banner) ? additionalData.banner : "") + globalVars;
                ignored = imports.contentsIgnoredChars;
                ignored[fileInfo.filename] = ignored[fileInfo.filename] || 0;
                ignored[fileInfo.filename] += preText.length;
            }

            str = str.replace(/\r\n?/g, '\n');
            // Remove potential UTF Byte Order Mark
            str = preText + str.replace(/^\uFEFF/, '') + modifyVars;
            imports.contents[fileInfo.filename] = str;

            // Start with the primary rule.
            // The whole syntax tree is held under a Ruleset node,
            // with the `root` property set to true, so no `{}` are
            // output. The callback is called when the input is parsed.
            try {
                parserInput.start(str, context.chunkInput, function fail(msg, index) {
                    throw new LessError({
                        index: index,
                        type: 'Parse',
                        message: msg,
                        filename: fileInfo.filename
                    }, imports);
                });

                root = new(tree.Ruleset)(null, this.parsers.primary());
                root.root = true;
                root.firstRoot = true;
            } catch (e) {
                return callback(new LessError(e, imports, fileInfo.filename));
            }

            // If `i` is smaller than the `input.length - 1`,
            // it means the parser wasn't able to parse the whole
            // string, so we've got a parsing error.
            //
            // We try to extract a \n delimited string,
            // showing the line where the parse error occurred.
            // We split it up into two parts (the part which parsed,
            // and the part which didn't), so we can color them differently.
            var endInfo = parserInput.end();
            if (!endInfo.isFinished) {

                var message = endInfo.furthestPossibleErrorMessage;

                if (!message) {
                    message = "Unrecognised input";
                    if (endInfo.furthestChar === '}') {
                        message += ". Possibly missing opening '{'";
                    } else if (endInfo.furthestChar === ')') {
                        message += ". Possibly missing opening '('";
                    } else if (endInfo.furthestReachedEnd) {
                        message += ". Possibly missing something";
                    }
                }

                error = new LessError({
                    type: "Parse",
                    message: message,
                    index: endInfo.furthest,
                    filename: fileInfo.filename
                }, imports);
            }

            var finish = function (e) {
                e = error || e || imports.error;

                if (e) {
                    if (!(e instanceof LessError)) {
                        e = new LessError(e, imports, fileInfo.filename);
                    }

                    return callback(e);
                }
                else {
                    return callback(null, root);
                }
            };

            if (context.processImports !== false) {
                new visitors.ImportVisitor(imports, finish)
                    .run(root);
            } else {
                return finish();
            }
        },

        //
        // Here in, the parsing rules/functions
        //
        // The basic structure of the syntax tree generated is as follows:
        //
        //   Ruleset ->  Rule -> Value -> Expression -> Entity
        //
        // Here's some Less code:
        //
        //    .class {
        //      color: #fff;
        //      border: 1px solid #000;
        //      width: @w + 4px;
        //      > .child {...}
        //    }
        //
        // And here's what the parse tree might look like:
        //
        //     Ruleset (Selector '.class', [
        //         Rule ("color",  Value ([Expression [Color #fff]]))
        //         Rule ("border", Value ([Expression [Dimension 1px][Keyword "solid"][Color #000]]))
        //         Rule ("width",  Value ([Expression [Operation " + " [Variable "@w"][Dimension 4px]]]))
        //         Ruleset (Selector [Element '>', '.child'], [...])
        //     ])
        //
        //  In general, most rules will try to parse a token with the `$re()` function, and if the return
        //  value is truly, will return a new node, of the relevant type. Sometimes, we need to check
        //  first, before parsing, that's when we use `peek()`.
        //
        parsers: parsers = {
            //
            // The `primary` rule is the *entry* and *exit* point of the parser.
            // The rules here can appear at any level of the parse tree.
            //
            // The recursive nature of the grammar is an interplay between the `block`
            // rule, which represents `{ ... }`, the `ruleset` rule, and this `primary` rule,
            // as represented by this simplified grammar:
            //
            //     primary  →  (ruleset | rule)+
            //     ruleset  →  selector+ block
            //     block    →  '{' primary '}'
            //
            // Only at one point is the primary rule not called from the
            // block rule: at the root level.
            //
            primary: function () {
                var mixin = this.mixin, root = [], node;

                while (true) {
                    while (true) {
                        node = this.comment();
                        if (!node) { break; }
                        root.push(node);
                    }
                    // always process comments before deciding if finished
                    if (parserInput.finished) {
                        break;
                    }
                    if (parserInput.peek('}')) {
                        break;
                    }

                    node = this.extendRule();
                    if (node) {
                        root = root.concat(node);
                        continue;
                    }

                    node = mixin.definition() || this.rule() || this.ruleset() ||
                        mixin.call() || this.rulesetCall() || this.entities.call() || this.directive();
                    if (node) {
                        root.push(node);
                    } else {
                        var foundSemiColon = false;
                        while (parserInput.$char(";")) {
                            foundSemiColon = true;
                        }
                        if (!foundSemiColon) {
                            break;
                        }
                    }
                }

                return root;
            },

            // comments are collected by the main parsing mechanism and then assigned to nodes
            // where the current structure allows it
            comment: function () {
                if (parserInput.commentStore.length) {
                    var comment = parserInput.commentStore.shift();
                    return new(tree.Comment)(comment.text, comment.isLineComment, comment.index, fileInfo);
                }
            },

            //
            // Entities are tokens which can be found inside an Expression
            //
            entities: {
                //
                // A string, which supports escaping " and '
                //
                //     "milky way" 'he\'s the one!'
                //
                quoted: function () {
                    var str, index = parserInput.i, isEscaped = false;

                    parserInput.save();
                    if (parserInput.$char("~")) {
                        isEscaped = true;
                    }
                    str = parserInput.$quoted();
                    if (!str) {
                        parserInput.restore();
                        return;
                    }
                    parserInput.forget();

                    return new(tree.Quoted)(str.charAt(0), str.substr(1, str.length - 2), isEscaped, index, fileInfo);
                },

                //
                // A catch-all word, such as:
                //
                //     black border-collapse
                //
                keyword: function () {
                    var k = parserInput.$char("%") || parserInput.$re(/^[_A-Za-z-][_A-Za-z0-9-]*/);
                    if (k) {
                        return tree.Color.fromKeyword(k) || new(tree.Keyword)(k);
                    }
                },

                //
                // A function call
                //
                //     rgb(255, 0, 255)
                //
                // We also try to catch IE's `alpha()`, but let the `alpha` parser
                // deal with the details.
                //
                // The arguments are parsed with the `entities.arguments` parser.
                //
                call: function () {
                    var name, nameLC, args, alpha, index = parserInput.i;

                    // http://jsperf.com/case-insensitive-regex-vs-strtolower-then-regex/18
                    if (parserInput.peek(/^url\(/i)) {
                        return;
                    }

                    parserInput.save();

                    name = parserInput.$re(/^([\w-]+|%|progid:[\w\.]+)\(/);
                    if (!name) { parserInput.forget(); return; }

                    name = name[1];
                    nameLC = name.toLowerCase();

                    if (nameLC === 'alpha') {
                        alpha = parsers.alpha();
                        if (alpha) {
                            parserInput.forget();
                            return alpha;
                        }
                    }

                    args = this.arguments();

                    if (! parserInput.$char(')')) {
                        parserInput.restore("Could not parse call arguments or missing ')'");
                        return;
                    }

                    parserInput.forget();
                    return new(tree.Call)(name, args, index, fileInfo);
                },
                arguments: function () {
                    var argsSemiColon = [], argsComma = [],
                        expressions = [],
                        isSemiColonSeparated, value, arg;

                    parserInput.save();

                    while (true) {

                        arg = parsers.detachedRuleset() || this.assignment() || parsers.expression();

                        if (!arg) {
                            break;
                        }

                        value = arg;

                        if (arg.value && arg.value.length == 1) {
                            value = arg.value[0];
                        }

                        if (value) {
                            expressions.push(value);
                        }

                        argsComma.push(value);

                        if (parserInput.$char(',')) {
                            continue;
                        }

                        if (parserInput.$char(';') || isSemiColonSeparated) {

                            isSemiColonSeparated = true;

                            if (expressions.length > 1) {
                                value = new(tree.Value)(expressions);
                            }
                            argsSemiColon.push(value);

                            expressions = [];
                        }
                    }

                    parserInput.forget();
                    return isSemiColonSeparated ? argsSemiColon : argsComma;
                },
                literal: function () {
                    return this.dimension() ||
                           this.color() ||
                           this.quoted() ||
                           this.unicodeDescriptor();
                },

                // Assignments are argument entities for calls.
                // They are present in ie filter properties as shown below.
                //
                //     filter: progid:DXImageTransform.Microsoft.Alpha( *opacity=50* )
                //

                assignment: function () {
                    var key, value;
                    parserInput.save();
                    key = parserInput.$re(/^\w+(?=\s?=)/i);
                    if (!key) {
                        parserInput.restore();
                        return;
                    }
                    if (!parserInput.$char('=')) {
                        parserInput.restore();
                        return;
                    }
                    value = parsers.entity();
                    if (value) {
                        parserInput.forget();
                        return new(tree.Assignment)(key, value);
                    } else {
                        parserInput.restore();
                    }
                },

                //
                // Parse url() tokens
                //
                // We use a specific rule for urls, because they don't really behave like
                // standard function calls. The difference is that the argument doesn't have
                // to be enclosed within a string, so it can't be parsed as an Expression.
                //
                url: function () {
                    var value, index = parserInput.i;

                    parserInput.autoCommentAbsorb = false;

                    if (!parserInput.$str("url(")) {
                        parserInput.autoCommentAbsorb = true;
                        return;
                    }

                    value = this.quoted() || this.variable() ||
                            parserInput.$re(/^(?:(?:\\[\(\)'"])|[^\(\)'"])+/) || "";

                    parserInput.autoCommentAbsorb = true;

                    expectChar(')');

                    return new(tree.URL)((value.value != null || value instanceof tree.Variable) ?
                                        value : new(tree.Anonymous)(value), index, fileInfo);
                },

                //
                // A Variable entity, such as `@fink`, in
                //
                //     width: @fink + 2px
                //
                // We use a different parser for variable definitions,
                // see `parsers.variable`.
                //
                variable: function () {
                    var name, index = parserInput.i;

                    if (parserInput.currentChar() === '@' && (name = parserInput.$re(/^@@?[\w-]+/))) {
                        return new(tree.Variable)(name, index, fileInfo);
                    }
                },

                // A variable entity using the protective {} e.g. @{var}
                variableCurly: function () {
                    var curly, index = parserInput.i;

                    if (parserInput.currentChar() === '@' && (curly = parserInput.$re(/^@\{([\w-]+)\}/))) {
                        return new(tree.Variable)("@" + curly[1], index, fileInfo);
                    }
                },

                //
                // A Hexadecimal color
                //
                //     #4F3C2F
                //
                // `rgb` and `hsl` colors are parsed through the `entities.call` parser.
                //
                color: function () {
                    var rgb;

                    if (parserInput.currentChar() === '#' && (rgb = parserInput.$re(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})/))) {
                        // strip colons, brackets, whitespaces and other characters that should not
                        // definitely be part of color string
                        var colorCandidateString = rgb.input.match(/^#([\w]+).*/);
                        colorCandidateString = colorCandidateString[1];
                        if (!colorCandidateString.match(/^[A-Fa-f0-9]+$/)) { // verify if candidate consists only of allowed HEX characters
                            error("Invalid HEX color code");
                        }
                        return new(tree.Color)(rgb[1], undefined, '#' + colorCandidateString);
                    }
                },

                colorKeyword: function () {
                    parserInput.save();
                    var autoCommentAbsorb = parserInput.autoCommentAbsorb;
                    parserInput.autoCommentAbsorb = false;
                    var k = parserInput.$re(/^[_A-Za-z-][_A-Za-z0-9-]+/);
                    parserInput.autoCommentAbsorb = autoCommentAbsorb;
                    if (!k) {
                        parserInput.forget();
                        return;
                    }
                    parserInput.restore();
                    var color = tree.Color.fromKeyword(k);
                    if (color) {
                        parserInput.$str(k);
                        return color;
                    }
                },

                //
                // A Dimension, that is, a number and a unit
                //
                //     0.5em 95%
                //
                dimension: function () {
                    if (parserInput.peekNotNumeric()) {
                        return;
                    }

                    var value = parserInput.$re(/^([+-]?\d*\.?\d+)(%|[a-z_]+)?/i);
                    if (value) {
                        return new(tree.Dimension)(value[1], value[2]);
                    }
                },

                //
                // A unicode descriptor, as is used in unicode-range
                //
                // U+0??  or U+00A1-00A9
                //
                unicodeDescriptor: function () {
                    var ud;

                    ud = parserInput.$re(/^U\+[0-9a-fA-F?]+(\-[0-9a-fA-F?]+)?/);
                    if (ud) {
                        return new(tree.UnicodeDescriptor)(ud[0]);
                    }
                },

                //
                // JavaScript code to be evaluated
                //
                //     `window.location.href`
                //
                javascript: function () {
                    var js, index = parserInput.i;

                    parserInput.save();

                    var escape = parserInput.$char("~");
                    var jsQuote = parserInput.$char("`");

                    if (!jsQuote) {
                        parserInput.restore();
                        return;
                    }

                    js = parserInput.$re(/^[^`]*`/);
                    if (js) {
                        parserInput.forget();
                        return new(tree.JavaScript)(js.substr(0, js.length - 1), Boolean(escape), index, fileInfo);
                    }
                    parserInput.restore("invalid javascript definition");
                }
            },

            //
            // The variable part of a variable definition. Used in the `rule` parser
            //
            //     @fink:
            //
            variable: function () {
                var name;

                if (parserInput.currentChar() === '@' && (name = parserInput.$re(/^(@[\w-]+)\s*:/))) { return name[1]; }
            },

            //
            // The variable part of a variable definition. Used in the `rule` parser
            //
            //     @fink();
            //
            rulesetCall: function () {
                var name;

                if (parserInput.currentChar() === '@' && (name = parserInput.$re(/^(@[\w-]+)\(\s*\)\s*;/))) {
                    return new tree.RulesetCall(name[1]);
                }
            },

            //
            // extend syntax - used to extend selectors
            //
            extend: function(isRule) {
                var elements, e, index = parserInput.i, option, extendList, extend;

                if (!parserInput.$str(isRule ? "&:extend(" : ":extend(")) {
                    return;
                }

                do {
                    option = null;
                    elements = null;
                    while (! (option = parserInput.$re(/^(all)(?=\s*(\)|,))/))) {
                        e = this.element();
                        if (!e) {
                            break;
                        }
                        if (elements) {
                            elements.push(e);
                        } else {
                            elements = [ e ];
                        }
                    }

                    option = option && option[1];
                    if (!elements) {
                        error("Missing target selector for :extend().");
                    }
                    extend = new(tree.Extend)(new(tree.Selector)(elements), option, index, fileInfo);
                    if (extendList) {
                        extendList.push(extend);
                    } else {
                        extendList = [ extend ];
                    }
                } while (parserInput.$char(","));

                expect(/^\)/);

                if (isRule) {
                    expect(/^;/);
                }

                return extendList;
            },

            //
            // extendRule - used in a rule to extend all the parent selectors
            //
            extendRule: function() {
                return this.extend(true);
            },

            //
            // Mixins
            //
            mixin: {
                //
                // A Mixin call, with an optional argument list
                //
                //     #mixins > .square(#fff);
                //     .rounded(4px, black);
                //     .button;
                //
                // The `while` loop is there because mixins can be
                // namespaced, but we only support the child and descendant
                // selector for now.
                //
                call: function () {
                    var s = parserInput.currentChar(), important = false, index = parserInput.i, elemIndex,
                        elements, elem, e, c, args;

                    if (s !== '.' && s !== '#') { return; }

                    parserInput.save(); // stop us absorbing part of an invalid selector

                    while (true) {
                        elemIndex = parserInput.i;
                        e = parserInput.$re(/^[#.](?:[\w-]|\\(?:[A-Fa-f0-9]{1,6} ?|[^A-Fa-f0-9]))+/);
                        if (!e) {
                            break;
                        }
                        elem = new(tree.Element)(c, e, elemIndex, fileInfo);
                        if (elements) {
                            elements.push(elem);
                        } else {
                            elements = [ elem ];
                        }
                        c = parserInput.$char('>');
                    }

                    if (elements) {
                        if (parserInput.$char('(')) {
                            args = this.args(true).args;
                            expectChar(')');
                        }

                        if (parsers.important()) {
                            important = true;
                        }

                        if (parsers.end()) {
                            parserInput.forget();
                            return new(tree.mixin.Call)(elements, args, index, fileInfo, important);
                        }
                    }

                    parserInput.restore();
                },
                args: function (isCall) {
                    var entities = parsers.entities,
                        returner = { args:null, variadic: false },
                        expressions = [], argsSemiColon = [], argsComma = [],
                        isSemiColonSeparated, expressionContainsNamed, name, nameLoop,
                        value, arg, expand;

                    parserInput.save();

                    while (true) {
                        if (isCall) {
                            arg = parsers.detachedRuleset() || parsers.expression();
                        } else {
                            parserInput.commentStore.length = 0;
                            if (parserInput.$str("...")) {
                                returner.variadic = true;
                                if (parserInput.$char(";") && !isSemiColonSeparated) {
                                    isSemiColonSeparated = true;
                                }
                                (isSemiColonSeparated ? argsSemiColon : argsComma)
                                    .push({ variadic: true });
                                break;
                            }
                            arg = entities.variable() || entities.literal() || entities.keyword();
                        }

                        if (!arg) {
                            break;
                        }

                        nameLoop = null;
                        if (arg.throwAwayComments) {
                            arg.throwAwayComments();
                        }
                        value = arg;
                        var val = null;

                        if (isCall) {
                            // Variable
                            if (arg.value && arg.value.length == 1) {
                                val = arg.value[0];
                            }
                        } else {
                            val = arg;
                        }

                        if (val && val instanceof tree.Variable) {
                            if (parserInput.$char(':')) {
                                if (expressions.length > 0) {
                                    if (isSemiColonSeparated) {
                                        error("Cannot mix ; and , as delimiter types");
                                    }
                                    expressionContainsNamed = true;
                                }

                                value = parsers.detachedRuleset() || parsers.expression();

                                if (!value) {
                                    if (isCall) {
                                        error("could not understand value for named argument");
                                    } else {
                                        parserInput.restore();
                                        returner.args = [];
                                        return returner;
                                    }
                                }
                                nameLoop = (name = val.name);
                            } else if (parserInput.$str("...")) {
                                if (!isCall) {
                                    returner.variadic = true;
                                    if (parserInput.$char(";") && !isSemiColonSeparated) {
                                        isSemiColonSeparated = true;
                                    }
                                    (isSemiColonSeparated ? argsSemiColon : argsComma)
                                        .push({ name: arg.name, variadic: true });
                                    break;
                                } else {
                                    expand = true;
                                }
                            } else if (!isCall) {
                                name = nameLoop = val.name;
                                value = null;
                            }
                        }

                        if (value) {
                            expressions.push(value);
                        }

                        argsComma.push({ name:nameLoop, value:value, expand:expand });

                        if (parserInput.$char(',')) {
                            continue;
                        }

                        if (parserInput.$char(';') || isSemiColonSeparated) {

                            if (expressionContainsNamed) {
                                error("Cannot mix ; and , as delimiter types");
                            }

                            isSemiColonSeparated = true;

                            if (expressions.length > 1) {
                                value = new(tree.Value)(expressions);
                            }
                            argsSemiColon.push({ name:name, value:value, expand:expand });

                            name = null;
                            expressions = [];
                            expressionContainsNamed = false;
                        }
                    }

                    parserInput.forget();
                    returner.args = isSemiColonSeparated ? argsSemiColon : argsComma;
                    return returner;
                },
                //
                // A Mixin definition, with a list of parameters
                //
                //     .rounded (@radius: 2px, @color) {
                //        ...
                //     }
                //
                // Until we have a finer grained state-machine, we have to
                // do a look-ahead, to make sure we don't have a mixin call.
                // See the `rule` function for more information.
                //
                // We start by matching `.rounded (`, and then proceed on to
                // the argument list, which has optional default values.
                // We store the parameters in `params`, with a `value` key,
                // if there is a value, such as in the case of `@radius`.
                //
                // Once we've got our params list, and a closing `)`, we parse
                // the `{...}` block.
                //
                definition: function () {
                    var name, params = [], match, ruleset, cond, variadic = false;
                    if ((parserInput.currentChar() !== '.' && parserInput.currentChar() !== '#') ||
                        parserInput.peek(/^[^{]*\}/)) {
                        return;
                    }

                    parserInput.save();

                    match = parserInput.$re(/^([#.](?:[\w-]|\\(?:[A-Fa-f0-9]{1,6} ?|[^A-Fa-f0-9]))+)\s*\(/);
                    if (match) {
                        name = match[1];

                        var argInfo = this.args(false);
                        params = argInfo.args;
                        variadic = argInfo.variadic;

                        // .mixincall("@{a}");
                        // looks a bit like a mixin definition..
                        // also
                        // .mixincall(@a: {rule: set;});
                        // so we have to be nice and restore
                        if (!parserInput.$char(')')) {
                            parserInput.restore("Missing closing ')'");
                            return;
                        }

                        parserInput.commentStore.length = 0;

                        if (parserInput.$str("when")) { // Guard
                            cond = expect(parsers.conditions, 'expected condition');
                        }

                        ruleset = parsers.block();

                        if (ruleset) {
                            parserInput.forget();
                            return new(tree.mixin.Definition)(name, params, ruleset, cond, variadic);
                        } else {
                            parserInput.restore();
                        }
                    } else {
                        parserInput.forget();
                    }
                }
            },

            //
            // Entities are the smallest recognized token,
            // and can be found inside a rule's value.
            //
            entity: function () {
                var entities = this.entities;

                return this.comment() || entities.literal() || entities.variable() || entities.url() ||
                       entities.call()    || entities.keyword()  || entities.javascript();
            },

            //
            // A Rule terminator. Note that we use `peek()` to check for '}',
            // because the `block` rule will be expecting it, but we still need to make sure
            // it's there, if ';' was omitted.
            //
            end: function () {
                return parserInput.$char(';') || parserInput.peek('}');
            },

            //
            // IE's alpha function
            //
            //     alpha(opacity=88)
            //
            alpha: function () {
                var value;

                // http://jsperf.com/case-insensitive-regex-vs-strtolower-then-regex/18
                if (! parserInput.$re(/^opacity=/i)) { return; }
                value = parserInput.$re(/^\d+/);
                if (!value) {
                    value = expect(this.entities.variable, "Could not parse alpha");
                }
                expectChar(')');
                return new(tree.Alpha)(value);
            },

            //
            // A Selector Element
            //
            //     div
            //     + h1
            //     #socks
            //     input[type="text"]
            //
            // Elements are the building blocks for Selectors,
            // they are made out of a `Combinator` (see combinator rule),
            // and an element name, such as a tag a class, or `*`.
            //
            element: function () {
                var e, c, v, index = parserInput.i;

                c = this.combinator();

                e = parserInput.$re(/^(?:\d+\.\d+|\d+)%/) ||
                    parserInput.$re(/^(?:[.#]?|:*)(?:[\w-]|[^\x00-\x9f]|\\(?:[A-Fa-f0-9]{1,6} ?|[^A-Fa-f0-9]))+/) ||
                    parserInput.$char('*') || parserInput.$char('&') || this.attribute() ||
                    parserInput.$re(/^\([^&()@]+\)/) ||  parserInput.$re(/^[\.#:](?=@)/) ||
                    this.entities.variableCurly();

                if (! e) {
                    parserInput.save();
                    if (parserInput.$char('(')) {
                        if ((v = this.selector()) && parserInput.$char(')')) {
                            e = new(tree.Paren)(v);
                            parserInput.forget();
                        } else {
                            parserInput.restore("Missing closing ')'");
                        }
                    } else {
                        parserInput.forget();
                    }
                }

                if (e) { return new(tree.Element)(c, e, index, fileInfo); }
            },

            //
            // Combinators combine elements together, in a Selector.
            //
            // Because our parser isn't white-space sensitive, special care
            // has to be taken, when parsing the descendant combinator, ` `,
            // as it's an empty space. We have to check the previous character
            // in the input, to see if it's a ` ` character. More info on how
            // we deal with this in *combinator.js*.
            //
            combinator: function () {
                var c = parserInput.currentChar();

                if (c === '/') {
                    parserInput.save();
                    var slashedCombinator = parserInput.$re(/^\/[a-z]+\//i);
                    if (slashedCombinator) {
                        parserInput.forget();
                        return new(tree.Combinator)(slashedCombinator);
                    }
                    parserInput.restore();
                }

                if (c === '>' || c === '+' || c === '~' || c === '|' || c === '^') {
                    parserInput.i++;
                    if (c === '^' && parserInput.currentChar() === '^') {
                        c = '^^';
                        parserInput.i++;
                    }
                    while (parserInput.isWhitespace()) { parserInput.i++; }
                    return new(tree.Combinator)(c);
                } else if (parserInput.isWhitespace(-1)) {
                    return new(tree.Combinator)(" ");
                } else {
                    return new(tree.Combinator)(null);
                }
            },
            //
            // A CSS selector (see selector below)
            // with less extensions e.g. the ability to extend and guard
            //
            lessSelector: function () {
                return this.selector(true);
            },
            //
            // A CSS Selector
            //
            //     .class > div + h1
            //     li a:hover
            //
            // Selectors are made out of one or more Elements, see above.
            //
            selector: function (isLess) {
                var index = parserInput.i, elements, extendList, c, e, allExtends, when, condition;

                while ((isLess && (extendList = this.extend())) || (isLess && (when = parserInput.$str("when"))) || (e = this.element())) {
                    if (when) {
                        condition = expect(this.conditions, 'expected condition');
                    } else if (condition) {
                        error("CSS guard can only be used at the end of selector");
                    } else if (extendList) {
                        if (allExtends) {
                            allExtends = allExtends.concat(extendList);
                        } else {
                            allExtends = extendList;
                        }
                    } else {
                        if (allExtends) { error("Extend can only be used at the end of selector"); }
                        c = parserInput.currentChar();
                        if (elements) {
                            elements.push(e);
                        } else {
                            elements = [ e ];
                        }
                        e = null;
                    }
                    if (c === '{' || c === '}' || c === ';' || c === ',' || c === ')') {
                        break;
                    }
                }

                if (elements) { return new(tree.Selector)(elements, allExtends, condition, index, fileInfo); }
                if (allExtends) { error("Extend must be used to extend a selector, it cannot be used on its own"); }
            },
            attribute: function () {
                if (! parserInput.$char('[')) { return; }

                var entities = this.entities,
                    key, val, op;

                if (!(key = entities.variableCurly())) {
                    key = expect(/^(?:[_A-Za-z0-9-\*]*\|)?(?:[_A-Za-z0-9-]|\\.)+/);
                }

                op = parserInput.$re(/^[|~*$^]?=/);
                if (op) {
                    val = entities.quoted() || parserInput.$re(/^[0-9]+%/) || parserInput.$re(/^[\w-]+/) || entities.variableCurly();
                }

                expectChar(']');

                return new(tree.Attribute)(key, op, val);
            },

            //
            // The `block` rule is used by `ruleset` and `mixin.definition`.
            // It's a wrapper around the `primary` rule, with added `{}`.
            //
            block: function () {
                var content;
                if (parserInput.$char('{') && (content = this.primary()) && parserInput.$char('}')) {
                    return content;
                }
            },

            blockRuleset: function() {
                var block = this.block();

                if (block) {
                    block = new tree.Ruleset(null, block);
                }
                return block;
            },

            detachedRuleset: function() {
                var blockRuleset = this.blockRuleset();
                if (blockRuleset) {
                    return new tree.DetachedRuleset(blockRuleset);
                }
            },

            //
            // div, .class, body > p {...}
            //
            ruleset: function () {
                var selectors, s, rules, debugInfo;

                parserInput.save();

                if (context.dumpLineNumbers) {
                    debugInfo = getDebugInfo(parserInput.i);
                }

                while (true) {
                    s = this.lessSelector();
                    if (!s) {
                        break;
                    }
                    if (selectors) {
                        selectors.push(s);
                    } else {
                        selectors = [ s ];
                    }
                    parserInput.commentStore.length = 0;
                    if (s.condition && selectors.length > 1) {
                        error("Guards are only currently allowed on a single selector.");
                    }
                    if (! parserInput.$char(',')) { break; }
                    if (s.condition) {
                        error("Guards are only currently allowed on a single selector.");
                    }
                    parserInput.commentStore.length = 0;
                }

                if (selectors && (rules = this.block())) {
                    parserInput.forget();
                    var ruleset = new(tree.Ruleset)(selectors, rules, context.strictImports);
                    if (context.dumpLineNumbers) {
                        ruleset.debugInfo = debugInfo;
                    }
                    return ruleset;
                } else {
                    parserInput.restore();
                }
            },
            rule: function (tryAnonymous) {
                var name, value, startOfRule = parserInput.i, c = parserInput.currentChar(), important, merge, isVariable;

                if (c === '.' || c === '#' || c === '&' || c === ':') { return; }

                parserInput.save();

                name = this.variable() || this.ruleProperty();
                if (name) {
                    isVariable = typeof name === "string";

                    if (isVariable) {
                        value = this.detachedRuleset();
                    }

                    parserInput.commentStore.length = 0;
                    if (!value) {
                        // a name returned by this.ruleProperty() is always an array of the form:
                        // [string-1, ..., string-n, ""] or [string-1, ..., string-n, "+"]
                        // where each item is a tree.Keyword or tree.Variable
                        merge = !isVariable && name.length > 1 && name.pop().value;

                        // prefer to try to parse first if its a variable or we are compressing
                        // but always fallback on the other one
                        var tryValueFirst = !tryAnonymous && (context.compress || isVariable);

                        if (tryValueFirst) {
                            value = this.value();
                        }
                        if (!value) {
                            value = this.anonymousValue();
                            if (value) {
                                parserInput.forget();
                                // anonymous values absorb the end ';' which is required for them to work
                                return new (tree.Rule)(name, value, false, merge, startOfRule, fileInfo);
                            }
                        }
                        if (!tryValueFirst && !value) {
                            value = this.value();
                        }

                        important = this.important();
                    }

                    if (value && this.end()) {
                        parserInput.forget();
                        return new (tree.Rule)(name, value, important, merge, startOfRule, fileInfo);
                    } else {
                        parserInput.restore();
                        if (value && !tryAnonymous) {
                            return this.rule(true);
                        }
                    }
                } else {
                    parserInput.forget();
                }
            },
            anonymousValue: function () {
                var match = parserInput.$re(/^([^@+\/'"*`(;{}-]*);/);
                if (match) {
                    return new(tree.Anonymous)(match[1]);
                }
            },

            //
            // An @import directive
            //
            //     @import "lib";
            //
            // Depending on our environment, importing is done differently:
            // In the browser, it's an XHR request, in Node, it would be a
            // file-system operation. The function used for importing is
            // stored in `import`, which we pass to the Import constructor.
            //
            "import": function () {
                var path, features, index = parserInput.i;

                var dir = parserInput.$re(/^@import?\s+/);

                if (dir) {
                    var options = (dir ? this.importOptions() : null) || {};

                    if ((path = this.entities.quoted() || this.entities.url())) {
                        features = this.mediaFeatures();

                        if (!parserInput.$char(';')) {
                            parserInput.i = index;
                            error("missing semi-colon or unrecognised media features on import");
                        }
                        features = features && new(tree.Value)(features);
                        return new(tree.Import)(path, features, options, index, fileInfo);
                    }
                    else {
                        parserInput.i = index;
                        error("malformed import statement");
                    }
                }
            },

            importOptions: function() {
                var o, options = {}, optionName, value;

                // list of options, surrounded by parens
                if (! parserInput.$char('(')) { return null; }
                do {
                    o = this.importOption();
                    if (o) {
                        optionName = o;
                        value = true;
                        switch(optionName) {
                            case "css":
                                optionName = "less";
                                value = false;
                                break;
                            case "once":
                                optionName = "multiple";
                                value = false;
                                break;
                        }
                        options[optionName] = value;
                        if (! parserInput.$char(',')) { break; }
                    }
                } while (o);
                expectChar(')');
                return options;
            },

            importOption: function() {
                var opt = parserInput.$re(/^(less|css|multiple|once|inline|reference|optional)/);
                if (opt) {
                    return opt[1];
                }
            },

            mediaFeature: function () {
                var entities = this.entities, nodes = [], e, p;
                parserInput.save();
                do {
                    e = entities.keyword() || entities.variable();
                    if (e) {
                        nodes.push(e);
                    } else if (parserInput.$char('(')) {
                        p = this.property();
                        e = this.value();
                        if (parserInput.$char(')')) {
                            if (p && e) {
                                nodes.push(new(tree.Paren)(new(tree.Rule)(p, e, null, null, parserInput.i, fileInfo, true)));
                            } else if (e) {
                                nodes.push(new(tree.Paren)(e));
                            } else {
                                error("badly formed media feature definition");
                            }
                        } else {
                            error("Missing closing ')'", "Parse");
                        }
                    }
                } while (e);

                parserInput.forget();
                if (nodes.length > 0) {
                    return new(tree.Expression)(nodes);
                }
            },

            mediaFeatures: function () {
                var entities = this.entities, features = [], e;
                do {
                    e = this.mediaFeature();
                    if (e) {
                        features.push(e);
                        if (! parserInput.$char(',')) { break; }
                    } else {
                        e = entities.variable();
                        if (e) {
                            features.push(e);
                            if (! parserInput.$char(',')) { break; }
                        }
                    }
                } while (e);

                return features.length > 0 ? features : null;
            },

            media: function () {
                var features, rules, media, debugInfo, index = parserInput.i;

                if (context.dumpLineNumbers) {
                    debugInfo = getDebugInfo(index);
                }

                parserInput.save();

                if (parserInput.$str("@media")) {
                    features = this.mediaFeatures();

                    rules = this.block();

                    if (!rules) {
                        error("media definitions require block statements after any features");
                    }

                    parserInput.forget();

                    media = new(tree.Media)(rules, features, index, fileInfo);
                    if (context.dumpLineNumbers) {
                        media.debugInfo = debugInfo;
                    }

                    return media;
                }

                parserInput.restore();
            },

            //
            // A @plugin directive, used to import compiler extensions dynamically.
            //
            //     @plugin "lib";
            //
            // Depending on our environment, importing is done differently:
            // In the browser, it's an XHR request, in Node, it would be a
            // file-system operation. The function used for importing is
            // stored in `import`, which we pass to the Import constructor.
            //
            plugin: function () {
                var path,
                    index = parserInput.i,
                    dir   = parserInput.$re(/^@plugin?\s+/);

                if (dir) {
                    var options = { plugin : true };

                    if ((path = this.entities.quoted() || this.entities.url())) {

                        if (!parserInput.$char(';')) {
                            parserInput.i = index;
                            error("missing semi-colon on plugin");
                        }

                        return new(tree.Import)(path, null, options, index, fileInfo);
                    }
                    else {
                        parserInput.i = index;
                        error("malformed plugin statement");
                    }
                }
            },

            //
            // A CSS Directive
            //
            //     @charset "utf-8";
            //
            directive: function () {
                var index = parserInput.i, name, value, rules, nonVendorSpecificName,
                    hasIdentifier, hasExpression, hasUnknown, hasBlock = true, isRooted = true;

                if (parserInput.currentChar() !== '@') { return; }

                value = this['import']() || this.plugin() || this.media();
                if (value) {
                    return value;
                }

                parserInput.save();

                name = parserInput.$re(/^@[a-z-]+/);

                if (!name) { return; }

                nonVendorSpecificName = name;
                if (name.charAt(1) == '-' && name.indexOf('-', 2) > 0) {
                    nonVendorSpecificName = "@" + name.slice(name.indexOf('-', 2) + 1);
                }

                switch(nonVendorSpecificName) {
                    case "@charset":
                        hasIdentifier = true;
                        hasBlock = false;
                        break;
                    case "@namespace":
                        hasExpression = true;
                        hasBlock = false;
                        break;
                    case "@keyframes":
                    case "@counter-style":
                        hasIdentifier = true;
                        break;
                    case "@document":
                    case "@supports":
                        hasUnknown = true;
                        isRooted = false;
                        break;
                    default:
                        hasUnknown = true;
                        break;
                }

                parserInput.commentStore.length = 0;

                if (hasIdentifier) {
                    value = this.entity();
                    if (!value) {
                        error("expected " + name + " identifier");
                    }
                } else if (hasExpression) {
                    value = this.expression();
                    if (!value) {
                        error("expected " + name + " expression");
                    }
                } else if (hasUnknown) {
                    value = (parserInput.$re(/^[^{;]+/) || '').trim();
                    hasBlock = (parserInput.currentChar() == '{');
                    if (value) {
                        value = new(tree.Anonymous)(value);
                    }
                }

                if (hasBlock) {
                    rules = this.blockRuleset();
                }

                if (rules || (!hasBlock && value && parserInput.$char(';'))) {
                    parserInput.forget();
                    return new (tree.Directive)(name, value, rules, index, fileInfo,
                        context.dumpLineNumbers ? getDebugInfo(index) : null,
                        isRooted
                    );
                }

                parserInput.restore("directive options not recognised");
            },

            //
            // A Value is a comma-delimited list of Expressions
            //
            //     font-family: Baskerville, Georgia, serif;
            //
            // In a Rule, a Value represents everything after the `:`,
            // and before the `;`.
            //
            value: function () {
                var e, expressions = [];

                do {
                    e = this.expression();
                    if (e) {
                        expressions.push(e);
                        if (! parserInput.$char(',')) { break; }
                    }
                } while (e);

                if (expressions.length > 0) {
                    return new(tree.Value)(expressions);
                }
            },
            important: function () {
                if (parserInput.currentChar() === '!') {
                    return parserInput.$re(/^! *important/);
                }
            },
            sub: function () {
                var a, e;

                parserInput.save();
                if (parserInput.$char('(')) {
                    a = this.addition();
                    if (a && parserInput.$char(')')) {
                        parserInput.forget();
                        e = new(tree.Expression)([a]);
                        e.parens = true;
                        return e;
                    }
                    parserInput.restore("Expected ')'");
                    return;
                }
                parserInput.restore();
            },
            multiplication: function () {
                var m, a, op, operation, isSpaced;
                m = this.operand();
                if (m) {
                    isSpaced = parserInput.isWhitespace(-1);
                    while (true) {
                        if (parserInput.peek(/^\/[*\/]/)) {
                            break;
                        }

                        parserInput.save();

                        op = parserInput.$char('/') || parserInput.$char('*');

                        if (!op) { parserInput.forget(); break; }

                        a = this.operand();

                        if (!a) { parserInput.restore(); break; }
                        parserInput.forget();

                        m.parensInOp = true;
                        a.parensInOp = true;
                        operation = new(tree.Operation)(op, [operation || m, a], isSpaced);
                        isSpaced = parserInput.isWhitespace(-1);
                    }
                    return operation || m;
                }
            },
            addition: function () {
                var m, a, op, operation, isSpaced;
                m = this.multiplication();
                if (m) {
                    isSpaced = parserInput.isWhitespace(-1);
                    while (true) {
                        op = parserInput.$re(/^[-+]\s+/) || (!isSpaced && (parserInput.$char('+') || parserInput.$char('-')));
                        if (!op) {
                            break;
                        }
                        a = this.multiplication();
                        if (!a) {
                            break;
                        }

                        m.parensInOp = true;
                        a.parensInOp = true;
                        operation = new(tree.Operation)(op, [operation || m, a], isSpaced);
                        isSpaced = parserInput.isWhitespace(-1);
                    }
                    return operation || m;
                }
            },
            conditions: function () {
                var a, b, index = parserInput.i, condition;

                a = this.condition();
                if (a) {
                    while (true) {
                        if (!parserInput.peek(/^,\s*(not\s*)?\(/) || !parserInput.$char(',')) {
                            break;
                        }
                        b = this.condition();
                        if (!b) {
                            break;
                        }
                        condition = new(tree.Condition)('or', condition || a, b, index);
                    }
                    return condition || a;
                }
            },
            condition: function () {
                var result, logical, next;
                function or() {
                    return parserInput.$str("or");
                }

                result = this.conditionAnd(this);
                if (!result) {
                    return ;
                }
                logical = or();
                if (logical) {
                    next = this.condition();
                    if (next) {
                        result = new(tree.Condition)(logical, result, next);
                    } else {
                        return ;
                    }
                }
                return result;
            },
            conditionAnd: function () {
                var result, logical, next;
                function insideCondition(me) {
                    return me.negatedCondition() || me.parenthesisCondition();
                }
                function and() {
                    return parserInput.$str("and");
                }

                result = insideCondition(this);
                if (!result) {
                    return ;
                }
                logical = and();
                if (logical) {
                    next = this.conditionAnd();
                    if (next) {
                        result = new(tree.Condition)(logical, result, next);
                    } else {
                        return ;
                    }
                }
                return result;
            },
            negatedCondition: function () {
                if (parserInput.$str("not")) {
                    var result = this.parenthesisCondition();
                    if (result) {
                        result.negate = !result.negate;
                    }
                    return result;
                }
            },
            parenthesisCondition: function () {
                function tryConditionFollowedByParenthesis(me) {
                    var body;
                    parserInput.save();
                    body = me.condition();
                    if (!body) {
                        parserInput.restore();
                        return ;
                    }
                    if (!parserInput.$char(')')) {
                        parserInput.restore();
                        return ;
                    }
                    parserInput.forget();
                    return body;
                }

                var body;
                parserInput.save();
                if (!parserInput.$str("(")) {
                    parserInput.restore();
                    return ;
                }
                body = tryConditionFollowedByParenthesis(this);
                if (body) {
                    parserInput.forget();
                    return body;
                }

                body = this.atomicCondition();
                if (!body) {
                    parserInput.restore();
                    return ;
                }
                if (!parserInput.$char(')')) {
                    parserInput.restore("expected ')' got '" + parserInput.currentChar() + "'");
                    return ;
                }
                parserInput.forget();
                return body;
            },
            atomicCondition: function () {
                var entities = this.entities, index = parserInput.i, a, b, c, op;

                a = this.addition() || entities.keyword() || entities.quoted();
                if (a) {
                    if (parserInput.$char('>')) {
                        if (parserInput.$char('=')) {
                            op = ">=";
                        } else {
                            op = '>';
                        }
                    } else
                    if (parserInput.$char('<')) {
                        if (parserInput.$char('=')) {
                            op = "<=";
                        } else {
                            op = '<';
                        }
                    } else
                    if (parserInput.$char('=')) {
                        if (parserInput.$char('>')) {
                            op = "=>";
                        } else if (parserInput.$char('<')) {
                            op = '=<';
                        } else {
                            op = '=';
                        }
                    }
                    if (op) {
                        b = this.addition() || entities.keyword() || entities.quoted();
                        if (b) {
                            c = new(tree.Condition)(op, a, b, index, false);
                        } else {
                            error('expected expression');
                        }
                    } else {
                        c = new(tree.Condition)('=', a, new(tree.Keyword)('true'), index, false);
                    }
                    return c;
                }
            },

            //
            // An operand is anything that can be part of an operation,
            // such as a Color, or a Variable
            //
            operand: function () {
                var entities = this.entities, negate;

                if (parserInput.peek(/^-[@\(]/)) {
                    negate = parserInput.$char('-');
                }

                var o = this.sub() || entities.dimension() ||
                        entities.color() || entities.variable() ||
                        entities.call() || entities.colorKeyword();

                if (negate) {
                    o.parensInOp = true;
                    o = new(tree.Negative)(o);
                }

                return o;
            },

            //
            // Expressions either represent mathematical operations,
            // or white-space delimited Entities.
            //
            //     1px solid black
            //     @var * 2
            //
            expression: function () {
                var entities = [], e, delim;

                do {
                    e = this.comment();
                    if (e) {
                        entities.push(e);
                        continue;
                    }
                    e = this.addition() || this.entity();
                    if (e) {
                        entities.push(e);
                        // operations do not allow keyword "/" dimension (e.g. small/20px) so we support that here
                        if (!parserInput.peek(/^\/[\/*]/)) {
                            delim = parserInput.$char('/');
                            if (delim) {
                                entities.push(new(tree.Anonymous)(delim));
                            }
                        }
                    }
                } while (e);
                if (entities.length > 0) {
                    return new(tree.Expression)(entities);
                }
            },
            property: function () {
                var name = parserInput.$re(/^(\*?-?[_a-zA-Z0-9-]+)\s*:/);
                if (name) {
                    return name[1];
                }
            },
            ruleProperty: function () {
                var name = [], index = [], s, k;

                parserInput.save();

                var simpleProperty = parserInput.$re(/^([_a-zA-Z0-9-]+)\s*:/);
                if (simpleProperty) {
                    name = [new(tree.Keyword)(simpleProperty[1])];
                    parserInput.forget();
                    return name;
                }

                function match(re) {
                    var i = parserInput.i,
                        chunk = parserInput.$re(re);
                    if (chunk) {
                        index.push(i);
                        return name.push(chunk[1]);
                    }
                }

                match(/^(\*?)/);
                while (true) {
                    if (!match(/^((?:[\w-]+)|(?:@\{[\w-]+\}))/)) {
                        break;
                    }
                }

                if ((name.length > 1) && match(/^((?:\+_|\+)?)\s*:/)) {
                    parserInput.forget();

                    // at last, we have the complete match now. move forward,
                    // convert name particles to tree objects and return:
                    if (name[0] === '') {
                        name.shift();
                        index.shift();
                    }
                    for (k = 0; k < name.length; k++) {
                        s = name[k];
                        name[k] = (s.charAt(0) !== '@') ?
                            new(tree.Keyword)(s) :
                            new(tree.Variable)('@' + s.slice(2, -1),
                                index[k], fileInfo);
                    }
                    return name;
                }
                parserInput.restore();
            }
        }
    };
};
Parser.serializeVars = function(vars) {
    var s = '';

    for (var name in vars) {
        if (Object.hasOwnProperty.call(vars, name)) {
            var value = vars[name];
            s += ((name[0] === '@') ? '' : '@') + name + ': ' + value +
                ((String(value).slice(-1) === ';') ? '' : ';');
        }
    }

    return s;
};

module.exports = Parser;

},{"../less-error":37,"../tree":67,"../utils":88,"../visitors":92,"./parser-input":42}],44:[function(require,module,exports){
/**
 * Plugin Manager
 */
var PluginManager = function(less) {
    this.less = less;
    this.visitors = [];
    this.preProcessors = [];
    this.postProcessors = [];
    this.installedPlugins = [];
    this.fileManagers = [];
};
/**
 * Adds all the plugins in the array
 * @param {Array} plugins
 */
PluginManager.prototype.addPlugins = function(plugins) {
    if (plugins) {
        for (var i = 0; i < plugins.length; i++) {
            this.addPlugin(plugins[i]);
        }
    }
};
/**
 *
 * @param plugin
 */
PluginManager.prototype.addPlugin = function(plugin) {
    this.installedPlugins.push(plugin);
    plugin.install(this.less, this);
};
/**
 * Adds a visitor. The visitor object has options on itself to determine
 * when it should run.
 * @param visitor
 */
PluginManager.prototype.addVisitor = function(visitor) {
    this.visitors.push(visitor);
};
/**
 * Adds a pre processor object
 * @param {object} preProcessor
 * @param {number} priority - guidelines 1 = before import, 1000 = import, 2000 = after import
 */
PluginManager.prototype.addPreProcessor = function(preProcessor, priority) {
    var indexToInsertAt;
    for (indexToInsertAt = 0; indexToInsertAt < this.preProcessors.length; indexToInsertAt++) {
        if (this.preProcessors[indexToInsertAt].priority >= priority) {
            break;
        }
    }
    this.preProcessors.splice(indexToInsertAt, 0, {preProcessor: preProcessor, priority: priority});
};
/**
 * Adds a post processor object
 * @param {object} postProcessor
 * @param {number} priority - guidelines 1 = before compression, 1000 = compression, 2000 = after compression
 */
PluginManager.prototype.addPostProcessor = function(postProcessor, priority) {
    var indexToInsertAt;
    for (indexToInsertAt = 0; indexToInsertAt < this.postProcessors.length; indexToInsertAt++) {
        if (this.postProcessors[indexToInsertAt].priority >= priority) {
            break;
        }
    }
    this.postProcessors.splice(indexToInsertAt, 0, {postProcessor: postProcessor, priority: priority});
};
/**
 *
 * @param manager
 */
PluginManager.prototype.addFileManager = function(manager) {
    this.fileManagers.push(manager);
};
/**
 *
 * @returns {Array}
 * @private
 */
PluginManager.prototype.getPreProcessors = function() {
    var preProcessors = [];
    for (var i = 0; i < this.preProcessors.length; i++) {
        preProcessors.push(this.preProcessors[i].preProcessor);
    }
    return preProcessors;
};
/**
 *
 * @returns {Array}
 * @private
 */
PluginManager.prototype.getPostProcessors = function() {
    var postProcessors = [];
    for (var i = 0; i < this.postProcessors.length; i++) {
        postProcessors.push(this.postProcessors[i].postProcessor);
    }
    return postProcessors;
};
/**
 *
 * @returns {Array}
 * @private
 */
PluginManager.prototype.getVisitors = function() {
    return this.visitors;
};
/**
 *
 * @returns {Array}
 * @private
 */
PluginManager.prototype.getFileManagers = function() {
    return this.fileManagers;
};
module.exports = PluginManager;

},{}],45:[function(require,module,exports){
var LessError = require('../less-error'),
    tree = require("../tree");

var FunctionImporter = module.exports = function FunctionImporter(context, fileInfo) {
    this.fileInfo = fileInfo;
};

FunctionImporter.prototype.eval = function(contents, callback) {
    var loaded = {},
        loader,
        registry;

    registry = {
        add: function(name, func) {
            loaded[name] = func;
        },
        addMultiple: function(functions) {
            Object.keys(functions).forEach(function(name) {
                loaded[name] = functions[name];
            });
        }
    };

    try {
        loader = new Function("functions", "tree", "fileInfo", contents);
        loader(registry, tree, this.fileInfo);
    } catch(e) {
        callback(new LessError({
            message: "Plugin evaluation error: '" + e.name + ': ' + e.message.replace(/["]/g, "'") + "'" ,
            filename: this.fileInfo.filename
        }), null );
    }

    callback(null, { functions: loaded });
};

},{"../less-error":37,"../tree":67}],46:[function(require,module,exports){
var PromiseConstructor;

module.exports = function(environment, ParseTree, ImportManager) {
    var render = function (input, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }

        if (!callback) {
            if (!PromiseConstructor) {
                PromiseConstructor = typeof Promise === 'undefined' ? require('promise') : Promise;
            }
            var self = this;
            return new PromiseConstructor(function (resolve, reject) {
                render.call(self, input, options, function(err, output) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(output);
                    }
                });
            });
        } else {
            this.parse(input, options, function(err, root, imports, options) {
                if (err) { return callback(err); }

                var result;
                try {
                    var parseTree = new ParseTree(root, imports);
                    result = parseTree.toCSS(options);
                }
                catch (err) { return callback(err); }

                callback(null, result);
            });
        }
    };

    return render;
};

},{"promise":97}],47:[function(require,module,exports){
module.exports = function (SourceMapOutput, environment) {

    var SourceMapBuilder = function (options) {
        this.options = options;
    };

    SourceMapBuilder.prototype.toCSS = function(rootNode, options, imports) {
        var sourceMapOutput = new SourceMapOutput(
            {
                contentsIgnoredCharsMap: imports.contentsIgnoredChars,
                rootNode: rootNode,
                contentsMap: imports.contents,
                sourceMapFilename: this.options.sourceMapFilename,
                sourceMapURL: this.options.sourceMapURL,
                outputFilename: this.options.sourceMapOutputFilename,
                sourceMapBasepath: this.options.sourceMapBasepath,
                sourceMapRootpath: this.options.sourceMapRootpath,
                outputSourceFiles: this.options.outputSourceFiles,
                sourceMapGenerator: this.options.sourceMapGenerator,
                sourceMapFileInline: this.options.sourceMapFileInline
            });

        var css = sourceMapOutput.toCSS(options);
        this.sourceMap = sourceMapOutput.sourceMap;
        this.sourceMapURL = sourceMapOutput.sourceMapURL;
        if (this.options.sourceMapInputFilename) {
            this.sourceMapInputFilename = sourceMapOutput.normalizeFilename(this.options.sourceMapInputFilename);
        }
        return css + this.getCSSAppendage();
    };

    SourceMapBuilder.prototype.getCSSAppendage = function() {

        var sourceMapURL = this.sourceMapURL;
        if (this.options.sourceMapFileInline) {
            if (this.sourceMap === undefined) {
                return "";
            }
            sourceMapURL = "data:application/json;base64," + environment.encodeBase64(this.sourceMap);
        }

        if (sourceMapURL) {
            return "/*# sourceMappingURL=" + sourceMapURL + " */";
        }
        return "";
    };

    SourceMapBuilder.prototype.getExternalSourceMap = function() {
        return this.sourceMap;
    };
    SourceMapBuilder.prototype.setExternalSourceMap = function(sourceMap) {
        this.sourceMap = sourceMap;
    };

    SourceMapBuilder.prototype.isInline = function() {
        return this.options.sourceMapFileInline;
    };
    SourceMapBuilder.prototype.getSourceMapURL = function() {
        return this.sourceMapURL;
    };
    SourceMapBuilder.prototype.getOutputFilename = function() {
        return this.options.sourceMapOutputFilename;
    };
    SourceMapBuilder.prototype.getInputFilename = function() {
        return this.sourceMapInputFilename;
    };

    return SourceMapBuilder;
};

},{}],48:[function(require,module,exports){
module.exports = function (environment) {

    var SourceMapOutput = function (options) {
        this._css = [];
        this._rootNode = options.rootNode;
        this._contentsMap = options.contentsMap;
        this._contentsIgnoredCharsMap = options.contentsIgnoredCharsMap;
        if (options.sourceMapFilename) {
            this._sourceMapFilename = options.sourceMapFilename.replace(/\\/g, '/');
        }
        this._outputFilename = options.outputFilename;
        this.sourceMapURL = options.sourceMapURL;
        if (options.sourceMapBasepath) {
            this._sourceMapBasepath = options.sourceMapBasepath.replace(/\\/g, '/');
        }
        if (options.sourceMapRootpath) {
            this._sourceMapRootpath = options.sourceMapRootpath.replace(/\\/g, '/');
            if (this._sourceMapRootpath.charAt(this._sourceMapRootpath.length - 1) !== '/') {
                this._sourceMapRootpath += '/';
            }
        } else {
            this._sourceMapRootpath = "";
        }
        this._outputSourceFiles = options.outputSourceFiles;
        this._sourceMapGeneratorConstructor = environment.getSourceMapGenerator();

        this._lineNumber = 0;
        this._column = 0;
    };

    SourceMapOutput.prototype.normalizeFilename = function(filename) {
        filename = filename.replace(/\\/g, '/');

        if (this._sourceMapBasepath && filename.indexOf(this._sourceMapBasepath) === 0) {
            filename = filename.substring(this._sourceMapBasepath.length);
            if (filename.charAt(0) === '\\' || filename.charAt(0) === '/') {
                filename = filename.substring(1);
            }
        }
        return (this._sourceMapRootpath || "") + filename;
    };

    SourceMapOutput.prototype.add = function(chunk, fileInfo, index, mapLines) {

        //ignore adding empty strings
        if (!chunk) {
            return;
        }

        var lines,
            sourceLines,
            columns,
            sourceColumns,
            i;

        if (fileInfo) {
            var inputSource = this._contentsMap[fileInfo.filename];

            // remove vars/banner added to the top of the file
            if (this._contentsIgnoredCharsMap[fileInfo.filename]) {
                // adjust the index
                index -= this._contentsIgnoredCharsMap[fileInfo.filename];
                if (index < 0) { index = 0; }
                // adjust the source
                inputSource = inputSource.slice(this._contentsIgnoredCharsMap[fileInfo.filename]);
            }
            inputSource = inputSource.substring(0, index);
            sourceLines = inputSource.split("\n");
            sourceColumns = sourceLines[sourceLines.length - 1];
        }

        lines = chunk.split("\n");
        columns = lines[lines.length - 1];

        if (fileInfo) {
            if (!mapLines) {
                this._sourceMapGenerator.addMapping({ generated: { line: this._lineNumber + 1, column: this._column},
                    original: { line: sourceLines.length, column: sourceColumns.length},
                    source: this.normalizeFilename(fileInfo.filename)});
            } else {
                for (i = 0; i < lines.length; i++) {
                    this._sourceMapGenerator.addMapping({ generated: { line: this._lineNumber + i + 1, column: i === 0 ? this._column : 0},
                        original: { line: sourceLines.length + i, column: i === 0 ? sourceColumns.length : 0},
                        source: this.normalizeFilename(fileInfo.filename)});
                }
            }
        }

        if (lines.length === 1) {
            this._column += columns.length;
        } else {
            this._lineNumber += lines.length - 1;
            this._column = columns.length;
        }

        this._css.push(chunk);
    };

    SourceMapOutput.prototype.isEmpty = function() {
        return this._css.length === 0;
    };

    SourceMapOutput.prototype.toCSS = function(context) {
        this._sourceMapGenerator = new this._sourceMapGeneratorConstructor({ file: this._outputFilename, sourceRoot: null });

        if (this._outputSourceFiles) {
            for (var filename in this._contentsMap) {
                if (this._contentsMap.hasOwnProperty(filename)) {
                    var source = this._contentsMap[filename];
                    if (this._contentsIgnoredCharsMap[filename]) {
                        source = source.slice(this._contentsIgnoredCharsMap[filename]);
                    }
                    this._sourceMapGenerator.setSourceContent(this.normalizeFilename(filename), source);
                }
            }
        }

        this._rootNode.genCSS(context, this);

        if (this._css.length > 0) {
            var sourceMapURL,
                sourceMapContent = JSON.stringify(this._sourceMapGenerator.toJSON());

            if (this.sourceMapURL) {
                sourceMapURL = this.sourceMapURL;
            } else if (this._sourceMapFilename) {
                sourceMapURL = this._sourceMapFilename;
            }
            this.sourceMapURL = sourceMapURL;

            this.sourceMap = sourceMapContent;
        }

        return this._css.join('');
    };

    return SourceMapOutput;
};

},{}],49:[function(require,module,exports){
var contexts = require("./contexts"),
    visitor = require("./visitors"),
    tree = require("./tree");

module.exports = function(root, options) {
    options = options || {};
    var evaldRoot,
        variables = options.variables,
        evalEnv = new contexts.Eval(options);

    //
    // Allows setting variables with a hash, so:
    //
    //   `{ color: new tree.Color('#f01') }` will become:
    //
    //   new tree.Rule('@color',
    //     new tree.Value([
    //       new tree.Expression([
    //         new tree.Color('#f01')
    //       ])
    //     ])
    //   )
    //
    if (typeof variables === 'object' && !Array.isArray(variables)) {
        variables = Object.keys(variables).map(function (k) {
            var value = variables[k];

            if (! (value instanceof tree.Value)) {
                if (! (value instanceof tree.Expression)) {
                    value = new tree.Expression([value]);
                }
                value = new tree.Value([value]);
            }
            return new tree.Rule('@' + k, value, false, null, 0);
        });
        evalEnv.frames = [new tree.Ruleset(null, variables)];
    }

    var preEvalVisitors = [],
        visitors = [
            new visitor.JoinSelectorVisitor(),
            new visitor.MarkVisibleSelectorsVisitor(true),
            new visitor.ExtendVisitor(),
            new visitor.ToCSSVisitor({compress: Boolean(options.compress)})
        ], i;

    if (options.pluginManager) {
        var pluginVisitors = options.pluginManager.getVisitors();
        for (i = 0; i < pluginVisitors.length; i++) {
            var pluginVisitor = pluginVisitors[i];
            if (pluginVisitor.isPreEvalVisitor) {
                preEvalVisitors.push(pluginVisitor);
            } else {
                if (pluginVisitor.isPreVisitor) {
                    visitors.splice(0, 0, pluginVisitor);
                } else {
                    visitors.push(pluginVisitor);
                }
            }
        }
    }

    for (i = 0; i < preEvalVisitors.length; i++) {
        preEvalVisitors[i].run(root);
    }

    evaldRoot = root.eval(evalEnv);

    for (i = 0; i < visitors.length; i++) {
        visitors[i].run(evaldRoot);
    }

    return evaldRoot;
};

},{"./contexts":16,"./tree":67,"./visitors":92}],50:[function(require,module,exports){
var Node = require("./node");

var Alpha = function (val) {
    this.value = val;
};
Alpha.prototype = new Node();
Alpha.prototype.type = "Alpha";

Alpha.prototype.accept = function (visitor) {
    this.value = visitor.visit(this.value);
};
Alpha.prototype.eval = function (context) {
    if (this.value.eval) { return new Alpha(this.value.eval(context)); }
    return this;
};
Alpha.prototype.genCSS = function (context, output) {
    output.add("alpha(opacity=");

    if (this.value.genCSS) {
        this.value.genCSS(context, output);
    } else {
        output.add(this.value);
    }

    output.add(")");
};

module.exports = Alpha;

},{"./node":75}],51:[function(require,module,exports){
var Node = require("./node");

var Anonymous = function (value, index, currentFileInfo, mapLines, rulesetLike, visibilityInfo) {
    this.value = value;
    this.index = index;
    this.mapLines = mapLines;
    this.currentFileInfo = currentFileInfo;
    this.rulesetLike = (typeof rulesetLike === 'undefined') ? false : rulesetLike;
    this.allowRoot = true;
    this.copyVisibilityInfo(visibilityInfo);
};
Anonymous.prototype = new Node();
Anonymous.prototype.type = "Anonymous";
Anonymous.prototype.eval = function () {
    return new Anonymous(this.value, this.index, this.currentFileInfo, this.mapLines, this.rulesetLike, this.visibilityInfo());
};
Anonymous.prototype.compare = function (other) {
    return other.toCSS && this.toCSS() === other.toCSS() ? 0 : undefined;
};
Anonymous.prototype.isRulesetLike = function() {
    return this.rulesetLike;
};
Anonymous.prototype.genCSS = function (context, output) {
    output.add(this.value, this.currentFileInfo, this.index, this.mapLines);
};
module.exports = Anonymous;

},{"./node":75}],52:[function(require,module,exports){
var Node = require("./node");

var Assignment = function (key, val) {
    this.key = key;
    this.value = val;
};

Assignment.prototype = new Node();
Assignment.prototype.type = "Assignment";
Assignment.prototype.accept = function (visitor) {
    this.value = visitor.visit(this.value);
};
Assignment.prototype.eval = function (context) {
    if (this.value.eval) {
        return new Assignment(this.key, this.value.eval(context));
    }
    return this;
};
Assignment.prototype.genCSS = function (context, output) {
    output.add(this.key + '=');
    if (this.value.genCSS) {
        this.value.genCSS(context, output);
    } else {
        output.add(this.value);
    }
};
module.exports = Assignment;

},{"./node":75}],53:[function(require,module,exports){
var Node = require("./node");

var Attribute = function (key, op, value) {
    this.key = key;
    this.op = op;
    this.value = value;
};
Attribute.prototype = new Node();
Attribute.prototype.type = "Attribute";
Attribute.prototype.eval = function (context) {
    return new Attribute(this.key.eval ? this.key.eval(context) : this.key,
        this.op, (this.value && this.value.eval) ? this.value.eval(context) : this.value);
};
Attribute.prototype.genCSS = function (context, output) {
    output.add(this.toCSS(context));
};
Attribute.prototype.toCSS = function (context) {
    var value = this.key.toCSS ? this.key.toCSS(context) : this.key;

    if (this.op) {
        value += this.op;
        value += (this.value.toCSS ? this.value.toCSS(context) : this.value);
    }

    return '[' + value + ']';
};
module.exports = Attribute;

},{"./node":75}],54:[function(require,module,exports){
var Node = require("./node"),
    FunctionCaller = require("../functions/function-caller");
//
// A function call node.
//
var Call = function (name, args, index, currentFileInfo) {
    this.name = name;
    this.args = args;
    this.index = index;
    this.currentFileInfo = currentFileInfo;
};
Call.prototype = new Node();
Call.prototype.type = "Call";
Call.prototype.accept = function (visitor) {
    if (this.args) {
        this.args = visitor.visitArray(this.args);
    }
};
//
// When evaluating a function call,
// we either find the function in the functionRegistry,
// in which case we call it, passing the  evaluated arguments,
// if this returns null or we cannot find the function, we
// simply print it out as it appeared originally [2].
//
// The reason why we evaluate the arguments, is in the case where
// we try to pass a variable to a function, like: `saturate(@color)`.
// The function should receive the value, not the variable.
//
Call.prototype.eval = function (context) {
    var args = this.args.map(function (a) { return a.eval(context); }),
        result, funcCaller = new FunctionCaller(this.name, context, this.index, this.currentFileInfo);

    if (funcCaller.isValid()) {
        try {
            result = funcCaller.call(args);
        } catch (e) {
            throw { type: e.type || "Runtime",
                    message: "error evaluating function `" + this.name + "`" +
                             (e.message ? ': ' + e.message : ''),
                    index: this.index, filename: this.currentFileInfo.filename };
        }

        if (result != null) {
            result.index = this.index;
            result.currentFileInfo = this.currentFileInfo;
            return result;
        }
    }

    return new Call(this.name, args, this.index, this.currentFileInfo);
};
Call.prototype.genCSS = function (context, output) {
    output.add(this.name + "(", this.currentFileInfo, this.index);

    for (var i = 0; i < this.args.length; i++) {
        this.args[i].genCSS(context, output);
        if (i + 1 < this.args.length) {
            output.add(", ");
        }
    }

    output.add(")");
};
module.exports = Call;

},{"../functions/function-caller":26,"./node":75}],55:[function(require,module,exports){
var Node = require("./node"),
    colors = require("../data/colors");

//
// RGB Colors - #ff0014, #eee
//
var Color = function (rgb, a, originalForm) {
    //
    // The end goal here, is to parse the arguments
    // into an integer triplet, such as `128, 255, 0`
    //
    // This facilitates operations and conversions.
    //
    if (Array.isArray(rgb)) {
        this.rgb = rgb;
    } else if (rgb.length == 6) {
        this.rgb = rgb.match(/.{2}/g).map(function (c) {
            return parseInt(c, 16);
        });
    } else {
        this.rgb = rgb.split('').map(function (c) {
            return parseInt(c + c, 16);
        });
    }
    this.alpha = typeof a === 'number' ? a : 1;
    if (typeof originalForm !== 'undefined') {
        this.value = originalForm;
    }
};

Color.prototype = new Node();
Color.prototype.type = "Color";

function clamp(v, max) {
    return Math.min(Math.max(v, 0), max);
}

function toHex(v) {
    return '#' + v.map(function (c) {
        c = clamp(Math.round(c), 255);
        return (c < 16 ? '0' : '') + c.toString(16);
    }).join('');
}

Color.prototype.luma = function () {
    var r = this.rgb[0] / 255,
        g = this.rgb[1] / 255,
        b = this.rgb[2] / 255;

    r = (r <= 0.03928) ? r / 12.92 : Math.pow(((r + 0.055) / 1.055), 2.4);
    g = (g <= 0.03928) ? g / 12.92 : Math.pow(((g + 0.055) / 1.055), 2.4);
    b = (b <= 0.03928) ? b / 12.92 : Math.pow(((b + 0.055) / 1.055), 2.4);

    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
Color.prototype.genCSS = function (context, output) {
    output.add(this.toCSS(context));
};
Color.prototype.toCSS = function (context, doNotCompress) {
    var compress = context && context.compress && !doNotCompress, color, alpha;

    // `value` is set if this color was originally
    // converted from a named color string so we need
    // to respect this and try to output named color too.
    if (this.value) {
        return this.value;
    }

    // If we have some transparency, the only way to represent it
    // is via `rgba`. Otherwise, we use the hex representation,
    // which has better compatibility with older browsers.
    // Values are capped between `0` and `255`, rounded and zero-padded.
    alpha = this.fround(context, this.alpha);
    if (alpha < 1) {
        return "rgba(" + this.rgb.map(function (c) {
            return clamp(Math.round(c), 255);
        }).concat(clamp(alpha, 1))
            .join(',' + (compress ? '' : ' ')) + ")";
    }

    color = this.toRGB();

    if (compress) {
        var splitcolor = color.split('');

        // Convert color to short format
        if (splitcolor[1] === splitcolor[2] && splitcolor[3] === splitcolor[4] && splitcolor[5] === splitcolor[6]) {
            color = '#' + splitcolor[1] + splitcolor[3] + splitcolor[5];
        }
    }

    return color;
};

//
// Operations have to be done per-channel, if not,
// channels will spill onto each other. Once we have
// our result, in the form of an integer triplet,
// we create a new Color node to hold the result.
//
Color.prototype.operate = function (context, op, other) {
    var rgb = [];
    var alpha = this.alpha * (1 - other.alpha) + other.alpha;
    for (var c = 0; c < 3; c++) {
        rgb[c] = this._operate(context, op, this.rgb[c], other.rgb[c]);
    }
    return new Color(rgb, alpha);
};
Color.prototype.toRGB = function () {
    return toHex(this.rgb);
};
Color.prototype.toHSL = function () {
    var r = this.rgb[0] / 255,
        g = this.rgb[1] / 255,
        b = this.rgb[2] / 255,
        a = this.alpha;

    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h, s, l = (max + min) / 2, d = max - min;

    if (max === min) {
        h = s = 0;
    } else {
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2;               break;
            case b: h = (r - g) / d + 4;               break;
        }
        h /= 6;
    }
    return { h: h * 360, s: s, l: l, a: a };
};
//Adapted from http://mjijackson.com/2008/02/rgb-to-hsl-and-rgb-to-hsv-color-model-conversion-algorithms-in-javascript
Color.prototype.toHSV = function () {
    var r = this.rgb[0] / 255,
        g = this.rgb[1] / 255,
        b = this.rgb[2] / 255,
        a = this.alpha;

    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h, s, v = max;

    var d = max - min;
    if (max === 0) {
        s = 0;
    } else {
        s = d / max;
    }

    if (max === min) {
        h = 0;
    } else {
        switch(max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    return { h: h * 360, s: s, v: v, a: a };
};
Color.prototype.toARGB = function () {
    return toHex([this.alpha * 255].concat(this.rgb));
};
Color.prototype.compare = function (x) {
    return (x.rgb &&
        x.rgb[0] === this.rgb[0] &&
        x.rgb[1] === this.rgb[1] &&
        x.rgb[2] === this.rgb[2] &&
        x.alpha  === this.alpha) ? 0 : undefined;
};

Color.fromKeyword = function(keyword) {
    var c, key = keyword.toLowerCase();
    if (colors.hasOwnProperty(key)) {
        c = new Color(colors[key].slice(1));
    }
    else if (key === "transparent") {
        c = new Color([0, 0, 0], 0);
    }

    if (c) {
        c.value = keyword;
        return c;
    }
};
module.exports = Color;

},{"../data/colors":17,"./node":75}],56:[function(require,module,exports){
var Node = require("./node");

var Combinator = function (value) {
    if (value === ' ') {
        this.value = ' ';
        this.emptyOrWhitespace = true;
    } else {
        this.value = value ? value.trim() : "";
        this.emptyOrWhitespace = this.value === "";
    }
};
Combinator.prototype = new Node();
Combinator.prototype.type = "Combinator";
var _noSpaceCombinators = {
    '': true,
    ' ': true,
    '|': true
};
Combinator.prototype.genCSS = function (context, output) {
    var spaceOrEmpty = (context.compress || _noSpaceCombinators[this.value]) ? '' : ' ';
    output.add(spaceOrEmpty + this.value + spaceOrEmpty);
};
module.exports = Combinator;

},{"./node":75}],57:[function(require,module,exports){
var Node = require("./node"),
    getDebugInfo = require("./debug-info");

var Comment = function (value, isLineComment, index, currentFileInfo) {
    this.value = value;
    this.isLineComment = isLineComment;
    this.index = index;
    this.currentFileInfo = currentFileInfo;
    this.allowRoot = true;
};
Comment.prototype = new Node();
Comment.prototype.type = "Comment";
Comment.prototype.genCSS = function (context, output) {
    if (this.debugInfo) {
        output.add(getDebugInfo(context, this), this.currentFileInfo, this.index);
    }
    output.add(this.value);
};
Comment.prototype.isSilent = function(context) {
    var isCompressed = context.compress && this.value[2] !== "!";
    return this.isLineComment || isCompressed;
};
module.exports = Comment;

},{"./debug-info":59,"./node":75}],58:[function(require,module,exports){
var Node = require("./node");

var Condition = function (op, l, r, i, negate) {
    this.op = op.trim();
    this.lvalue = l;
    this.rvalue = r;
    this.index = i;
    this.negate = negate;
};
Condition.prototype = new Node();
Condition.prototype.type = "Condition";
Condition.prototype.accept = function (visitor) {
    this.lvalue = visitor.visit(this.lvalue);
    this.rvalue = visitor.visit(this.rvalue);
};
Condition.prototype.eval = function (context) {
    var result = (function (op, a, b) {
        switch (op) {
            case 'and': return a && b;
            case 'or':  return a || b;
            default:
                switch (Node.compare(a, b)) {
                    case -1:
                        return op === '<' || op === '=<' || op === '<=';
                    case 0:
                        return op === '=' || op === '>=' || op === '=<' || op === '<=';
                    case 1:
                        return op === '>' || op === '>=';
                    default:
                        return false;
                }
        }
    })(this.op, this.lvalue.eval(context), this.rvalue.eval(context));

    return this.negate ? !result : result;
};
module.exports = Condition;

},{"./node":75}],59:[function(require,module,exports){
var debugInfo = function(context, ctx, lineSeparator) {
    var result = "";
    if (context.dumpLineNumbers && !context.compress) {
        switch(context.dumpLineNumbers) {
            case 'comments':
                result = debugInfo.asComment(ctx);
                break;
            case 'mediaquery':
                result = debugInfo.asMediaQuery(ctx);
                break;
            case 'all':
                result = debugInfo.asComment(ctx) + (lineSeparator || "") + debugInfo.asMediaQuery(ctx);
                break;
        }
    }
    return result;
};

debugInfo.asComment = function(ctx) {
    return '/* line ' + ctx.debugInfo.lineNumber + ', ' + ctx.debugInfo.fileName + ' */\n';
};

debugInfo.asMediaQuery = function(ctx) {
    var filenameWithProtocol = ctx.debugInfo.fileName;
    if (!/^[a-z]+:\/\//i.test(filenameWithProtocol)) {
        filenameWithProtocol = 'file://' + filenameWithProtocol;
    }
    return '@media -sass-debug-info{filename{font-family:' +
        filenameWithProtocol.replace(/([.:\/\\])/g, function (a) {
            if (a == '\\') {
                a = '\/';
            }
            return '\\' + a;
        }) +
        '}line{font-family:\\00003' + ctx.debugInfo.lineNumber + '}}\n';
};

module.exports = debugInfo;

},{}],60:[function(require,module,exports){
var Node = require("./node"),
    contexts = require("../contexts");

var DetachedRuleset = function (ruleset, frames) {
    this.ruleset = ruleset;
    this.frames = frames;
};
DetachedRuleset.prototype = new Node();
DetachedRuleset.prototype.type = "DetachedRuleset";
DetachedRuleset.prototype.evalFirst = true;
DetachedRuleset.prototype.accept = function (visitor) {
    this.ruleset = visitor.visit(this.ruleset);
};
DetachedRuleset.prototype.eval = function (context) {
    var frames = this.frames || context.frames.slice(0);
    return new DetachedRuleset(this.ruleset, frames);
};
DetachedRuleset.prototype.callEval = function (context) {
    return this.ruleset.eval(this.frames ? new contexts.Eval(context, this.frames.concat(context.frames)) : context);
};
module.exports = DetachedRuleset;

},{"../contexts":16,"./node":75}],61:[function(require,module,exports){
var Node = require("./node"),
    unitConversions = require("../data/unit-conversions"),
    Unit = require("./unit"),
    Color = require("./color");

//
// A number with a unit
//
var Dimension = function (value, unit) {
    this.value = parseFloat(value);
    this.unit = (unit && unit instanceof Unit) ? unit :
      new Unit(unit ? [unit] : undefined);
};

Dimension.prototype = new Node();
Dimension.prototype.type = "Dimension";
Dimension.prototype.accept = function (visitor) {
    this.unit = visitor.visit(this.unit);
};
Dimension.prototype.eval = function (context) {
    return this;
};
Dimension.prototype.toColor = function () {
    return new Color([this.value, this.value, this.value]);
};
Dimension.prototype.genCSS = function (context, output) {
    if ((context && context.strictUnits) && !this.unit.isSingular()) {
        throw new Error("Multiple units in dimension. Correct the units or use the unit function. Bad unit: " + this.unit.toString());
    }

    var value = this.fround(context, this.value),
        strValue = String(value);

    if (value !== 0 && value < 0.000001 && value > -0.000001) {
        // would be output 1e-6 etc.
        strValue = value.toFixed(20).replace(/0+$/, "");
    }

    if (context && context.compress) {
        // Zero values doesn't need a unit
        if (value === 0 && this.unit.isLength()) {
            output.add(strValue);
            return;
        }

        // Float values doesn't need a leading zero
        if (value > 0 && value < 1) {
            strValue = (strValue).substr(1);
        }
    }

    output.add(strValue);
    this.unit.genCSS(context, output);
};

// In an operation between two Dimensions,
// we default to the first Dimension's unit,
// so `1px + 2` will yield `3px`.
Dimension.prototype.operate = function (context, op, other) {
    /*jshint noempty:false */
    var value = this._operate(context, op, this.value, other.value),
        unit = this.unit.clone();

    if (op === '+' || op === '-') {
        if (unit.numerator.length === 0 && unit.denominator.length === 0) {
            unit = other.unit.clone();
            if (this.unit.backupUnit) {
                unit.backupUnit = this.unit.backupUnit;
            }
        } else if (other.unit.numerator.length === 0 && unit.denominator.length === 0) {
            // do nothing
        } else {
            other = other.convertTo(this.unit.usedUnits());

            if (context.strictUnits && other.unit.toString() !== unit.toString()) {
                throw new Error("Incompatible units. Change the units or use the unit function. Bad units: '" + unit.toString() +
                    "' and '" + other.unit.toString() + "'.");
            }

            value = this._operate(context, op, this.value, other.value);
        }
    } else if (op === '*') {
        unit.numerator = unit.numerator.concat(other.unit.numerator).sort();
        unit.denominator = unit.denominator.concat(other.unit.denominator).sort();
        unit.cancel();
    } else if (op === '/') {
        unit.numerator = unit.numerator.concat(other.unit.denominator).sort();
        unit.denominator = unit.denominator.concat(other.unit.numerator).sort();
        unit.cancel();
    }
    return new Dimension(value, unit);
};
Dimension.prototype.compare = function (other) {
    var a, b;

    if (!(other instanceof Dimension)) {
        return undefined;
    }

    if (this.unit.isEmpty() || other.unit.isEmpty()) {
        a = this;
        b = other;
    } else {
        a = this.unify();
        b = other.unify();
        if (a.unit.compare(b.unit) !== 0) {
            return undefined;
        }
    }

    return Node.numericCompare(a.value, b.value);
};
Dimension.prototype.unify = function () {
    return this.convertTo({ length: 'px', duration: 's', angle: 'rad' });
};
Dimension.prototype.convertTo = function (conversions) {
    var value = this.value, unit = this.unit.clone(),
        i, groupName, group, targetUnit, derivedConversions = {}, applyUnit;

    if (typeof conversions === 'string') {
        for (i in unitConversions) {
            if (unitConversions[i].hasOwnProperty(conversions)) {
                derivedConversions = {};
                derivedConversions[i] = conversions;
            }
        }
        conversions = derivedConversions;
    }
    applyUnit = function (atomicUnit, denominator) {
        /* jshint loopfunc:true */
        if (group.hasOwnProperty(atomicUnit)) {
            if (denominator) {
                value = value / (group[atomicUnit] / group[targetUnit]);
            } else {
                value = value * (group[atomicUnit] / group[targetUnit]);
            }

            return targetUnit;
        }

        return atomicUnit;
    };

    for (groupName in conversions) {
        if (conversions.hasOwnProperty(groupName)) {
            targetUnit = conversions[groupName];
            group = unitConversions[groupName];

            unit.map(applyUnit);
        }
    }

    unit.cancel();

    return new Dimension(value, unit);
};
module.exports = Dimension;

},{"../data/unit-conversions":19,"./color":55,"./node":75,"./unit":84}],62:[function(require,module,exports){
var Node = require("./node"),
    Selector = require("./selector"),
    Ruleset = require("./ruleset");

var Directive = function (name, value, rules, index, currentFileInfo, debugInfo, isRooted, visibilityInfo) {
    var i;

    this.name  = name;
    this.value = value;
    if (rules) {
        if (Array.isArray(rules)) {
            this.rules = rules;
        } else {
            this.rules = [rules];
            this.rules[0].selectors = (new Selector([], null, null, this.index, currentFileInfo)).createEmptySelectors();
        }
        for (i = 0; i < this.rules.length; i++) {
            this.rules[i].allowImports = true;
        }
    }
    this.index = index;
    this.currentFileInfo = currentFileInfo;
    this.debugInfo = debugInfo;
    this.isRooted = isRooted || false;
    this.copyVisibilityInfo(visibilityInfo);
    this.allowRoot = true;
};

Directive.prototype = new Node();
Directive.prototype.type = "Directive";
Directive.prototype.accept = function (visitor) {
    var value = this.value, rules = this.rules;
    if (rules) {
        this.rules = visitor.visitArray(rules);
    }
    if (value) {
        this.value = visitor.visit(value);
    }
};
Directive.prototype.isRulesetLike = function() {
    return this.rules || !this.isCharset();
};
Directive.prototype.isCharset = function() {
    return "@charset" === this.name;
};
Directive.prototype.genCSS = function (context, output) {
    var value = this.value, rules = this.rules;
    output.add(this.name, this.currentFileInfo, this.index);
    if (value) {
        output.add(' ');
        value.genCSS(context, output);
    }
    if (rules) {
        this.outputRuleset(context, output, rules);
    } else {
        output.add(';');
    }
};
Directive.prototype.eval = function (context) {
    var mediaPathBackup, mediaBlocksBackup, value = this.value, rules = this.rules;

    //media stored inside other directive should not bubble over it
    //backpup media bubbling information
    mediaPathBackup = context.mediaPath;
    mediaBlocksBackup = context.mediaBlocks;
    //deleted media bubbling information
    context.mediaPath = [];
    context.mediaBlocks = [];

    if (value) {
        value = value.eval(context);
    }
    if (rules) {
        // assuming that there is only one rule at this point - that is how parser constructs the rule
        rules = [rules[0].eval(context)];
        rules[0].root = true;
    }
    //restore media bubbling information
    context.mediaPath = mediaPathBackup;
    context.mediaBlocks = mediaBlocksBackup;

    return new Directive(this.name, value, rules,
        this.index, this.currentFileInfo, this.debugInfo, this.isRooted, this.visibilityInfo());
};
Directive.prototype.variable = function (name) {
    if (this.rules) {
        // assuming that there is only one rule at this point - that is how parser constructs the rule
        return Ruleset.prototype.variable.call(this.rules[0], name);
    }
};
Directive.prototype.find = function () {
    if (this.rules) {
        // assuming that there is only one rule at this point - that is how parser constructs the rule
        return Ruleset.prototype.find.apply(this.rules[0], arguments);
    }
};
Directive.prototype.rulesets = function () {
    if (this.rules) {
        // assuming that there is only one rule at this point - that is how parser constructs the rule
        return Ruleset.prototype.rulesets.apply(this.rules[0]);
    }
};
Directive.prototype.outputRuleset = function (context, output, rules) {
    var ruleCnt = rules.length, i;
    context.tabLevel = (context.tabLevel | 0) + 1;

    // Compressed
    if (context.compress) {
        output.add('{');
        for (i = 0; i < ruleCnt; i++) {
            rules[i].genCSS(context, output);
        }
        output.add('}');
        context.tabLevel--;
        return;
    }

    // Non-compressed
    var tabSetStr = '\n' + Array(context.tabLevel).join("  "), tabRuleStr = tabSetStr + "  ";
    if (!ruleCnt) {
        output.add(" {" + tabSetStr + '}');
    } else {
        output.add(" {" + tabRuleStr);
        rules[0].genCSS(context, output);
        for (i = 1; i < ruleCnt; i++) {
            output.add(tabRuleStr);
            rules[i].genCSS(context, output);
        }
        output.add(tabSetStr + '}');
    }

    context.tabLevel--;
};
module.exports = Directive;

},{"./node":75,"./ruleset":81,"./selector":82}],63:[function(require,module,exports){
var Node = require("./node"),
    Paren = require("./paren"),
    Combinator = require("./combinator");

var Element = function (combinator, value, index, currentFileInfo, info) {
    this.combinator = combinator instanceof Combinator ?
                      combinator : new Combinator(combinator);

    if (typeof value === 'string') {
        this.value = value.trim();
    } else if (value) {
        this.value = value;
    } else {
        this.value = "";
    }
    this.index = index;
    this.currentFileInfo = currentFileInfo;
    this.copyVisibilityInfo(info);
};
Element.prototype = new Node();
Element.prototype.type = "Element";
Element.prototype.accept = function (visitor) {
    var value = this.value;
    this.combinator = visitor.visit(this.combinator);
    if (typeof value === "object") {
        this.value = visitor.visit(value);
    }
};
Element.prototype.eval = function (context) {
    return new Element(this.combinator,
                             this.value.eval ? this.value.eval(context) : this.value,
                             this.index,
                             this.currentFileInfo, this.visibilityInfo());
};
Element.prototype.clone = function () {
    return new Element(this.combinator,
        this.value,
        this.index,
        this.currentFileInfo, this.visibilityInfo());
};
Element.prototype.genCSS = function (context, output) {
    output.add(this.toCSS(context), this.currentFileInfo, this.index);
};
Element.prototype.toCSS = function (context) {
    context = context || {};
    var value = this.value, firstSelector = context.firstSelector;
    if (value instanceof Paren) {
        // selector in parens should not be affected by outer selector
        // flags (breaks only interpolated selectors - see #1973)
        context.firstSelector = true;
    }
    value = value.toCSS ? value.toCSS(context) : value;
    context.firstSelector = firstSelector;
    if (value === '' && this.combinator.value.charAt(0) === '&') {
        return '';
    } else {
        return this.combinator.toCSS(context) + value;
    }
};
module.exports = Element;

},{"./combinator":56,"./node":75,"./paren":77}],64:[function(require,module,exports){
var Node = require("./node"),
    Paren = require("./paren"),
    Comment = require("./comment");

var Expression = function (value) {
    this.value = value;
    if (!value) {
        throw new Error("Expression requires an array parameter");
    }
};
Expression.prototype = new Node();
Expression.prototype.type = "Expression";
Expression.prototype.accept = function (visitor) {
    this.value = visitor.visitArray(this.value);
};
Expression.prototype.eval = function (context) {
    var returnValue,
        inParenthesis = this.parens && !this.parensInOp,
        doubleParen = false;
    if (inParenthesis) {
        context.inParenthesis();
    }
    if (this.value.length > 1) {
        returnValue = new Expression(this.value.map(function (e) {
            return e.eval(context);
        }));
    } else if (this.value.length === 1) {
        if (this.value[0].parens && !this.value[0].parensInOp) {
            doubleParen = true;
        }
        returnValue = this.value[0].eval(context);
    } else {
        returnValue = this;
    }
    if (inParenthesis) {
        context.outOfParenthesis();
    }
    if (this.parens && this.parensInOp && !(context.isMathOn()) && !doubleParen) {
        returnValue = new Paren(returnValue);
    }
    return returnValue;
};
Expression.prototype.genCSS = function (context, output) {
    for (var i = 0; i < this.value.length; i++) {
        this.value[i].genCSS(context, output);
        if (i + 1 < this.value.length) {
            output.add(" ");
        }
    }
};
Expression.prototype.throwAwayComments = function () {
    this.value = this.value.filter(function(v) {
        return !(v instanceof Comment);
    });
};
module.exports = Expression;

},{"./comment":57,"./node":75,"./paren":77}],65:[function(require,module,exports){
var Node = require("./node"),
    Selector = require("./selector");

var Extend = function Extend(selector, option, index, currentFileInfo, visibilityInfo) {
    this.selector = selector;
    this.option = option;
    this.index = index;
    this.object_id = Extend.next_id++;
    this.parent_ids = [this.object_id];
    this.currentFileInfo = currentFileInfo || {};
    this.copyVisibilityInfo(visibilityInfo);
    this.allowRoot = true;

    switch(option) {
        case "all":
            this.allowBefore = true;
            this.allowAfter = true;
            break;
        default:
            this.allowBefore = false;
            this.allowAfter = false;
            break;
    }
};
Extend.next_id = 0;

Extend.prototype = new Node();
Extend.prototype.type = "Extend";
Extend.prototype.accept = function (visitor) {
    this.selector = visitor.visit(this.selector);
};
Extend.prototype.eval = function (context) {
    return new Extend(this.selector.eval(context), this.option, this.index, this.currentFileInfo, this.visibilityInfo());
};
Extend.prototype.clone = function (context) {
    return new Extend(this.selector, this.option, this.index, this.currentFileInfo, this.visibilityInfo());
};
//it concatenates (joins) all selectors in selector array
Extend.prototype.findSelfSelectors = function (selectors) {
    var selfElements = [],
        i,
        selectorElements;

    for (i = 0; i < selectors.length; i++) {
        selectorElements = selectors[i].elements;
        // duplicate the logic in genCSS function inside the selector node.
        // future TODO - move both logics into the selector joiner visitor
        if (i > 0 && selectorElements.length && selectorElements[0].combinator.value === "") {
            selectorElements[0].combinator.value = ' ';
        }
        selfElements = selfElements.concat(selectors[i].elements);
    }

    this.selfSelectors = [new Selector(selfElements)];
    this.selfSelectors[0].copyVisibilityInfo(this.visibilityInfo());
};
module.exports = Extend;

},{"./node":75,"./selector":82}],66:[function(require,module,exports){
var Node = require("./node"),
    Media = require("./media"),
    URL = require("./url"),
    Quoted = require("./quoted"),
    Ruleset = require("./ruleset"),
    Anonymous = require("./anonymous");

//
// CSS @import node
//
// The general strategy here is that we don't want to wait
// for the parsing to be completed, before we start importing
// the file. That's because in the context of a browser,
// most of the time will be spent waiting for the server to respond.
//
// On creation, we push the import path to our import queue, though
// `import,push`, we also pass it a callback, which it'll call once
// the file has been fetched, and parsed.
//
var Import = function (path, features, options, index, currentFileInfo, visibilityInfo) {
    this.options = options;
    this.index = index;
    this.path = path;
    this.features = features;
    this.currentFileInfo = currentFileInfo;
    this.allowRoot = true;

    if (this.options.less !== undefined || this.options.inline) {
        this.css = !this.options.less || this.options.inline;
    } else {
        var pathValue = this.getPath();
        if (pathValue && /[#\.\&\?\/]css([\?;].*)?$/.test(pathValue)) {
            this.css = true;
        }
    }
    this.copyVisibilityInfo(visibilityInfo);
};

//
// The actual import node doesn't return anything, when converted to CSS.
// The reason is that it's used at the evaluation stage, so that the rules
// it imports can be treated like any other rules.
//
// In `eval`, we make sure all Import nodes get evaluated, recursively, so
// we end up with a flat structure, which can easily be imported in the parent
// ruleset.
//
Import.prototype = new Node();
Import.prototype.type = "Import";
Import.prototype.accept = function (visitor) {
    if (this.features) {
        this.features = visitor.visit(this.features);
    }
    this.path = visitor.visit(this.path);
    if (!this.options.plugin && !this.options.inline && this.root) {
        this.root = visitor.visit(this.root);
    }
};
Import.prototype.genCSS = function (context, output) {
    if (this.css && this.path.currentFileInfo.reference === undefined) {
        output.add("@import ", this.currentFileInfo, this.index);
        this.path.genCSS(context, output);
        if (this.features) {
            output.add(" ");
            this.features.genCSS(context, output);
        }
        output.add(';');
    }
};
Import.prototype.getPath = function () {
    return (this.path instanceof URL) ?
        this.path.value.value : this.path.value;
};
Import.prototype.isVariableImport = function () {
    var path = this.path;
    if (path instanceof URL) {
        path = path.value;
    }
    if (path instanceof Quoted) {
        return path.containsVariables();
    }

    return true;
};
Import.prototype.evalForImport = function (context) {
    var path = this.path;

    if (path instanceof URL) {
        path = path.value;
    }

    return new Import(path.eval(context), this.features, this.options, this.index, this.currentFileInfo, this.visibilityInfo());
};
Import.prototype.evalPath = function (context) {
    var path = this.path.eval(context);
    var rootpath = this.currentFileInfo && this.currentFileInfo.rootpath;

    if (!(path instanceof URL)) {
        if (rootpath) {
            var pathValue = path.value;
            // Add the base path if the import is relative
            if (pathValue && context.isPathRelative(pathValue)) {
                path.value = rootpath + pathValue;
            }
        }
        path.value = context.normalizePath(path.value);
    }

    return path;
};
Import.prototype.eval = function (context) {
    var result = this.doEval(context);
    if (this.options.reference || this.blocksVisibility()) {
        if (result.length || result.length === 0) {
            result.forEach(function (node) {
                    node.addVisibilityBlock();
                }
            );
        } else {
            result.addVisibilityBlock();
        }
    }
    return result;
};
Import.prototype.doEval = function (context) {
    var ruleset, registry,
        features = this.features && this.features.eval(context);

    if (this.options.plugin) {
        registry = context.frames[0] && context.frames[0].functionRegistry;
        if ( registry && this.root && this.root.functions ) {
            registry.addMultiple( this.root.functions );
        }
        return [];
    }

    if (this.skip) {
        if (typeof this.skip === "function") {
            this.skip = this.skip();
        }
        if (this.skip) {
            return [];
        }
    }
    if (this.options.inline) {
        var contents = new Anonymous(this.root, 0,
          {
              filename: this.importedFilename,
              reference: this.path.currentFileInfo && this.path.currentFileInfo.reference
          }, true, true);

        return this.features ? new Media([contents], this.features.value) : [contents];
    } else if (this.css) {
        var newImport = new Import(this.evalPath(context), features, this.options, this.index);
        if (!newImport.css && this.error) {
            throw this.error;
        }
        return newImport;
    } else {
        ruleset = new Ruleset(null, this.root.rules.slice(0));
        ruleset.evalImports(context);

        return this.features ? new Media(ruleset.rules, this.features.value) : ruleset.rules;
    }
};
module.exports = Import;

},{"./anonymous":51,"./media":71,"./node":75,"./quoted":78,"./ruleset":81,"./url":85}],67:[function(require,module,exports){
var tree = {};

tree.Node = require('./node');
tree.Alpha = require('./alpha');
tree.Color = require('./color');
tree.Directive = require('./directive');
tree.DetachedRuleset = require('./detached-ruleset');
tree.Operation = require('./operation');
tree.Dimension = require('./dimension');
tree.Unit = require('./unit');
tree.Keyword = require('./keyword');
tree.Variable = require('./variable');
tree.Ruleset = require('./ruleset');
tree.Element = require('./element');
tree.Attribute = require('./attribute');
tree.Combinator = require('./combinator');
tree.Selector = require('./selector');
tree.Quoted = require('./quoted');
tree.Expression = require('./expression');
tree.Rule = require('./rule');
tree.Call = require('./call');
tree.URL = require('./url');
tree.Import = require('./import');
tree.mixin = {
    Call: require('./mixin-call'),
    Definition: require('./mixin-definition')
};
tree.Comment = require('./comment');
tree.Anonymous = require('./anonymous');
tree.Value = require('./value');
tree.JavaScript = require('./javascript');
tree.Assignment = require('./assignment');
tree.Condition = require('./condition');
tree.Paren = require('./paren');
tree.Media = require('./media');
tree.UnicodeDescriptor = require('./unicode-descriptor');
tree.Negative = require('./negative');
tree.Extend = require('./extend');
tree.RulesetCall = require('./ruleset-call');

module.exports = tree;

},{"./alpha":50,"./anonymous":51,"./assignment":52,"./attribute":53,"./call":54,"./color":55,"./combinator":56,"./comment":57,"./condition":58,"./detached-ruleset":60,"./dimension":61,"./directive":62,"./element":63,"./expression":64,"./extend":65,"./import":66,"./javascript":68,"./keyword":70,"./media":71,"./mixin-call":72,"./mixin-definition":73,"./negative":74,"./node":75,"./operation":76,"./paren":77,"./quoted":78,"./rule":79,"./ruleset":81,"./ruleset-call":80,"./selector":82,"./unicode-descriptor":83,"./unit":84,"./url":85,"./value":86,"./variable":87}],68:[function(require,module,exports){
var JsEvalNode = require("./js-eval-node"),
    Dimension = require("./dimension"),
    Quoted = require("./quoted"),
    Anonymous = require("./anonymous");

var JavaScript = function (string, escaped, index, currentFileInfo) {
    this.escaped = escaped;
    this.expression = string;
    this.index = index;
    this.currentFileInfo = currentFileInfo;
};
JavaScript.prototype = new JsEvalNode();
JavaScript.prototype.type = "JavaScript";
JavaScript.prototype.eval = function(context) {
    var result = this.evaluateJavaScript(this.expression, context);

    if (typeof result === 'number') {
        return new Dimension(result);
    } else if (typeof result === 'string') {
        return new Quoted('"' + result + '"', result, this.escaped, this.index);
    } else if (Array.isArray(result)) {
        return new Anonymous(result.join(', '));
    } else {
        return new Anonymous(result);
    }
};

module.exports = JavaScript;

},{"./anonymous":51,"./dimension":61,"./js-eval-node":69,"./quoted":78}],69:[function(require,module,exports){
var Node = require("./node"),
    Variable = require("./variable");

var JsEvalNode = function() {
};
JsEvalNode.prototype = new Node();

JsEvalNode.prototype.evaluateJavaScript = function (expression, context) {
    var result,
        that = this,
        evalContext = {};

    if (context.javascriptEnabled !== undefined && !context.javascriptEnabled) {
        throw { message: "You are using JavaScript, which has been disabled.",
            filename: this.currentFileInfo.filename,
            index: this.index };
    }

    expression = expression.replace(/@\{([\w-]+)\}/g, function (_, name) {
        return that.jsify(new Variable('@' + name, that.index, that.currentFileInfo).eval(context));
    });

    try {
        expression = new Function('return (' + expression + ')');
    } catch (e) {
        throw { message: "JavaScript evaluation error: " + e.message + " from `" + expression + "`" ,
            filename: this.currentFileInfo.filename,
            index: this.index };
    }

    var variables = context.frames[0].variables();
    for (var k in variables) {
        if (variables.hasOwnProperty(k)) {
            /*jshint loopfunc:true */
            evalContext[k.slice(1)] = {
                value: variables[k].value,
                toJS: function () {
                    return this.value.eval(context).toCSS();
                }
            };
        }
    }

    try {
        result = expression.call(evalContext);
    } catch (e) {
        throw { message: "JavaScript evaluation error: '" + e.name + ': ' + e.message.replace(/["]/g, "'") + "'" ,
            filename: this.currentFileInfo.filename,
            index: this.index };
    }
    return result;
};
JsEvalNode.prototype.jsify = function (obj) {
    if (Array.isArray(obj.value) && (obj.value.length > 1)) {
        return '[' + obj.value.map(function (v) { return v.toCSS(); }).join(', ') + ']';
    } else {
        return obj.toCSS();
    }
};

module.exports = JsEvalNode;

},{"./node":75,"./variable":87}],70:[function(require,module,exports){
var Node = require("./node");

var Keyword = function (value) { this.value = value; };
Keyword.prototype = new Node();
Keyword.prototype.type = "Keyword";
Keyword.prototype.genCSS = function (context, output) {
    if (this.value === '%') { throw { type: "Syntax", message: "Invalid % without number" }; }
    output.add(this.value);
};

Keyword.True = new Keyword('true');
Keyword.False = new Keyword('false');

module.exports = Keyword;

},{"./node":75}],71:[function(require,module,exports){
var Ruleset = require("./ruleset"),
    Value = require("./value"),
    Selector = require("./selector"),
    Anonymous = require("./anonymous"),
    Expression = require("./expression"),
    Directive = require("./directive");

var Media = function (value, features, index, currentFileInfo, visibilityInfo) {
    this.index = index;
    this.currentFileInfo = currentFileInfo;

    var selectors = (new Selector([], null, null, this.index, this.currentFileInfo)).createEmptySelectors();

    this.features = new Value(features);
    this.rules = [new Ruleset(selectors, value)];
    this.rules[0].allowImports = true;
    this.copyVisibilityInfo(visibilityInfo);
    this.allowRoot = true;
};
Media.prototype = new Directive();
Media.prototype.type = "Media";
Media.prototype.isRulesetLike = true;
Media.prototype.accept = function (visitor) {
    if (this.features) {
        this.features = visitor.visit(this.features);
    }
    if (this.rules) {
        this.rules = visitor.visitArray(this.rules);
    }
};
Media.prototype.genCSS = function (context, output) {
    output.add('@media ', this.currentFileInfo, this.index);
    this.features.genCSS(context, output);
    this.outputRuleset(context, output, this.rules);
};
Media.prototype.eval = function (context) {
    if (!context.mediaBlocks) {
        context.mediaBlocks = [];
        context.mediaPath = [];
    }

    var media = new Media(null, [], this.index, this.currentFileInfo, this.visibilityInfo());
    if (this.debugInfo) {
        this.rules[0].debugInfo = this.debugInfo;
        media.debugInfo = this.debugInfo;
    }
    var strictMathBypass = false;
    if (!context.strictMath) {
        strictMathBypass = true;
        context.strictMath = true;
    }
    try {
        media.features = this.features.eval(context);
    }
    finally {
        if (strictMathBypass) {
            context.strictMath = false;
        }
    }

    context.mediaPath.push(media);
    context.mediaBlocks.push(media);

    this.rules[0].functionRegistry = context.frames[0].functionRegistry.inherit();
    context.frames.unshift(this.rules[0]);
    media.rules = [this.rules[0].eval(context)];
    context.frames.shift();

    context.mediaPath.pop();

    return context.mediaPath.length === 0 ? media.evalTop(context) :
                media.evalNested(context);
};
Media.prototype.evalTop = function (context) {
    var result = this;

    // Render all dependent Media blocks.
    if (context.mediaBlocks.length > 1) {
        var selectors = (new Selector([], null, null, this.index, this.currentFileInfo)).createEmptySelectors();
        result = new Ruleset(selectors, context.mediaBlocks);
        result.multiMedia = true;
        result.copyVisibilityInfo(this.visibilityInfo());
    }

    delete context.mediaBlocks;
    delete context.mediaPath;

    return result;
};
Media.prototype.evalNested = function (context) {
    var i, value,
        path = context.mediaPath.concat([this]);

    // Extract the media-query conditions separated with `,` (OR).
    for (i = 0; i < path.length; i++) {
        value = path[i].features instanceof Value ?
                    path[i].features.value : path[i].features;
        path[i] = Array.isArray(value) ? value : [value];
    }

    // Trace all permutations to generate the resulting media-query.
    //
    // (a, b and c) with nested (d, e) ->
    //    a and d
    //    a and e
    //    b and c and d
    //    b and c and e
    this.features = new Value(this.permute(path).map(function (path) {
        path = path.map(function (fragment) {
            return fragment.toCSS ? fragment : new Anonymous(fragment);
        });

        for (i = path.length - 1; i > 0; i--) {
            path.splice(i, 0, new Anonymous("and"));
        }

        return new Expression(path);
    }));

    // Fake a tree-node that doesn't output anything.
    return new Ruleset([], []);
};
Media.prototype.permute = function (arr) {
    if (arr.length === 0) {
        return [];
    } else if (arr.length === 1) {
        return arr[0];
    } else {
        var result = [];
        var rest = this.permute(arr.slice(1));
        for (var i = 0; i < rest.length; i++) {
            for (var j = 0; j < arr[0].length; j++) {
                result.push([arr[0][j]].concat(rest[i]));
            }
        }
        return result;
    }
};
Media.prototype.bubbleSelectors = function (selectors) {
    if (!selectors) {
        return;
    }
    this.rules = [new Ruleset(selectors.slice(0), [this.rules[0]])];
};
module.exports = Media;

},{"./anonymous":51,"./directive":62,"./expression":64,"./ruleset":81,"./selector":82,"./value":86}],72:[function(require,module,exports){
var Node = require("./node"),
    Selector = require("./selector"),
    MixinDefinition = require("./mixin-definition"),
    defaultFunc = require("../functions/default");

var MixinCall = function (elements, args, index, currentFileInfo, important) {
    this.selector = new Selector(elements);
    this.arguments = args || [];
    this.index = index;
    this.currentFileInfo = currentFileInfo;
    this.important = important;
    this.allowRoot = true;
};
MixinCall.prototype = new Node();
MixinCall.prototype.type = "MixinCall";
MixinCall.prototype.accept = function (visitor) {
    if (this.selector) {
        this.selector = visitor.visit(this.selector);
    }
    if (this.arguments.length) {
        this.arguments = visitor.visitArray(this.arguments);
    }
};
MixinCall.prototype.eval = function (context) {
    var mixins, mixin, mixinPath, args = [], arg, argValue,
        rules = [], match = false, i, m, f, isRecursive, isOneFound,
        candidates = [], candidate, conditionResult = [], defaultResult, defFalseEitherCase = -1,
        defNone = 0, defTrue = 1, defFalse = 2, count, originalRuleset, noArgumentsFilter;

    function calcDefGroup(mixin, mixinPath) {
        var f, p, namespace;

        for (f = 0; f < 2; f++) {
            conditionResult[f] = true;
            defaultFunc.value(f);
            for (p = 0; p < mixinPath.length && conditionResult[f]; p++) {
                namespace = mixinPath[p];
                if (namespace.matchCondition) {
                    conditionResult[f] = conditionResult[f] && namespace.matchCondition(null, context);
                }
            }
            if (mixin.matchCondition) {
                conditionResult[f] = conditionResult[f] && mixin.matchCondition(args, context);
            }
        }
        if (conditionResult[0] || conditionResult[1]) {
            if (conditionResult[0] != conditionResult[1]) {
                return conditionResult[1] ?
                    defTrue : defFalse;
            }

            return defNone;
        }
        return defFalseEitherCase;
    }

    for (i = 0; i < this.arguments.length; i++) {
        arg = this.arguments[i];
        argValue = arg.value.eval(context);
        if (arg.expand && Array.isArray(argValue.value)) {
            argValue = argValue.value;
            for (m = 0; m < argValue.length; m++) {
                args.push({value: argValue[m]});
            }
        } else {
            args.push({name: arg.name, value: argValue});
        }
    }

    noArgumentsFilter = function(rule) {return rule.matchArgs(null, context);};

    for (i = 0; i < context.frames.length; i++) {
        if ((mixins = context.frames[i].find(this.selector, null, noArgumentsFilter)).length > 0) {
            isOneFound = true;

            // To make `default()` function independent of definition order we have two "subpasses" here.
            // At first we evaluate each guard *twice* (with `default() == true` and `default() == false`),
            // and build candidate list with corresponding flags. Then, when we know all possible matches,
            // we make a final decision.

            for (m = 0; m < mixins.length; m++) {
                mixin = mixins[m].rule;
                mixinPath = mixins[m].path;
                isRecursive = false;
                for (f = 0; f < context.frames.length; f++) {
                    if ((!(mixin instanceof MixinDefinition)) && mixin === (context.frames[f].originalRuleset || context.frames[f])) {
                        isRecursive = true;
                        break;
                    }
                }
                if (isRecursive) {
                    continue;
                }

                if (mixin.matchArgs(args, context)) {
                    candidate = {mixin: mixin, group: calcDefGroup(mixin, mixinPath)};

                    if (candidate.group !== defFalseEitherCase) {
                        candidates.push(candidate);
                    }

                    match = true;
                }
            }

            defaultFunc.reset();

            count = [0, 0, 0];
            for (m = 0; m < candidates.length; m++) {
                count[candidates[m].group]++;
            }

            if (count[defNone] > 0) {
                defaultResult = defFalse;
            } else {
                defaultResult = defTrue;
                if ((count[defTrue] + count[defFalse]) > 1) {
                    throw { type: 'Runtime',
                        message: 'Ambiguous use of `default()` found when matching for `' + this.format(args) + '`',
                        index: this.index, filename: this.currentFileInfo.filename };
                }
            }

            for (m = 0; m < candidates.length; m++) {
                candidate = candidates[m].group;
                if ((candidate === defNone) || (candidate === defaultResult)) {
                    try {
                        mixin = candidates[m].mixin;
                        if (!(mixin instanceof MixinDefinition)) {
                            originalRuleset = mixin.originalRuleset || mixin;
                            mixin = new MixinDefinition("", [], mixin.rules, null, false, null, originalRuleset.visibilityInfo());
                            mixin.originalRuleset = originalRuleset;
                        }
                        var newRules = mixin.evalCall(context, args, this.important).rules;
                        this._setVisibilityToReplacement(newRules);
                        Array.prototype.push.apply(rules, newRules);
                    } catch (e) {
                        throw { message: e.message, index: this.index, filename: this.currentFileInfo.filename, stack: e.stack };
                    }
                }
            }

            if (match) {
                return rules;
            }
        }
    }
    if (isOneFound) {
        throw { type:    'Runtime',
            message: 'No matching definition was found for `' + this.format(args) + '`',
            index:   this.index, filename: this.currentFileInfo.filename };
    } else {
        throw { type:    'Name',
            message: this.selector.toCSS().trim() + " is undefined",
            index:   this.index, filename: this.currentFileInfo.filename };
    }
};

MixinCall.prototype._setVisibilityToReplacement = function (replacement) {
    var i, rule;
    if (this.blocksVisibility()) {
        for (i = 0; i < replacement.length; i++) {
            rule = replacement[i];
            rule.addVisibilityBlock();
        }
    }
};
MixinCall.prototype.format = function (args) {
    return this.selector.toCSS().trim() + '(' +
        (args ? args.map(function (a) {
            var argValue = "";
            if (a.name) {
                argValue += a.name + ":";
            }
            if (a.value.toCSS) {
                argValue += a.value.toCSS();
            } else {
                argValue += "???";
            }
            return argValue;
        }).join(', ') : "") + ")";
};
module.exports = MixinCall;

},{"../functions/default":25,"./mixin-definition":73,"./node":75,"./selector":82}],73:[function(require,module,exports){
var Selector = require("./selector"),
    Element = require("./element"),
    Ruleset = require("./ruleset"),
    Rule = require("./rule"),
    Expression = require("./expression"),
    contexts = require("../contexts");

var Definition = function (name, params, rules, condition, variadic, frames, visibilityInfo) {
    this.name = name;
    this.selectors = [new Selector([new Element(null, name, this.index, this.currentFileInfo)])];
    this.params = params;
    this.condition = condition;
    this.variadic = variadic;
    this.arity = params.length;
    this.rules = rules;
    this._lookups = {};
    var optionalParameters = [];
    this.required = params.reduce(function (count, p) {
        if (!p.name || (p.name && !p.value)) {
            return count + 1;
        }
        else {
            optionalParameters.push(p.name);
            return count;
        }
    }, 0);
    this.optionalParameters = optionalParameters;
    this.frames = frames;
    this.copyVisibilityInfo(visibilityInfo);
    this.allowRoot = true;
};
Definition.prototype = new Ruleset();
Definition.prototype.type = "MixinDefinition";
Definition.prototype.evalFirst = true;
Definition.prototype.accept = function (visitor) {
    if (this.params && this.params.length) {
        this.params = visitor.visitArray(this.params);
    }
    this.rules = visitor.visitArray(this.rules);
    if (this.condition) {
        this.condition = visitor.visit(this.condition);
    }
};
Definition.prototype.evalParams = function (context, mixinEnv, args, evaldArguments) {
    /*jshint boss:true */
    var frame = new Ruleset(null, null),
        varargs, arg,
        params = this.params.slice(0),
        i, j, val, name, isNamedFound, argIndex, argsLength = 0;

    if (mixinEnv.frames && mixinEnv.frames[0] && mixinEnv.frames[0].functionRegistry) {
        frame.functionRegistry = mixinEnv.frames[0].functionRegistry.inherit();
    }
    mixinEnv = new contexts.Eval(mixinEnv, [frame].concat(mixinEnv.frames));

    if (args) {
        args = args.slice(0);
        argsLength = args.length;

        for (i = 0; i < argsLength; i++) {
            arg = args[i];
            if (name = (arg && arg.name)) {
                isNamedFound = false;
                for (j = 0; j < params.length; j++) {
                    if (!evaldArguments[j] && name === params[j].name) {
                        evaldArguments[j] = arg.value.eval(context);
                        frame.prependRule(new Rule(name, arg.value.eval(context)));
                        isNamedFound = true;
                        break;
                    }
                }
                if (isNamedFound) {
                    args.splice(i, 1);
                    i--;
                    continue;
                } else {
                    throw { type: 'Runtime', message: "Named argument for " + this.name +
                        ' ' + args[i].name + ' not found' };
                }
            }
        }
    }
    argIndex = 0;
    for (i = 0; i < params.length; i++) {
        if (evaldArguments[i]) { continue; }

        arg = args && args[argIndex];

        if (name = params[i].name) {
            if (params[i].variadic) {
                varargs = [];
                for (j = argIndex; j < argsLength; j++) {
                    varargs.push(args[j].value.eval(context));
                }
                frame.prependRule(new Rule(name, new Expression(varargs).eval(context)));
            } else {
                val = arg && arg.value;
                if (val) {
                    val = val.eval(context);
                } else if (params[i].value) {
                    val = params[i].value.eval(mixinEnv);
                    frame.resetCache();
                } else {
                    throw { type: 'Runtime', message: "wrong number of arguments for " + this.name +
                        ' (' + argsLength + ' for ' + this.arity + ')' };
                }

                frame.prependRule(new Rule(name, val));
                evaldArguments[i] = val;
            }
        }

        if (params[i].variadic && args) {
            for (j = argIndex; j < argsLength; j++) {
                evaldArguments[j] = args[j].value.eval(context);
            }
        }
        argIndex++;
    }

    return frame;
};
Definition.prototype.makeImportant = function() {
    var rules = !this.rules ? this.rules : this.rules.map(function (r) {
        if (r.makeImportant) {
            return r.makeImportant(true);
        } else {
            return r;
        }
    });
    var result = new Definition(this.name, this.params, rules, this.condition, this.variadic, this.frames);
    return result;
};
Definition.prototype.eval = function (context) {
    return new Definition(this.name, this.params, this.rules, this.condition, this.variadic, this.frames || context.frames.slice(0));
};
Definition.prototype.evalCall = function (context, args, important) {
    var _arguments = [],
        mixinFrames = this.frames ? this.frames.concat(context.frames) : context.frames,
        frame = this.evalParams(context, new contexts.Eval(context, mixinFrames), args, _arguments),
        rules, ruleset;

    frame.prependRule(new Rule('@arguments', new Expression(_arguments).eval(context)));

    rules = this.rules.slice(0);

    ruleset = new Ruleset(null, rules);
    ruleset.originalRuleset = this;
    ruleset = ruleset.eval(new contexts.Eval(context, [this, frame].concat(mixinFrames)));
    if (important) {
        ruleset = ruleset.makeImportant();
    }
    return ruleset;
};
Definition.prototype.matchCondition = function (args, context) {
    if (this.condition && !this.condition.eval(
        new contexts.Eval(context,
            [this.evalParams(context, /* the parameter variables*/
                new contexts.Eval(context, this.frames ? this.frames.concat(context.frames) : context.frames), args, [])]
            .concat(this.frames || []) // the parent namespace/mixin frames
            .concat(context.frames)))) { // the current environment frames
        return false;
    }
    return true;
};
Definition.prototype.matchArgs = function (args, context) {
    var allArgsCnt = (args && args.length) || 0, len, optionalParameters = this.optionalParameters;
    var requiredArgsCnt = !args ? 0 : args.reduce(function (count, p) {
        if (optionalParameters.indexOf(p.name) < 0) {
            return count + 1;
        } else {
            return count;
        }
    }, 0);

    if (! this.variadic) {
        if (requiredArgsCnt < this.required) {
            return false;
        }
        if (allArgsCnt > this.params.length) {
            return false;
        }
    } else {
        if (requiredArgsCnt < (this.required - 1)) {
            return false;
        }
    }

    // check patterns
    len = Math.min(requiredArgsCnt, this.arity);

    for (var i = 0; i < len; i++) {
        if (!this.params[i].name && !this.params[i].variadic) {
            if (args[i].value.eval(context).toCSS() != this.params[i].value.eval(context).toCSS()) {
                return false;
            }
        }
    }
    return true;
};
module.exports = Definition;

},{"../contexts":16,"./element":63,"./expression":64,"./rule":79,"./ruleset":81,"./selector":82}],74:[function(require,module,exports){
var Node = require("./node"),
    Operation = require("./operation"),
    Dimension = require("./dimension");

var Negative = function (node) {
    this.value = node;
};
Negative.prototype = new Node();
Negative.prototype.type = "Negative";
Negative.prototype.genCSS = function (context, output) {
    output.add('-');
    this.value.genCSS(context, output);
};
Negative.prototype.eval = function (context) {
    if (context.isMathOn()) {
        return (new Operation('*', [new Dimension(-1), this.value])).eval(context);
    }
    return new Negative(this.value.eval(context));
};
module.exports = Negative;

},{"./dimension":61,"./node":75,"./operation":76}],75:[function(require,module,exports){
var Node = function() {
};
Node.prototype.toCSS = function (context) {
    var strs = [];
    this.genCSS(context, {
        add: function(chunk, fileInfo, index) {
            strs.push(chunk);
        },
        isEmpty: function () {
            return strs.length === 0;
        }
    });
    return strs.join('');
};
Node.prototype.genCSS = function (context, output) {
    output.add(this.value);
};
Node.prototype.accept = function (visitor) {
    this.value = visitor.visit(this.value);
};
Node.prototype.eval = function () { return this; };
Node.prototype._operate = function (context, op, a, b) {
    switch (op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return a / b;
    }
};
Node.prototype.fround = function(context, value) {
    var precision = context && context.numPrecision;
    //add "epsilon" to ensure numbers like 1.000000005 (represented as 1.000000004999....) are properly rounded...
    return (precision == null) ? value : Number((value + 2e-16).toFixed(precision));
};
Node.compare = function (a, b) {
    /* returns:
     -1: a < b
     0: a = b
     1: a > b
     and *any* other value for a != b (e.g. undefined, NaN, -2 etc.) */

    if ((a.compare) &&
        // for "symmetric results" force toCSS-based comparison
        // of Quoted or Anonymous if either value is one of those
        !(b.type === "Quoted" || b.type === "Anonymous")) {
        return a.compare(b);
    } else if (b.compare) {
        return -b.compare(a);
    } else if (a.type !== b.type) {
        return undefined;
    }

    a = a.value;
    b = b.value;
    if (!Array.isArray(a)) {
        return a === b ? 0 : undefined;
    }
    if (a.length !== b.length) {
        return undefined;
    }
    for (var i = 0; i < a.length; i++) {
        if (Node.compare(a[i], b[i]) !== 0) {
            return undefined;
        }
    }
    return 0;
};

Node.numericCompare = function (a, b) {
    return a  <  b ? -1
        : a === b ?  0
        : a  >  b ?  1 : undefined;
};
// Returns true if this node represents root of ast imported by reference
Node.prototype.blocksVisibility = function () {
    if (this.visibilityBlocks == null) {
        this.visibilityBlocks = 0;
    }
    return this.visibilityBlocks !== 0;
};
Node.prototype.addVisibilityBlock = function () {
    if (this.visibilityBlocks == null) {
        this.visibilityBlocks = 0;
    }
    this.visibilityBlocks = this.visibilityBlocks + 1;
};
Node.prototype.removeVisibilityBlock = function () {
    if (this.visibilityBlocks == null) {
        this.visibilityBlocks = 0;
    }
    this.visibilityBlocks = this.visibilityBlocks - 1;
};
//Turns on node visibility - if called node will be shown in output regardless
//of whether it comes from import by reference or not
Node.prototype.ensureVisibility = function () {
    this.nodeVisible = true;
};
//Turns off node visibility - if called node will NOT be shown in output regardless
//of whether it comes from import by reference or not
Node.prototype.ensureInvisibility = function () {
    this.nodeVisible = false;
};
// return values:
// false - the node must not be visible
// true - the node must be visible
// undefined or null - the node has the same visibility as its parent
Node.prototype.isVisible = function () {
    return this.nodeVisible;
};
Node.prototype.visibilityInfo = function() {
    return {
        visibilityBlocks: this.visibilityBlocks,
        nodeVisible: this.nodeVisible
    };
};
Node.prototype.copyVisibilityInfo = function(info) {
    if (!info) {
        return;
    }
    this.visibilityBlocks = info.visibilityBlocks;
    this.nodeVisible = info.nodeVisible;
};
module.exports = Node;

},{}],76:[function(require,module,exports){
var Node = require("./node"),
    Color = require("./color"),
    Dimension = require("./dimension");

var Operation = function (op, operands, isSpaced) {
    this.op = op.trim();
    this.operands = operands;
    this.isSpaced = isSpaced;
};
Operation.prototype = new Node();
Operation.prototype.type = "Operation";
Operation.prototype.accept = function (visitor) {
    this.operands = visitor.visit(this.operands);
};
Operation.prototype.eval = function (context) {
    var a = this.operands[0].eval(context),
        b = this.operands[1].eval(context);

    if (context.isMathOn()) {
        if (a instanceof Dimension && b instanceof Color) {
            a = a.toColor();
        }
        if (b instanceof Dimension && a instanceof Color) {
            b = b.toColor();
        }
        if (!a.operate) {
            throw { type: "Operation",
                    message: "Operation on an invalid type" };
        }

        return a.operate(context, this.op, b);
    } else {
        return new Operation(this.op, [a, b], this.isSpaced);
    }
};
Operation.prototype.genCSS = function (context, output) {
    this.operands[0].genCSS(context, output);
    if (this.isSpaced) {
        output.add(" ");
    }
    output.add(this.op);
    if (this.isSpaced) {
        output.add(" ");
    }
    this.operands[1].genCSS(context, output);
};

module.exports = Operation;

},{"./color":55,"./dimension":61,"./node":75}],77:[function(require,module,exports){
var Node = require("./node");

var Paren = function (node) {
    this.value = node;
};
Paren.prototype = new Node();
Paren.prototype.type = "Paren";
Paren.prototype.genCSS = function (context, output) {
    output.add('(');
    this.value.genCSS(context, output);
    output.add(')');
};
Paren.prototype.eval = function (context) {
    return new Paren(this.value.eval(context));
};
module.exports = Paren;

},{"./node":75}],78:[function(require,module,exports){
var Node = require("./node"),
    JsEvalNode = require("./js-eval-node"),
    Variable = require("./variable");

var Quoted = function (str, content, escaped, index, currentFileInfo) {
    this.escaped = (escaped == null) ? true : escaped;
    this.value = content || '';
    this.quote = str.charAt(0);
    this.index = index;
    this.currentFileInfo = currentFileInfo;
};
Quoted.prototype = new JsEvalNode();
Quoted.prototype.type = "Quoted";
Quoted.prototype.genCSS = function (context, output) {
    if (!this.escaped) {
        output.add(this.quote, this.currentFileInfo, this.index);
    }
    output.add(this.value);
    if (!this.escaped) {
        output.add(this.quote);
    }
};
Quoted.prototype.containsVariables = function() {
    return this.value.match(/(`([^`]+)`)|@\{([\w-]+)\}/);
};
Quoted.prototype.eval = function (context) {
    var that = this, value = this.value;
    var javascriptReplacement = function (_, exp) {
        return String(that.evaluateJavaScript(exp, context));
    };
    var interpolationReplacement = function (_, name) {
        var v = new Variable('@' + name, that.index, that.currentFileInfo).eval(context, true);
        return (v instanceof Quoted) ? v.value : v.toCSS();
    };
    function iterativeReplace(value, regexp, replacementFnc) {
        var evaluatedValue = value;
        do {
            value = evaluatedValue;
            evaluatedValue = value.replace(regexp, replacementFnc);
        } while (value !== evaluatedValue);
        return evaluatedValue;
    }
    value = iterativeReplace(value, /`([^`]+)`/g, javascriptReplacement);
    value = iterativeReplace(value, /@\{([\w-]+)\}/g, interpolationReplacement);
    return new Quoted(this.quote + value + this.quote, value, this.escaped, this.index, this.currentFileInfo);
};
Quoted.prototype.compare = function (other) {
    // when comparing quoted strings allow the quote to differ
    if (other.type === "Quoted" && !this.escaped && !other.escaped) {
        return Node.numericCompare(this.value, other.value);
    } else {
        return other.toCSS && this.toCSS() === other.toCSS() ? 0 : undefined;
    }
};
module.exports = Quoted;

},{"./js-eval-node":69,"./node":75,"./variable":87}],79:[function(require,module,exports){
var Node = require("./node"),
    Value = require("./value"),
    Keyword = require("./keyword");

var Rule = function (name, value, important, merge, index, currentFileInfo, inline, variable) {
    this.name = name;
    this.value = (value instanceof Node) ? value : new Value([value]); //value instanceof tree.Value || value instanceof tree.Ruleset ??
    this.important = important ? ' ' + important.trim() : '';
    this.merge = merge;
    this.index = index;
    this.currentFileInfo = currentFileInfo;
    this.inline = inline || false;
    this.variable = (variable !== undefined) ? variable
        : (name.charAt && (name.charAt(0) === '@'));
    this.allowRoot = true;
};

function evalName(context, name) {
    var value = "", i, n = name.length,
        output = {add: function (s) {value += s;}};
    for (i = 0; i < n; i++) {
        name[i].eval(context).genCSS(context, output);
    }
    return value;
}

Rule.prototype = new Node();
Rule.prototype.type = "Rule";
Rule.prototype.genCSS = function (context, output) {
    output.add(this.name + (context.compress ? ':' : ': '), this.currentFileInfo, this.index);
    try {
        this.value.genCSS(context, output);
    }
    catch(e) {
        e.index = this.index;
        e.filename = this.currentFileInfo.filename;
        throw e;
    }
    output.add(this.important + ((this.inline || (context.lastRule && context.compress)) ? "" : ";"), this.currentFileInfo, this.index);
};
Rule.prototype.eval = function (context) {
    var strictMathBypass = false, name = this.name, evaldValue, variable = this.variable;
    if (typeof name !== "string") {
        // expand 'primitive' name directly to get
        // things faster (~10% for benchmark.less):
        name = (name.length === 1) && (name[0] instanceof Keyword) ?
                name[0].value : evalName(context, name);
        variable = false; // never treat expanded interpolation as new variable name
    }
    if (name === "font" && !context.strictMath) {
        strictMathBypass = true;
        context.strictMath = true;
    }
    try {
        context.importantScope.push({});
        evaldValue = this.value.eval(context);

        if (!this.variable && evaldValue.type === "DetachedRuleset") {
            throw { message: "Rulesets cannot be evaluated on a property.",
                    index: this.index, filename: this.currentFileInfo.filename };
        }
        var important = this.important,
            importantResult = context.importantScope.pop();
        if (!important && importantResult.important) {
            important = importantResult.important;
        }

        return new Rule(name,
                          evaldValue,
                          important,
                          this.merge,
                          this.index, this.currentFileInfo, this.inline,
                              variable);
    }
    catch(e) {
        if (typeof e.index !== 'number') {
            e.index = this.index;
            e.filename = this.currentFileInfo.filename;
        }
        throw e;
    }
    finally {
        if (strictMathBypass) {
            context.strictMath = false;
        }
    }
};
Rule.prototype.makeImportant = function () {
    return new Rule(this.name,
                          this.value,
                          "!important",
                          this.merge,
                          this.index, this.currentFileInfo, this.inline);
};

module.exports = Rule;
},{"./keyword":70,"./node":75,"./value":86}],80:[function(require,module,exports){
var Node = require("./node"),
    Variable = require("./variable");

var RulesetCall = function (variable) {
    this.variable = variable;
    this.allowRoot = true;
};
RulesetCall.prototype = new Node();
RulesetCall.prototype.type = "RulesetCall";
RulesetCall.prototype.eval = function (context) {
    var detachedRuleset = new Variable(this.variable).eval(context);
    return detachedRuleset.callEval(context);
};
module.exports = RulesetCall;

},{"./node":75,"./variable":87}],81:[function(require,module,exports){
var Node = require("./node"),
    Rule = require("./rule"),
    Selector = require("./selector"),
    Element = require("./element"),
    Paren = require("./paren"),
    contexts = require("../contexts"),
    globalFunctionRegistry = require("../functions/function-registry"),
    defaultFunc = require("../functions/default"),
    getDebugInfo = require("./debug-info");

var Ruleset = function (selectors, rules, strictImports, visibilityInfo) {
    this.selectors = selectors;
    this.rules = rules;
    this._lookups = {};
    this.strictImports = strictImports;
    this.copyVisibilityInfo(visibilityInfo);
    this.allowRoot = true;
};
Ruleset.prototype = new Node();
Ruleset.prototype.type = "Ruleset";
Ruleset.prototype.isRuleset = true;
Ruleset.prototype.isRulesetLike = true;
Ruleset.prototype.accept = function (visitor) {
    if (this.paths) {
        this.paths = visitor.visitArray(this.paths, true);
    } else if (this.selectors) {
        this.selectors = visitor.visitArray(this.selectors);
    }
    if (this.rules && this.rules.length) {
        this.rules = visitor.visitArray(this.rules);
    }
};
Ruleset.prototype.eval = function (context) {
    var thisSelectors = this.selectors, selectors,
        selCnt, selector, i, hasOnePassingSelector = false;

    if (thisSelectors && (selCnt = thisSelectors.length)) {
        selectors = [];
        defaultFunc.error({
            type: "Syntax",
            message: "it is currently only allowed in parametric mixin guards,"
        });
        for (i = 0; i < selCnt; i++) {
            selector = thisSelectors[i].eval(context);
            selectors.push(selector);
            if (selector.evaldCondition) {
                hasOnePassingSelector = true;
            }
        }
        defaultFunc.reset();
    } else {
        hasOnePassingSelector = true;
    }

    var rules = this.rules ? this.rules.slice(0) : null,
        ruleset = new Ruleset(selectors, rules, this.strictImports, this.visibilityInfo()),
        rule, subRule;

    ruleset.originalRuleset = this;
    ruleset.root = this.root;
    ruleset.firstRoot = this.firstRoot;
    ruleset.allowImports = this.allowImports;

    if (this.debugInfo) {
        ruleset.debugInfo = this.debugInfo;
    }

    if (!hasOnePassingSelector) {
        rules.length = 0;
    }

    // inherit a function registry from the frames stack when possible;
    // otherwise from the global registry
    ruleset.functionRegistry = (function (frames) {
        var i = 0,
            n = frames.length,
            found;
        for ( ; i !== n ; ++i ) {
            found = frames[ i ].functionRegistry;
            if ( found ) { return found; }
        }
        return globalFunctionRegistry;
    }(context.frames)).inherit();

    // push the current ruleset to the frames stack
    var ctxFrames = context.frames;
    ctxFrames.unshift(ruleset);

    // currrent selectors
    var ctxSelectors = context.selectors;
    if (!ctxSelectors) {
        context.selectors = ctxSelectors = [];
    }
    ctxSelectors.unshift(this.selectors);

    // Evaluate imports
    if (ruleset.root || ruleset.allowImports || !ruleset.strictImports) {
        ruleset.evalImports(context);
    }

    // Store the frames around mixin definitions,
    // so they can be evaluated like closures when the time comes.
    var rsRules = ruleset.rules, rsRuleCnt = rsRules ? rsRules.length : 0;
    for (i = 0; i < rsRuleCnt; i++) {
        if (rsRules[i].evalFirst) {
            rsRules[i] = rsRules[i].eval(context);
        }
    }

    var mediaBlockCount = (context.mediaBlocks && context.mediaBlocks.length) || 0;

    // Evaluate mixin calls.
    for (i = 0; i < rsRuleCnt; i++) {
        if (rsRules[i].type === "MixinCall") {
            /*jshint loopfunc:true */
            rules = rsRules[i].eval(context).filter(function(r) {
                if ((r instanceof Rule) && r.variable) {
                    // do not pollute the scope if the variable is
                    // already there. consider returning false here
                    // but we need a way to "return" variable from mixins
                    return !(ruleset.variable(r.name));
                }
                return true;
            });
            rsRules.splice.apply(rsRules, [i, 1].concat(rules));
            rsRuleCnt += rules.length - 1;
            i += rules.length - 1;
            ruleset.resetCache();
        } else if (rsRules[i].type === "RulesetCall") {
            /*jshint loopfunc:true */
            rules = rsRules[i].eval(context).rules.filter(function(r) {
                if ((r instanceof Rule) && r.variable) {
                    // do not pollute the scope at all
                    return false;
                }
                return true;
            });
            rsRules.splice.apply(rsRules, [i, 1].concat(rules));
            rsRuleCnt += rules.length - 1;
            i += rules.length - 1;
            ruleset.resetCache();
        }
    }

    // Evaluate everything else
    for (i = 0; i < rsRules.length; i++) {
        rule = rsRules[i];
        if (!rule.evalFirst) {
            rsRules[i] = rule = rule.eval ? rule.eval(context) : rule;
        }
    }

    // Evaluate everything else
    for (i = 0; i < rsRules.length; i++) {
        rule = rsRules[i];
        // for rulesets, check if it is a css guard and can be removed
        if (rule instanceof Ruleset && rule.selectors && rule.selectors.length === 1) {
            // check if it can be folded in (e.g. & where)
            if (rule.selectors[0].isJustParentSelector()) {
                rsRules.splice(i--, 1);

                for (var j = 0; j < rule.rules.length; j++) {
                    subRule = rule.rules[j];
                    subRule.copyVisibilityInfo(rule.visibilityInfo());
                    if (!(subRule instanceof Rule) || !subRule.variable) {
                        rsRules.splice(++i, 0, subRule);
                    }
                }
            }
        }
    }

    // Pop the stack
    ctxFrames.shift();
    ctxSelectors.shift();

    if (context.mediaBlocks) {
        for (i = mediaBlockCount; i < context.mediaBlocks.length; i++) {
            context.mediaBlocks[i].bubbleSelectors(selectors);
        }
    }

    return ruleset;
};
Ruleset.prototype.evalImports = function(context) {
    var rules = this.rules, i, importRules;
    if (!rules) { return; }

    for (i = 0; i < rules.length; i++) {
        if (rules[i].type === "Import") {
            importRules = rules[i].eval(context);
            if (importRules && (importRules.length || importRules.length === 0)) {
                rules.splice.apply(rules, [i, 1].concat(importRules));
                i+= importRules.length - 1;
            } else {
                rules.splice(i, 1, importRules);
            }
            this.resetCache();
        }
    }
};
Ruleset.prototype.makeImportant = function() {
    var result = new Ruleset(this.selectors, this.rules.map(function (r) {
        if (r.makeImportant) {
            return r.makeImportant();
        } else {
            return r;
        }
    }), this.strictImports, this.visibilityInfo());

    return result;
};
Ruleset.prototype.matchArgs = function (args) {
    return !args || args.length === 0;
};
// lets you call a css selector with a guard
Ruleset.prototype.matchCondition = function (args, context) {
    var lastSelector = this.selectors[this.selectors.length - 1];
    if (!lastSelector.evaldCondition) {
        return false;
    }
    if (lastSelector.condition &&
        !lastSelector.condition.eval(
            new contexts.Eval(context,
                context.frames))) {
        return false;
    }
    return true;
};
Ruleset.prototype.resetCache = function () {
    this._rulesets = null;
    this._variables = null;
    this._lookups = {};
};
Ruleset.prototype.variables = function () {
    if (!this._variables) {
        this._variables = !this.rules ? {} : this.rules.reduce(function (hash, r) {
            if (r instanceof Rule && r.variable === true) {
                hash[r.name] = r;
            }
            // when evaluating variables in an import statement, imports have not been eval'd
            // so we need to go inside import statements.
            // guard against root being a string (in the case of inlined less)
            if (r.type === "Import" && r.root && r.root.variables) {
                var vars = r.root.variables();
                for (var name in vars) {
                    if (vars.hasOwnProperty(name)) {
                        hash[name] = vars[name];
                    }
                }
            }
            return hash;
        }, {});
    }
    return this._variables;
};
Ruleset.prototype.variable = function (name) {
    return this.variables()[name];
};
Ruleset.prototype.rulesets = function () {
    if (!this.rules) { return []; }

    var filtRules = [], rules = this.rules, cnt = rules.length,
        i, rule;

    for (i = 0; i < cnt; i++) {
        rule = rules[i];
        if (rule.isRuleset) {
            filtRules.push(rule);
        }
    }

    return filtRules;
};
Ruleset.prototype.prependRule = function (rule) {
    var rules = this.rules;
    if (rules) {
        rules.unshift(rule);
    } else {
        this.rules = [ rule ];
    }
};
Ruleset.prototype.find = function (selector, self, filter) {
    self = self || this;
    var rules = [], match, foundMixins,
        key = selector.toCSS();

    if (key in this._lookups) { return this._lookups[key]; }

    this.rulesets().forEach(function (rule) {
        if (rule !== self) {
            for (var j = 0; j < rule.selectors.length; j++) {
                match = selector.match(rule.selectors[j]);
                if (match) {
                    if (selector.elements.length > match) {
                        if (!filter || filter(rule)) {
                            foundMixins = rule.find(new Selector(selector.elements.slice(match)), self, filter);
                            for (var i = 0; i < foundMixins.length; ++i) {
                                foundMixins[i].path.push(rule);
                            }
                            Array.prototype.push.apply(rules, foundMixins);
                        }
                    } else {
                        rules.push({ rule: rule, path: []});
                    }
                    break;
                }
            }
        }
    });
    this._lookups[key] = rules;
    return rules;
};
Ruleset.prototype.genCSS = function (context, output) {
    var i, j,
        charsetRuleNodes = [],
        ruleNodes = [],
        debugInfo,     // Line number debugging
        rule,
        path;

    context.tabLevel = (context.tabLevel || 0);

    if (!this.root) {
        context.tabLevel++;
    }

    var tabRuleStr = context.compress ? '' : Array(context.tabLevel + 1).join("  "),
        tabSetStr = context.compress ? '' : Array(context.tabLevel).join("  "),
        sep;

    function isRulesetLikeNode(rule) {
        // if it has nested rules, then it should be treated like a ruleset
        // medias and comments do not have nested rules, but should be treated like rulesets anyway
        // some directives and anonymous nodes are ruleset like, others are not
        if (typeof rule.isRulesetLike === "boolean") {
            return rule.isRulesetLike;
        } else if (typeof rule.isRulesetLike === "function") {
            return rule.isRulesetLike();
        }

        //anything else is assumed to be a rule
        return false;
    }

    var charsetNodeIndex = 0;
    var importNodeIndex = 0;
    for (i = 0; i < this.rules.length; i++) {
        rule = this.rules[i];
        if (rule.type === "Comment") {
            if (importNodeIndex === i) {
                importNodeIndex++;
            }
            ruleNodes.push(rule);
        } else if (rule.isCharset && rule.isCharset()) {
            ruleNodes.splice(charsetNodeIndex, 0, rule);
            charsetNodeIndex++;
            importNodeIndex++;
        } else if (rule.type === "Import") {
            ruleNodes.splice(importNodeIndex, 0, rule);
            importNodeIndex++;
        } else {
            ruleNodes.push(rule);
        }
    }
    ruleNodes = charsetRuleNodes.concat(ruleNodes);

    // If this is the root node, we don't render
    // a selector, or {}.
    if (!this.root) {
        debugInfo = getDebugInfo(context, this, tabSetStr);

        if (debugInfo) {
            output.add(debugInfo);
            output.add(tabSetStr);
        }

        var paths = this.paths, pathCnt = paths.length,
            pathSubCnt;

        sep = context.compress ? ',' : (',\n' + tabSetStr);

        for (i = 0; i < pathCnt; i++) {
            path = paths[i];
            if (!(pathSubCnt = path.length)) { continue; }
            if (i > 0) { output.add(sep); }

            context.firstSelector = true;
            path[0].genCSS(context, output);

            context.firstSelector = false;
            for (j = 1; j < pathSubCnt; j++) {
                path[j].genCSS(context, output);
            }
        }

        output.add((context.compress ? '{' : ' {\n') + tabRuleStr);
    }

    // Compile rules and rulesets
    for (i = 0; i < ruleNodes.length; i++) {
        rule = ruleNodes[i];

        if (i + 1 === ruleNodes.length) {
            context.lastRule = true;
        }

        var currentLastRule = context.lastRule;
        if (isRulesetLikeNode(rule)) {
            context.lastRule = false;
        }

        if (rule.genCSS) {
            rule.genCSS(context, output);
        } else if (rule.value) {
            output.add(rule.value.toString());
        }

        context.lastRule = currentLastRule;

        if (!context.lastRule) {
            output.add(context.compress ? '' : ('\n' + tabRuleStr));
        } else {
            context.lastRule = false;
        }
    }

    if (!this.root) {
        output.add((context.compress ? '}' : '\n' + tabSetStr + '}'));
        context.tabLevel--;
    }

    if (!output.isEmpty() && !context.compress && this.firstRoot) {
        output.add('\n');
    }
};

Ruleset.prototype.joinSelectors = function (paths, context, selectors) {
    for (var s = 0; s < selectors.length; s++) {
        this.joinSelector(paths, context, selectors[s]);
    }
};

Ruleset.prototype.joinSelector = function (paths, context, selector) {

    function createParenthesis(elementsToPak, originalElement) {
        var replacementParen, j;
        if (elementsToPak.length === 0) {
            replacementParen = new Paren(elementsToPak[0]);
        } else {
            var insideParent = [];
            for (j = 0; j < elementsToPak.length; j++) {
                insideParent.push(new Element(null, elementsToPak[j], originalElement.index, originalElement.currentFileInfo));
            }
            replacementParen = new Paren(new Selector(insideParent));
        }
        return replacementParen;
    }

    function createSelector(containedElement, originalElement) {
        var element, selector;
        element = new Element(null, containedElement, originalElement.index, originalElement.currentFileInfo);
        selector = new Selector([element]);
        return selector;
    }

    // joins selector path from `beginningPath` with selector path in `addPath`
    // `replacedElement` contains element that is being replaced by `addPath`
    // returns concatenated path
    function addReplacementIntoPath(beginningPath, addPath, replacedElement, originalSelector) {
        var newSelectorPath, lastSelector, newJoinedSelector;
        // our new selector path
        newSelectorPath = [];

        //construct the joined selector - if & is the first thing this will be empty,
        // if not newJoinedSelector will be the last set of elements in the selector
        if (beginningPath.length > 0) {
            newSelectorPath = beginningPath.slice(0);
            lastSelector = newSelectorPath.pop();
            newJoinedSelector = originalSelector.createDerived(lastSelector.elements.slice(0));
        }
        else {
            newJoinedSelector = originalSelector.createDerived([]);
        }

        if (addPath.length > 0) {
            // /deep/ is a combinator that is valid without anything in front of it
            // so if the & does not have a combinator that is "" or " " then
            // and there is a combinator on the parent, then grab that.
            // this also allows + a { & .b { .a & { ... though not sure why you would want to do that
            var combinator = replacedElement.combinator, parentEl = addPath[0].elements[0];
            if (combinator.emptyOrWhitespace && !parentEl.combinator.emptyOrWhitespace) {
                combinator = parentEl.combinator;
            }
            // join the elements so far with the first part of the parent
            newJoinedSelector.elements.push(new Element(combinator, parentEl.value, replacedElement.index, replacedElement.currentFileInfo));
            newJoinedSelector.elements = newJoinedSelector.elements.concat(addPath[0].elements.slice(1));
        }

        // now add the joined selector - but only if it is not empty
        if (newJoinedSelector.elements.length !== 0) {
            newSelectorPath.push(newJoinedSelector);
        }

        //put together the parent selectors after the join (e.g. the rest of the parent)
        if (addPath.length > 1) {
            var restOfPath = addPath.slice(1);
            restOfPath = restOfPath.map(function (selector) {
                return selector.createDerived(selector.elements, []);
            });
            newSelectorPath = newSelectorPath.concat(restOfPath);
        }
        return newSelectorPath;
    }

    // joins selector path from `beginningPath` with every selector path in `addPaths` array
    // `replacedElement` contains element that is being replaced by `addPath`
    // returns array with all concatenated paths
    function addAllReplacementsIntoPath( beginningPath, addPaths, replacedElement, originalSelector, result) {
        var j;
        for (j = 0; j < beginningPath.length; j++) {
            var newSelectorPath = addReplacementIntoPath(beginningPath[j], addPaths, replacedElement, originalSelector);
            result.push(newSelectorPath);
        }
        return result;
    }

    function mergeElementsOnToSelectors(elements, selectors) {
        var i, sel;

        if (elements.length === 0) {
            return ;
        }
        if (selectors.length === 0) {
            selectors.push([ new Selector(elements) ]);
            return;
        }

        for (i = 0; i < selectors.length; i++) {
            sel = selectors[i];

            // if the previous thing in sel is a parent this needs to join on to it
            if (sel.length > 0) {
                sel[sel.length - 1] = sel[sel.length - 1].createDerived(sel[sel.length - 1].elements.concat(elements));
            }
            else {
                sel.push(new Selector(elements));
            }
        }
    }

    // replace all parent selectors inside `inSelector` by content of `context` array
    // resulting selectors are returned inside `paths` array
    // returns true if `inSelector` contained at least one parent selector
    function replaceParentSelector(paths, context, inSelector) {
        // The paths are [[Selector]]
        // The first list is a list of comma separated selectors
        // The inner list is a list of inheritance separated selectors
        // e.g.
        // .a, .b {
        //   .c {
        //   }
        // }
        // == [[.a] [.c]] [[.b] [.c]]
        //
        var i, j, k, currentElements, newSelectors, selectorsMultiplied, sel, el, hadParentSelector = false, length, lastSelector;
        function findNestedSelector(element) {
            var maybeSelector;
            if (element.value.type !== 'Paren') {
                return null;
            }

            maybeSelector = element.value.value;
            if (maybeSelector.type !== 'Selector') {
                return null;
            }

            return maybeSelector;
        }

        // the elements from the current selector so far
        currentElements = [];
        // the current list of new selectors to add to the path.
        // We will build it up. We initiate it with one empty selector as we "multiply" the new selectors
        // by the parents
        newSelectors = [
            []
        ];

        for (i = 0; i < inSelector.elements.length; i++) {
            el = inSelector.elements[i];
            // non parent reference elements just get added
            if (el.value !== "&") {
                var nestedSelector = findNestedSelector(el);
                if (nestedSelector != null) {
                    // merge the current list of non parent selector elements
                    // on to the current list of selectors to add
                    mergeElementsOnToSelectors(currentElements, newSelectors);

                    var nestedPaths = [], replaced, replacedNewSelectors = [];
                    replaced = replaceParentSelector(nestedPaths, context, nestedSelector);
                    hadParentSelector = hadParentSelector || replaced;
                    //the nestedPaths array should have only one member - replaceParentSelector does not multiply selectors
                    for (k = 0; k < nestedPaths.length; k++) {
                        var replacementSelector = createSelector(createParenthesis(nestedPaths[k], el), el);
                        addAllReplacementsIntoPath(newSelectors, [replacementSelector], el, inSelector, replacedNewSelectors);
                    }
                    newSelectors = replacedNewSelectors;
                    currentElements = [];

                } else {
                    currentElements.push(el);
                }

            } else {
                hadParentSelector = true;
                // the new list of selectors to add
                selectorsMultiplied = [];

                // merge the current list of non parent selector elements
                // on to the current list of selectors to add
                mergeElementsOnToSelectors(currentElements, newSelectors);

                // loop through our current selectors
                for (j = 0; j < newSelectors.length; j++) {
                    sel = newSelectors[j];
                    // if we don't have any parent paths, the & might be in a mixin so that it can be used
                    // whether there are parents or not
                    if (context.length === 0) {
                        // the combinator used on el should now be applied to the next element instead so that
                        // it is not lost
                        if (sel.length > 0) {
                            sel[0].elements.push(new Element(el.combinator, '', el.index, el.currentFileInfo));
                        }
                        selectorsMultiplied.push(sel);
                    }
                    else {
                        // and the parent selectors
                        for (k = 0; k < context.length; k++) {
                            // We need to put the current selectors
                            // then join the last selector's elements on to the parents selectors
                            var newSelectorPath = addReplacementIntoPath(sel, context[k], el, inSelector);
                            // add that to our new set of selectors
                            selectorsMultiplied.push(newSelectorPath);
                        }
                    }
                }

                // our new selectors has been multiplied, so reset the state
                newSelectors = selectorsMultiplied;
                currentElements = [];
            }
        }

        // if we have any elements left over (e.g. .a& .b == .b)
        // add them on to all the current selectors
        mergeElementsOnToSelectors(currentElements, newSelectors);

        for (i = 0; i < newSelectors.length; i++) {
            length = newSelectors[i].length;
            if (length > 0) {
                paths.push(newSelectors[i]);
                lastSelector = newSelectors[i][length - 1];
                newSelectors[i][length - 1] = lastSelector.createDerived(lastSelector.elements, inSelector.extendList);
                //newSelectors[i][length - 1].copyVisibilityInfo(inSelector.visibilityInfo());
            }
        }

        return hadParentSelector;
    }

    function deriveSelector(visibilityInfo, deriveFrom) {
        var newSelector = deriveFrom.createDerived(deriveFrom.elements, deriveFrom.extendList, deriveFrom.evaldCondition);
        newSelector.copyVisibilityInfo(visibilityInfo);
        return newSelector;
    }

    // joinSelector code follows
    var i, newPaths, hadParentSelector;

    newPaths = [];
    hadParentSelector = replaceParentSelector(newPaths, context, selector);

    if (!hadParentSelector) {
        if (context.length > 0) {
            newPaths = [];
            for (i = 0; i < context.length; i++) {
                //var concatenated = [];
                //context[i].forEach(function(entry) {
                //    var newEntry = entry.createDerived(entry.elements, entry.extendList, entry.evaldCondition);
                //    newEntry.copyVisibilityInfo(selector.visibilityInfo());
                //    concatenated.push(newEntry);
                //}, this);
                var concatenated = context[i].map(deriveSelector.bind(this, selector.visibilityInfo()));

                concatenated.push(selector);
                newPaths.push(concatenated);
            }
        }
        else {
            newPaths = [[selector]];
        }
    }

    for (i = 0; i < newPaths.length; i++) {
        paths.push(newPaths[i]);
    }

};
module.exports = Ruleset;

},{"../contexts":16,"../functions/default":25,"../functions/function-registry":27,"./debug-info":59,"./element":63,"./node":75,"./paren":77,"./rule":79,"./selector":82}],82:[function(require,module,exports){
var Node = require("./node"),
    Element = require("./element");

var Selector = function (elements, extendList, condition, index, currentFileInfo, visibilityInfo) {
    this.elements = elements;
    this.extendList = extendList;
    this.condition = condition;
    this.currentFileInfo = currentFileInfo || {};
    if (!condition) {
        this.evaldCondition = true;
    }
    this.copyVisibilityInfo(visibilityInfo);
};
Selector.prototype = new Node();
Selector.prototype.type = "Selector";
Selector.prototype.accept = function (visitor) {
    if (this.elements) {
        this.elements = visitor.visitArray(this.elements);
    }
    if (this.extendList) {
        this.extendList = visitor.visitArray(this.extendList);
    }
    if (this.condition) {
        this.condition = visitor.visit(this.condition);
    }
};
Selector.prototype.createDerived = function(elements, extendList, evaldCondition) {
    var info = this.visibilityInfo();
    evaldCondition = (evaldCondition != null) ? evaldCondition : this.evaldCondition;
    var newSelector = new Selector(elements, extendList || this.extendList, null, this.index, this.currentFileInfo, info);
    newSelector.evaldCondition = evaldCondition;
    newSelector.mediaEmpty = this.mediaEmpty;
    return newSelector;
};
Selector.prototype.createEmptySelectors = function() {
    var el = new Element('', '&', this.index, this.currentFileInfo),
        sels = [new Selector([el], null, null, this.index, this.currentFileInfo)];
    sels[0].mediaEmpty = true;
    return sels;
};
Selector.prototype.match = function (other) {
    var elements = this.elements,
        len = elements.length,
        olen, i;

    other.CacheElements();

    olen = other._elements.length;
    if (olen === 0 || len < olen) {
        return 0;
    } else {
        for (i = 0; i < olen; i++) {
            if (elements[i].value !== other._elements[i]) {
                return 0;
            }
        }
    }

    return olen; // return number of matched elements
};
Selector.prototype.CacheElements = function() {
    if (this._elements) {
        return;
    }

    var elements = this.elements.map( function(v) {
        return v.combinator.value + (v.value.value || v.value);
    }).join("").match(/[,&#\*\.\w-]([\w-]|(\\.))*/g);

    if (elements) {
        if (elements[0] === "&") {
            elements.shift();
        }
    } else {
        elements = [];
    }

    this._elements = elements;
};
Selector.prototype.isJustParentSelector = function() {
    return !this.mediaEmpty &&
        this.elements.length === 1 &&
        this.elements[0].value === '&' &&
        (this.elements[0].combinator.value === ' ' || this.elements[0].combinator.value === '');
};
Selector.prototype.eval = function (context) {
    var evaldCondition = this.condition && this.condition.eval(context),
        elements = this.elements, extendList = this.extendList;

    elements = elements && elements.map(function (e) { return e.eval(context); });
    extendList = extendList && extendList.map(function(extend) { return extend.eval(context); });

    return this.createDerived(elements, extendList, evaldCondition);
};
Selector.prototype.genCSS = function (context, output) {
    var i, element;
    if ((!context || !context.firstSelector) && this.elements[0].combinator.value === "") {
        output.add(' ', this.currentFileInfo, this.index);
    }
    if (!this._css) {
        //TODO caching? speed comparison?
        for (i = 0; i < this.elements.length; i++) {
            element = this.elements[i];
            element.genCSS(context, output);
        }
    }
};
Selector.prototype.getIsOutput = function() {
    return this.evaldCondition;
};
module.exports = Selector;

},{"./element":63,"./node":75}],83:[function(require,module,exports){
var Node = require("./node");

var UnicodeDescriptor = function (value) {
    this.value = value;
};
UnicodeDescriptor.prototype = new Node();
UnicodeDescriptor.prototype.type = "UnicodeDescriptor";

module.exports = UnicodeDescriptor;

},{"./node":75}],84:[function(require,module,exports){
var Node = require("./node"),
    unitConversions = require("../data/unit-conversions");

var Unit = function (numerator, denominator, backupUnit) {
    this.numerator = numerator ? numerator.slice(0).sort() : [];
    this.denominator = denominator ? denominator.slice(0).sort() : [];
    if (backupUnit) {
        this.backupUnit = backupUnit;
    } else if (numerator && numerator.length) {
        this.backupUnit = numerator[0];
    }
};

Unit.prototype = new Node();
Unit.prototype.type = "Unit";
Unit.prototype.clone = function () {
    return new Unit(this.numerator.slice(0), this.denominator.slice(0), this.backupUnit);
};
Unit.prototype.genCSS = function (context, output) {
    // Dimension checks the unit is singular and throws an error if in strict math mode.
    var strictUnits = context && context.strictUnits;
    if (this.numerator.length === 1) {
        output.add(this.numerator[0]); // the ideal situation
    } else if (!strictUnits && this.backupUnit) {
        output.add(this.backupUnit);
    } else if (!strictUnits && this.denominator.length) {
        output.add(this.denominator[0]);
    }
};
Unit.prototype.toString = function () {
    var i, returnStr = this.numerator.join("*");
    for (i = 0; i < this.denominator.length; i++) {
        returnStr += "/" + this.denominator[i];
    }
    return returnStr;
};
Unit.prototype.compare = function (other) {
    return this.is(other.toString()) ? 0 : undefined;
};
Unit.prototype.is = function (unitString) {
    return this.toString().toUpperCase() === unitString.toUpperCase();
};
Unit.prototype.isLength = function () {
    return Boolean(this.toCSS().match(/px|em|%|in|cm|mm|pc|pt|ex/));
};
Unit.prototype.isEmpty = function () {
    return this.numerator.length === 0 && this.denominator.length === 0;
};
Unit.prototype.isSingular = function() {
    return this.numerator.length <= 1 && this.denominator.length === 0;
};
Unit.prototype.map = function(callback) {
    var i;

    for (i = 0; i < this.numerator.length; i++) {
        this.numerator[i] = callback(this.numerator[i], false);
    }

    for (i = 0; i < this.denominator.length; i++) {
        this.denominator[i] = callback(this.denominator[i], true);
    }
};
Unit.prototype.usedUnits = function() {
    var group, result = {}, mapUnit, groupName;

    mapUnit = function (atomicUnit) {
        /*jshint loopfunc:true */
        if (group.hasOwnProperty(atomicUnit) && !result[groupName]) {
            result[groupName] = atomicUnit;
        }

        return atomicUnit;
    };

    for (groupName in unitConversions) {
        if (unitConversions.hasOwnProperty(groupName)) {
            group = unitConversions[groupName];

            this.map(mapUnit);
        }
    }

    return result;
};
Unit.prototype.cancel = function () {
    var counter = {}, atomicUnit, i;

    for (i = 0; i < this.numerator.length; i++) {
        atomicUnit = this.numerator[i];
        counter[atomicUnit] = (counter[atomicUnit] || 0) + 1;
    }

    for (i = 0; i < this.denominator.length; i++) {
        atomicUnit = this.denominator[i];
        counter[atomicUnit] = (counter[atomicUnit] || 0) - 1;
    }

    this.numerator = [];
    this.denominator = [];

    for (atomicUnit in counter) {
        if (counter.hasOwnProperty(atomicUnit)) {
            var count = counter[atomicUnit];

            if (count > 0) {
                for (i = 0; i < count; i++) {
                    this.numerator.push(atomicUnit);
                }
            } else if (count < 0) {
                for (i = 0; i < -count; i++) {
                    this.denominator.push(atomicUnit);
                }
            }
        }
    }

    this.numerator.sort();
    this.denominator.sort();
};
module.exports = Unit;

},{"../data/unit-conversions":19,"./node":75}],85:[function(require,module,exports){
var Node = require("./node");

var URL = function (val, index, currentFileInfo, isEvald) {
    this.value = val;
    this.currentFileInfo = currentFileInfo;
    this.index = index;
    this.isEvald = isEvald;
};
URL.prototype = new Node();
URL.prototype.type = "Url";
URL.prototype.accept = function (visitor) {
    this.value = visitor.visit(this.value);
};
URL.prototype.genCSS = function (context, output) {
    output.add("url(");
    this.value.genCSS(context, output);
    output.add(")");
};
URL.prototype.eval = function (context) {
    var val = this.value.eval(context),
        rootpath;

    if (!this.isEvald) {
        // Add the base path if the URL is relative
        rootpath = this.currentFileInfo && this.currentFileInfo.rootpath;
        if (rootpath &&
            typeof val.value === "string" &&
            context.isPathRelative(val.value)) {

            if (!val.quote) {
                rootpath = rootpath.replace(/[\(\)'"\s]/g, function(match) { return "\\" + match; });
            }
            val.value = rootpath + val.value;
        }

        val.value = context.normalizePath(val.value);

        // Add url args if enabled
        if (context.urlArgs) {
            if (!val.value.match(/^\s*data:/)) {
                var delimiter = val.value.indexOf('?') === -1 ? '?' : '&';
                var urlArgs = delimiter + context.urlArgs;
                if (val.value.indexOf('#') !== -1) {
                    val.value = val.value.replace('#', urlArgs + '#');
                } else {
                    val.value += urlArgs;
                }
            }
        }
    }

    return new URL(val, this.index, this.currentFileInfo, true);
};
module.exports = URL;

},{"./node":75}],86:[function(require,module,exports){
var Node = require("./node");

var Value = function (value) {
    this.value = value;
    if (!value) {
        throw new Error("Value requires an array argument");
    }
};
Value.prototype = new Node();
Value.prototype.type = "Value";
Value.prototype.accept = function (visitor) {
    if (this.value) {
        this.value = visitor.visitArray(this.value);
    }
};
Value.prototype.eval = function (context) {
    if (this.value.length === 1) {
        return this.value[0].eval(context);
    } else {
        return new Value(this.value.map(function (v) {
            return v.eval(context);
        }));
    }
};
Value.prototype.genCSS = function (context, output) {
    var i;
    for (i = 0; i < this.value.length; i++) {
        this.value[i].genCSS(context, output);
        if (i + 1 < this.value.length) {
            output.add((context && context.compress) ? ',' : ', ');
        }
    }
};
module.exports = Value;

},{"./node":75}],87:[function(require,module,exports){
var Node = require("./node");

var Variable = function (name, index, currentFileInfo) {
    this.name = name;
    this.index = index;
    this.currentFileInfo = currentFileInfo || {};
};
Variable.prototype = new Node();
Variable.prototype.type = "Variable";
Variable.prototype.eval = function (context) {
    var variable, name = this.name;

    if (name.indexOf('@@') === 0) {
        name = '@' + new Variable(name.slice(1), this.index, this.currentFileInfo).eval(context).value;
    }

    if (this.evaluating) {
        throw { type: 'Name',
                message: "Recursive variable definition for " + name,
                filename: this.currentFileInfo.filename,
                index: this.index };
    }

    this.evaluating = true;

    variable = this.find(context.frames, function (frame) {
        var v = frame.variable(name);
        if (v) {
            if (v.important) {
                var importantScope = context.importantScope[context.importantScope.length - 1];
                importantScope.important = v.important;
            }
            return v.value.eval(context);
        }
    });
    if (variable) {
        this.evaluating = false;
        return variable;
    } else {
        throw { type: 'Name',
                message: "variable " + name + " is undefined",
                filename: this.currentFileInfo.filename,
                index: this.index };
    }
};
Variable.prototype.find = function (obj, fun) {
    for (var i = 0, r; i < obj.length; i++) {
        r = fun.call(obj, obj[i]);
        if (r) { return r; }
    }
    return null;
};
module.exports = Variable;

},{"./node":75}],88:[function(require,module,exports){
module.exports = {
    getLocation: function(index, inputStream) {
        var n = index + 1,
            line = null,
            column = -1;

        while (--n >= 0 && inputStream.charAt(n) !== '\n') {
            column++;
        }

        if (typeof index === 'number') {
            line = (inputStream.slice(0, index).match(/\n/g) || "").length;
        }

        return {
            line: line,
            column: column
        };
    }
};

},{}],89:[function(require,module,exports){
var tree = require("../tree"),
    Visitor = require("./visitor"),
    logger = require("../logger");

/*jshint loopfunc:true */

var ExtendFinderVisitor = function() {
    this._visitor = new Visitor(this);
    this.contexts = [];
    this.allExtendsStack = [[]];
};

ExtendFinderVisitor.prototype = {
    run: function (root) {
        root = this._visitor.visit(root);
        root.allExtends = this.allExtendsStack[0];
        return root;
    },
    visitRule: function (ruleNode, visitArgs) {
        visitArgs.visitDeeper = false;
    },
    visitMixinDefinition: function (mixinDefinitionNode, visitArgs) {
        visitArgs.visitDeeper = false;
    },
    visitRuleset: function (rulesetNode, visitArgs) {
        if (rulesetNode.root) {
            return;
        }

        var i, j, extend, allSelectorsExtendList = [], extendList;

        // get &:extend(.a); rules which apply to all selectors in this ruleset
        var rules = rulesetNode.rules, ruleCnt = rules ? rules.length : 0;
        for (i = 0; i < ruleCnt; i++) {
            if (rulesetNode.rules[i] instanceof tree.Extend) {
                allSelectorsExtendList.push(rules[i]);
                rulesetNode.extendOnEveryPath = true;
            }
        }

        // now find every selector and apply the extends that apply to all extends
        // and the ones which apply to an individual extend
        var paths = rulesetNode.paths;
        for (i = 0; i < paths.length; i++) {
            var selectorPath = paths[i],
                selector = selectorPath[selectorPath.length - 1],
                selExtendList = selector.extendList;

            extendList = selExtendList ? selExtendList.slice(0).concat(allSelectorsExtendList)
                                       : allSelectorsExtendList;

            if (extendList) {
                extendList = extendList.map(function(allSelectorsExtend) {
                    return allSelectorsExtend.clone();
                });
            }

            for (j = 0; j < extendList.length; j++) {
                this.foundExtends = true;
                extend = extendList[j];
                extend.findSelfSelectors(selectorPath);
                extend.ruleset = rulesetNode;
                if (j === 0) { extend.firstExtendOnThisSelectorPath = true; }
                this.allExtendsStack[this.allExtendsStack.length - 1].push(extend);
            }
        }

        this.contexts.push(rulesetNode.selectors);
    },
    visitRulesetOut: function (rulesetNode) {
        if (!rulesetNode.root) {
            this.contexts.length = this.contexts.length - 1;
        }
    },
    visitMedia: function (mediaNode, visitArgs) {
        mediaNode.allExtends = [];
        this.allExtendsStack.push(mediaNode.allExtends);
    },
    visitMediaOut: function (mediaNode) {
        this.allExtendsStack.length = this.allExtendsStack.length - 1;
    },
    visitDirective: function (directiveNode, visitArgs) {
        directiveNode.allExtends = [];
        this.allExtendsStack.push(directiveNode.allExtends);
    },
    visitDirectiveOut: function (directiveNode) {
        this.allExtendsStack.length = this.allExtendsStack.length - 1;
    }
};

var ProcessExtendsVisitor = function() {
    this._visitor = new Visitor(this);
};

ProcessExtendsVisitor.prototype = {
    run: function(root) {
        var extendFinder = new ExtendFinderVisitor();
        this.extendIndices = {};
        extendFinder.run(root);
        if (!extendFinder.foundExtends) { return root; }
        root.allExtends = root.allExtends.concat(this.doExtendChaining(root.allExtends, root.allExtends));
        this.allExtendsStack = [root.allExtends];
        var newRoot = this._visitor.visit(root);
        this.checkExtendsForNonMatched(root.allExtends);
        return newRoot;
    },
    checkExtendsForNonMatched: function(extendList) {
        var indices = this.extendIndices;
        extendList.filter(function(extend) {
            return !extend.hasFoundMatches && extend.parent_ids.length == 1;
        }).forEach(function(extend) {
                var selector = "_unknown_";
                try {
                    selector = extend.selector.toCSS({});
                }
                catch(_) {}

                if (!indices[extend.index + ' ' + selector]) {
                    indices[extend.index + ' ' + selector] = true;
                    logger.warn("extend '" + selector + "' has no matches");
                }
            });
    },
    doExtendChaining: function (extendsList, extendsListTarget, iterationCount) {
        //
        // chaining is different from normal extension.. if we extend an extend then we are not just copying, altering
        // and pasting the selector we would do normally, but we are also adding an extend with the same target selector
        // this means this new extend can then go and alter other extends
        //
        // this method deals with all the chaining work - without it, extend is flat and doesn't work on other extend selectors
        // this is also the most expensive.. and a match on one selector can cause an extension of a selector we had already
        // processed if we look at each selector at a time, as is done in visitRuleset

        var extendIndex, targetExtendIndex, matches, extendsToAdd = [], newSelector, extendVisitor = this, selectorPath,
            extend, targetExtend, newExtend;

        iterationCount = iterationCount || 0;

        //loop through comparing every extend with every target extend.
        // a target extend is the one on the ruleset we are looking at copy/edit/pasting in place
        // e.g.  .a:extend(.b) {}  and .b:extend(.c) {} then the first extend extends the second one
        // and the second is the target.
        // the separation into two lists allows us to process a subset of chains with a bigger set, as is the
        // case when processing media queries
        for (extendIndex = 0; extendIndex < extendsList.length; extendIndex++) {
            for (targetExtendIndex = 0; targetExtendIndex < extendsListTarget.length; targetExtendIndex++) {

                extend = extendsList[extendIndex];
                targetExtend = extendsListTarget[targetExtendIndex];

                // look for circular references
                if ( extend.parent_ids.indexOf( targetExtend.object_id ) >= 0 ) { continue; }

                // find a match in the target extends self selector (the bit before :extend)
                selectorPath = [targetExtend.selfSelectors[0]];
                matches = extendVisitor.findMatch(extend, selectorPath);

                if (matches.length) {
                    extend.hasFoundMatches = true;

                    // we found a match, so for each self selector..
                    extend.selfSelectors.forEach(function(selfSelector) {
                        var info = targetExtend.visibilityInfo();

                        // process the extend as usual
                        newSelector = extendVisitor.extendSelector(matches, selectorPath, selfSelector, extend.isVisible());

                        // but now we create a new extend from it
                        newExtend = new(tree.Extend)(targetExtend.selector, targetExtend.option, 0, targetExtend.currentFileInfo, info);
                        newExtend.selfSelectors = newSelector;

                        // add the extend onto the list of extends for that selector
                        newSelector[newSelector.length - 1].extendList = [newExtend];

                        // record that we need to add it.
                        extendsToAdd.push(newExtend);
                        newExtend.ruleset = targetExtend.ruleset;

                        //remember its parents for circular references
                        newExtend.parent_ids = newExtend.parent_ids.concat(targetExtend.parent_ids, extend.parent_ids);

                        // only process the selector once.. if we have :extend(.a,.b) then multiple
                        // extends will look at the same selector path, so when extending
                        // we know that any others will be duplicates in terms of what is added to the css
                        if (targetExtend.firstExtendOnThisSelectorPath) {
                            newExtend.firstExtendOnThisSelectorPath = true;
                            targetExtend.ruleset.paths.push(newSelector);
                        }
                    });
                }
            }
        }

        if (extendsToAdd.length) {
            // try to detect circular references to stop a stack overflow.
            // may no longer be needed.
            this.extendChainCount++;
            if (iterationCount > 100) {
                var selectorOne = "{unable to calculate}";
                var selectorTwo = "{unable to calculate}";
                try {
                    selectorOne = extendsToAdd[0].selfSelectors[0].toCSS();
                    selectorTwo = extendsToAdd[0].selector.toCSS();
                }
                catch(e) {}
                throw { message: "extend circular reference detected. One of the circular extends is currently:" +
                    selectorOne + ":extend(" + selectorTwo + ")"};
            }

            // now process the new extends on the existing rules so that we can handle a extending b extending c extending
            // d extending e...
            return extendsToAdd.concat(extendVisitor.doExtendChaining(extendsToAdd, extendsListTarget, iterationCount + 1));
        } else {
            return extendsToAdd;
        }
    },
    visitRule: function (ruleNode, visitArgs) {
        visitArgs.visitDeeper = false;
    },
    visitMixinDefinition: function (mixinDefinitionNode, visitArgs) {
        visitArgs.visitDeeper = false;
    },
    visitSelector: function (selectorNode, visitArgs) {
        visitArgs.visitDeeper = false;
    },
    visitRuleset: function (rulesetNode, visitArgs) {
        if (rulesetNode.root) {
            return;
        }
        var matches, pathIndex, extendIndex, allExtends = this.allExtendsStack[this.allExtendsStack.length - 1],
            selectorsToAdd = [], extendVisitor = this, selectorPath;

        // look at each selector path in the ruleset, find any extend matches and then copy, find and replace

        for (extendIndex = 0; extendIndex < allExtends.length; extendIndex++) {
            for (pathIndex = 0; pathIndex < rulesetNode.paths.length; pathIndex++) {
                selectorPath = rulesetNode.paths[pathIndex];

                // extending extends happens initially, before the main pass
                if (rulesetNode.extendOnEveryPath) { continue; }
                var extendList = selectorPath[selectorPath.length - 1].extendList;
                if (extendList && extendList.length) { continue; }

                matches = this.findMatch(allExtends[extendIndex], selectorPath);

                if (matches.length) {
                    allExtends[extendIndex].hasFoundMatches = true;

                    allExtends[extendIndex].selfSelectors.forEach(function(selfSelector) {
                        var extendedSelectors;
                        extendedSelectors = extendVisitor.extendSelector(matches, selectorPath, selfSelector, allExtends[extendIndex].isVisible());
                        selectorsToAdd.push(extendedSelectors);
                    });
                }
            }
        }
        rulesetNode.paths = rulesetNode.paths.concat(selectorsToAdd);
    },
    findMatch: function (extend, haystackSelectorPath) {
        //
        // look through the haystack selector path to try and find the needle - extend.selector
        // returns an array of selector matches that can then be replaced
        //
        var haystackSelectorIndex, hackstackSelector, hackstackElementIndex, haystackElement,
            targetCombinator, i,
            extendVisitor = this,
            needleElements = extend.selector.elements,
            potentialMatches = [], potentialMatch, matches = [];

        // loop through the haystack elements
        for (haystackSelectorIndex = 0; haystackSelectorIndex < haystackSelectorPath.length; haystackSelectorIndex++) {
            hackstackSelector = haystackSelectorPath[haystackSelectorIndex];

            for (hackstackElementIndex = 0; hackstackElementIndex < hackstackSelector.elements.length; hackstackElementIndex++) {

                haystackElement = hackstackSelector.elements[hackstackElementIndex];

                // if we allow elements before our match we can add a potential match every time. otherwise only at the first element.
                if (extend.allowBefore || (haystackSelectorIndex === 0 && hackstackElementIndex === 0)) {
                    potentialMatches.push({pathIndex: haystackSelectorIndex, index: hackstackElementIndex, matched: 0,
                        initialCombinator: haystackElement.combinator});
                }

                for (i = 0; i < potentialMatches.length; i++) {
                    potentialMatch = potentialMatches[i];

                    // selectors add " " onto the first element. When we use & it joins the selectors together, but if we don't
                    // then each selector in haystackSelectorPath has a space before it added in the toCSS phase. so we need to
                    // work out what the resulting combinator will be
                    targetCombinator = haystackElement.combinator.value;
                    if (targetCombinator === '' && hackstackElementIndex === 0) {
                        targetCombinator = ' ';
                    }

                    // if we don't match, null our match to indicate failure
                    if (!extendVisitor.isElementValuesEqual(needleElements[potentialMatch.matched].value, haystackElement.value) ||
                        (potentialMatch.matched > 0 && needleElements[potentialMatch.matched].combinator.value !== targetCombinator)) {
                        potentialMatch = null;
                    } else {
                        potentialMatch.matched++;
                    }

                    // if we are still valid and have finished, test whether we have elements after and whether these are allowed
                    if (potentialMatch) {
                        potentialMatch.finished = potentialMatch.matched === needleElements.length;
                        if (potentialMatch.finished &&
                            (!extend.allowAfter &&
                                (hackstackElementIndex + 1 < hackstackSelector.elements.length || haystackSelectorIndex + 1 < haystackSelectorPath.length))) {
                            potentialMatch = null;
                        }
                    }
                    // if null we remove, if not, we are still valid, so either push as a valid match or continue
                    if (potentialMatch) {
                        if (potentialMatch.finished) {
                            potentialMatch.length = needleElements.length;
                            potentialMatch.endPathIndex = haystackSelectorIndex;
                            potentialMatch.endPathElementIndex = hackstackElementIndex + 1; // index after end of match
                            potentialMatches.length = 0; // we don't allow matches to overlap, so start matching again
                            matches.push(potentialMatch);
                        }
                    } else {
                        potentialMatches.splice(i, 1);
                        i--;
                    }
                }
            }
        }
        return matches;
    },
    isElementValuesEqual: function(elementValue1, elementValue2) {
        if (typeof elementValue1 === "string" || typeof elementValue2 === "string") {
            return elementValue1 === elementValue2;
        }
        if (elementValue1 instanceof tree.Attribute) {
            if (elementValue1.op !== elementValue2.op || elementValue1.key !== elementValue2.key) {
                return false;
            }
            if (!elementValue1.value || !elementValue2.value) {
                if (elementValue1.value || elementValue2.value) {
                    return false;
                }
                return true;
            }
            elementValue1 = elementValue1.value.value || elementValue1.value;
            elementValue2 = elementValue2.value.value || elementValue2.value;
            return elementValue1 === elementValue2;
        }
        elementValue1 = elementValue1.value;
        elementValue2 = elementValue2.value;
        if (elementValue1 instanceof tree.Selector) {
            if (!(elementValue2 instanceof tree.Selector) || elementValue1.elements.length !== elementValue2.elements.length) {
                return false;
            }
            for (var i = 0; i  < elementValue1.elements.length; i++) {
                if (elementValue1.elements[i].combinator.value !== elementValue2.elements[i].combinator.value) {
                    if (i !== 0 || (elementValue1.elements[i].combinator.value || ' ') !== (elementValue2.elements[i].combinator.value || ' ')) {
                        return false;
                    }
                }
                if (!this.isElementValuesEqual(elementValue1.elements[i].value, elementValue2.elements[i].value)) {
                    return false;
                }
            }
            return true;
        }
        return false;
    },
    extendSelector:function (matches, selectorPath, replacementSelector, isVisible) {

        //for a set of matches, replace each match with the replacement selector

        var currentSelectorPathIndex = 0,
            currentSelectorPathElementIndex = 0,
            path = [],
            matchIndex,
            selector,
            firstElement,
            match,
            newElements;

        for (matchIndex = 0; matchIndex < matches.length; matchIndex++) {
            match = matches[matchIndex];
            selector = selectorPath[match.pathIndex];
            firstElement = new tree.Element(
                match.initialCombinator,
                replacementSelector.elements[0].value,
                replacementSelector.elements[0].index,
                replacementSelector.elements[0].currentFileInfo
            );

            if (match.pathIndex > currentSelectorPathIndex && currentSelectorPathElementIndex > 0) {
                path[path.length - 1].elements = path[path.length - 1]
                    .elements.concat(selectorPath[currentSelectorPathIndex].elements.slice(currentSelectorPathElementIndex));
                currentSelectorPathElementIndex = 0;
                currentSelectorPathIndex++;
            }

            newElements = selector.elements
                .slice(currentSelectorPathElementIndex, match.index)
                .concat([firstElement])
                .concat(replacementSelector.elements.slice(1));

            if (currentSelectorPathIndex === match.pathIndex && matchIndex > 0) {
                path[path.length - 1].elements =
                    path[path.length - 1].elements.concat(newElements);
            } else {
                path = path.concat(selectorPath.slice(currentSelectorPathIndex, match.pathIndex));

                path.push(new tree.Selector(
                    newElements
                ));
            }
            currentSelectorPathIndex = match.endPathIndex;
            currentSelectorPathElementIndex = match.endPathElementIndex;
            if (currentSelectorPathElementIndex >= selectorPath[currentSelectorPathIndex].elements.length) {
                currentSelectorPathElementIndex = 0;
                currentSelectorPathIndex++;
            }
        }

        if (currentSelectorPathIndex < selectorPath.length && currentSelectorPathElementIndex > 0) {
            path[path.length - 1].elements = path[path.length - 1]
                .elements.concat(selectorPath[currentSelectorPathIndex].elements.slice(currentSelectorPathElementIndex));
            currentSelectorPathIndex++;
        }

        path = path.concat(selectorPath.slice(currentSelectorPathIndex, selectorPath.length));
        path = path.map(function (currentValue) {
            // we can re-use elements here, because the visibility property matters only for selectors
            var derived = currentValue.createDerived(currentValue.elements);
            if (isVisible) {
                derived.ensureVisibility();
            } else {
                derived.ensureInvisibility();
            }
            return derived;
        });
        return path;
    },
    visitMedia: function (mediaNode, visitArgs) {
        var newAllExtends = mediaNode.allExtends.concat(this.allExtendsStack[this.allExtendsStack.length - 1]);
        newAllExtends = newAllExtends.concat(this.doExtendChaining(newAllExtends, mediaNode.allExtends));
        this.allExtendsStack.push(newAllExtends);
    },
    visitMediaOut: function (mediaNode) {
        var lastIndex = this.allExtendsStack.length - 1;
        this.allExtendsStack.length = lastIndex;
    },
    visitDirective: function (directiveNode, visitArgs) {
        var newAllExtends = directiveNode.allExtends.concat(this.allExtendsStack[this.allExtendsStack.length - 1]);
        newAllExtends = newAllExtends.concat(this.doExtendChaining(newAllExtends, directiveNode.allExtends));
        this.allExtendsStack.push(newAllExtends);
    },
    visitDirectiveOut: function (directiveNode) {
        var lastIndex = this.allExtendsStack.length - 1;
        this.allExtendsStack.length = lastIndex;
    }
};

module.exports = ProcessExtendsVisitor;

},{"../logger":38,"../tree":67,"./visitor":96}],90:[function(require,module,exports){
function ImportSequencer(onSequencerEmpty) {
    this.imports = [];
    this.variableImports = [];
    this._onSequencerEmpty = onSequencerEmpty;
    this._currentDepth = 0;
}

ImportSequencer.prototype.addImport = function(callback) {
    var importSequencer = this,
        importItem = {
            callback: callback,
            args: null,
            isReady: false
        };
    this.imports.push(importItem);
    return function() {
        importItem.args = Array.prototype.slice.call(arguments, 0);
        importItem.isReady = true;
        importSequencer.tryRun();
    };
};

ImportSequencer.prototype.addVariableImport = function(callback) {
    this.variableImports.push(callback);
};

ImportSequencer.prototype.tryRun = function() {
    this._currentDepth++;
    try {
        while (true) {
            while (this.imports.length > 0) {
                var importItem = this.imports[0];
                if (!importItem.isReady) {
                    return;
                }
                this.imports = this.imports.slice(1);
                importItem.callback.apply(null, importItem.args);
            }
            if (this.variableImports.length === 0) {
                break;
            }
            var variableImport = this.variableImports[0];
            this.variableImports = this.variableImports.slice(1);
            variableImport();
        }
    } finally {
        this._currentDepth--;
    }
    if (this._currentDepth === 0 && this._onSequencerEmpty) {
        this._onSequencerEmpty();
    }
};

module.exports = ImportSequencer;

},{}],91:[function(require,module,exports){
var contexts = require("../contexts"),
    Visitor = require("./visitor"),
    ImportSequencer = require("./import-sequencer");

var ImportVisitor = function(importer, finish) {

    this._visitor = new Visitor(this);
    this._importer = importer;
    this._finish = finish;
    this.context = new contexts.Eval();
    this.importCount = 0;
    this.onceFileDetectionMap = {};
    this.recursionDetector = {};
    this._sequencer = new ImportSequencer(this._onSequencerEmpty.bind(this));
};

ImportVisitor.prototype = {
    isReplacing: false,
    run: function (root) {
        try {
            // process the contents
            this._visitor.visit(root);
        }
        catch(e) {
            this.error = e;
        }

        this.isFinished = true;
        this._sequencer.tryRun();
    },
    _onSequencerEmpty: function() {
        if (!this.isFinished) {
            return;
        }
        this._finish(this.error);
    },
    visitImport: function (importNode, visitArgs) {
        var inlineCSS = importNode.options.inline;

        if (!importNode.css || inlineCSS) {

            var context = new contexts.Eval(this.context, this.context.frames.slice(0));
            var importParent = context.frames[0];

            this.importCount++;
            if (importNode.isVariableImport()) {
                this._sequencer.addVariableImport(this.processImportNode.bind(this, importNode, context, importParent));
            } else {
                this.processImportNode(importNode, context, importParent);
            }
        }
        visitArgs.visitDeeper = false;
    },
    processImportNode: function(importNode, context, importParent) {
        var evaldImportNode,
            inlineCSS = importNode.options.inline;

        try {
            evaldImportNode = importNode.evalForImport(context);
        } catch(e) {
            if (!e.filename) { e.index = importNode.index; e.filename = importNode.currentFileInfo.filename; }
            // attempt to eval properly and treat as css
            importNode.css = true;
            // if that fails, this error will be thrown
            importNode.error = e;
        }

        if (evaldImportNode && (!evaldImportNode.css || inlineCSS)) {

            if (evaldImportNode.options.multiple) {
                context.importMultiple = true;
            }

            // try appending if we haven't determined if it is css or not
            var tryAppendLessExtension = evaldImportNode.css === undefined;

            for (var i = 0; i < importParent.rules.length; i++) {
                if (importParent.rules[i] === importNode) {
                    importParent.rules[i] = evaldImportNode;
                    break;
                }
            }

            var onImported = this.onImported.bind(this, evaldImportNode, context),
                sequencedOnImported = this._sequencer.addImport(onImported);

            this._importer.push(evaldImportNode.getPath(), tryAppendLessExtension, evaldImportNode.currentFileInfo,
                evaldImportNode.options, sequencedOnImported);
        } else {
            this.importCount--;
            if (this.isFinished) {
                this._sequencer.tryRun();
            }
        }
    },
    onImported: function (importNode, context, e, root, importedAtRoot, fullPath) {
        if (e) {
            if (!e.filename) {
                e.index = importNode.index; e.filename = importNode.currentFileInfo.filename;
            }
            this.error = e;
        }

        var importVisitor = this,
            inlineCSS = importNode.options.inline,
            isPlugin = importNode.options.plugin,
            isOptional = importNode.options.optional,
            duplicateImport = importedAtRoot || fullPath in importVisitor.recursionDetector;

        if (!context.importMultiple) {
            if (duplicateImport) {
                importNode.skip = true;
            } else {
                importNode.skip = function() {
                    if (fullPath in importVisitor.onceFileDetectionMap) {
                        return true;
                    }
                    importVisitor.onceFileDetectionMap[fullPath] = true;
                    return false;
                };
            }
        }

        if (!fullPath && isOptional) {
            importNode.skip = true;
        }

        if (root) {
            importNode.root = root;
            importNode.importedFilename = fullPath;

            if (!inlineCSS && !isPlugin && (context.importMultiple || !duplicateImport)) {
                importVisitor.recursionDetector[fullPath] = true;

                var oldContext = this.context;
                this.context = context;
                try {
                    this._visitor.visit(root);
                } catch (e) {
                    this.error = e;
                }
                this.context = oldContext;
            }
        }

        importVisitor.importCount--;

        if (importVisitor.isFinished) {
            importVisitor._sequencer.tryRun();
        }
    },
    visitRule: function (ruleNode, visitArgs) {
        if (ruleNode.value.type === "DetachedRuleset") {
            this.context.frames.unshift(ruleNode);
        } else {
            visitArgs.visitDeeper = false;
        }
    },
    visitRuleOut : function(ruleNode) {
        if (ruleNode.value.type === "DetachedRuleset") {
            this.context.frames.shift();
        }
    },
    visitDirective: function (directiveNode, visitArgs) {
        this.context.frames.unshift(directiveNode);
    },
    visitDirectiveOut: function (directiveNode) {
        this.context.frames.shift();
    },
    visitMixinDefinition: function (mixinDefinitionNode, visitArgs) {
        this.context.frames.unshift(mixinDefinitionNode);
    },
    visitMixinDefinitionOut: function (mixinDefinitionNode) {
        this.context.frames.shift();
    },
    visitRuleset: function (rulesetNode, visitArgs) {
        this.context.frames.unshift(rulesetNode);
    },
    visitRulesetOut: function (rulesetNode) {
        this.context.frames.shift();
    },
    visitMedia: function (mediaNode, visitArgs) {
        this.context.frames.unshift(mediaNode.rules[0]);
    },
    visitMediaOut: function (mediaNode) {
        this.context.frames.shift();
    }
};
module.exports = ImportVisitor;

},{"../contexts":16,"./import-sequencer":90,"./visitor":96}],92:[function(require,module,exports){
var visitors = {
    Visitor: require("./visitor"),
    ImportVisitor: require('./import-visitor'),
    MarkVisibleSelectorsVisitor: require("./set-tree-visibility-visitor"),
    ExtendVisitor: require('./extend-visitor'),
    JoinSelectorVisitor: require('./join-selector-visitor'),
    ToCSSVisitor: require('./to-css-visitor')
};

module.exports = visitors;

},{"./extend-visitor":89,"./import-visitor":91,"./join-selector-visitor":93,"./set-tree-visibility-visitor":94,"./to-css-visitor":95,"./visitor":96}],93:[function(require,module,exports){
var Visitor = require("./visitor");

var JoinSelectorVisitor = function() {
    this.contexts = [[]];
    this._visitor = new Visitor(this);
};

JoinSelectorVisitor.prototype = {
    run: function (root) {
        return this._visitor.visit(root);
    },
    visitRule: function (ruleNode, visitArgs) {
        visitArgs.visitDeeper = false;
    },
    visitMixinDefinition: function (mixinDefinitionNode, visitArgs) {
        visitArgs.visitDeeper = false;
    },

    visitRuleset: function (rulesetNode, visitArgs) {
        var context = this.contexts[this.contexts.length - 1],
            paths = [], selectors;

        this.contexts.push(paths);

        if (! rulesetNode.root) {
            selectors = rulesetNode.selectors;
            if (selectors) {
                selectors = selectors.filter(function(selector) { return selector.getIsOutput(); });
                rulesetNode.selectors = selectors.length ? selectors : (selectors = null);
                if (selectors) { rulesetNode.joinSelectors(paths, context, selectors); }
            }
            if (!selectors) { rulesetNode.rules = null; }
            rulesetNode.paths = paths;
        }
    },
    visitRulesetOut: function (rulesetNode) {
        this.contexts.length = this.contexts.length - 1;
    },
    visitMedia: function (mediaNode, visitArgs) {
        var context = this.contexts[this.contexts.length - 1];
        mediaNode.rules[0].root = (context.length === 0 || context[0].multiMedia);
    },
    visitDirective: function (directiveNode, visitArgs) {
        var context = this.contexts[this.contexts.length - 1];
        if (directiveNode.rules && directiveNode.rules.length) {
            directiveNode.rules[0].root = (directiveNode.isRooted || context.length === 0 || null);
        }
    }
};

module.exports = JoinSelectorVisitor;

},{"./visitor":96}],94:[function(require,module,exports){
var SetTreeVisibilityVisitor = function(visible) {
    this.visible = visible;
};
SetTreeVisibilityVisitor.prototype.run = function(root) {
    this.visit(root);
};
SetTreeVisibilityVisitor.prototype.visitArray = function(nodes) {
    if (!nodes) {
        return nodes;
    }

    var cnt = nodes.length, i;
    for (i = 0; i < cnt; i++) {
        this.visit(nodes[i]);
    }
    return nodes;
};
SetTreeVisibilityVisitor.prototype.visit = function(node) {
    if (!node) {
        return node;
    }
    if (node.constructor === Array) {
        return this.visitArray(node);
    }

    if (!node.blocksVisibility || node.blocksVisibility()) {
        return node;
    }
    if (this.visible) {
        node.ensureVisibility();
    } else {
        node.ensureInvisibility();
    }

    node.accept(this);
    return node;
};
module.exports = SetTreeVisibilityVisitor;
},{}],95:[function(require,module,exports){
var tree = require("../tree"),
    Visitor = require("./visitor");

var CSSVisitorUtils = function(context) {
    this._visitor = new Visitor(this);
    this._context = context;
};

CSSVisitorUtils.prototype = {
    containsSilentNonBlockedChild: function(bodyRules) {
        var rule;
        if (bodyRules == null) {
            return false;
        }
        for (var r = 0; r < bodyRules.length; r++) {
            rule = bodyRules[r];
            if (rule.isSilent && rule.isSilent(this._context) && !rule.blocksVisibility()) {
                //the directive contains something that was referenced (likely by extend)
                //therefore it needs to be shown in output too
                return true;
            }
        }
        return false;
    },

    keepOnlyVisibleChilds: function(owner) {
        if (owner == null || owner.rules == null) {
            return ;
        }

        owner.rules = owner.rules.filter(function(thing) {
                return thing.isVisible();
            }
        );
    },

    isEmpty: function(owner) {
        if (owner == null || owner.rules == null) {
            return true;
        }
        return owner.rules.length === 0;
    },

    hasVisibleSelector: function(rulesetNode) {
        if (rulesetNode == null || rulesetNode.paths == null) {
            return false;
        }
        return rulesetNode.paths.length > 0;
    },

    resolveVisibility: function (node, originalRules) {
        if (!node.blocksVisibility()) {
            if (this.isEmpty(node) && !this.containsSilentNonBlockedChild(originalRules)) {
                return ;
            }

            return node;
        }

        var compiledRulesBody = node.rules[0];
        this.keepOnlyVisibleChilds(compiledRulesBody);

        if (this.isEmpty(compiledRulesBody)) {
            return ;
        }

        node.ensureVisibility();
        node.removeVisibilityBlock();

        return node;
    },

    isVisibleRuleset: function(rulesetNode) {
        if (rulesetNode.firstRoot) {
            return true;
        }

        if (this.isEmpty(rulesetNode)) {
            return false;
        }

        if (!rulesetNode.root && !this.hasVisibleSelector(rulesetNode)) {
            return false;
        }

        return true;
    }

};

var ToCSSVisitor = function(context) {
    this._visitor = new Visitor(this);
    this._context = context;
    this.utils = new CSSVisitorUtils(context);
};

ToCSSVisitor.prototype = {
    isReplacing: true,
    run: function (root) {
        return this._visitor.visit(root);
    },

    visitRule: function (ruleNode, visitArgs) {
        if (ruleNode.blocksVisibility() || ruleNode.variable) {
            return;
        }
        return ruleNode;
    },

    visitMixinDefinition: function (mixinNode, visitArgs) {
        // mixin definitions do not get eval'd - this means they keep state
        // so we have to clear that state here so it isn't used if toCSS is called twice
        mixinNode.frames = [];
    },

    visitExtend: function (extendNode, visitArgs) {
    },

    visitComment: function (commentNode, visitArgs) {
        if (commentNode.blocksVisibility() || commentNode.isSilent(this._context)) {
            return;
        }
        return commentNode;
    },

    visitMedia: function(mediaNode, visitArgs) {
        var originalRules = mediaNode.rules[0].rules;
        mediaNode.accept(this._visitor);
        visitArgs.visitDeeper = false;

        return this.utils.resolveVisibility(mediaNode, originalRules);
    },

    visitImport: function (importNode, visitArgs) {
        if (importNode.blocksVisibility()) {
            return ;
        }
        return importNode;
    },

    visitDirective: function(directiveNode, visitArgs) {
        if (directiveNode.rules && directiveNode.rules.length) {
            return this.visitDirectiveWithBody(directiveNode, visitArgs);
        } else {
            return this.visitDirectiveWithoutBody(directiveNode, visitArgs);
        }
    },

    visitDirectiveWithBody: function(directiveNode, visitArgs) {
        //if there is only one nested ruleset and that one has no path, then it is
        //just fake ruleset
        function hasFakeRuleset(directiveNode) {
            var bodyRules = directiveNode.rules;
            return bodyRules.length === 1 && (!bodyRules[0].paths || bodyRules[0].paths.length === 0);
        }
        function getBodyRules(directiveNode) {
            var nodeRules = directiveNode.rules;
            if (hasFakeRuleset(directiveNode)) {
                return nodeRules[0].rules;
            }

            return nodeRules;
        }
        //it is still true that it is only one ruleset in array
        //this is last such moment
        //process childs
        var originalRules = getBodyRules(directiveNode);
        directiveNode.accept(this._visitor);
        visitArgs.visitDeeper = false;

        if (!this.utils.isEmpty(directiveNode)) {
            this._mergeRules(directiveNode.rules[0].rules);
        }

        return this.utils.resolveVisibility(directiveNode, originalRules);
    },

    visitDirectiveWithoutBody: function(directiveNode, visitArgs) {
        if (directiveNode.blocksVisibility()) {
            return;
        }

        if (directiveNode.name === "@charset") {
            // Only output the debug info together with subsequent @charset definitions
            // a comment (or @media statement) before the actual @charset directive would
            // be considered illegal css as it has to be on the first line
            if (this.charset) {
                if (directiveNode.debugInfo) {
                    var comment = new tree.Comment("/* " + directiveNode.toCSS(this._context).replace(/\n/g, "") + " */\n");
                    comment.debugInfo = directiveNode.debugInfo;
                    return this._visitor.visit(comment);
                }
                return;
            }
            this.charset = true;
        }

        return directiveNode;
    },

    checkValidNodes: function(rules, isRoot) {
        if (!rules) {
            return;
        }

        for (var i = 0; i < rules.length; i++) {
            var ruleNode = rules[i];
            if (isRoot && ruleNode instanceof tree.Rule && !ruleNode.variable) {
                throw { message: "Properties must be inside selector blocks. They cannot be in the root",
                    index: ruleNode.index, filename: ruleNode.currentFileInfo && ruleNode.currentFileInfo.filename};
            }
            if (ruleNode instanceof tree.Call) {
                throw { message: "Function '" + ruleNode.name + "' is undefined",
                    index: ruleNode.index, filename: ruleNode.currentFileInfo && ruleNode.currentFileInfo.filename};
            }
            if (ruleNode.type && !ruleNode.allowRoot) {
                throw { message: ruleNode.type + " node returned by a function is not valid here",
                    index: ruleNode.index, filename: ruleNode.currentFileInfo && ruleNode.currentFileInfo.filename};
            }
        }
    },

    visitRuleset: function (rulesetNode, visitArgs) {
        //at this point rulesets are nested into each other
        var rule, rulesets = [];

        this.checkValidNodes(rulesetNode.rules, rulesetNode.firstRoot);

        if (! rulesetNode.root) {
            //remove invisible paths
            this._compileRulesetPaths(rulesetNode);

            // remove rulesets from this ruleset body and compile them separately
            var nodeRules = rulesetNode.rules, nodeRuleCnt = nodeRules ? nodeRules.length : 0;
            for (var i = 0; i < nodeRuleCnt; ) {
                rule = nodeRules[i];
                if (rule && rule.rules) {
                    // visit because we are moving them out from being a child
                    rulesets.push(this._visitor.visit(rule));
                    nodeRules.splice(i, 1);
                    nodeRuleCnt--;
                    continue;
                }
                i++;
            }
            // accept the visitor to remove rules and refactor itself
            // then we can decide nogw whether we want it or not
            // compile body
            if (nodeRuleCnt > 0) {
                rulesetNode.accept(this._visitor);
            } else {
                rulesetNode.rules = null;
            }
            visitArgs.visitDeeper = false;

        } else { //if (! rulesetNode.root) {
            rulesetNode.accept(this._visitor);
            visitArgs.visitDeeper = false;
        }

        if (rulesetNode.rules) {
            this._mergeRules(rulesetNode.rules);
            this._removeDuplicateRules(rulesetNode.rules);
        }

        //now decide whether we keep the ruleset
        if (this.utils.isVisibleRuleset(rulesetNode)) {
            rulesetNode.ensureVisibility();
            rulesets.splice(0, 0, rulesetNode);
        }

        if (rulesets.length === 1) {
            return rulesets[0];
        }
        return rulesets;
    },

    _compileRulesetPaths: function(rulesetNode) {
        if (rulesetNode.paths) {
            rulesetNode.paths = rulesetNode.paths
                .filter(function(p) {
                    var i;
                    if (p[0].elements[0].combinator.value === ' ') {
                        p[0].elements[0].combinator = new(tree.Combinator)('');
                    }
                    for (i = 0; i < p.length; i++) {
                        if (p[i].isVisible() && p[i].getIsOutput()) {
                            return true;
                        }
                    }
                    return false;
                });
        }
    },

    _removeDuplicateRules: function(rules) {
        if (!rules) { return; }

        // remove duplicates
        var ruleCache = {},
            ruleList, rule, i;

        for (i = rules.length - 1; i >= 0 ; i--) {
            rule = rules[i];
            if (rule instanceof tree.Rule) {
                if (!ruleCache[rule.name]) {
                    ruleCache[rule.name] = rule;
                } else {
                    ruleList = ruleCache[rule.name];
                    if (ruleList instanceof tree.Rule) {
                        ruleList = ruleCache[rule.name] = [ruleCache[rule.name].toCSS(this._context)];
                    }
                    var ruleCSS = rule.toCSS(this._context);
                    if (ruleList.indexOf(ruleCSS) !== -1) {
                        rules.splice(i, 1);
                    } else {
                        ruleList.push(ruleCSS);
                    }
                }
            }
        }
    },

    _mergeRules: function (rules) {
        if (!rules) { return; }

        var groups = {},
            parts,
            rule,
            key;

        for (var i = 0; i < rules.length; i++) {
            rule = rules[i];

            if ((rule instanceof tree.Rule) && rule.merge) {
                key = [rule.name,
                    rule.important ? "!" : ""].join(",");

                if (!groups[key]) {
                    groups[key] = [];
                } else {
                    rules.splice(i--, 1);
                }

                groups[key].push(rule);
            }
        }

        Object.keys(groups).map(function (k) {

            function toExpression(values) {
                return new (tree.Expression)(values.map(function (p) {
                    return p.value;
                }));
            }

            function toValue(values) {
                return new (tree.Value)(values.map(function (p) {
                    return p;
                }));
            }

            parts = groups[k];

            if (parts.length > 1) {
                rule = parts[0];
                var spacedGroups = [];
                var lastSpacedGroup = [];
                parts.map(function (p) {
                    if (p.merge === "+") {
                        if (lastSpacedGroup.length > 0) {
                            spacedGroups.push(toExpression(lastSpacedGroup));
                        }
                        lastSpacedGroup = [];
                    }
                    lastSpacedGroup.push(p);
                });
                spacedGroups.push(toExpression(lastSpacedGroup));
                rule.value = toValue(spacedGroups);
            }
        });
    },

    visitAnonymous: function(anonymousNode, visitArgs) {
        if (anonymousNode.blocksVisibility()) {
            return ;
        }
        anonymousNode.accept(this._visitor);
        return anonymousNode;
    }
};

module.exports = ToCSSVisitor;

},{"../tree":67,"./visitor":96}],96:[function(require,module,exports){
var tree = require("../tree");

var _visitArgs = { visitDeeper: true },
    _hasIndexed = false;

function _noop(node) {
    return node;
}

function indexNodeTypes(parent, ticker) {
    // add .typeIndex to tree node types for lookup table
    var key, child;
    for (key in parent) {
        if (parent.hasOwnProperty(key)) {
            child = parent[key];
            switch (typeof child) {
                case "function":
                    // ignore bound functions directly on tree which do not have a prototype
                    // or aren't nodes
                    if (child.prototype && child.prototype.type) {
                        child.prototype.typeIndex = ticker++;
                    }
                    break;
                case "object":
                    ticker = indexNodeTypes(child, ticker);
                    break;
            }
        }
    }
    return ticker;
}

var Visitor = function(implementation) {
    this._implementation = implementation;
    this._visitFnCache = [];

    if (!_hasIndexed) {
        indexNodeTypes(tree, 1);
        _hasIndexed = true;
    }
};

Visitor.prototype = {
    visit: function(node) {
        if (!node) {
            return node;
        }

        var nodeTypeIndex = node.typeIndex;
        if (!nodeTypeIndex) {
            return node;
        }

        var visitFnCache = this._visitFnCache,
            impl = this._implementation,
            aryIndx = nodeTypeIndex << 1,
            outAryIndex = aryIndx | 1,
            func = visitFnCache[aryIndx],
            funcOut = visitFnCache[outAryIndex],
            visitArgs = _visitArgs,
            fnName;

        visitArgs.visitDeeper = true;

        if (!func) {
            fnName = "visit" + node.type;
            func = impl[fnName] || _noop;
            funcOut = impl[fnName + "Out"] || _noop;
            visitFnCache[aryIndx] = func;
            visitFnCache[outAryIndex] = funcOut;
        }

        if (func !== _noop) {
            var newNode = func.call(impl, node, visitArgs);
            if (impl.isReplacing) {
                node = newNode;
            }
        }

        if (visitArgs.visitDeeper && node && node.accept) {
            node.accept(this);
        }

        if (funcOut != _noop) {
            funcOut.call(impl, node);
        }

        return node;
    },
    visitArray: function(nodes, nonReplacing) {
        if (!nodes) {
            return nodes;
        }

        var cnt = nodes.length, i;

        // Non-replacing
        if (nonReplacing || !this._implementation.isReplacing) {
            for (i = 0; i < cnt; i++) {
                this.visit(nodes[i]);
            }
            return nodes;
        }

        // Replacing
        var out = [];
        for (i = 0; i < cnt; i++) {
            var evald = this.visit(nodes[i]);
            if (evald === undefined) { continue; }
            if (!evald.splice) {
                out.push(evald);
            } else if (evald.length) {
                this.flatten(evald, out);
            }
        }
        return out;
    },
    flatten: function(arr, out) {
        if (!out) {
            out = [];
        }

        var cnt, i, item,
            nestedCnt, j, nestedItem;

        for (i = 0, cnt = arr.length; i < cnt; i++) {
            item = arr[i];
            if (item === undefined) {
                continue;
            }
            if (!item.splice) {
                out.push(item);
                continue;
            }

            for (j = 0, nestedCnt = item.length; j < nestedCnt; j++) {
                nestedItem = item[j];
                if (nestedItem === undefined) {
                    continue;
                }
                if (!nestedItem.splice) {
                    out.push(nestedItem);
                } else if (nestedItem.length) {
                    this.flatten(nestedItem, out);
                }
            }
        }

        return out;
    }
};
module.exports = Visitor;

},{"../tree":67}],97:[function(require,module,exports){
'use strict';

module.exports = require('./lib')

},{"./lib":102}],98:[function(require,module,exports){
'use strict';

var asap = require('asap/raw');

function noop() {}

// States:
//
// 0 - pending
// 1 - fulfilled with _value
// 2 - rejected with _value
// 3 - adopted the state of another promise, _value
//
// once the state is no longer pending (0) it is immutable

// All `_` prefixed properties will be reduced to `_{random number}`
// at build time to obfuscate them and discourage their use.
// We don't use symbols or Object.defineProperty to fully hide them
// because the performance isn't good enough.


// to avoid using try/catch inside critical functions, we
// extract them to here.
var LAST_ERROR = null;
var IS_ERROR = {};
function getThen(obj) {
  try {
    return obj.then;
  } catch (ex) {
    LAST_ERROR = ex;
    return IS_ERROR;
  }
}

function tryCallOne(fn, a) {
  try {
    return fn(a);
  } catch (ex) {
    LAST_ERROR = ex;
    return IS_ERROR;
  }
}
function tryCallTwo(fn, a, b) {
  try {
    fn(a, b);
  } catch (ex) {
    LAST_ERROR = ex;
    return IS_ERROR;
  }
}

module.exports = Promise;

function Promise(fn) {
  if (typeof this !== 'object') {
    throw new TypeError('Promises must be constructed via new');
  }
  if (typeof fn !== 'function') {
    throw new TypeError('not a function');
  }
  this._45 = 0;
  this._81 = 0;
  this._65 = null;
  this._54 = null;
  if (fn === noop) return;
  doResolve(fn, this);
}
Promise._10 = null;
Promise._97 = null;
Promise._61 = noop;

Promise.prototype.then = function(onFulfilled, onRejected) {
  if (this.constructor !== Promise) {
    return safeThen(this, onFulfilled, onRejected);
  }
  var res = new Promise(noop);
  handle(this, new Handler(onFulfilled, onRejected, res));
  return res;
};

function safeThen(self, onFulfilled, onRejected) {
  return new self.constructor(function (resolve, reject) {
    var res = new Promise(noop);
    res.then(resolve, reject);
    handle(self, new Handler(onFulfilled, onRejected, res));
  });
};
function handle(self, deferred) {
  while (self._81 === 3) {
    self = self._65;
  }
  if (Promise._10) {
    Promise._10(self);
  }
  if (self._81 === 0) {
    if (self._45 === 0) {
      self._45 = 1;
      self._54 = deferred;
      return;
    }
    if (self._45 === 1) {
      self._45 = 2;
      self._54 = [self._54, deferred];
      return;
    }
    self._54.push(deferred);
    return;
  }
  handleResolved(self, deferred);
}

function handleResolved(self, deferred) {
  asap(function() {
    var cb = self._81 === 1 ? deferred.onFulfilled : deferred.onRejected;
    if (cb === null) {
      if (self._81 === 1) {
        resolve(deferred.promise, self._65);
      } else {
        reject(deferred.promise, self._65);
      }
      return;
    }
    var ret = tryCallOne(cb, self._65);
    if (ret === IS_ERROR) {
      reject(deferred.promise, LAST_ERROR);
    } else {
      resolve(deferred.promise, ret);
    }
  });
}
function resolve(self, newValue) {
  // Promise Resolution Procedure: https://github.com/promises-aplus/promises-spec#the-promise-resolution-procedure
  if (newValue === self) {
    return reject(
      self,
      new TypeError('A promise cannot be resolved with itself.')
    );
  }
  if (
    newValue &&
    (typeof newValue === 'object' || typeof newValue === 'function')
  ) {
    var then = getThen(newValue);
    if (then === IS_ERROR) {
      return reject(self, LAST_ERROR);
    }
    if (
      then === self.then &&
      newValue instanceof Promise
    ) {
      self._81 = 3;
      self._65 = newValue;
      finale(self);
      return;
    } else if (typeof then === 'function') {
      doResolve(then.bind(newValue), self);
      return;
    }
  }
  self._81 = 1;
  self._65 = newValue;
  finale(self);
}

function reject(self, newValue) {
  self._81 = 2;
  self._65 = newValue;
  if (Promise._97) {
    Promise._97(self, newValue);
  }
  finale(self);
}
function finale(self) {
  if (self._45 === 1) {
    handle(self, self._54);
    self._54 = null;
  }
  if (self._45 === 2) {
    for (var i = 0; i < self._54.length; i++) {
      handle(self, self._54[i]);
    }
    self._54 = null;
  }
}

function Handler(onFulfilled, onRejected, promise){
  this.onFulfilled = typeof onFulfilled === 'function' ? onFulfilled : null;
  this.onRejected = typeof onRejected === 'function' ? onRejected : null;
  this.promise = promise;
}

/**
 * Take a potentially misbehaving resolver function and make sure
 * onFulfilled and onRejected are only called once.
 *
 * Makes no guarantees about asynchrony.
 */
function doResolve(fn, promise) {
  var done = false;
  var res = tryCallTwo(fn, function (value) {
    if (done) return;
    done = true;
    resolve(promise, value);
  }, function (reason) {
    if (done) return;
    done = true;
    reject(promise, reason);
  })
  if (!done && res === IS_ERROR) {
    done = true;
    reject(promise, LAST_ERROR);
  }
}

},{"asap/raw":2}],99:[function(require,module,exports){
'use strict';

var Promise = require('./core.js');

module.exports = Promise;
Promise.prototype.done = function (onFulfilled, onRejected) {
  var self = arguments.length ? this.then.apply(this, arguments) : this;
  self.then(null, function (err) {
    setTimeout(function () {
      throw err;
    }, 0);
  });
};

},{"./core.js":98}],100:[function(require,module,exports){
'use strict';

//This file contains the ES6 extensions to the core Promises/A+ API

var Promise = require('./core.js');

module.exports = Promise;

/* Static Functions */

var TRUE = valuePromise(true);
var FALSE = valuePromise(false);
var NULL = valuePromise(null);
var UNDEFINED = valuePromise(undefined);
var ZERO = valuePromise(0);
var EMPTYSTRING = valuePromise('');

function valuePromise(value) {
  var p = new Promise(Promise._61);
  p._81 = 1;
  p._65 = value;
  return p;
}
Promise.resolve = function (value) {
  if (value instanceof Promise) return value;

  if (value === null) return NULL;
  if (value === undefined) return UNDEFINED;
  if (value === true) return TRUE;
  if (value === false) return FALSE;
  if (value === 0) return ZERO;
  if (value === '') return EMPTYSTRING;

  if (typeof value === 'object' || typeof value === 'function') {
    try {
      var then = value.then;
      if (typeof then === 'function') {
        return new Promise(then.bind(value));
      }
    } catch (ex) {
      return new Promise(function (resolve, reject) {
        reject(ex);
      });
    }
  }
  return valuePromise(value);
};

Promise.all = function (arr) {
  var args = Array.prototype.slice.call(arr);

  return new Promise(function (resolve, reject) {
    if (args.length === 0) return resolve([]);
    var remaining = args.length;
    function res(i, val) {
      if (val && (typeof val === 'object' || typeof val === 'function')) {
        if (val instanceof Promise && val.then === Promise.prototype.then) {
          while (val._81 === 3) {
            val = val._65;
          }
          if (val._81 === 1) return res(i, val._65);
          if (val._81 === 2) reject(val._65);
          val.then(function (val) {
            res(i, val);
          }, reject);
          return;
        } else {
          var then = val.then;
          if (typeof then === 'function') {
            var p = new Promise(then.bind(val));
            p.then(function (val) {
              res(i, val);
            }, reject);
            return;
          }
        }
      }
      args[i] = val;
      if (--remaining === 0) {
        resolve(args);
      }
    }
    for (var i = 0; i < args.length; i++) {
      res(i, args[i]);
    }
  });
};

Promise.reject = function (value) {
  return new Promise(function (resolve, reject) {
    reject(value);
  });
};

Promise.race = function (values) {
  return new Promise(function (resolve, reject) {
    values.forEach(function(value){
      Promise.resolve(value).then(resolve, reject);
    });
  });
};

/* Prototype Methods */

Promise.prototype['catch'] = function (onRejected) {
  return this.then(null, onRejected);
};

},{"./core.js":98}],101:[function(require,module,exports){
'use strict';

var Promise = require('./core.js');

module.exports = Promise;
Promise.prototype['finally'] = function (f) {
  return this.then(function (value) {
    return Promise.resolve(f()).then(function () {
      return value;
    });
  }, function (err) {
    return Promise.resolve(f()).then(function () {
      throw err;
    });
  });
};

},{"./core.js":98}],102:[function(require,module,exports){
'use strict';

module.exports = require('./core.js');
require('./done.js');
require('./finally.js');
require('./es6-extensions.js');
require('./node-extensions.js');
require('./synchronous.js');

},{"./core.js":98,"./done.js":99,"./es6-extensions.js":100,"./finally.js":101,"./node-extensions.js":103,"./synchronous.js":104}],103:[function(require,module,exports){
'use strict';

// This file contains then/promise specific extensions that are only useful
// for node.js interop

var Promise = require('./core.js');
var asap = require('asap');

module.exports = Promise;

/* Static Functions */

Promise.denodeify = function (fn, argumentCount) {
  if (
    typeof argumentCount === 'number' && argumentCount !== Infinity
  ) {
    return denodeifyWithCount(fn, argumentCount);
  } else {
    return denodeifyWithoutCount(fn);
  }
}

var callbackFn = (
  'function (err, res) {' +
  'if (err) { rj(err); } else { rs(res); }' +
  '}'
);
function denodeifyWithCount(fn, argumentCount) {
  var args = [];
  for (var i = 0; i < argumentCount; i++) {
    args.push('a' + i);
  }
  var body = [
    'return function (' + args.join(',') + ') {',
    'var self = this;',
    'return new Promise(function (rs, rj) {',
    'var res = fn.call(',
    ['self'].concat(args).concat([callbackFn]).join(','),
    ');',
    'if (res &&',
    '(typeof res === "object" || typeof res === "function") &&',
    'typeof res.then === "function"',
    ') {rs(res);}',
    '});',
    '};'
  ].join('');
  return Function(['Promise', 'fn'], body)(Promise, fn);
}
function denodeifyWithoutCount(fn) {
  var fnLength = Math.max(fn.length - 1, 3);
  var args = [];
  for (var i = 0; i < fnLength; i++) {
    args.push('a' + i);
  }
  var body = [
    'return function (' + args.join(',') + ') {',
    'var self = this;',
    'var args;',
    'var argLength = arguments.length;',
    'if (arguments.length > ' + fnLength + ') {',
    'args = new Array(arguments.length + 1);',
    'for (var i = 0; i < arguments.length; i++) {',
    'args[i] = arguments[i];',
    '}',
    '}',
    'return new Promise(function (rs, rj) {',
    'var cb = ' + callbackFn + ';',
    'var res;',
    'switch (argLength) {',
    args.concat(['extra']).map(function (_, index) {
      return (
        'case ' + (index) + ':' +
        'res = fn.call(' + ['self'].concat(args.slice(0, index)).concat('cb').join(',') + ');' +
        'break;'
      );
    }).join(''),
    'default:',
    'args[argLength] = cb;',
    'res = fn.apply(self, args);',
    '}',
    
    'if (res &&',
    '(typeof res === "object" || typeof res === "function") &&',
    'typeof res.then === "function"',
    ') {rs(res);}',
    '});',
    '};'
  ].join('');

  return Function(
    ['Promise', 'fn'],
    body
  )(Promise, fn);
}

Promise.nodeify = function (fn) {
  return function () {
    var args = Array.prototype.slice.call(arguments);
    var callback =
      typeof args[args.length - 1] === 'function' ? args.pop() : null;
    var ctx = this;
    try {
      return fn.apply(this, arguments).nodeify(callback, ctx);
    } catch (ex) {
      if (callback === null || typeof callback == 'undefined') {
        return new Promise(function (resolve, reject) {
          reject(ex);
        });
      } else {
        asap(function () {
          callback.call(ctx, ex);
        })
      }
    }
  }
}

Promise.prototype.nodeify = function (callback, ctx) {
  if (typeof callback != 'function') return this;

  this.then(function (value) {
    asap(function () {
      callback.call(ctx, null, value);
    });
  }, function (err) {
    asap(function () {
      callback.call(ctx, err);
    });
  });
}

},{"./core.js":98,"asap":1}],104:[function(require,module,exports){
'use strict';

var Promise = require('./core.js');

module.exports = Promise;
Promise.enableSynchronous = function () {
  Promise.prototype.isPending = function() {
    return this.getState() == 0;
  };

  Promise.prototype.isFulfilled = function() {
    return this.getState() == 1;
  };

  Promise.prototype.isRejected = function() {
    return this.getState() == 2;
  };

  Promise.prototype.getValue = function () {
    if (this._81 === 3) {
      return this._65.getValue();
    }

    if (!this.isFulfilled()) {
      throw new Error('Cannot get a value of an unfulfilled promise.');
    }

    return this._65;
  };

  Promise.prototype.getReason = function () {
    if (this._81 === 3) {
      return this._65.getReason();
    }

    if (!this.isRejected()) {
      throw new Error('Cannot get a rejection reason of a non-rejected promise.');
    }

    return this._65;
  };

  Promise.prototype.getState = function () {
    if (this._81 === 3) {
      return this._65.getState();
    }
    if (this._81 === -1 || this._81 === -2) {
      return 0;
    }

    return this._81;
  };
};

Promise.disableSynchronous = function() {
  Promise.prototype.isPending = undefined;
  Promise.prototype.isFulfilled = undefined;
  Promise.prototype.isRejected = undefined;
  Promise.prototype.getValue = undefined;
  Promise.prototype.getReason = undefined;
  Promise.prototype.getState = undefined;
};

},{"./core.js":98}],105:[function(require,module,exports){
// should work in any browser without browserify

if (typeof Promise.prototype.done !== 'function') {
  Promise.prototype.done = function (onFulfilled, onRejected) {
    var self = arguments.length ? this.then.apply(this, arguments) : this
    self.then(null, function (err) {
      setTimeout(function () {
        throw err
      }, 0)
    })
  }
}
},{}],106:[function(require,module,exports){
// not "use strict" so we can declare global "Promise"

var asap = require('asap');

if (typeof Promise === 'undefined') {
  Promise = require('./lib/core.js')
  require('./lib/es6-extensions.js')
}

require('./polyfill-done.js');

},{"./lib/core.js":98,"./lib/es6-extensions.js":100,"./polyfill-done.js":105,"asap":1}],107:[function(require,module,exports){
'use strict';

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

require("promise/polyfill");
var buble = require('./buble');
var less = require('less/lib/less-browser/bootstrap');

var GUID_HELPER = 0;

var VM_HEADER = '\nvar exports = {};\nvar module  = {};\nObject.defineProperty( module, \'exports\', {\n\tget: function()  { return exports; },\n\tset: function(v) { exports = v; return exports; },\n});\n(function() {\n';
var VM_FOOTER = '\n}());\nreturn exports;\n';

module.exports = function () {
	function _class(componentElement) {
		_classCallCheck(this, _class);

		this._guid = 'v__guid__helper--' + GUID_HELPER++;
		this._componentElement = componentElement;
	}

	_createClass(_class, [{
		key: 'compileScript',
		value: function compileScript(output, options) {
			var script = this._componentElement.querySelector('script');
			if (!script) return;

			var transpiledScript = buble.transform(script.innerHTML);

			var requires = [];
			var code = transpiledScript.code.replace(/require\(\s*([\"'])((?:\\\1|.)*?)\1\s*\)/g, function (match, quote, moduleName) {
				requires.push(moduleName);
			});
			return options.require(requires).then(function (require) {
				var isolatedVm = new Function('global', 'require', VM_HEADER + transpiledScript.code + VM_FOOTER);
				var vmComponent = isolatedVm(options.global || window, require);
				for (var key in vmComponent) {
					output.component[key] = vmComponent[key];
				}
			});
		}
	}, {
		key: 'compileTemplate',
		value: function compileTemplate(output) {
			var template = this._componentElement.querySelector('template');
			output.component.template = template.innerHTML;
		}
	}, {
		key: 'compileStyle',
		value: function compileStyle(output) {
			var style = this._componentElement.querySelector('style');
			if (!style) return;

			var styleString = '.' + this._guid + ' { ' + style.textContent + ' }';
			return new Promise(function (resolve, reject) {
				less.render(styleString, function (err, output) {
					if (err) {
						reject(err);
						return;
					}
					resolve(output);
				});
			}).then(function (_ref) {
				var css = _ref.css;

				if (!css) return;
				var head = document.head || document.body;
				var compiledStyle = document.createElement('style');
				var styleContent = document.createTextNode(css);
				compiledStyle.appendChild(styleContent);
				head.appendChild(compiledStyle);
			});
		}
	}, {
		key: 'compile',
		value: function compile(options) {
			var _this = this;

			var output = {
				component: {}
			};
			return Promise.resolve().then(function () {
				return Promise.all([_this.compileScript(output, options), _this.compileTemplate(output, options), _this.compileStyle(output, options)]);
			}).then(function () {
				return output.component;
			});
		}
	}]);

	return _class;
}();

},{"./buble":108,"less/lib/less-browser/bootstrap":7,"promise/polyfill":106}],108:[function(require,module,exports){
(function (global,Buffer){
'use strict';

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; };

var define;
(function (global, factory) {
  (typeof exports === 'undefined' ? 'undefined' : _typeof(exports)) === 'object' && typeof module !== 'undefined' ? factory(exports) : typeof define === 'function' && define.amd ? define(['exports'], factory) : factory(global.buble = global.buble || {});
})(undefined, function (exports) {
  'use strict';

  var __commonjs_global = typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this;
  function __commonjs(fn, module) {
    return module = { exports: {} }, fn(module, module.exports, __commonjs_global), module.exports;
  }

  var acorn = __commonjs(function (module, exports, global) {
    (function (global, factory) {
      (typeof exports === 'undefined' ? 'undefined' : _typeof(exports)) === 'object' && typeof module !== 'undefined' ? factory(exports) : typeof define === 'function' && define.amd ? define(['exports'], factory) : factory(global.acorn = global.acorn || {});
    })(__commonjs_global, function (exports) {
      'use strict';

      // Reserved word lists for various dialects of the language

      var reservedWords = {
        3: "abstract boolean byte char class double enum export extends final float goto implements import int interface long native package private protected public short static super synchronized throws transient volatile",
        5: "class enum extends super const export import",
        6: "enum",
        7: "enum",
        strict: "implements interface let package private protected public static yield",
        strictBind: "eval arguments"
      };

      // And the keywords

      var ecma5AndLessKeywords = "break case catch continue debugger default do else finally for function if return switch throw try var while with null true false instanceof typeof void delete new in this";

      var keywords = {
        5: ecma5AndLessKeywords,
        6: ecma5AndLessKeywords + " const class extends export import super"
      };

      // ## Character categories

      // Big ugly regular expressions that match characters in the
      // whitespace, identifier, and identifier-start categories. These
      // are only applied when a character is found to actually have a
      // code point above 128.
      // Generated by `bin/generate-identifier-regex.js`.

      var nonASCIIidentifierStartChars = '\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u05D0-\u05EA\u05F0-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u08A0-\u08B4\u08B6-\u08BD\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0AF9\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58-\u0C5A\u0C60\u0C61\u0C80\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D54-\u0D56\u0D5F-\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1877\u1880-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4B\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1C80-\u1C88\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2118-\u211D\u2124\u2126\u2128\u212A-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309B-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312D\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FD5\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA7AE\uA7B0-\uA7B7\uA7F7-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA8FD\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC';
      var nonASCIIidentifierChars = '\u200C\u200D\xB7\u0300-\u036F\u0387\u0483-\u0487\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u0610-\u061A\u064B-\u0669\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u06F0-\u06F9\u0711\u0730-\u074A\u07A6-\u07B0\u07C0-\u07C9\u07EB-\u07F3\u0816-\u0819\u081B-\u0823\u0825-\u0827\u0829-\u082D\u0859-\u085B\u08D4-\u08E1\u08E3-\u0903\u093A-\u093C\u093E-\u094F\u0951-\u0957\u0962\u0963\u0966-\u096F\u0981-\u0983\u09BC\u09BE-\u09C4\u09C7\u09C8\u09CB-\u09CD\u09D7\u09E2\u09E3\u09E6-\u09EF\u0A01-\u0A03\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A66-\u0A71\u0A75\u0A81-\u0A83\u0ABC\u0ABE-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AE2\u0AE3\u0AE6-\u0AEF\u0B01-\u0B03\u0B3C\u0B3E-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B56\u0B57\u0B62\u0B63\u0B66-\u0B6F\u0B82\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD7\u0BE6-\u0BEF\u0C00-\u0C03\u0C3E-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C62\u0C63\u0C66-\u0C6F\u0C81-\u0C83\u0CBC\u0CBE-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CE2\u0CE3\u0CE6-\u0CEF\u0D01-\u0D03\u0D3E-\u0D44\u0D46-\u0D48\u0D4A-\u0D4D\u0D57\u0D62\u0D63\u0D66-\u0D6F\u0D82\u0D83\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2\u0DF3\u0E31\u0E34-\u0E3A\u0E47-\u0E4E\u0E50-\u0E59\u0EB1\u0EB4-\u0EB9\u0EBB\u0EBC\u0EC8-\u0ECD\u0ED0-\u0ED9\u0F18\u0F19\u0F20-\u0F29\u0F35\u0F37\u0F39\u0F3E\u0F3F\u0F71-\u0F84\u0F86\u0F87\u0F8D-\u0F97\u0F99-\u0FBC\u0FC6\u102B-\u103E\u1040-\u1049\u1056-\u1059\u105E-\u1060\u1062-\u1064\u1067-\u106D\u1071-\u1074\u1082-\u108D\u108F-\u109D\u135D-\u135F\u1369-\u1371\u1712-\u1714\u1732-\u1734\u1752\u1753\u1772\u1773\u17B4-\u17D3\u17DD\u17E0-\u17E9\u180B-\u180D\u1810-\u1819\u18A9\u1920-\u192B\u1930-\u193B\u1946-\u194F\u19D0-\u19DA\u1A17-\u1A1B\u1A55-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AB0-\u1ABD\u1B00-\u1B04\u1B34-\u1B44\u1B50-\u1B59\u1B6B-\u1B73\u1B80-\u1B82\u1BA1-\u1BAD\u1BB0-\u1BB9\u1BE6-\u1BF3\u1C24-\u1C37\u1C40-\u1C49\u1C50-\u1C59\u1CD0-\u1CD2\u1CD4-\u1CE8\u1CED\u1CF2-\u1CF4\u1CF8\u1CF9\u1DC0-\u1DF5\u1DFB-\u1DFF\u203F\u2040\u2054\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2CEF-\u2CF1\u2D7F\u2DE0-\u2DFF\u302A-\u302F\u3099\u309A\uA620-\uA629\uA66F\uA674-\uA67D\uA69E\uA69F\uA6F0\uA6F1\uA802\uA806\uA80B\uA823-\uA827\uA880\uA881\uA8B4-\uA8C5\uA8D0-\uA8D9\uA8E0-\uA8F1\uA900-\uA909\uA926-\uA92D\uA947-\uA953\uA980-\uA983\uA9B3-\uA9C0\uA9D0-\uA9D9\uA9E5\uA9F0-\uA9F9\uAA29-\uAA36\uAA43\uAA4C\uAA4D\uAA50-\uAA59\uAA7B-\uAA7D\uAAB0\uAAB2-\uAAB4\uAAB7\uAAB8\uAABE\uAABF\uAAC1\uAAEB-\uAAEF\uAAF5\uAAF6\uABE3-\uABEA\uABEC\uABED\uABF0-\uABF9\uFB1E\uFE00-\uFE0F\uFE20-\uFE2F\uFE33\uFE34\uFE4D-\uFE4F\uFF10-\uFF19\uFF3F';

      var nonASCIIidentifierStart = new RegExp("[" + nonASCIIidentifierStartChars + "]");
      var nonASCIIidentifier = new RegExp("[" + nonASCIIidentifierStartChars + nonASCIIidentifierChars + "]");

      nonASCIIidentifierStartChars = nonASCIIidentifierChars = null;

      // These are a run-length and offset encoded representation of the
      // >0xffff code points that are a valid part of identifiers. The
      // offset starts at 0x10000, and each pair of numbers represents an
      // offset to the next range, and then a size of the range. They were
      // generated by bin/generate-identifier-regex.js
      var astralIdentifierStartCodes = [0, 11, 2, 25, 2, 18, 2, 1, 2, 14, 3, 13, 35, 122, 70, 52, 268, 28, 4, 48, 48, 31, 17, 26, 6, 37, 11, 29, 3, 35, 5, 7, 2, 4, 43, 157, 19, 35, 5, 35, 5, 39, 9, 51, 157, 310, 10, 21, 11, 7, 153, 5, 3, 0, 2, 43, 2, 1, 4, 0, 3, 22, 11, 22, 10, 30, 66, 18, 2, 1, 11, 21, 11, 25, 71, 55, 7, 1, 65, 0, 16, 3, 2, 2, 2, 26, 45, 28, 4, 28, 36, 7, 2, 27, 28, 53, 11, 21, 11, 18, 14, 17, 111, 72, 56, 50, 14, 50, 785, 52, 76, 44, 33, 24, 27, 35, 42, 34, 4, 0, 13, 47, 15, 3, 22, 0, 2, 0, 36, 17, 2, 24, 85, 6, 2, 0, 2, 3, 2, 14, 2, 9, 8, 46, 39, 7, 3, 1, 3, 21, 2, 6, 2, 1, 2, 4, 4, 0, 19, 0, 13, 4, 159, 52, 19, 3, 54, 47, 21, 1, 2, 0, 185, 46, 42, 3, 37, 47, 21, 0, 60, 42, 86, 25, 391, 63, 32, 0, 449, 56, 264, 8, 2, 36, 18, 0, 50, 29, 881, 921, 103, 110, 18, 195, 2749, 1070, 4050, 582, 8634, 568, 8, 30, 114, 29, 19, 47, 17, 3, 32, 20, 6, 18, 881, 68, 12, 0, 67, 12, 65, 0, 32, 6124, 20, 754, 9486, 1, 3071, 106, 6, 12, 4, 8, 8, 9, 5991, 84, 2, 70, 2, 1, 3, 0, 3, 1, 3, 3, 2, 11, 2, 0, 2, 6, 2, 64, 2, 3, 3, 7, 2, 6, 2, 27, 2, 3, 2, 4, 2, 0, 4, 6, 2, 339, 3, 24, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 7, 4149, 196, 60, 67, 1213, 3, 2, 26, 2, 1, 2, 0, 3, 0, 2, 9, 2, 3, 2, 0, 2, 0, 7, 0, 5, 0, 2, 0, 2, 0, 2, 2, 2, 1, 2, 0, 3, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 1, 2, 0, 3, 3, 2, 6, 2, 3, 2, 3, 2, 0, 2, 9, 2, 16, 6, 2, 2, 4, 2, 16, 4421, 42710, 42, 4148, 12, 221, 3, 5761, 10591, 541];
      var astralIdentifierCodes = [509, 0, 227, 0, 150, 4, 294, 9, 1368, 2, 2, 1, 6, 3, 41, 2, 5, 0, 166, 1, 1306, 2, 54, 14, 32, 9, 16, 3, 46, 10, 54, 9, 7, 2, 37, 13, 2, 9, 52, 0, 13, 2, 49, 13, 10, 2, 4, 9, 83, 11, 7, 0, 161, 11, 6, 9, 7, 3, 57, 0, 2, 6, 3, 1, 3, 2, 10, 0, 11, 1, 3, 6, 4, 4, 193, 17, 10, 9, 87, 19, 13, 9, 214, 6, 3, 8, 28, 1, 83, 16, 16, 9, 82, 12, 9, 9, 84, 14, 5, 9, 423, 9, 838, 7, 2, 7, 17, 9, 57, 21, 2, 13, 19882, 9, 135, 4, 60, 6, 26, 9, 1016, 45, 17, 3, 19723, 1, 5319, 4, 4, 5, 9, 7, 3, 6, 31, 3, 149, 2, 1418, 49, 513, 54, 5, 49, 9, 0, 15, 0, 23, 4, 2, 14, 1361, 6, 2, 16, 3, 6, 2, 1, 2, 4, 2214, 6, 110, 6, 6, 9, 792487, 239];

      // This has a complexity linear to the value of the code. The
      // assumption is that looking up astral identifier characters is
      // rare.
      function isInAstralSet(code, set) {
        var pos = 0x10000;
        for (var i = 0; i < set.length; i += 2) {
          pos += set[i];
          if (pos > code) return false;
          pos += set[i + 1];
          if (pos >= code) return true;
        }
      }

      // Test whether a given character code starts an identifier.

      function isIdentifierStart(code, astral) {
        if (code < 65) return code === 36;
        if (code < 91) return true;
        if (code < 97) return code === 95;
        if (code < 123) return true;
        if (code <= 0xffff) return code >= 0xaa && nonASCIIidentifierStart.test(String.fromCharCode(code));
        if (astral === false) return false;
        return isInAstralSet(code, astralIdentifierStartCodes);
      }

      // Test whether a given character is part of an identifier.

      function isIdentifierChar(code, astral) {
        if (code < 48) return code === 36;
        if (code < 58) return true;
        if (code < 65) return false;
        if (code < 91) return true;
        if (code < 97) return code === 95;
        if (code < 123) return true;
        if (code <= 0xffff) return code >= 0xaa && nonASCIIidentifier.test(String.fromCharCode(code));
        if (astral === false) return false;
        return isInAstralSet(code, astralIdentifierStartCodes) || isInAstralSet(code, astralIdentifierCodes);
      }

      // ## Token types

      // The assignment of fine-grained, information-carrying type objects
      // allows the tokenizer to store the information it has about a
      // token in a way that is very cheap for the parser to look up.

      // All token type variables start with an underscore, to make them
      // easy to recognize.

      // The `beforeExpr` property is used to disambiguate between regular
      // expressions and divisions. It is set on all token types that can
      // be followed by an expression (thus, a slash after them would be a
      // regular expression).
      //
      // The `startsExpr` property is used to check if the token ends a
      // `yield` expression. It is set on all token types that either can
      // directly start an expression (like a quotation mark) or can
      // continue an expression (like the body of a string).
      //
      // `isLoop` marks a keyword as starting a loop, which is important
      // to know when parsing a label, in order to allow or disallow
      // continue jumps to that label.

      var TokenType = function TokenType(label, conf) {
        if (conf === void 0) conf = {};

        this.label = label;
        this.keyword = conf.keyword;
        this.beforeExpr = !!conf.beforeExpr;
        this.startsExpr = !!conf.startsExpr;
        this.isLoop = !!conf.isLoop;
        this.isAssign = !!conf.isAssign;
        this.prefix = !!conf.prefix;
        this.postfix = !!conf.postfix;
        this.binop = conf.binop || null;
        this.updateContext = null;
      };

      function binop(name, prec) {
        return new TokenType(name, { beforeExpr: true, binop: prec });
      }
      var beforeExpr = { beforeExpr: true };
      var startsExpr = { startsExpr: true };
      // Map keyword names to token types.

      var keywordTypes = {};

      // Succinct definitions of keyword token types
      function kw(name, options) {
        if (options === void 0) options = {};

        options.keyword = name;
        return keywordTypes[name] = new TokenType(name, options);
      }

      var tt = {
        num: new TokenType("num", startsExpr),
        regexp: new TokenType("regexp", startsExpr),
        string: new TokenType("string", startsExpr),
        name: new TokenType("name", startsExpr),
        eof: new TokenType("eof"),

        // Punctuation token types.
        bracketL: new TokenType("[", { beforeExpr: true, startsExpr: true }),
        bracketR: new TokenType("]"),
        braceL: new TokenType("{", { beforeExpr: true, startsExpr: true }),
        braceR: new TokenType("}"),
        parenL: new TokenType("(", { beforeExpr: true, startsExpr: true }),
        parenR: new TokenType(")"),
        comma: new TokenType(",", beforeExpr),
        semi: new TokenType(";", beforeExpr),
        colon: new TokenType(":", beforeExpr),
        dot: new TokenType("."),
        question: new TokenType("?", beforeExpr),
        arrow: new TokenType("=>", beforeExpr),
        template: new TokenType("template"),
        ellipsis: new TokenType("...", beforeExpr),
        backQuote: new TokenType("`", startsExpr),
        dollarBraceL: new TokenType("${", { beforeExpr: true, startsExpr: true }),

        // Operators. These carry several kinds of properties to help the
        // parser use them properly (the presence of these properties is
        // what categorizes them as operators).
        //
        // `binop`, when present, specifies that this operator is a binary
        // operator, and will refer to its precedence.
        //
        // `prefix` and `postfix` mark the operator as a prefix or postfix
        // unary operator.
        //
        // `isAssign` marks all of `=`, `+=`, `-=` etcetera, which act as
        // binary operators with a very low precedence, that should result
        // in AssignmentExpression nodes.

        eq: new TokenType("=", { beforeExpr: true, isAssign: true }),
        assign: new TokenType("_=", { beforeExpr: true, isAssign: true }),
        incDec: new TokenType("++/--", { prefix: true, postfix: true, startsExpr: true }),
        prefix: new TokenType("prefix", { beforeExpr: true, prefix: true, startsExpr: true }),
        logicalOR: binop("||", 1),
        logicalAND: binop("&&", 2),
        bitwiseOR: binop("|", 3),
        bitwiseXOR: binop("^", 4),
        bitwiseAND: binop("&", 5),
        equality: binop("==/!=", 6),
        relational: binop("</>", 7),
        bitShift: binop("<</>>", 8),
        plusMin: new TokenType("+/-", { beforeExpr: true, binop: 9, prefix: true, startsExpr: true }),
        modulo: binop("%", 10),
        star: binop("*", 10),
        slash: binop("/", 10),
        starstar: new TokenType("**", { beforeExpr: true }),

        // Keyword token types.
        _break: kw("break"),
        _case: kw("case", beforeExpr),
        _catch: kw("catch"),
        _continue: kw("continue"),
        _debugger: kw("debugger"),
        _default: kw("default", beforeExpr),
        _do: kw("do", { isLoop: true, beforeExpr: true }),
        _else: kw("else", beforeExpr),
        _finally: kw("finally"),
        _for: kw("for", { isLoop: true }),
        _function: kw("function", startsExpr),
        _if: kw("if"),
        _return: kw("return", beforeExpr),
        _switch: kw("switch"),
        _throw: kw("throw", beforeExpr),
        _try: kw("try"),
        _var: kw("var"),
        _const: kw("const"),
        _while: kw("while", { isLoop: true }),
        _with: kw("with"),
        _new: kw("new", { beforeExpr: true, startsExpr: true }),
        _this: kw("this", startsExpr),
        _super: kw("super", startsExpr),
        _class: kw("class"),
        _extends: kw("extends", beforeExpr),
        _export: kw("export"),
        _import: kw("import"),
        _null: kw("null", startsExpr),
        _true: kw("true", startsExpr),
        _false: kw("false", startsExpr),
        _in: kw("in", { beforeExpr: true, binop: 7 }),
        _instanceof: kw("instanceof", { beforeExpr: true, binop: 7 }),
        _typeof: kw("typeof", { beforeExpr: true, prefix: true, startsExpr: true }),
        _void: kw("void", { beforeExpr: true, prefix: true, startsExpr: true }),
        _delete: kw("delete", { beforeExpr: true, prefix: true, startsExpr: true })
      };

      // Matches a whole line break (where CRLF is considered a single
      // line break). Used to count lines.

      var lineBreak = /\r\n?|\n|\u2028|\u2029/;
      var lineBreakG = new RegExp(lineBreak.source, "g");

      function isNewLine(code) {
        return code === 10 || code === 13 || code === 0x2028 || code == 0x2029;
      }

      var nonASCIIwhitespace = /[\u1680\u180e\u2000-\u200a\u202f\u205f\u3000\ufeff]/;

      var skipWhiteSpace = /(?:\s|\/\/.*|\/\*[^]*?\*\/)*/g;

      function isArray(obj) {
        return Object.prototype.toString.call(obj) === "[object Array]";
      }

      // Checks if an object has a property.

      function has(obj, propName) {
        return Object.prototype.hasOwnProperty.call(obj, propName);
      }

      // These are used when `options.locations` is on, for the
      // `startLoc` and `endLoc` properties.

      var Position = function Position(line, col) {
        this.line = line;
        this.column = col;
      };

      Position.prototype.offset = function offset(n) {
        return new Position(this.line, this.column + n);
      };

      var SourceLocation = function SourceLocation(p, start, end) {
        this.start = start;
        this.end = end;
        if (p.sourceFile !== null) this.source = p.sourceFile;
      };

      // The `getLineInfo` function is mostly useful when the
      // `locations` option is off (for performance reasons) and you
      // want to find the line/column position for a given character
      // offset. `input` should be the code string that the offset refers
      // into.

      function getLineInfo(input, offset) {
        for (var line = 1, cur = 0;;) {
          lineBreakG.lastIndex = cur;
          var match = lineBreakG.exec(input);
          if (match && match.index < offset) {
            ++line;
            cur = match.index + match[0].length;
          } else {
            return new Position(line, offset - cur);
          }
        }
      }

      // A second optional argument can be given to further configure
      // the parser process. These options are recognized:

      var defaultOptions = {
        // `ecmaVersion` indicates the ECMAScript version to parse. Must
        // be either 3, or 5, or 6. This influences support for strict
        // mode, the set of reserved words, support for getters and
        // setters and other features. The default is 6.
        ecmaVersion: 6,
        // Source type ("script" or "module") for different semantics
        sourceType: "script",
        // `onInsertedSemicolon` can be a callback that will be called
        // when a semicolon is automatically inserted. It will be passed
        // th position of the comma as an offset, and if `locations` is
        // enabled, it is given the location as a `{line, column}` object
        // as second argument.
        onInsertedSemicolon: null,
        // `onTrailingComma` is similar to `onInsertedSemicolon`, but for
        // trailing commas.
        onTrailingComma: null,
        // By default, reserved words are only enforced if ecmaVersion >= 5.
        // Set `allowReserved` to a boolean value to explicitly turn this on
        // an off. When this option has the value "never", reserved words
        // and keywords can also not be used as property names.
        allowReserved: null,
        // When enabled, a return at the top level is not considered an
        // error.
        allowReturnOutsideFunction: false,
        // When enabled, import/export statements are not constrained to
        // appearing at the top of the program.
        allowImportExportEverywhere: false,
        // When enabled, hashbang directive in the beginning of file
        // is allowed and treated as a line comment.
        allowHashBang: false,
        // When `locations` is on, `loc` properties holding objects with
        // `start` and `end` properties in `{line, column}` form (with
        // line being 1-based and column 0-based) will be attached to the
        // nodes.
        locations: false,
        // A function can be passed as `onToken` option, which will
        // cause Acorn to call that function with object in the same
        // format as tokens returned from `tokenizer().getToken()`. Note
        // that you are not allowed to call the parser from the
        // callback—that will corrupt its internal state.
        onToken: null,
        // A function can be passed as `onComment` option, which will
        // cause Acorn to call that function with `(block, text, start,
        // end)` parameters whenever a comment is skipped. `block` is a
        // boolean indicating whether this is a block (`/* */`) comment,
        // `text` is the content of the comment, and `start` and `end` are
        // character offsets that denote the start and end of the comment.
        // When the `locations` option is on, two more parameters are
        // passed, the full `{line, column}` locations of the start and
        // end of the comments. Note that you are not allowed to call the
        // parser from the callback—that will corrupt its internal state.
        onComment: null,
        // Nodes have their start and end characters offsets recorded in
        // `start` and `end` properties (directly on the node, rather than
        // the `loc` object, which holds line/column data. To also add a
        // [semi-standardized][range] `range` property holding a `[start,
        // end]` array with the same numbers, set the `ranges` option to
        // `true`.
        //
        // [range]: https://bugzilla.mozilla.org/show_bug.cgi?id=745678
        ranges: false,
        // It is possible to parse multiple files into a single AST by
        // passing the tree produced by parsing the first file as
        // `program` option in subsequent parses. This will add the
        // toplevel forms of the parsed file to the `Program` (top) node
        // of an existing parse tree.
        program: null,
        // When `locations` is on, you can pass this to record the source
        // file in every node's `loc` object.
        sourceFile: null,
        // This value, if given, is stored in every node, whether
        // `locations` is on or off.
        directSourceFile: null,
        // When enabled, parenthesized expressions are represented by
        // (non-standard) ParenthesizedExpression nodes
        preserveParens: false,
        plugins: {}
      };

      // Interpret and default an options object

      function getOptions(opts) {
        var options = {};
        for (var opt in defaultOptions) {
          options[opt] = opts && has(opts, opt) ? opts[opt] : defaultOptions[opt];
        }if (options.allowReserved == null) options.allowReserved = options.ecmaVersion < 5;

        if (isArray(options.onToken)) {
          var tokens = options.onToken;
          options.onToken = function (token) {
            return tokens.push(token);
          };
        }
        if (isArray(options.onComment)) options.onComment = pushComment(options, options.onComment);

        return options;
      }

      function pushComment(options, array) {
        return function (block, text, start, end, startLoc, endLoc) {
          var comment = {
            type: block ? 'Block' : 'Line',
            value: text,
            start: start,
            end: end
          };
          if (options.locations) comment.loc = new SourceLocation(this, startLoc, endLoc);
          if (options.ranges) comment.range = [start, end];
          array.push(comment);
        };
      }

      // Registered plugins
      var plugins = {};

      function keywordRegexp(words) {
        return new RegExp("^(" + words.replace(/ /g, "|") + ")$");
      }

      var Parser = function Parser(options, input, startPos) {
        this.options = options = getOptions(options);
        this.sourceFile = options.sourceFile;
        this.keywords = keywordRegexp(keywords[options.ecmaVersion >= 6 ? 6 : 5]);
        var reserved = options.allowReserved ? "" : reservedWords[options.ecmaVersion] + (options.sourceType == "module" ? " await" : "");
        this.reservedWords = keywordRegexp(reserved);
        var reservedStrict = (reserved ? reserved + " " : "") + reservedWords.strict;
        this.reservedWordsStrict = keywordRegexp(reservedStrict);
        this.reservedWordsStrictBind = keywordRegexp(reservedStrict + " " + reservedWords.strictBind);
        this.input = String(input);

        // Used to signal to callers of `readWord1` whether the word
        // contained any escape sequences. This is needed because words with
        // escape sequences must not be interpreted as keywords.
        this.containsEsc = false;

        // Load plugins
        this.loadPlugins(options.plugins);

        // Set up token state

        // The current position of the tokenizer in the input.
        if (startPos) {
          this.pos = startPos;
          this.lineStart = Math.max(0, this.input.lastIndexOf("\n", startPos));
          this.curLine = this.input.slice(0, this.lineStart).split(lineBreak).length;
        } else {
          this.pos = this.lineStart = 0;
          this.curLine = 1;
        }

        // Properties of the current token:
        // Its type
        this.type = tt.eof;
        // For tokens that include more information than their type, the value
        this.value = null;
        // Its start and end offset
        this.start = this.end = this.pos;
        // And, if locations are used, the {line, column} object
        // corresponding to those offsets
        this.startLoc = this.endLoc = this.curPosition();

        // Position information for the previous token
        this.lastTokEndLoc = this.lastTokStartLoc = null;
        this.lastTokStart = this.lastTokEnd = this.pos;

        // The context stack is used to superficially track syntactic
        // context to predict whether a regular expression is allowed in a
        // given position.
        this.context = this.initialContext();
        this.exprAllowed = true;

        // Figure out if it's a module code.
        this.strict = this.inModule = options.sourceType === "module";

        // Used to signify the start of a potential arrow function
        this.potentialArrowAt = -1;

        // Flags to track whether we are in a function, a generator.
        this.inFunction = this.inGenerator = false;
        // Labels in scope.
        this.labels = [];

        // If enabled, skip leading hashbang line.
        if (this.pos === 0 && options.allowHashBang && this.input.slice(0, 2) === '#!') this.skipLineComment(2);
      };

      // DEPRECATED Kept for backwards compatibility until 3.0 in case a plugin uses them
      Parser.prototype.isKeyword = function isKeyword(word) {
        return this.keywords.test(word);
      };
      Parser.prototype.isReservedWord = function isReservedWord(word) {
        return this.reservedWords.test(word);
      };

      Parser.prototype.extend = function extend(name, f) {
        this[name] = f(this[name]);
      };

      Parser.prototype.loadPlugins = function loadPlugins(pluginConfigs) {
        var this$1 = this;

        for (var name in pluginConfigs) {
          var plugin = plugins[name];
          if (!plugin) throw new Error("Plugin '" + name + "' not found");
          plugin(this$1, pluginConfigs[name]);
        }
      };

      Parser.prototype.parse = function parse() {
        var node = this.options.program || this.startNode();
        this.nextToken();
        return this.parseTopLevel(node);
      };

      var pp = Parser.prototype;

      // ## Parser utilities

      // Test whether a statement node is the string literal `"use strict"`.

      pp.isUseStrict = function (stmt) {
        return this.options.ecmaVersion >= 5 && stmt.type === "ExpressionStatement" && stmt.expression.type === "Literal" && stmt.expression.raw.slice(1, -1) === "use strict";
      };

      // Predicate that tests whether the next token is of the given
      // type, and if yes, consumes it as a side effect.

      pp.eat = function (type) {
        if (this.type === type) {
          this.next();
          return true;
        } else {
          return false;
        }
      };

      // Tests whether parsed token is a contextual keyword.

      pp.isContextual = function (name) {
        return this.type === tt.name && this.value === name;
      };

      // Consumes contextual keyword if possible.

      pp.eatContextual = function (name) {
        return this.value === name && this.eat(tt.name);
      };

      // Asserts that following token is given contextual keyword.

      pp.expectContextual = function (name) {
        if (!this.eatContextual(name)) this.unexpected();
      };

      // Test whether a semicolon can be inserted at the current position.

      pp.canInsertSemicolon = function () {
        return this.type === tt.eof || this.type === tt.braceR || lineBreak.test(this.input.slice(this.lastTokEnd, this.start));
      };

      pp.insertSemicolon = function () {
        if (this.canInsertSemicolon()) {
          if (this.options.onInsertedSemicolon) this.options.onInsertedSemicolon(this.lastTokEnd, this.lastTokEndLoc);
          return true;
        }
      };

      // Consume a semicolon, or, failing that, see if we are allowed to
      // pretend that there is a semicolon at this position.

      pp.semicolon = function () {
        if (!this.eat(tt.semi) && !this.insertSemicolon()) this.unexpected();
      };

      pp.afterTrailingComma = function (tokType) {
        if (this.type == tokType) {
          if (this.options.onTrailingComma) this.options.onTrailingComma(this.lastTokStart, this.lastTokStartLoc);
          this.next();
          return true;
        }
      };

      // Expect a token of a given type. If found, consume it, otherwise,
      // raise an unexpected token error.

      pp.expect = function (type) {
        this.eat(type) || this.unexpected();
      };

      // Raise an unexpected token error.

      pp.unexpected = function (pos) {
        this.raise(pos != null ? pos : this.start, "Unexpected token");
      };

      var DestructuringErrors = function DestructuringErrors() {
        this.shorthandAssign = 0;
        this.trailingComma = 0;
      };

      pp.checkPatternErrors = function (refDestructuringErrors, andThrow) {
        var trailing = refDestructuringErrors && refDestructuringErrors.trailingComma;
        if (!andThrow) return !!trailing;
        if (trailing) this.raise(trailing, "Comma is not permitted after the rest element");
      };

      pp.checkExpressionErrors = function (refDestructuringErrors, andThrow) {
        var pos = refDestructuringErrors && refDestructuringErrors.shorthandAssign;
        if (!andThrow) return !!pos;
        if (pos) this.raise(pos, "Shorthand property assignments are valid only in destructuring patterns");
      };

      var pp$1 = Parser.prototype;

      // ### Statement parsing

      // Parse a program. Initializes the parser, reads any number of
      // statements, and wraps them in a Program node.  Optionally takes a
      // `program` argument.  If present, the statements will be appended
      // to its body instead of creating a new node.

      pp$1.parseTopLevel = function (node) {
        var this$1 = this;

        var first = true;
        if (!node.body) node.body = [];
        while (this.type !== tt.eof) {
          var stmt = this$1.parseStatement(true, true);
          node.body.push(stmt);
          if (first) {
            if (this$1.isUseStrict(stmt)) this$1.setStrict(true);
            first = false;
          }
        }
        this.next();
        if (this.options.ecmaVersion >= 6) {
          node.sourceType = this.options.sourceType;
        }
        return this.finishNode(node, "Program");
      };

      var loopLabel = { kind: "loop" };
      var switchLabel = { kind: "switch" };
      pp$1.isLet = function () {
        if (this.type !== tt.name || this.options.ecmaVersion < 6 || this.value != "let") return false;
        skipWhiteSpace.lastIndex = this.pos;
        var skip = skipWhiteSpace.exec(this.input);
        var next = this.pos + skip[0].length,
            nextCh = this.input.charCodeAt(next);
        if (nextCh === 91 || nextCh == 123) return true; // '{' and '['
        if (isIdentifierStart(nextCh, true)) {
          for (var pos = next + 1; isIdentifierChar(this.input.charCodeAt(pos), true); ++pos) {}
          var ident = this.input.slice(next, pos);
          if (!this.isKeyword(ident)) return true;
        }
        return false;
      };

      // Parse a single statement.
      //
      // If expecting a statement and finding a slash operator, parse a
      // regular expression literal. This is to handle cases like
      // `if (foo) /blah/.exec(foo)`, where looking at the previous token
      // does not help.

      pp$1.parseStatement = function (declaration, topLevel) {
        var starttype = this.type,
            node = this.startNode(),
            kind;

        if (this.isLet()) {
          starttype = tt._var;
          kind = "let";
        }

        // Most types of statements are recognized by the keyword they
        // start with. Many are trivial to parse, some require a bit of
        // complexity.

        switch (starttype) {
          case tt._break:case tt._continue:
            return this.parseBreakContinueStatement(node, starttype.keyword);
          case tt._debugger:
            return this.parseDebuggerStatement(node);
          case tt._do:
            return this.parseDoStatement(node);
          case tt._for:
            return this.parseForStatement(node);
          case tt._function:
            if (!declaration && this.options.ecmaVersion >= 6) this.unexpected();
            return this.parseFunctionStatement(node);
          case tt._class:
            if (!declaration) this.unexpected();
            return this.parseClass(node, true);
          case tt._if:
            return this.parseIfStatement(node);
          case tt._return:
            return this.parseReturnStatement(node);
          case tt._switch:
            return this.parseSwitchStatement(node);
          case tt._throw:
            return this.parseThrowStatement(node);
          case tt._try:
            return this.parseTryStatement(node);
          case tt._const:case tt._var:
            kind = kind || this.value;
            if (!declaration && kind != "var") this.unexpected();
            return this.parseVarStatement(node, kind);
          case tt._while:
            return this.parseWhileStatement(node);
          case tt._with:
            return this.parseWithStatement(node);
          case tt.braceL:
            return this.parseBlock();
          case tt.semi:
            return this.parseEmptyStatement(node);
          case tt._export:
          case tt._import:
            if (!this.options.allowImportExportEverywhere) {
              if (!topLevel) this.raise(this.start, "'import' and 'export' may only appear at the top level");
              if (!this.inModule) this.raise(this.start, "'import' and 'export' may appear only with 'sourceType: module'");
            }
            return starttype === tt._import ? this.parseImport(node) : this.parseExport(node);

          // If the statement does not start with a statement keyword or a
          // brace, it's an ExpressionStatement or LabeledStatement. We
          // simply start parsing an expression, and afterwards, if the
          // next token is a colon and the expression was a simple
          // Identifier node, we switch to interpreting it as a label.
          default:
            var maybeName = this.value,
                expr = this.parseExpression();
            if (starttype === tt.name && expr.type === "Identifier" && this.eat(tt.colon)) return this.parseLabeledStatement(node, maybeName, expr);else return this.parseExpressionStatement(node, expr);
        }
      };

      pp$1.parseBreakContinueStatement = function (node, keyword) {
        var this$1 = this;

        var isBreak = keyword == "break";
        this.next();
        if (this.eat(tt.semi) || this.insertSemicolon()) node.label = null;else if (this.type !== tt.name) this.unexpected();else {
          node.label = this.parseIdent();
          this.semicolon();
        }

        // Verify that there is an actual destination to break or
        // continue to.
        for (var i = 0; i < this.labels.length; ++i) {
          var lab = this$1.labels[i];
          if (node.label == null || lab.name === node.label.name) {
            if (lab.kind != null && (isBreak || lab.kind === "loop")) break;
            if (node.label && isBreak) break;
          }
        }
        if (i === this.labels.length) this.raise(node.start, "Unsyntactic " + keyword);
        return this.finishNode(node, isBreak ? "BreakStatement" : "ContinueStatement");
      };

      pp$1.parseDebuggerStatement = function (node) {
        this.next();
        this.semicolon();
        return this.finishNode(node, "DebuggerStatement");
      };

      pp$1.parseDoStatement = function (node) {
        this.next();
        this.labels.push(loopLabel);
        node.body = this.parseStatement(false);
        this.labels.pop();
        this.expect(tt._while);
        node.test = this.parseParenExpression();
        if (this.options.ecmaVersion >= 6) this.eat(tt.semi);else this.semicolon();
        return this.finishNode(node, "DoWhileStatement");
      };

      // Disambiguating between a `for` and a `for`/`in` or `for`/`of`
      // loop is non-trivial. Basically, we have to parse the init `var`
      // statement or expression, disallowing the `in` operator (see
      // the second parameter to `parseExpression`), and then check
      // whether the next token is `in` or `of`. When there is no init
      // part (semicolon immediately after the opening parenthesis), it
      // is a regular `for` loop.

      pp$1.parseForStatement = function (node) {
        this.next();
        this.labels.push(loopLabel);
        this.expect(tt.parenL);
        if (this.type === tt.semi) return this.parseFor(node, null);
        var isLet = this.isLet();
        if (this.type === tt._var || this.type === tt._const || isLet) {
          var init$1 = this.startNode(),
              kind = isLet ? "let" : this.value;
          this.next();
          this.parseVar(init$1, true, kind);
          this.finishNode(init$1, "VariableDeclaration");
          if ((this.type === tt._in || this.options.ecmaVersion >= 6 && this.isContextual("of")) && init$1.declarations.length === 1 && !(kind !== "var" && init$1.declarations[0].init)) return this.parseForIn(node, init$1);
          return this.parseFor(node, init$1);
        }
        var refDestructuringErrors = new DestructuringErrors();
        var init = this.parseExpression(true, refDestructuringErrors);
        if (this.type === tt._in || this.options.ecmaVersion >= 6 && this.isContextual("of")) {
          this.checkPatternErrors(refDestructuringErrors, true);
          this.toAssignable(init);
          this.checkLVal(init);
          return this.parseForIn(node, init);
        } else {
          this.checkExpressionErrors(refDestructuringErrors, true);
        }
        return this.parseFor(node, init);
      };

      pp$1.parseFunctionStatement = function (node) {
        this.next();
        return this.parseFunction(node, true);
      };

      pp$1.parseIfStatement = function (node) {
        this.next();
        node.test = this.parseParenExpression();
        node.consequent = this.parseStatement(false);
        node.alternate = this.eat(tt._else) ? this.parseStatement(false) : null;
        return this.finishNode(node, "IfStatement");
      };

      pp$1.parseReturnStatement = function (node) {
        if (!this.inFunction && !this.options.allowReturnOutsideFunction) this.raise(this.start, "'return' outside of function");
        this.next();

        // In `return` (and `break`/`continue`), the keywords with
        // optional arguments, we eagerly look for a semicolon or the
        // possibility to insert one.

        if (this.eat(tt.semi) || this.insertSemicolon()) node.argument = null;else {
          node.argument = this.parseExpression();this.semicolon();
        }
        return this.finishNode(node, "ReturnStatement");
      };

      pp$1.parseSwitchStatement = function (node) {
        var this$1 = this;

        this.next();
        node.discriminant = this.parseParenExpression();
        node.cases = [];
        this.expect(tt.braceL);
        this.labels.push(switchLabel);

        // Statements under must be grouped (by label) in SwitchCase
        // nodes. `cur` is used to keep the node that we are currently
        // adding statements to.

        for (var cur, sawDefault = false; this.type != tt.braceR;) {
          if (this$1.type === tt._case || this$1.type === tt._default) {
            var isCase = this$1.type === tt._case;
            if (cur) this$1.finishNode(cur, "SwitchCase");
            node.cases.push(cur = this$1.startNode());
            cur.consequent = [];
            this$1.next();
            if (isCase) {
              cur.test = this$1.parseExpression();
            } else {
              if (sawDefault) this$1.raiseRecoverable(this$1.lastTokStart, "Multiple default clauses");
              sawDefault = true;
              cur.test = null;
            }
            this$1.expect(tt.colon);
          } else {
            if (!cur) this$1.unexpected();
            cur.consequent.push(this$1.parseStatement(true));
          }
        }
        if (cur) this.finishNode(cur, "SwitchCase");
        this.next(); // Closing brace
        this.labels.pop();
        return this.finishNode(node, "SwitchStatement");
      };

      pp$1.parseThrowStatement = function (node) {
        this.next();
        if (lineBreak.test(this.input.slice(this.lastTokEnd, this.start))) this.raise(this.lastTokEnd, "Illegal newline after throw");
        node.argument = this.parseExpression();
        this.semicolon();
        return this.finishNode(node, "ThrowStatement");
      };

      // Reused empty array added for node fields that are always empty.

      var empty = [];

      pp$1.parseTryStatement = function (node) {
        this.next();
        node.block = this.parseBlock();
        node.handler = null;
        if (this.type === tt._catch) {
          var clause = this.startNode();
          this.next();
          this.expect(tt.parenL);
          clause.param = this.parseBindingAtom();
          this.checkLVal(clause.param, true);
          this.expect(tt.parenR);
          clause.body = this.parseBlock();
          node.handler = this.finishNode(clause, "CatchClause");
        }
        node.finalizer = this.eat(tt._finally) ? this.parseBlock() : null;
        if (!node.handler && !node.finalizer) this.raise(node.start, "Missing catch or finally clause");
        return this.finishNode(node, "TryStatement");
      };

      pp$1.parseVarStatement = function (node, kind) {
        this.next();
        this.parseVar(node, false, kind);
        this.semicolon();
        return this.finishNode(node, "VariableDeclaration");
      };

      pp$1.parseWhileStatement = function (node) {
        this.next();
        node.test = this.parseParenExpression();
        this.labels.push(loopLabel);
        node.body = this.parseStatement(false);
        this.labels.pop();
        return this.finishNode(node, "WhileStatement");
      };

      pp$1.parseWithStatement = function (node) {
        if (this.strict) this.raise(this.start, "'with' in strict mode");
        this.next();
        node.object = this.parseParenExpression();
        node.body = this.parseStatement(false);
        return this.finishNode(node, "WithStatement");
      };

      pp$1.parseEmptyStatement = function (node) {
        this.next();
        return this.finishNode(node, "EmptyStatement");
      };

      pp$1.parseLabeledStatement = function (node, maybeName, expr) {
        var this$1 = this;

        for (var i = 0; i < this.labels.length; ++i) {
          if (this$1.labels[i].name === maybeName) this$1.raise(expr.start, "Label '" + maybeName + "' is already declared");
        }var kind = this.type.isLoop ? "loop" : this.type === tt._switch ? "switch" : null;
        for (var i$1 = this.labels.length - 1; i$1 >= 0; i$1--) {
          var label = this$1.labels[i$1];
          if (label.statementStart == node.start) {
            label.statementStart = this$1.start;
            label.kind = kind;
          } else break;
        }
        this.labels.push({ name: maybeName, kind: kind, statementStart: this.start });
        node.body = this.parseStatement(true);
        this.labels.pop();
        node.label = expr;
        return this.finishNode(node, "LabeledStatement");
      };

      pp$1.parseExpressionStatement = function (node, expr) {
        node.expression = expr;
        this.semicolon();
        return this.finishNode(node, "ExpressionStatement");
      };

      // Parse a semicolon-enclosed block of statements, handling `"use
      // strict"` declarations when `allowStrict` is true (used for
      // function bodies).

      pp$1.parseBlock = function (allowStrict) {
        var this$1 = this;

        var node = this.startNode(),
            first = true,
            oldStrict;
        node.body = [];
        this.expect(tt.braceL);
        while (!this.eat(tt.braceR)) {
          var stmt = this$1.parseStatement(true);
          node.body.push(stmt);
          if (first && allowStrict && this$1.isUseStrict(stmt)) {
            oldStrict = this$1.strict;
            this$1.setStrict(this$1.strict = true);
          }
          first = false;
        }
        if (oldStrict === false) this.setStrict(false);
        return this.finishNode(node, "BlockStatement");
      };

      // Parse a regular `for` loop. The disambiguation code in
      // `parseStatement` will already have parsed the init statement or
      // expression.

      pp$1.parseFor = function (node, init) {
        node.init = init;
        this.expect(tt.semi);
        node.test = this.type === tt.semi ? null : this.parseExpression();
        this.expect(tt.semi);
        node.update = this.type === tt.parenR ? null : this.parseExpression();
        this.expect(tt.parenR);
        node.body = this.parseStatement(false);
        this.labels.pop();
        return this.finishNode(node, "ForStatement");
      };

      // Parse a `for`/`in` and `for`/`of` loop, which are almost
      // same from parser's perspective.

      pp$1.parseForIn = function (node, init) {
        var type = this.type === tt._in ? "ForInStatement" : "ForOfStatement";
        this.next();
        node.left = init;
        node.right = this.parseExpression();
        this.expect(tt.parenR);
        node.body = this.parseStatement(false);
        this.labels.pop();
        return this.finishNode(node, type);
      };

      // Parse a list of variable declarations.

      pp$1.parseVar = function (node, isFor, kind) {
        var this$1 = this;

        node.declarations = [];
        node.kind = kind;
        for (;;) {
          var decl = this$1.startNode();
          this$1.parseVarId(decl);
          if (this$1.eat(tt.eq)) {
            decl.init = this$1.parseMaybeAssign(isFor);
          } else if (kind === "const" && !(this$1.type === tt._in || this$1.options.ecmaVersion >= 6 && this$1.isContextual("of"))) {
            this$1.unexpected();
          } else if (decl.id.type != "Identifier" && !(isFor && (this$1.type === tt._in || this$1.isContextual("of")))) {
            this$1.raise(this$1.lastTokEnd, "Complex binding patterns require an initialization value");
          } else {
            decl.init = null;
          }
          node.declarations.push(this$1.finishNode(decl, "VariableDeclarator"));
          if (!this$1.eat(tt.comma)) break;
        }
        return node;
      };

      pp$1.parseVarId = function (decl) {
        decl.id = this.parseBindingAtom();
        this.checkLVal(decl.id, true);
      };

      // Parse a function declaration or literal (depending on the
      // `isStatement` parameter).

      pp$1.parseFunction = function (node, isStatement, allowExpressionBody) {
        this.initFunction(node);
        if (this.options.ecmaVersion >= 6) node.generator = this.eat(tt.star);
        var oldInGen = this.inGenerator;
        this.inGenerator = node.generator;
        if (isStatement || this.type === tt.name) node.id = this.parseIdent();
        this.parseFunctionParams(node);
        this.parseFunctionBody(node, allowExpressionBody);
        this.inGenerator = oldInGen;
        return this.finishNode(node, isStatement ? "FunctionDeclaration" : "FunctionExpression");
      };

      pp$1.parseFunctionParams = function (node) {
        this.expect(tt.parenL);
        node.params = this.parseBindingList(tt.parenR, false, false, true);
      };

      // Parse a class declaration or literal (depending on the
      // `isStatement` parameter).

      pp$1.parseClass = function (node, isStatement) {
        var this$1 = this;

        this.next();
        this.parseClassId(node, isStatement);
        this.parseClassSuper(node);
        var classBody = this.startNode();
        var hadConstructor = false;
        classBody.body = [];
        this.expect(tt.braceL);
        while (!this.eat(tt.braceR)) {
          if (this$1.eat(tt.semi)) continue;
          var method = this$1.startNode();
          var isGenerator = this$1.eat(tt.star);
          var isMaybeStatic = this$1.type === tt.name && this$1.value === "static";
          this$1.parsePropertyName(method);
          method.static = isMaybeStatic && this$1.type !== tt.parenL;
          if (method.static) {
            if (isGenerator) this$1.unexpected();
            isGenerator = this$1.eat(tt.star);
            this$1.parsePropertyName(method);
          }
          method.kind = "method";
          var isGetSet = false;
          if (!method.computed) {
            var key = method.key;
            if (!isGenerator && key.type === "Identifier" && this$1.type !== tt.parenL && (key.name === "get" || key.name === "set")) {
              isGetSet = true;
              method.kind = key.name;
              key = this$1.parsePropertyName(method);
            }
            if (!method.static && (key.type === "Identifier" && key.name === "constructor" || key.type === "Literal" && key.value === "constructor")) {
              if (hadConstructor) this$1.raise(key.start, "Duplicate constructor in the same class");
              if (isGetSet) this$1.raise(key.start, "Constructor can't have get/set modifier");
              if (isGenerator) this$1.raise(key.start, "Constructor can't be a generator");
              method.kind = "constructor";
              hadConstructor = true;
            }
          }
          this$1.parseClassMethod(classBody, method, isGenerator);
          if (isGetSet) {
            var paramCount = method.kind === "get" ? 0 : 1;
            if (method.value.params.length !== paramCount) {
              var start = method.value.start;
              if (method.kind === "get") this$1.raiseRecoverable(start, "getter should have no params");else this$1.raiseRecoverable(start, "setter should have exactly one param");
            }
            if (method.kind === "set" && method.value.params[0].type === "RestElement") this$1.raise(method.value.params[0].start, "Setter cannot use rest params");
          }
        }
        node.body = this.finishNode(classBody, "ClassBody");
        return this.finishNode(node, isStatement ? "ClassDeclaration" : "ClassExpression");
      };

      pp$1.parseClassMethod = function (classBody, method, isGenerator) {
        method.value = this.parseMethod(isGenerator);
        classBody.body.push(this.finishNode(method, "MethodDefinition"));
      };

      pp$1.parseClassId = function (node, isStatement) {
        node.id = this.type === tt.name ? this.parseIdent() : isStatement ? this.unexpected() : null;
      };

      pp$1.parseClassSuper = function (node) {
        node.superClass = this.eat(tt._extends) ? this.parseExprSubscripts() : null;
      };

      // Parses module export declaration.

      pp$1.parseExport = function (node) {
        var this$1 = this;

        this.next();
        // export * from '...'
        if (this.eat(tt.star)) {
          this.expectContextual("from");
          node.source = this.type === tt.string ? this.parseExprAtom() : this.unexpected();
          this.semicolon();
          return this.finishNode(node, "ExportAllDeclaration");
        }
        if (this.eat(tt._default)) {
          // export default ...
          var parens = this.type == tt.parenL;
          var expr = this.parseMaybeAssign();
          var needsSemi = true;
          if (!parens && (expr.type == "FunctionExpression" || expr.type == "ClassExpression")) {
            needsSemi = false;
            if (expr.id) {
              expr.type = expr.type == "FunctionExpression" ? "FunctionDeclaration" : "ClassDeclaration";
            }
          }
          node.declaration = expr;
          if (needsSemi) this.semicolon();
          return this.finishNode(node, "ExportDefaultDeclaration");
        }
        // export var|const|let|function|class ...
        if (this.shouldParseExportStatement()) {
          node.declaration = this.parseStatement(true);
          node.specifiers = [];
          node.source = null;
        } else {
          // export { x, y as z } [from '...']
          node.declaration = null;
          node.specifiers = this.parseExportSpecifiers();
          if (this.eatContextual("from")) {
            node.source = this.type === tt.string ? this.parseExprAtom() : this.unexpected();
          } else {
            // check for keywords used as local names
            for (var i = 0; i < node.specifiers.length; i++) {
              if (this$1.keywords.test(node.specifiers[i].local.name) || this$1.reservedWords.test(node.specifiers[i].local.name)) {
                this$1.unexpected(node.specifiers[i].local.start);
              }
            }

            node.source = null;
          }
          this.semicolon();
        }
        return this.finishNode(node, "ExportNamedDeclaration");
      };

      pp$1.shouldParseExportStatement = function () {
        return this.type.keyword || this.isLet();
      };

      // Parses a comma-separated list of module exports.

      pp$1.parseExportSpecifiers = function () {
        var this$1 = this;

        var nodes = [],
            first = true;
        // export { x, y as z } [from '...']
        this.expect(tt.braceL);
        while (!this.eat(tt.braceR)) {
          if (!first) {
            this$1.expect(tt.comma);
            if (this$1.afterTrailingComma(tt.braceR)) break;
          } else first = false;

          var node = this$1.startNode();
          node.local = this$1.parseIdent(this$1.type === tt._default);
          node.exported = this$1.eatContextual("as") ? this$1.parseIdent(true) : node.local;
          nodes.push(this$1.finishNode(node, "ExportSpecifier"));
        }
        return nodes;
      };

      // Parses import declaration.

      pp$1.parseImport = function (node) {
        this.next();
        // import '...'
        if (this.type === tt.string) {
          node.specifiers = empty;
          node.source = this.parseExprAtom();
        } else {
          node.specifiers = this.parseImportSpecifiers();
          this.expectContextual("from");
          node.source = this.type === tt.string ? this.parseExprAtom() : this.unexpected();
        }
        this.semicolon();
        return this.finishNode(node, "ImportDeclaration");
      };

      // Parses a comma-separated list of module imports.

      pp$1.parseImportSpecifiers = function () {
        var this$1 = this;

        var nodes = [],
            first = true;
        if (this.type === tt.name) {
          // import defaultObj, { x, y as z } from '...'
          var node = this.startNode();
          node.local = this.parseIdent();
          this.checkLVal(node.local, true);
          nodes.push(this.finishNode(node, "ImportDefaultSpecifier"));
          if (!this.eat(tt.comma)) return nodes;
        }
        if (this.type === tt.star) {
          var node$1 = this.startNode();
          this.next();
          this.expectContextual("as");
          node$1.local = this.parseIdent();
          this.checkLVal(node$1.local, true);
          nodes.push(this.finishNode(node$1, "ImportNamespaceSpecifier"));
          return nodes;
        }
        this.expect(tt.braceL);
        while (!this.eat(tt.braceR)) {
          if (!first) {
            this$1.expect(tt.comma);
            if (this$1.afterTrailingComma(tt.braceR)) break;
          } else first = false;

          var node$2 = this$1.startNode();
          node$2.imported = this$1.parseIdent(true);
          if (this$1.eatContextual("as")) {
            node$2.local = this$1.parseIdent();
          } else {
            node$2.local = node$2.imported;
            if (this$1.isKeyword(node$2.local.name)) this$1.unexpected(node$2.local.start);
            if (this$1.reservedWordsStrict.test(node$2.local.name)) this$1.raise(node$2.local.start, "The keyword '" + node$2.local.name + "' is reserved");
          }
          this$1.checkLVal(node$2.local, true);
          nodes.push(this$1.finishNode(node$2, "ImportSpecifier"));
        }
        return nodes;
      };

      var pp$2 = Parser.prototype;

      // Convert existing expression atom to assignable pattern
      // if possible.

      pp$2.toAssignable = function (node, isBinding) {
        var this$1 = this;

        if (this.options.ecmaVersion >= 6 && node) {
          switch (node.type) {
            case "Identifier":
            case "ObjectPattern":
            case "ArrayPattern":
              break;

            case "ObjectExpression":
              node.type = "ObjectPattern";
              for (var i = 0; i < node.properties.length; i++) {
                var prop = node.properties[i];
                if (prop.kind !== "init") this$1.raise(prop.key.start, "Object pattern can't contain getter or setter");
                this$1.toAssignable(prop.value, isBinding);
              }
              break;

            case "ArrayExpression":
              node.type = "ArrayPattern";
              this.toAssignableList(node.elements, isBinding);
              break;

            case "AssignmentExpression":
              if (node.operator === "=") {
                node.type = "AssignmentPattern";
                delete node.operator;
                // falls through to AssignmentPattern
              } else {
                this.raise(node.left.end, "Only '=' operator can be used for specifying default value.");
                break;
              }

            case "AssignmentPattern":
              if (node.right.type === "YieldExpression") this.raise(node.right.start, "Yield expression cannot be a default value");
              break;

            case "ParenthesizedExpression":
              node.expression = this.toAssignable(node.expression, isBinding);
              break;

            case "MemberExpression":
              if (!isBinding) break;

            default:
              this.raise(node.start, "Assigning to rvalue");
          }
        }
        return node;
      };

      // Convert list of expression atoms to binding list.

      pp$2.toAssignableList = function (exprList, isBinding) {
        var this$1 = this;

        var end = exprList.length;
        if (end) {
          var last = exprList[end - 1];
          if (last && last.type == "RestElement") {
            --end;
          } else if (last && last.type == "SpreadElement") {
            last.type = "RestElement";
            var arg = last.argument;
            this.toAssignable(arg, isBinding);
            if (arg.type !== "Identifier" && arg.type !== "MemberExpression" && arg.type !== "ArrayPattern") this.unexpected(arg.start);
            --end;
          }

          if (isBinding && last && last.type === "RestElement" && last.argument.type !== "Identifier") this.unexpected(last.argument.start);
        }
        for (var i = 0; i < end; i++) {
          var elt = exprList[i];
          if (elt) this$1.toAssignable(elt, isBinding);
        }
        return exprList;
      };

      // Parses spread element.

      pp$2.parseSpread = function (refDestructuringErrors) {
        var node = this.startNode();
        this.next();
        node.argument = this.parseMaybeAssign(false, refDestructuringErrors);
        return this.finishNode(node, "SpreadElement");
      };

      pp$2.parseRest = function (allowNonIdent) {
        var node = this.startNode();
        this.next();

        // RestElement inside of a function parameter must be an identifier
        if (allowNonIdent) node.argument = this.type === tt.name ? this.parseIdent() : this.unexpected();else node.argument = this.type === tt.name || this.type === tt.bracketL ? this.parseBindingAtom() : this.unexpected();

        return this.finishNode(node, "RestElement");
      };

      // Parses lvalue (assignable) atom.

      pp$2.parseBindingAtom = function () {
        if (this.options.ecmaVersion < 6) return this.parseIdent();
        switch (this.type) {
          case tt.name:
            return this.parseIdent();

          case tt.bracketL:
            var node = this.startNode();
            this.next();
            node.elements = this.parseBindingList(tt.bracketR, true, true);
            return this.finishNode(node, "ArrayPattern");

          case tt.braceL:
            return this.parseObj(true);

          default:
            this.unexpected();
        }
      };

      pp$2.parseBindingList = function (close, allowEmpty, allowTrailingComma, allowNonIdent) {
        var this$1 = this;

        var elts = [],
            first = true;
        while (!this.eat(close)) {
          if (first) first = false;else this$1.expect(tt.comma);
          if (allowEmpty && this$1.type === tt.comma) {
            elts.push(null);
          } else if (allowTrailingComma && this$1.afterTrailingComma(close)) {
            break;
          } else if (this$1.type === tt.ellipsis) {
            var rest = this$1.parseRest(allowNonIdent);
            this$1.parseBindingListItem(rest);
            elts.push(rest);
            if (this$1.type === tt.comma) this$1.raise(this$1.start, "Comma is not permitted after the rest element");
            this$1.expect(close);
            break;
          } else {
            var elem = this$1.parseMaybeDefault(this$1.start, this$1.startLoc);
            this$1.parseBindingListItem(elem);
            elts.push(elem);
          }
        }
        return elts;
      };

      pp$2.parseBindingListItem = function (param) {
        return param;
      };

      // Parses assignment pattern around given atom if possible.

      pp$2.parseMaybeDefault = function (startPos, startLoc, left) {
        left = left || this.parseBindingAtom();
        if (this.options.ecmaVersion < 6 || !this.eat(tt.eq)) return left;
        var node = this.startNodeAt(startPos, startLoc);
        node.left = left;
        node.right = this.parseMaybeAssign();
        return this.finishNode(node, "AssignmentPattern");
      };

      // Verify that a node is an lval — something that can be assigned
      // to.

      pp$2.checkLVal = function (expr, isBinding, checkClashes) {
        var this$1 = this;

        switch (expr.type) {
          case "Identifier":
            if (this.strict && this.reservedWordsStrictBind.test(expr.name)) this.raiseRecoverable(expr.start, (isBinding ? "Binding " : "Assigning to ") + expr.name + " in strict mode");
            if (checkClashes) {
              if (has(checkClashes, expr.name)) this.raiseRecoverable(expr.start, "Argument name clash");
              checkClashes[expr.name] = true;
            }
            break;

          case "MemberExpression":
            if (isBinding) this.raiseRecoverable(expr.start, (isBinding ? "Binding" : "Assigning to") + " member expression");
            break;

          case "ObjectPattern":
            for (var i = 0; i < expr.properties.length; i++) {
              this$1.checkLVal(expr.properties[i].value, isBinding, checkClashes);
            }break;

          case "ArrayPattern":
            for (var i$1 = 0; i$1 < expr.elements.length; i$1++) {
              var elem = expr.elements[i$1];
              if (elem) this$1.checkLVal(elem, isBinding, checkClashes);
            }
            break;

          case "AssignmentPattern":
            this.checkLVal(expr.left, isBinding, checkClashes);
            break;

          case "RestElement":
            this.checkLVal(expr.argument, isBinding, checkClashes);
            break;

          case "ParenthesizedExpression":
            this.checkLVal(expr.expression, isBinding, checkClashes);
            break;

          default:
            this.raise(expr.start, (isBinding ? "Binding" : "Assigning to") + " rvalue");
        }
      };

      var pp$3 = Parser.prototype;

      // Check if property name clashes with already added.
      // Object/class getters and setters are not allowed to clash —
      // either with each other or with an init property — and in
      // strict mode, init properties are also not allowed to be repeated.

      pp$3.checkPropClash = function (prop, propHash) {
        if (this.options.ecmaVersion >= 6 && (prop.computed || prop.method || prop.shorthand)) return;
        var key = prop.key;
        var name;
        switch (key.type) {
          case "Identifier":
            name = key.name;break;
          case "Literal":
            name = String(key.value);break;
          default:
            return;
        }
        var kind = prop.kind;
        if (this.options.ecmaVersion >= 6) {
          if (name === "__proto__" && kind === "init") {
            if (propHash.proto) this.raiseRecoverable(key.start, "Redefinition of __proto__ property");
            propHash.proto = true;
          }
          return;
        }
        name = "$" + name;
        var other = propHash[name];
        if (other) {
          var isGetSet = kind !== "init";
          if ((this.strict || isGetSet) && other[kind] || !(isGetSet ^ other.init)) this.raiseRecoverable(key.start, "Redefinition of property");
        } else {
          other = propHash[name] = {
            init: false,
            get: false,
            set: false
          };
        }
        other[kind] = true;
      };

      // ### Expression parsing

      // These nest, from the most general expression type at the top to
      // 'atomic', nondivisible expression types at the bottom. Most of
      // the functions will simply let the function(s) below them parse,
      // and, *if* the syntactic construct they handle is present, wrap
      // the AST node that the inner parser gave them in another node.

      // Parse a full expression. The optional arguments are used to
      // forbid the `in` operator (in for loops initalization expressions)
      // and provide reference for storing '=' operator inside shorthand
      // property assignment in contexts where both object expression
      // and object pattern might appear (so it's possible to raise
      // delayed syntax error at correct position).

      pp$3.parseExpression = function (noIn, refDestructuringErrors) {
        var this$1 = this;

        var startPos = this.start,
            startLoc = this.startLoc;
        var expr = this.parseMaybeAssign(noIn, refDestructuringErrors);
        if (this.type === tt.comma) {
          var node = this.startNodeAt(startPos, startLoc);
          node.expressions = [expr];
          while (this.eat(tt.comma)) {
            node.expressions.push(this$1.parseMaybeAssign(noIn, refDestructuringErrors));
          }return this.finishNode(node, "SequenceExpression");
        }
        return expr;
      };

      // Parse an assignment expression. This includes applications of
      // operators like `+=`.

      pp$3.parseMaybeAssign = function (noIn, refDestructuringErrors, afterLeftParse) {
        if (this.inGenerator && this.isContextual("yield")) return this.parseYield();

        var ownDestructuringErrors = false;
        if (!refDestructuringErrors) {
          refDestructuringErrors = new DestructuringErrors();
          ownDestructuringErrors = true;
        }
        var startPos = this.start,
            startLoc = this.startLoc;
        if (this.type == tt.parenL || this.type == tt.name) this.potentialArrowAt = this.start;
        var left = this.parseMaybeConditional(noIn, refDestructuringErrors);
        if (afterLeftParse) left = afterLeftParse.call(this, left, startPos, startLoc);
        if (this.type.isAssign) {
          this.checkPatternErrors(refDestructuringErrors, true);
          if (!ownDestructuringErrors) DestructuringErrors.call(refDestructuringErrors);
          var node = this.startNodeAt(startPos, startLoc);
          node.operator = this.value;
          node.left = this.type === tt.eq ? this.toAssignable(left) : left;
          refDestructuringErrors.shorthandAssign = 0; // reset because shorthand default was used correctly
          this.checkLVal(left);
          this.next();
          node.right = this.parseMaybeAssign(noIn);
          return this.finishNode(node, "AssignmentExpression");
        } else {
          if (ownDestructuringErrors) this.checkExpressionErrors(refDestructuringErrors, true);
        }
        return left;
      };

      // Parse a ternary conditional (`?:`) operator.

      pp$3.parseMaybeConditional = function (noIn, refDestructuringErrors) {
        var startPos = this.start,
            startLoc = this.startLoc;
        var expr = this.parseExprOps(noIn, refDestructuringErrors);
        if (this.checkExpressionErrors(refDestructuringErrors)) return expr;
        if (this.eat(tt.question)) {
          var node = this.startNodeAt(startPos, startLoc);
          node.test = expr;
          node.consequent = this.parseMaybeAssign();
          this.expect(tt.colon);
          node.alternate = this.parseMaybeAssign(noIn);
          return this.finishNode(node, "ConditionalExpression");
        }
        return expr;
      };

      // Start the precedence parser.

      pp$3.parseExprOps = function (noIn, refDestructuringErrors) {
        var startPos = this.start,
            startLoc = this.startLoc;
        var expr = this.parseMaybeUnary(refDestructuringErrors, false);
        if (this.checkExpressionErrors(refDestructuringErrors)) return expr;
        return this.parseExprOp(expr, startPos, startLoc, -1, noIn);
      };

      // Parse binary operators with the operator precedence parsing
      // algorithm. `left` is the left-hand side of the operator.
      // `minPrec` provides context that allows the function to stop and
      // defer further parser to one of its callers when it encounters an
      // operator that has a lower precedence than the set it is parsing.

      pp$3.parseExprOp = function (left, leftStartPos, leftStartLoc, minPrec, noIn) {
        var prec = this.type.binop;
        if (prec != null && (!noIn || this.type !== tt._in)) {
          if (prec > minPrec) {
            var logical = this.type === tt.logicalOR || this.type === tt.logicalAND;
            var op = this.value;
            this.next();
            var startPos = this.start,
                startLoc = this.startLoc;
            var right = this.parseExprOp(this.parseMaybeUnary(null, false), startPos, startLoc, prec, noIn);
            var node = this.buildBinary(leftStartPos, leftStartLoc, left, right, op, logical);
            return this.parseExprOp(node, leftStartPos, leftStartLoc, minPrec, noIn);
          }
        }
        return left;
      };

      pp$3.buildBinary = function (startPos, startLoc, left, right, op, logical) {
        var node = this.startNodeAt(startPos, startLoc);
        node.left = left;
        node.operator = op;
        node.right = right;
        return this.finishNode(node, logical ? "LogicalExpression" : "BinaryExpression");
      };

      // Parse unary operators, both prefix and postfix.

      pp$3.parseMaybeUnary = function (refDestructuringErrors, sawUnary) {
        var this$1 = this;

        var startPos = this.start,
            startLoc = this.startLoc,
            expr;
        if (this.type.prefix) {
          var node = this.startNode(),
              update = this.type === tt.incDec;
          node.operator = this.value;
          node.prefix = true;
          this.next();
          node.argument = this.parseMaybeUnary(null, true);
          this.checkExpressionErrors(refDestructuringErrors, true);
          if (update) this.checkLVal(node.argument);else if (this.strict && node.operator === "delete" && node.argument.type === "Identifier") this.raiseRecoverable(node.start, "Deleting local variable in strict mode");else sawUnary = true;
          expr = this.finishNode(node, update ? "UpdateExpression" : "UnaryExpression");
        } else {
          expr = this.parseExprSubscripts(refDestructuringErrors);
          if (this.checkExpressionErrors(refDestructuringErrors)) return expr;
          while (this.type.postfix && !this.canInsertSemicolon()) {
            var node$1 = this$1.startNodeAt(startPos, startLoc);
            node$1.operator = this$1.value;
            node$1.prefix = false;
            node$1.argument = expr;
            this$1.checkLVal(expr);
            this$1.next();
            expr = this$1.finishNode(node$1, "UpdateExpression");
          }
        }

        if (!sawUnary && this.eat(tt.starstar)) return this.buildBinary(startPos, startLoc, expr, this.parseMaybeUnary(null, false), "**", false);else return expr;
      };

      // Parse call, dot, and `[]`-subscript expressions.

      pp$3.parseExprSubscripts = function (refDestructuringErrors) {
        var startPos = this.start,
            startLoc = this.startLoc;
        var expr = this.parseExprAtom(refDestructuringErrors);
        var skipArrowSubscripts = expr.type === "ArrowFunctionExpression" && this.input.slice(this.lastTokStart, this.lastTokEnd) !== ")";
        if (this.checkExpressionErrors(refDestructuringErrors) || skipArrowSubscripts) return expr;
        return this.parseSubscripts(expr, startPos, startLoc);
      };

      pp$3.parseSubscripts = function (base, startPos, startLoc, noCalls) {
        var this$1 = this;

        for (;;) {
          if (this$1.eat(tt.dot)) {
            var node = this$1.startNodeAt(startPos, startLoc);
            node.object = base;
            node.property = this$1.parseIdent(true);
            node.computed = false;
            base = this$1.finishNode(node, "MemberExpression");
          } else if (this$1.eat(tt.bracketL)) {
            var node$1 = this$1.startNodeAt(startPos, startLoc);
            node$1.object = base;
            node$1.property = this$1.parseExpression();
            node$1.computed = true;
            this$1.expect(tt.bracketR);
            base = this$1.finishNode(node$1, "MemberExpression");
          } else if (!noCalls && this$1.eat(tt.parenL)) {
            var node$2 = this$1.startNodeAt(startPos, startLoc);
            node$2.callee = base;
            node$2.arguments = this$1.parseExprList(tt.parenR, false);
            base = this$1.finishNode(node$2, "CallExpression");
          } else if (this$1.type === tt.backQuote) {
            var node$3 = this$1.startNodeAt(startPos, startLoc);
            node$3.tag = base;
            node$3.quasi = this$1.parseTemplate();
            base = this$1.finishNode(node$3, "TaggedTemplateExpression");
          } else {
            return base;
          }
        }
      };

      // Parse an atomic expression — either a single token that is an
      // expression, an expression started by a keyword like `function` or
      // `new`, or an expression wrapped in punctuation like `()`, `[]`,
      // or `{}`.

      pp$3.parseExprAtom = function (refDestructuringErrors) {
        var node,
            canBeArrow = this.potentialArrowAt == this.start;
        switch (this.type) {
          case tt._super:
            if (!this.inFunction) this.raise(this.start, "'super' outside of function or class");

          case tt._this:
            var type = this.type === tt._this ? "ThisExpression" : "Super";
            node = this.startNode();
            this.next();
            return this.finishNode(node, type);

          case tt.name:
            var startPos = this.start,
                startLoc = this.startLoc;
            var id = this.parseIdent(this.type !== tt.name);
            if (canBeArrow && !this.canInsertSemicolon() && this.eat(tt.arrow)) return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), [id]);
            return id;

          case tt.regexp:
            var value = this.value;
            node = this.parseLiteral(value.value);
            node.regex = { pattern: value.pattern, flags: value.flags };
            return node;

          case tt.num:case tt.string:
            return this.parseLiteral(this.value);

          case tt._null:case tt._true:case tt._false:
            node = this.startNode();
            node.value = this.type === tt._null ? null : this.type === tt._true;
            node.raw = this.type.keyword;
            this.next();
            return this.finishNode(node, "Literal");

          case tt.parenL:
            return this.parseParenAndDistinguishExpression(canBeArrow);

          case tt.bracketL:
            node = this.startNode();
            this.next();
            node.elements = this.parseExprList(tt.bracketR, true, true, refDestructuringErrors);
            return this.finishNode(node, "ArrayExpression");

          case tt.braceL:
            return this.parseObj(false, refDestructuringErrors);

          case tt._function:
            node = this.startNode();
            this.next();
            return this.parseFunction(node, false);

          case tt._class:
            return this.parseClass(this.startNode(), false);

          case tt._new:
            return this.parseNew();

          case tt.backQuote:
            return this.parseTemplate();

          default:
            this.unexpected();
        }
      };

      pp$3.parseLiteral = function (value) {
        var node = this.startNode();
        node.value = value;
        node.raw = this.input.slice(this.start, this.end);
        this.next();
        return this.finishNode(node, "Literal");
      };

      pp$3.parseParenExpression = function () {
        this.expect(tt.parenL);
        var val = this.parseExpression();
        this.expect(tt.parenR);
        return val;
      };

      pp$3.parseParenAndDistinguishExpression = function (canBeArrow) {
        var this$1 = this;

        var startPos = this.start,
            startLoc = this.startLoc,
            val;
        if (this.options.ecmaVersion >= 6) {
          this.next();

          var innerStartPos = this.start,
              innerStartLoc = this.startLoc;
          var exprList = [],
              first = true;
          var refDestructuringErrors = new DestructuringErrors(),
              spreadStart,
              innerParenStart;
          while (this.type !== tt.parenR) {
            first ? first = false : this$1.expect(tt.comma);
            if (this$1.type === tt.ellipsis) {
              spreadStart = this$1.start;
              exprList.push(this$1.parseParenItem(this$1.parseRest()));
              break;
            } else {
              if (this$1.type === tt.parenL && !innerParenStart) {
                innerParenStart = this$1.start;
              }
              exprList.push(this$1.parseMaybeAssign(false, refDestructuringErrors, this$1.parseParenItem));
            }
          }
          var innerEndPos = this.start,
              innerEndLoc = this.startLoc;
          this.expect(tt.parenR);

          if (canBeArrow && !this.canInsertSemicolon() && this.eat(tt.arrow)) {
            this.checkPatternErrors(refDestructuringErrors, true);
            if (innerParenStart) this.unexpected(innerParenStart);
            return this.parseParenArrowList(startPos, startLoc, exprList);
          }

          if (!exprList.length) this.unexpected(this.lastTokStart);
          if (spreadStart) this.unexpected(spreadStart);
          this.checkExpressionErrors(refDestructuringErrors, true);

          if (exprList.length > 1) {
            val = this.startNodeAt(innerStartPos, innerStartLoc);
            val.expressions = exprList;
            this.finishNodeAt(val, "SequenceExpression", innerEndPos, innerEndLoc);
          } else {
            val = exprList[0];
          }
        } else {
          val = this.parseParenExpression();
        }

        if (this.options.preserveParens) {
          var par = this.startNodeAt(startPos, startLoc);
          par.expression = val;
          return this.finishNode(par, "ParenthesizedExpression");
        } else {
          return val;
        }
      };

      pp$3.parseParenItem = function (item) {
        return item;
      };

      pp$3.parseParenArrowList = function (startPos, startLoc, exprList) {
        return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), exprList);
      };

      // New's precedence is slightly tricky. It must allow its argument to
      // be a `[]` or dot subscript expression, but not a call — at least,
      // not without wrapping it in parentheses. Thus, it uses the noCalls
      // argument to parseSubscripts to prevent it from consuming the
      // argument list.

      var empty$1 = [];

      pp$3.parseNew = function () {
        var node = this.startNode();
        var meta = this.parseIdent(true);
        if (this.options.ecmaVersion >= 6 && this.eat(tt.dot)) {
          node.meta = meta;
          node.property = this.parseIdent(true);
          if (node.property.name !== "target") this.raiseRecoverable(node.property.start, "The only valid meta property for new is new.target");
          if (!this.inFunction) this.raiseRecoverable(node.start, "new.target can only be used in functions");
          return this.finishNode(node, "MetaProperty");
        }
        var startPos = this.start,
            startLoc = this.startLoc;
        node.callee = this.parseSubscripts(this.parseExprAtom(), startPos, startLoc, true);
        if (this.eat(tt.parenL)) node.arguments = this.parseExprList(tt.parenR, false);else node.arguments = empty$1;
        return this.finishNode(node, "NewExpression");
      };

      // Parse template expression.

      pp$3.parseTemplateElement = function () {
        var elem = this.startNode();
        elem.value = {
          raw: this.input.slice(this.start, this.end).replace(/\r\n?/g, '\n'),
          cooked: this.value
        };
        this.next();
        elem.tail = this.type === tt.backQuote;
        return this.finishNode(elem, "TemplateElement");
      };

      pp$3.parseTemplate = function () {
        var this$1 = this;

        var node = this.startNode();
        this.next();
        node.expressions = [];
        var curElt = this.parseTemplateElement();
        node.quasis = [curElt];
        while (!curElt.tail) {
          this$1.expect(tt.dollarBraceL);
          node.expressions.push(this$1.parseExpression());
          this$1.expect(tt.braceR);
          node.quasis.push(curElt = this$1.parseTemplateElement());
        }
        this.next();
        return this.finishNode(node, "TemplateLiteral");
      };

      // Parse an object literal or binding pattern.

      pp$3.parseObj = function (isPattern, refDestructuringErrors) {
        var this$1 = this;

        var node = this.startNode(),
            first = true,
            propHash = {};
        node.properties = [];
        this.next();
        while (!this.eat(tt.braceR)) {
          if (!first) {
            this$1.expect(tt.comma);
            if (this$1.afterTrailingComma(tt.braceR)) break;
          } else first = false;

          var prop = this$1.startNode(),
              isGenerator,
              startPos,
              startLoc;
          if (this$1.options.ecmaVersion >= 6) {
            prop.method = false;
            prop.shorthand = false;
            if (isPattern || refDestructuringErrors) {
              startPos = this$1.start;
              startLoc = this$1.startLoc;
            }
            if (!isPattern) isGenerator = this$1.eat(tt.star);
          }
          this$1.parsePropertyName(prop);
          this$1.parsePropertyValue(prop, isPattern, isGenerator, startPos, startLoc, refDestructuringErrors);
          this$1.checkPropClash(prop, propHash);
          node.properties.push(this$1.finishNode(prop, "Property"));
        }
        return this.finishNode(node, isPattern ? "ObjectPattern" : "ObjectExpression");
      };

      pp$3.parsePropertyValue = function (prop, isPattern, isGenerator, startPos, startLoc, refDestructuringErrors) {
        if (this.eat(tt.colon)) {
          prop.value = isPattern ? this.parseMaybeDefault(this.start, this.startLoc) : this.parseMaybeAssign(false, refDestructuringErrors);
          prop.kind = "init";
        } else if (this.options.ecmaVersion >= 6 && this.type === tt.parenL) {
          if (isPattern) this.unexpected();
          prop.kind = "init";
          prop.method = true;
          prop.value = this.parseMethod(isGenerator);
        } else if (this.options.ecmaVersion >= 5 && !prop.computed && prop.key.type === "Identifier" && (prop.key.name === "get" || prop.key.name === "set") && this.type != tt.comma && this.type != tt.braceR) {
          if (isGenerator || isPattern) this.unexpected();
          prop.kind = prop.key.name;
          this.parsePropertyName(prop);
          prop.value = this.parseMethod(false);
          var paramCount = prop.kind === "get" ? 0 : 1;
          if (prop.value.params.length !== paramCount) {
            var start = prop.value.start;
            if (prop.kind === "get") this.raiseRecoverable(start, "getter should have no params");else this.raiseRecoverable(start, "setter should have exactly one param");
          }
          if (prop.kind === "set" && prop.value.params[0].type === "RestElement") this.raiseRecoverable(prop.value.params[0].start, "Setter cannot use rest params");
        } else if (this.options.ecmaVersion >= 6 && !prop.computed && prop.key.type === "Identifier") {
          if (this.keywords.test(prop.key.name) || (this.strict ? this.reservedWordsStrictBind : this.reservedWords).test(prop.key.name) || this.inGenerator && prop.key.name == "yield") this.raiseRecoverable(prop.key.start, "'" + prop.key.name + "' can not be used as shorthand property");
          prop.kind = "init";
          if (isPattern) {
            prop.value = this.parseMaybeDefault(startPos, startLoc, prop.key);
          } else if (this.type === tt.eq && refDestructuringErrors) {
            if (!refDestructuringErrors.shorthandAssign) refDestructuringErrors.shorthandAssign = this.start;
            prop.value = this.parseMaybeDefault(startPos, startLoc, prop.key);
          } else {
            prop.value = prop.key;
          }
          prop.shorthand = true;
        } else this.unexpected();
      };

      pp$3.parsePropertyName = function (prop) {
        if (this.options.ecmaVersion >= 6) {
          if (this.eat(tt.bracketL)) {
            prop.computed = true;
            prop.key = this.parseMaybeAssign();
            this.expect(tt.bracketR);
            return prop.key;
          } else {
            prop.computed = false;
          }
        }
        return prop.key = this.type === tt.num || this.type === tt.string ? this.parseExprAtom() : this.parseIdent(true);
      };

      // Initialize empty function node.

      pp$3.initFunction = function (node) {
        node.id = null;
        if (this.options.ecmaVersion >= 6) {
          node.generator = false;
          node.expression = false;
        }
      };

      // Parse object or class method.

      pp$3.parseMethod = function (isGenerator) {
        var node = this.startNode(),
            oldInGen = this.inGenerator;
        this.inGenerator = isGenerator;
        this.initFunction(node);
        this.expect(tt.parenL);
        node.params = this.parseBindingList(tt.parenR, false, false);
        if (this.options.ecmaVersion >= 6) node.generator = isGenerator;
        this.parseFunctionBody(node, false);
        this.inGenerator = oldInGen;
        return this.finishNode(node, "FunctionExpression");
      };

      // Parse arrow function expression with given parameters.

      pp$3.parseArrowExpression = function (node, params) {
        var oldInGen = this.inGenerator;
        this.inGenerator = false;
        this.initFunction(node);
        node.params = this.toAssignableList(params, true);
        this.parseFunctionBody(node, true);
        this.inGenerator = oldInGen;
        return this.finishNode(node, "ArrowFunctionExpression");
      };

      // Parse function body and check parameters.

      pp$3.parseFunctionBody = function (node, isArrowFunction) {
        var isExpression = isArrowFunction && this.type !== tt.braceL;

        if (isExpression) {
          node.body = this.parseMaybeAssign();
          node.expression = true;
        } else {
          // Start a new scope with regard to labels and the `inFunction`
          // flag (restore them to their old value afterwards).
          var oldInFunc = this.inFunction,
              oldLabels = this.labels;
          this.inFunction = true;this.labels = [];
          node.body = this.parseBlock(true);
          node.expression = false;
          this.inFunction = oldInFunc;this.labels = oldLabels;
        }

        // If this is a strict mode function, verify that argument names
        // are not repeated, and it does not try to bind the words `eval`
        // or `arguments`.
        var useStrict = !isExpression && node.body.body.length && this.isUseStrict(node.body.body[0]) ? node.body.body[0] : null;
        if (this.strict || useStrict) {
          var oldStrict = this.strict;
          this.strict = true;
          if (node.id) this.checkLVal(node.id, true);
          this.checkParams(node, useStrict);
          this.strict = oldStrict;
        } else if (isArrowFunction) {
          this.checkParams(node, useStrict);
        }
      };

      // Checks function params for various disallowed patterns such as using "eval"
      // or "arguments" and duplicate parameters.

      pp$3.checkParams = function (node, useStrict) {
        var this$1 = this;

        var nameHash = {};
        for (var i = 0; i < node.params.length; i++) {
          if (useStrict && this$1.options.ecmaVersion >= 7 && node.params[i].type !== "Identifier") this$1.raiseRecoverable(useStrict.start, "Illegal 'use strict' directive in function with non-simple parameter list");
          this$1.checkLVal(node.params[i], true, nameHash);
        }
      };

      // Parses a comma-separated list of expressions, and returns them as
      // an array. `close` is the token type that ends the list, and
      // `allowEmpty` can be turned on to allow subsequent commas with
      // nothing in between them to be parsed as `null` (which is needed
      // for array literals).

      pp$3.parseExprList = function (close, allowTrailingComma, allowEmpty, refDestructuringErrors) {
        var this$1 = this;

        var elts = [],
            first = true;
        while (!this.eat(close)) {
          if (!first) {
            this$1.expect(tt.comma);
            if (allowTrailingComma && this$1.afterTrailingComma(close)) break;
          } else first = false;

          var elt;
          if (allowEmpty && this$1.type === tt.comma) elt = null;else if (this$1.type === tt.ellipsis) {
            elt = this$1.parseSpread(refDestructuringErrors);
            if (this$1.type === tt.comma && refDestructuringErrors && !refDestructuringErrors.trailingComma) {
              refDestructuringErrors.trailingComma = this$1.lastTokStart;
            }
          } else elt = this$1.parseMaybeAssign(false, refDestructuringErrors);
          elts.push(elt);
        }
        return elts;
      };

      // Parse the next token as an identifier. If `liberal` is true (used
      // when parsing properties), it will also convert keywords into
      // identifiers.

      pp$3.parseIdent = function (liberal) {
        var node = this.startNode();
        if (liberal && this.options.allowReserved == "never") liberal = false;
        if (this.type === tt.name) {
          if (!liberal && (this.strict ? this.reservedWordsStrict : this.reservedWords).test(this.value) && (this.options.ecmaVersion >= 6 || this.input.slice(this.start, this.end).indexOf("\\") == -1)) this.raiseRecoverable(this.start, "The keyword '" + this.value + "' is reserved");
          if (!liberal && this.inGenerator && this.value === "yield") this.raiseRecoverable(this.start, "Can not use 'yield' as identifier inside a generator");
          node.name = this.value;
        } else if (liberal && this.type.keyword) {
          node.name = this.type.keyword;
        } else {
          this.unexpected();
        }
        this.next();
        return this.finishNode(node, "Identifier");
      };

      // Parses yield expression inside generator.

      pp$3.parseYield = function () {
        var node = this.startNode();
        this.next();
        if (this.type == tt.semi || this.canInsertSemicolon() || this.type != tt.star && !this.type.startsExpr) {
          node.delegate = false;
          node.argument = null;
        } else {
          node.delegate = this.eat(tt.star);
          node.argument = this.parseMaybeAssign();
        }
        return this.finishNode(node, "YieldExpression");
      };

      var pp$4 = Parser.prototype;

      // This function is used to raise exceptions on parse errors. It
      // takes an offset integer (into the current `input`) to indicate
      // the location of the error, attaches the position to the end
      // of the error message, and then raises a `SyntaxError` with that
      // message.

      pp$4.raise = function (pos, message) {
        var loc = getLineInfo(this.input, pos);
        message += " (" + loc.line + ":" + loc.column + ")";
        var err = new SyntaxError(message);
        err.pos = pos;err.loc = loc;err.raisedAt = this.pos;
        throw err;
      };

      pp$4.raiseRecoverable = pp$4.raise;

      pp$4.curPosition = function () {
        if (this.options.locations) {
          return new Position(this.curLine, this.pos - this.lineStart);
        }
      };

      var Node = function Node(parser, pos, loc) {
        this.type = "";
        this.start = pos;
        this.end = 0;
        if (parser.options.locations) this.loc = new SourceLocation(parser, loc);
        if (parser.options.directSourceFile) this.sourceFile = parser.options.directSourceFile;
        if (parser.options.ranges) this.range = [pos, 0];
      };

      // Start an AST node, attaching a start offset.

      var pp$5 = Parser.prototype;

      pp$5.startNode = function () {
        return new Node(this, this.start, this.startLoc);
      };

      pp$5.startNodeAt = function (pos, loc) {
        return new Node(this, pos, loc);
      };

      // Finish an AST node, adding `type` and `end` properties.

      function finishNodeAt(node, type, pos, loc) {
        node.type = type;
        node.end = pos;
        if (this.options.locations) node.loc.end = loc;
        if (this.options.ranges) node.range[1] = pos;
        return node;
      }

      pp$5.finishNode = function (node, type) {
        return finishNodeAt.call(this, node, type, this.lastTokEnd, this.lastTokEndLoc);
      };

      // Finish node at given position

      pp$5.finishNodeAt = function (node, type, pos, loc) {
        return finishNodeAt.call(this, node, type, pos, loc);
      };

      var TokContext = function TokContext(token, isExpr, preserveSpace, override) {
        this.token = token;
        this.isExpr = !!isExpr;
        this.preserveSpace = !!preserveSpace;
        this.override = override;
      };

      var types = {
        b_stat: new TokContext("{", false),
        b_expr: new TokContext("{", true),
        b_tmpl: new TokContext("${", true),
        p_stat: new TokContext("(", false),
        p_expr: new TokContext("(", true),
        q_tmpl: new TokContext("`", true, true, function (p) {
          return p.readTmplToken();
        }),
        f_expr: new TokContext("function", true)
      };

      var pp$6 = Parser.prototype;

      pp$6.initialContext = function () {
        return [types.b_stat];
      };

      pp$6.braceIsBlock = function (prevType) {
        if (prevType === tt.colon) {
          var parent = this.curContext();
          if (parent === types.b_stat || parent === types.b_expr) return !parent.isExpr;
        }
        if (prevType === tt._return) return lineBreak.test(this.input.slice(this.lastTokEnd, this.start));
        if (prevType === tt._else || prevType === tt.semi || prevType === tt.eof || prevType === tt.parenR) return true;
        if (prevType == tt.braceL) return this.curContext() === types.b_stat;
        return !this.exprAllowed;
      };

      pp$6.updateContext = function (prevType) {
        var update,
            type = this.type;
        if (type.keyword && prevType == tt.dot) this.exprAllowed = false;else if (update = type.updateContext) update.call(this, prevType);else this.exprAllowed = type.beforeExpr;
      };

      // Token-specific context update code

      tt.parenR.updateContext = tt.braceR.updateContext = function () {
        if (this.context.length == 1) {
          this.exprAllowed = true;
          return;
        }
        var out = this.context.pop();
        if (out === types.b_stat && this.curContext() === types.f_expr) {
          this.context.pop();
          this.exprAllowed = false;
        } else if (out === types.b_tmpl) {
          this.exprAllowed = true;
        } else {
          this.exprAllowed = !out.isExpr;
        }
      };

      tt.braceL.updateContext = function (prevType) {
        this.context.push(this.braceIsBlock(prevType) ? types.b_stat : types.b_expr);
        this.exprAllowed = true;
      };

      tt.dollarBraceL.updateContext = function () {
        this.context.push(types.b_tmpl);
        this.exprAllowed = true;
      };

      tt.parenL.updateContext = function (prevType) {
        var statementParens = prevType === tt._if || prevType === tt._for || prevType === tt._with || prevType === tt._while;
        this.context.push(statementParens ? types.p_stat : types.p_expr);
        this.exprAllowed = true;
      };

      tt.incDec.updateContext = function () {
        // tokExprAllowed stays unchanged
      };

      tt._function.updateContext = function (prevType) {
        if (prevType.beforeExpr && prevType !== tt.semi && prevType !== tt._else && !((prevType === tt.colon || prevType === tt.braceL) && this.curContext() === types.b_stat)) this.context.push(types.f_expr);
        this.exprAllowed = false;
      };

      tt.backQuote.updateContext = function () {
        if (this.curContext() === types.q_tmpl) this.context.pop();else this.context.push(types.q_tmpl);
        this.exprAllowed = false;
      };

      // Object type used to represent tokens. Note that normally, tokens
      // simply exist as properties on the parser object. This is only
      // used for the onToken callback and the external tokenizer.

      var Token = function Token(p) {
        this.type = p.type;
        this.value = p.value;
        this.start = p.start;
        this.end = p.end;
        if (p.options.locations) this.loc = new SourceLocation(p, p.startLoc, p.endLoc);
        if (p.options.ranges) this.range = [p.start, p.end];
      };

      // ## Tokenizer

      var pp$7 = Parser.prototype;

      // Are we running under Rhino?
      var isRhino = (typeof Packages === 'undefined' ? 'undefined' : _typeof(Packages)) == "object" && Object.prototype.toString.call(Packages) == "[object JavaPackage]";

      // Move to the next token

      pp$7.next = function () {
        if (this.options.onToken) this.options.onToken(new Token(this));

        this.lastTokEnd = this.end;
        this.lastTokStart = this.start;
        this.lastTokEndLoc = this.endLoc;
        this.lastTokStartLoc = this.startLoc;
        this.nextToken();
      };

      pp$7.getToken = function () {
        this.next();
        return new Token(this);
      };

      // If we're in an ES6 environment, make parsers iterable
      if (typeof Symbol !== "undefined") pp$7[Symbol.iterator] = function () {
        var self = this;
        return { next: function next() {
            var token = self.getToken();
            return {
              done: token.type === tt.eof,
              value: token
            };
          } };
      };

      // Toggle strict mode. Re-reads the next number or string to please
      // pedantic tests (`"use strict"; 010;` should fail).

      pp$7.setStrict = function (strict) {
        var this$1 = this;

        this.strict = strict;
        if (this.type !== tt.num && this.type !== tt.string) return;
        this.pos = this.start;
        if (this.options.locations) {
          while (this.pos < this.lineStart) {
            this$1.lineStart = this$1.input.lastIndexOf("\n", this$1.lineStart - 2) + 1;
            --this$1.curLine;
          }
        }
        this.nextToken();
      };

      pp$7.curContext = function () {
        return this.context[this.context.length - 1];
      };

      // Read a single token, updating the parser object's token-related
      // properties.

      pp$7.nextToken = function () {
        var curContext = this.curContext();
        if (!curContext || !curContext.preserveSpace) this.skipSpace();

        this.start = this.pos;
        if (this.options.locations) this.startLoc = this.curPosition();
        if (this.pos >= this.input.length) return this.finishToken(tt.eof);

        if (curContext.override) return curContext.override(this);else this.readToken(this.fullCharCodeAtPos());
      };

      pp$7.readToken = function (code) {
        // Identifier or keyword. '\uXXXX' sequences are allowed in
        // identifiers, so '\' also dispatches to that.
        if (isIdentifierStart(code, this.options.ecmaVersion >= 6) || code === 92 /* '\' */) return this.readWord();

        return this.getTokenFromCode(code);
      };

      pp$7.fullCharCodeAtPos = function () {
        var code = this.input.charCodeAt(this.pos);
        if (code <= 0xd7ff || code >= 0xe000) return code;
        var next = this.input.charCodeAt(this.pos + 1);
        return (code << 10) + next - 0x35fdc00;
      };

      pp$7.skipBlockComment = function () {
        var this$1 = this;

        var startLoc = this.options.onComment && this.curPosition();
        var start = this.pos,
            end = this.input.indexOf("*/", this.pos += 2);
        if (end === -1) this.raise(this.pos - 2, "Unterminated comment");
        this.pos = end + 2;
        if (this.options.locations) {
          lineBreakG.lastIndex = start;
          var match;
          while ((match = lineBreakG.exec(this.input)) && match.index < this.pos) {
            ++this$1.curLine;
            this$1.lineStart = match.index + match[0].length;
          }
        }
        if (this.options.onComment) this.options.onComment(true, this.input.slice(start + 2, end), start, this.pos, startLoc, this.curPosition());
      };

      pp$7.skipLineComment = function (startSkip) {
        var this$1 = this;

        var start = this.pos;
        var startLoc = this.options.onComment && this.curPosition();
        var ch = this.input.charCodeAt(this.pos += startSkip);
        while (this.pos < this.input.length && ch !== 10 && ch !== 13 && ch !== 8232 && ch !== 8233) {
          ++this$1.pos;
          ch = this$1.input.charCodeAt(this$1.pos);
        }
        if (this.options.onComment) this.options.onComment(false, this.input.slice(start + startSkip, this.pos), start, this.pos, startLoc, this.curPosition());
      };

      // Called at the start of the parse and after every token. Skips
      // whitespace and comments, and.

      pp$7.skipSpace = function () {
        var this$1 = this;

        loop: while (this.pos < this.input.length) {
          var ch = this$1.input.charCodeAt(this$1.pos);
          switch (ch) {
            case 32:case 160:
              // ' '
              ++this$1.pos;
              break;
            case 13:
              if (this$1.input.charCodeAt(this$1.pos + 1) === 10) {
                ++this$1.pos;
              }
            case 10:case 8232:case 8233:
              ++this$1.pos;
              if (this$1.options.locations) {
                ++this$1.curLine;
                this$1.lineStart = this$1.pos;
              }
              break;
            case 47:
              // '/'
              switch (this$1.input.charCodeAt(this$1.pos + 1)) {
                case 42:
                  // '*'
                  this$1.skipBlockComment();
                  break;
                case 47:
                  this$1.skipLineComment(2);
                  break;
                default:
                  break loop;
              }
              break;
            default:
              if (ch > 8 && ch < 14 || ch >= 5760 && nonASCIIwhitespace.test(String.fromCharCode(ch))) {
                ++this$1.pos;
              } else {
                break loop;
              }
          }
        }
      };

      // Called at the end of every token. Sets `end`, `val`, and
      // maintains `context` and `exprAllowed`, and skips the space after
      // the token, so that the next one's `start` will point at the
      // right position.

      pp$7.finishToken = function (type, val) {
        this.end = this.pos;
        if (this.options.locations) this.endLoc = this.curPosition();
        var prevType = this.type;
        this.type = type;
        this.value = val;

        this.updateContext(prevType);
      };

      // ### Token reading

      // This is the function that is called to fetch the next token. It
      // is somewhat obscure, because it works in character codes rather
      // than characters, and because operator parsing has been inlined
      // into it.
      //
      // All in the name of speed.
      //
      pp$7.readToken_dot = function () {
        var next = this.input.charCodeAt(this.pos + 1);
        if (next >= 48 && next <= 57) return this.readNumber(true);
        var next2 = this.input.charCodeAt(this.pos + 2);
        if (this.options.ecmaVersion >= 6 && next === 46 && next2 === 46) {
          // 46 = dot '.'
          this.pos += 3;
          return this.finishToken(tt.ellipsis);
        } else {
          ++this.pos;
          return this.finishToken(tt.dot);
        }
      };

      pp$7.readToken_slash = function () {
        // '/'
        var next = this.input.charCodeAt(this.pos + 1);
        if (this.exprAllowed) {
          ++this.pos;return this.readRegexp();
        }
        if (next === 61) return this.finishOp(tt.assign, 2);
        return this.finishOp(tt.slash, 1);
      };

      pp$7.readToken_mult_modulo_exp = function (code) {
        // '%*'
        var next = this.input.charCodeAt(this.pos + 1);
        var size = 1;
        var tokentype = code === 42 ? tt.star : tt.modulo;

        // exponentiation operator ** and **=
        if (this.options.ecmaVersion >= 7 && next === 42) {
          ++size;
          tokentype = tt.starstar;
          next = this.input.charCodeAt(this.pos + 2);
        }

        if (next === 61) return this.finishOp(tt.assign, size + 1);
        return this.finishOp(tokentype, size);
      };

      pp$7.readToken_pipe_amp = function (code) {
        // '|&'
        var next = this.input.charCodeAt(this.pos + 1);
        if (next === code) return this.finishOp(code === 124 ? tt.logicalOR : tt.logicalAND, 2);
        if (next === 61) return this.finishOp(tt.assign, 2);
        return this.finishOp(code === 124 ? tt.bitwiseOR : tt.bitwiseAND, 1);
      };

      pp$7.readToken_caret = function () {
        // '^'
        var next = this.input.charCodeAt(this.pos + 1);
        if (next === 61) return this.finishOp(tt.assign, 2);
        return this.finishOp(tt.bitwiseXOR, 1);
      };

      pp$7.readToken_plus_min = function (code) {
        // '+-'
        var next = this.input.charCodeAt(this.pos + 1);
        if (next === code) {
          if (next == 45 && this.input.charCodeAt(this.pos + 2) == 62 && lineBreak.test(this.input.slice(this.lastTokEnd, this.pos))) {
            // A `-->` line comment
            this.skipLineComment(3);
            this.skipSpace();
            return this.nextToken();
          }
          return this.finishOp(tt.incDec, 2);
        }
        if (next === 61) return this.finishOp(tt.assign, 2);
        return this.finishOp(tt.plusMin, 1);
      };

      pp$7.readToken_lt_gt = function (code) {
        // '<>'
        var next = this.input.charCodeAt(this.pos + 1);
        var size = 1;
        if (next === code) {
          size = code === 62 && this.input.charCodeAt(this.pos + 2) === 62 ? 3 : 2;
          if (this.input.charCodeAt(this.pos + size) === 61) return this.finishOp(tt.assign, size + 1);
          return this.finishOp(tt.bitShift, size);
        }
        if (next == 33 && code == 60 && this.input.charCodeAt(this.pos + 2) == 45 && this.input.charCodeAt(this.pos + 3) == 45) {
          if (this.inModule) this.unexpected();
          // `<!--`, an XML-style comment that should be interpreted as a line comment
          this.skipLineComment(4);
          this.skipSpace();
          return this.nextToken();
        }
        if (next === 61) size = 2;
        return this.finishOp(tt.relational, size);
      };

      pp$7.readToken_eq_excl = function (code) {
        // '=!'
        var next = this.input.charCodeAt(this.pos + 1);
        if (next === 61) return this.finishOp(tt.equality, this.input.charCodeAt(this.pos + 2) === 61 ? 3 : 2);
        if (code === 61 && next === 62 && this.options.ecmaVersion >= 6) {
          // '=>'
          this.pos += 2;
          return this.finishToken(tt.arrow);
        }
        return this.finishOp(code === 61 ? tt.eq : tt.prefix, 1);
      };

      pp$7.getTokenFromCode = function (code) {
        switch (code) {
          // The interpretation of a dot depends on whether it is followed
          // by a digit or another two dots.
          case 46:
            // '.'
            return this.readToken_dot();

          // Punctuation tokens.
          case 40:
            ++this.pos;return this.finishToken(tt.parenL);
          case 41:
            ++this.pos;return this.finishToken(tt.parenR);
          case 59:
            ++this.pos;return this.finishToken(tt.semi);
          case 44:
            ++this.pos;return this.finishToken(tt.comma);
          case 91:
            ++this.pos;return this.finishToken(tt.bracketL);
          case 93:
            ++this.pos;return this.finishToken(tt.bracketR);
          case 123:
            ++this.pos;return this.finishToken(tt.braceL);
          case 125:
            ++this.pos;return this.finishToken(tt.braceR);
          case 58:
            ++this.pos;return this.finishToken(tt.colon);
          case 63:
            ++this.pos;return this.finishToken(tt.question);

          case 96:
            // '`'
            if (this.options.ecmaVersion < 6) break;
            ++this.pos;
            return this.finishToken(tt.backQuote);

          case 48:
            // '0'
            var next = this.input.charCodeAt(this.pos + 1);
            if (next === 120 || next === 88) return this.readRadixNumber(16); // '0x', '0X' - hex number
            if (this.options.ecmaVersion >= 6) {
              if (next === 111 || next === 79) return this.readRadixNumber(8); // '0o', '0O' - octal number
              if (next === 98 || next === 66) return this.readRadixNumber(2); // '0b', '0B' - binary number
            }
          // Anything else beginning with a digit is an integer, octal
          // number, or float.
          case 49:case 50:case 51:case 52:case 53:case 54:case 55:case 56:case 57:
            // 1-9
            return this.readNumber(false);

          // Quotes produce strings.
          case 34:case 39:
            // '"', "'"
            return this.readString(code);

          // Operators are parsed inline in tiny state machines. '=' (61) is
          // often referred to. `finishOp` simply skips the amount of
          // characters it is given as second argument, and returns a token
          // of the type given by its first argument.

          case 47:
            // '/'
            return this.readToken_slash();

          case 37:case 42:
            // '%*'
            return this.readToken_mult_modulo_exp(code);

          case 124:case 38:
            // '|&'
            return this.readToken_pipe_amp(code);

          case 94:
            // '^'
            return this.readToken_caret();

          case 43:case 45:
            // '+-'
            return this.readToken_plus_min(code);

          case 60:case 62:
            // '<>'
            return this.readToken_lt_gt(code);

          case 61:case 33:
            // '=!'
            return this.readToken_eq_excl(code);

          case 126:
            // '~'
            return this.finishOp(tt.prefix, 1);
        }

        this.raise(this.pos, "Unexpected character '" + codePointToString(code) + "'");
      };

      pp$7.finishOp = function (type, size) {
        var str = this.input.slice(this.pos, this.pos + size);
        this.pos += size;
        return this.finishToken(type, str);
      };

      // Parse a regular expression. Some context-awareness is necessary,
      // since a '/' inside a '[]' set does not end the expression.

      function tryCreateRegexp(src, flags, throwErrorAt, parser) {
        try {
          return new RegExp(src, flags);
        } catch (e) {
          if (throwErrorAt !== undefined) {
            if (e instanceof SyntaxError) parser.raise(throwErrorAt, "Error parsing regular expression: " + e.message);
            throw e;
          }
        }
      }

      var regexpUnicodeSupport = !!tryCreateRegexp('\uFFFF', "u");

      pp$7.readRegexp = function () {
        var this$1 = this;

        var escaped,
            inClass,
            start = this.pos;
        for (;;) {
          if (this$1.pos >= this$1.input.length) this$1.raise(start, "Unterminated regular expression");
          var ch = this$1.input.charAt(this$1.pos);
          if (lineBreak.test(ch)) this$1.raise(start, "Unterminated regular expression");
          if (!escaped) {
            if (ch === "[") inClass = true;else if (ch === "]" && inClass) inClass = false;else if (ch === "/" && !inClass) break;
            escaped = ch === "\\";
          } else escaped = false;
          ++this$1.pos;
        }
        var content = this.input.slice(start, this.pos);
        ++this.pos;
        // Need to use `readWord1` because '\uXXXX' sequences are allowed
        // here (don't ask).
        var mods = this.readWord1();
        var tmp = content,
            tmpFlags = "";
        if (mods) {
          var validFlags = /^[gim]*$/;
          if (this.options.ecmaVersion >= 6) validFlags = /^[gimuy]*$/;
          if (!validFlags.test(mods)) this.raise(start, "Invalid regular expression flag");
          if (mods.indexOf("u") >= 0) {
            if (regexpUnicodeSupport) {
              tmpFlags = "u";
            } else {
              // Replace each astral symbol and every Unicode escape sequence that
              // possibly represents an astral symbol or a paired surrogate with a
              // single ASCII symbol to avoid throwing on regular expressions that
              // are only valid in combination with the `/u` flag.
              // Note: replacing with the ASCII symbol `x` might cause false
              // negatives in unlikely scenarios. For example, `[\u{61}-b]` is a
              // perfectly valid pattern that is equivalent to `[a-b]`, but it would
              // be replaced by `[x-b]` which throws an error.
              tmp = tmp.replace(/\\u\{([0-9a-fA-F]+)\}/g, function (_match, code, offset) {
                code = Number("0x" + code);
                if (code > 0x10FFFF) this$1.raise(start + offset + 3, "Code point out of bounds");
                return "x";
              });
              tmp = tmp.replace(/\\u([a-fA-F0-9]{4})|[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "x");
              tmpFlags = tmpFlags.replace("u", "");
            }
          }
        }
        // Detect invalid regular expressions.
        var value = null;
        // Rhino's regular expression parser is flaky and throws uncatchable exceptions,
        // so don't do detection if we are running under Rhino
        if (!isRhino) {
          tryCreateRegexp(tmp, tmpFlags, start, this);
          // Get a regular expression object for this pattern-flag pair, or `null` in
          // case the current environment doesn't support the flags it uses.
          value = tryCreateRegexp(content, mods);
        }
        return this.finishToken(tt.regexp, { pattern: content, flags: mods, value: value });
      };

      // Read an integer in the given radix. Return null if zero digits
      // were read, the integer value otherwise. When `len` is given, this
      // will return `null` unless the integer has exactly `len` digits.

      pp$7.readInt = function (radix, len) {
        var this$1 = this;

        var start = this.pos,
            total = 0;
        for (var i = 0, e = len == null ? Infinity : len; i < e; ++i) {
          var code = this$1.input.charCodeAt(this$1.pos),
              val;
          if (code >= 97) val = code - 97 + 10; // a
          else if (code >= 65) val = code - 65 + 10; // A
            else if (code >= 48 && code <= 57) val = code - 48; // 0-9
              else val = Infinity;
          if (val >= radix) break;
          ++this$1.pos;
          total = total * radix + val;
        }
        if (this.pos === start || len != null && this.pos - start !== len) return null;

        return total;
      };

      pp$7.readRadixNumber = function (radix) {
        this.pos += 2; // 0x
        var val = this.readInt(radix);
        if (val == null) this.raise(this.start + 2, "Expected number in radix " + radix);
        if (isIdentifierStart(this.fullCharCodeAtPos())) this.raise(this.pos, "Identifier directly after number");
        return this.finishToken(tt.num, val);
      };

      // Read an integer, octal integer, or floating-point number.

      pp$7.readNumber = function (startsWithDot) {
        var start = this.pos,
            isFloat = false,
            octal = this.input.charCodeAt(this.pos) === 48;
        if (!startsWithDot && this.readInt(10) === null) this.raise(start, "Invalid number");
        var next = this.input.charCodeAt(this.pos);
        if (next === 46) {
          // '.'
          ++this.pos;
          this.readInt(10);
          isFloat = true;
          next = this.input.charCodeAt(this.pos);
        }
        if (next === 69 || next === 101) {
          // 'eE'
          next = this.input.charCodeAt(++this.pos);
          if (next === 43 || next === 45) ++this.pos; // '+-'
          if (this.readInt(10) === null) this.raise(start, "Invalid number");
          isFloat = true;
        }
        if (isIdentifierStart(this.fullCharCodeAtPos())) this.raise(this.pos, "Identifier directly after number");

        var str = this.input.slice(start, this.pos),
            val;
        if (isFloat) val = parseFloat(str);else if (!octal || str.length === 1) val = parseInt(str, 10);else if (/[89]/.test(str) || this.strict) this.raise(start, "Invalid number");else val = parseInt(str, 8);
        return this.finishToken(tt.num, val);
      };

      // Read a string value, interpreting backslash-escapes.

      pp$7.readCodePoint = function () {
        var ch = this.input.charCodeAt(this.pos),
            code;

        if (ch === 123) {
          if (this.options.ecmaVersion < 6) this.unexpected();
          var codePos = ++this.pos;
          code = this.readHexChar(this.input.indexOf('}', this.pos) - this.pos);
          ++this.pos;
          if (code > 0x10FFFF) this.raise(codePos, "Code point out of bounds");
        } else {
          code = this.readHexChar(4);
        }
        return code;
      };

      function codePointToString(code) {
        // UTF-16 Decoding
        if (code <= 0xFFFF) return String.fromCharCode(code);
        code -= 0x10000;
        return String.fromCharCode((code >> 10) + 0xD800, (code & 1023) + 0xDC00);
      }

      pp$7.readString = function (quote) {
        var this$1 = this;

        var out = "",
            chunkStart = ++this.pos;
        for (;;) {
          if (this$1.pos >= this$1.input.length) this$1.raise(this$1.start, "Unterminated string constant");
          var ch = this$1.input.charCodeAt(this$1.pos);
          if (ch === quote) break;
          if (ch === 92) {
            // '\'
            out += this$1.input.slice(chunkStart, this$1.pos);
            out += this$1.readEscapedChar(false);
            chunkStart = this$1.pos;
          } else {
            if (isNewLine(ch)) this$1.raise(this$1.start, "Unterminated string constant");
            ++this$1.pos;
          }
        }
        out += this.input.slice(chunkStart, this.pos++);
        return this.finishToken(tt.string, out);
      };

      // Reads template string tokens.

      pp$7.readTmplToken = function () {
        var this$1 = this;

        var out = "",
            chunkStart = this.pos;
        for (;;) {
          if (this$1.pos >= this$1.input.length) this$1.raise(this$1.start, "Unterminated template");
          var ch = this$1.input.charCodeAt(this$1.pos);
          if (ch === 96 || ch === 36 && this$1.input.charCodeAt(this$1.pos + 1) === 123) {
            // '`', '${'
            if (this$1.pos === this$1.start && this$1.type === tt.template) {
              if (ch === 36) {
                this$1.pos += 2;
                return this$1.finishToken(tt.dollarBraceL);
              } else {
                ++this$1.pos;
                return this$1.finishToken(tt.backQuote);
              }
            }
            out += this$1.input.slice(chunkStart, this$1.pos);
            return this$1.finishToken(tt.template, out);
          }
          if (ch === 92) {
            // '\'
            out += this$1.input.slice(chunkStart, this$1.pos);
            out += this$1.readEscapedChar(true);
            chunkStart = this$1.pos;
          } else if (isNewLine(ch)) {
            out += this$1.input.slice(chunkStart, this$1.pos);
            ++this$1.pos;
            switch (ch) {
              case 13:
                if (this$1.input.charCodeAt(this$1.pos) === 10) ++this$1.pos;
              case 10:
                out += "\n";
                break;
              default:
                out += String.fromCharCode(ch);
                break;
            }
            if (this$1.options.locations) {
              ++this$1.curLine;
              this$1.lineStart = this$1.pos;
            }
            chunkStart = this$1.pos;
          } else {
            ++this$1.pos;
          }
        }
      };

      // Used to read escaped characters

      pp$7.readEscapedChar = function (inTemplate) {
        var ch = this.input.charCodeAt(++this.pos);
        ++this.pos;
        switch (ch) {
          case 110:
            return "\n"; // 'n' -> '\n'
          case 114:
            return "\r"; // 'r' -> '\r'
          case 120:
            return String.fromCharCode(this.readHexChar(2)); // 'x'
          case 117:
            return codePointToString(this.readCodePoint()); // 'u'
          case 116:
            return "\t"; // 't' -> '\t'
          case 98:
            return "\b"; // 'b' -> '\b'
          case 118:
            return '\x0B'; // 'v' -> '\u000b'
          case 102:
            return "\f"; // 'f' -> '\f'
          case 13:
            if (this.input.charCodeAt(this.pos) === 10) ++this.pos; // '\r\n'
          case 10:
            // ' \n'
            if (this.options.locations) {
              this.lineStart = this.pos;++this.curLine;
            }
            return "";
          default:
            if (ch >= 48 && ch <= 55) {
              var octalStr = this.input.substr(this.pos - 1, 3).match(/^[0-7]+/)[0];
              var octal = parseInt(octalStr, 8);
              if (octal > 255) {
                octalStr = octalStr.slice(0, -1);
                octal = parseInt(octalStr, 8);
              }
              if (octalStr !== "0" && (this.strict || inTemplate)) {
                this.raise(this.pos - 2, "Octal literal in strict mode");
              }
              this.pos += octalStr.length - 1;
              return String.fromCharCode(octal);
            }
            return String.fromCharCode(ch);
        }
      };

      // Used to read character escape sequences ('\x', '\u', '\U').

      pp$7.readHexChar = function (len) {
        var codePos = this.pos;
        var n = this.readInt(16, len);
        if (n === null) this.raise(codePos, "Bad character escape sequence");
        return n;
      };

      // Read an identifier, and return it as a string. Sets `this.containsEsc`
      // to whether the word contained a '\u' escape.
      //
      // Incrementally adds only escaped chars, adding other chunks as-is
      // as a micro-optimization.

      pp$7.readWord1 = function () {
        var this$1 = this;

        this.containsEsc = false;
        var word = "",
            first = true,
            chunkStart = this.pos;
        var astral = this.options.ecmaVersion >= 6;
        while (this.pos < this.input.length) {
          var ch = this$1.fullCharCodeAtPos();
          if (isIdentifierChar(ch, astral)) {
            this$1.pos += ch <= 0xffff ? 1 : 2;
          } else if (ch === 92) {
            // "\"
            this$1.containsEsc = true;
            word += this$1.input.slice(chunkStart, this$1.pos);
            var escStart = this$1.pos;
            if (this$1.input.charCodeAt(++this$1.pos) != 117) // "u"
              this$1.raise(this$1.pos, 'Expecting Unicode escape sequence \\uXXXX');
            ++this$1.pos;
            var esc = this$1.readCodePoint();
            if (!(first ? isIdentifierStart : isIdentifierChar)(esc, astral)) this$1.raise(escStart, "Invalid Unicode escape");
            word += codePointToString(esc);
            chunkStart = this$1.pos;
          } else {
            break;
          }
          first = false;
        }
        return word + this.input.slice(chunkStart, this.pos);
      };

      // Read an identifier or keyword token. Will check for reserved
      // words when necessary.

      pp$7.readWord = function () {
        var word = this.readWord1();
        var type = tt.name;
        if ((this.options.ecmaVersion >= 6 || !this.containsEsc) && this.keywords.test(word)) type = keywordTypes[word];
        return this.finishToken(type, word);
      };

      var version = "3.3.0";

      // The main exported interface (under `self.acorn` when in the
      // browser) is a `parse` function that takes a code string and
      // returns an abstract syntax tree as specified by [Mozilla parser
      // API][api].
      //
      // [api]: https://developer.mozilla.org/en-US/docs/SpiderMonkey/Parser_API

      function parse(input, options) {
        return new Parser(options, input).parse();
      }

      // This function tries to parse a single expression at a given
      // offset in a string. Useful for parsing mixed-language formats
      // that embed JavaScript expressions.

      function parseExpressionAt(input, pos, options) {
        var p = new Parser(options, input, pos);
        p.nextToken();
        return p.parseExpression();
      }

      // Acorn is organized as a tokenizer and a recursive-descent parser.
      // The `tokenizer` export provides an interface to the tokenizer.

      function tokenizer(input, options) {
        return new Parser(options, input);
      }

      exports.version = version;
      exports.parse = parse;
      exports.parseExpressionAt = parseExpressionAt;
      exports.tokenizer = tokenizer;
      exports.Parser = Parser;
      exports.plugins = plugins;
      exports.defaultOptions = defaultOptions;
      exports.Position = Position;
      exports.SourceLocation = SourceLocation;
      exports.getLineInfo = getLineInfo;
      exports.Node = Node;
      exports.TokenType = TokenType;
      exports.tokTypes = tt;
      exports.TokContext = TokContext;
      exports.tokContexts = types;
      exports.isIdentifierChar = isIdentifierChar;
      exports.isIdentifierStart = isIdentifierStart;
      exports.Token = Token;
      exports.isNewLine = isNewLine;
      exports.lineBreak = lineBreak;
      exports.lineBreakG = lineBreakG;

      Object.defineProperty(exports, '__esModule', { value: true });
    });
  });

  var acorn$1 = acorn && (typeof acorn === 'undefined' ? 'undefined' : _typeof(acorn)) === 'object' && 'default' in acorn ? acorn['default'] : acorn;

  var xhtml = __commonjs(function (module) {
    module.exports = {
      quot: '"',
      amp: '&',
      apos: '\'',
      lt: '<',
      gt: '>',
      nbsp: '\xA0',
      iexcl: '\xA1',
      cent: '\xA2',
      pound: '\xA3',
      curren: '\xA4',
      yen: '\xA5',
      brvbar: '\xA6',
      sect: '\xA7',
      uml: '\xA8',
      copy: '\xA9',
      ordf: '\xAA',
      laquo: '\xAB',
      not: '\xAC',
      shy: '\xAD',
      reg: '\xAE',
      macr: '\xAF',
      deg: '\xB0',
      plusmn: '\xB1',
      sup2: '\xB2',
      sup3: '\xB3',
      acute: '\xB4',
      micro: '\xB5',
      para: '\xB6',
      middot: '\xB7',
      cedil: '\xB8',
      sup1: '\xB9',
      ordm: '\xBA',
      raquo: '\xBB',
      frac14: '\xBC',
      frac12: '\xBD',
      frac34: '\xBE',
      iquest: '\xBF',
      Agrave: '\xC0',
      Aacute: '\xC1',
      Acirc: '\xC2',
      Atilde: '\xC3',
      Auml: '\xC4',
      Aring: '\xC5',
      AElig: '\xC6',
      Ccedil: '\xC7',
      Egrave: '\xC8',
      Eacute: '\xC9',
      Ecirc: '\xCA',
      Euml: '\xCB',
      Igrave: '\xCC',
      Iacute: '\xCD',
      Icirc: '\xCE',
      Iuml: '\xCF',
      ETH: '\xD0',
      Ntilde: '\xD1',
      Ograve: '\xD2',
      Oacute: '\xD3',
      Ocirc: '\xD4',
      Otilde: '\xD5',
      Ouml: '\xD6',
      times: '\xD7',
      Oslash: '\xD8',
      Ugrave: '\xD9',
      Uacute: '\xDA',
      Ucirc: '\xDB',
      Uuml: '\xDC',
      Yacute: '\xDD',
      THORN: '\xDE',
      szlig: '\xDF',
      agrave: '\xE0',
      aacute: '\xE1',
      acirc: '\xE2',
      atilde: '\xE3',
      auml: '\xE4',
      aring: '\xE5',
      aelig: '\xE6',
      ccedil: '\xE7',
      egrave: '\xE8',
      eacute: '\xE9',
      ecirc: '\xEA',
      euml: '\xEB',
      igrave: '\xEC',
      iacute: '\xED',
      icirc: '\xEE',
      iuml: '\xEF',
      eth: '\xF0',
      ntilde: '\xF1',
      ograve: '\xF2',
      oacute: '\xF3',
      ocirc: '\xF4',
      otilde: '\xF5',
      ouml: '\xF6',
      divide: '\xF7',
      oslash: '\xF8',
      ugrave: '\xF9',
      uacute: '\xFA',
      ucirc: '\xFB',
      uuml: '\xFC',
      yacute: '\xFD',
      thorn: '\xFE',
      yuml: '\xFF',
      OElig: '\u0152',
      oelig: '\u0153',
      Scaron: '\u0160',
      scaron: '\u0161',
      Yuml: '\u0178',
      fnof: '\u0192',
      circ: '\u02C6',
      tilde: '\u02DC',
      Alpha: '\u0391',
      Beta: '\u0392',
      Gamma: '\u0393',
      Delta: '\u0394',
      Epsilon: '\u0395',
      Zeta: '\u0396',
      Eta: '\u0397',
      Theta: '\u0398',
      Iota: '\u0399',
      Kappa: '\u039A',
      Lambda: '\u039B',
      Mu: '\u039C',
      Nu: '\u039D',
      Xi: '\u039E',
      Omicron: '\u039F',
      Pi: '\u03A0',
      Rho: '\u03A1',
      Sigma: '\u03A3',
      Tau: '\u03A4',
      Upsilon: '\u03A5',
      Phi: '\u03A6',
      Chi: '\u03A7',
      Psi: '\u03A8',
      Omega: '\u03A9',
      alpha: '\u03B1',
      beta: '\u03B2',
      gamma: '\u03B3',
      delta: '\u03B4',
      epsilon: '\u03B5',
      zeta: '\u03B6',
      eta: '\u03B7',
      theta: '\u03B8',
      iota: '\u03B9',
      kappa: '\u03BA',
      lambda: '\u03BB',
      mu: '\u03BC',
      nu: '\u03BD',
      xi: '\u03BE',
      omicron: '\u03BF',
      pi: '\u03C0',
      rho: '\u03C1',
      sigmaf: '\u03C2',
      sigma: '\u03C3',
      tau: '\u03C4',
      upsilon: '\u03C5',
      phi: '\u03C6',
      chi: '\u03C7',
      psi: '\u03C8',
      omega: '\u03C9',
      thetasym: '\u03D1',
      upsih: '\u03D2',
      piv: '\u03D6',
      ensp: '\u2002',
      emsp: '\u2003',
      thinsp: '\u2009',
      zwnj: '\u200C',
      zwj: '\u200D',
      lrm: '\u200E',
      rlm: '\u200F',
      ndash: '\u2013',
      mdash: '\u2014',
      lsquo: '\u2018',
      rsquo: '\u2019',
      sbquo: '\u201A',
      ldquo: '\u201C',
      rdquo: '\u201D',
      bdquo: '\u201E',
      dagger: '\u2020',
      Dagger: '\u2021',
      bull: '\u2022',
      hellip: '\u2026',
      permil: '\u2030',
      prime: '\u2032',
      Prime: '\u2033',
      lsaquo: '\u2039',
      rsaquo: '\u203A',
      oline: '\u203E',
      frasl: '\u2044',
      euro: '\u20AC',
      image: '\u2111',
      weierp: '\u2118',
      real: '\u211C',
      trade: '\u2122',
      alefsym: '\u2135',
      larr: '\u2190',
      uarr: '\u2191',
      rarr: '\u2192',
      darr: '\u2193',
      harr: '\u2194',
      crarr: '\u21B5',
      lArr: '\u21D0',
      uArr: '\u21D1',
      rArr: '\u21D2',
      dArr: '\u21D3',
      hArr: '\u21D4',
      forall: '\u2200',
      part: '\u2202',
      exist: '\u2203',
      empty: '\u2205',
      nabla: '\u2207',
      isin: '\u2208',
      notin: '\u2209',
      ni: '\u220B',
      prod: '\u220F',
      sum: '\u2211',
      minus: '\u2212',
      lowast: '\u2217',
      radic: '\u221A',
      prop: '\u221D',
      infin: '\u221E',
      ang: '\u2220',
      and: '\u2227',
      or: '\u2228',
      cap: '\u2229',
      cup: '\u222A',
      'int': '\u222B',
      there4: '\u2234',
      sim: '\u223C',
      cong: '\u2245',
      asymp: '\u2248',
      ne: '\u2260',
      equiv: '\u2261',
      le: '\u2264',
      ge: '\u2265',
      sub: '\u2282',
      sup: '\u2283',
      nsub: '\u2284',
      sube: '\u2286',
      supe: '\u2287',
      oplus: '\u2295',
      otimes: '\u2297',
      perp: '\u22A5',
      sdot: '\u22C5',
      lceil: '\u2308',
      rceil: '\u2309',
      lfloor: '\u230A',
      rfloor: '\u230B',
      lang: '\u2329',
      rang: '\u232A',
      loz: '\u25CA',
      spades: '\u2660',
      clubs: '\u2663',
      hearts: '\u2665',
      diams: '\u2666'
    };
  });

  var require$$0 = xhtml && (typeof xhtml === 'undefined' ? 'undefined' : _typeof(xhtml)) === 'object' && 'default' in xhtml ? xhtml['default'] : xhtml;

  var inject = __commonjs(function (module) {
    'use strict';

    var XHTMLEntities = require$$0;

    var hexNumber = /^[\da-fA-F]+$/;
    var decimalNumber = /^\d+$/;

    module.exports = function (acorn) {
      var tt = acorn.tokTypes;
      var tc = acorn.tokContexts;

      tc.j_oTag = new acorn.TokContext('<tag', false);
      tc.j_cTag = new acorn.TokContext('</tag', false);
      tc.j_expr = new acorn.TokContext('<tag>...</tag>', true, true);

      tt.jsxName = new acorn.TokenType('jsxName');
      tt.jsxText = new acorn.TokenType('jsxText', { beforeExpr: true });
      tt.jsxTagStart = new acorn.TokenType('jsxTagStart');
      tt.jsxTagEnd = new acorn.TokenType('jsxTagEnd');

      tt.jsxTagStart.updateContext = function () {
        this.context.push(tc.j_expr); // treat as beginning of JSX expression
        this.context.push(tc.j_oTag); // start opening tag context
        this.exprAllowed = false;
      };
      tt.jsxTagEnd.updateContext = function (prevType) {
        var out = this.context.pop();
        if (out === tc.j_oTag && prevType === tt.slash || out === tc.j_cTag) {
          this.context.pop();
          this.exprAllowed = this.curContext() === tc.j_expr;
        } else {
          this.exprAllowed = true;
        }
      };

      var pp = acorn.Parser.prototype;

      // Reads inline JSX contents token.

      pp.jsx_readToken = function () {
        var out = '',
            chunkStart = this.pos;
        for (;;) {
          if (this.pos >= this.input.length) this.raise(this.start, 'Unterminated JSX contents');
          var ch = this.input.charCodeAt(this.pos);

          switch (ch) {
            case 60: // '<'
            case 123:
              // '{'
              if (this.pos === this.start) {
                if (ch === 60 && this.exprAllowed) {
                  ++this.pos;
                  return this.finishToken(tt.jsxTagStart);
                }
                return this.getTokenFromCode(ch);
              }
              out += this.input.slice(chunkStart, this.pos);
              return this.finishToken(tt.jsxText, out);

            case 38:
              // '&'
              out += this.input.slice(chunkStart, this.pos);
              out += this.jsx_readEntity();
              chunkStart = this.pos;
              break;

            default:
              if (acorn.isNewLine(ch)) {
                out += this.input.slice(chunkStart, this.pos);
                out += this.jsx_readNewLine(true);
                chunkStart = this.pos;
              } else {
                ++this.pos;
              }
          }
        }
      };

      pp.jsx_readNewLine = function (normalizeCRLF) {
        var ch = this.input.charCodeAt(this.pos);
        var out;
        ++this.pos;
        if (ch === 13 && this.input.charCodeAt(this.pos) === 10) {
          ++this.pos;
          out = normalizeCRLF ? '\n' : '\r\n';
        } else {
          out = String.fromCharCode(ch);
        }
        if (this.options.locations) {
          ++this.curLine;
          this.lineStart = this.pos;
        }

        return out;
      };

      pp.jsx_readString = function (quote) {
        var out = '',
            chunkStart = ++this.pos;
        for (;;) {
          if (this.pos >= this.input.length) this.raise(this.start, 'Unterminated string constant');
          var ch = this.input.charCodeAt(this.pos);
          if (ch === quote) break;
          if (ch === 38) {
            // '&'
            out += this.input.slice(chunkStart, this.pos);
            out += this.jsx_readEntity();
            chunkStart = this.pos;
          } else if (acorn.isNewLine(ch)) {
            out += this.input.slice(chunkStart, this.pos);
            out += this.jsx_readNewLine(false);
            chunkStart = this.pos;
          } else {
            ++this.pos;
          }
        }
        out += this.input.slice(chunkStart, this.pos++);
        return this.finishToken(tt.string, out);
      };

      pp.jsx_readEntity = function () {
        var str = '',
            count = 0,
            entity;
        var ch = this.input[this.pos];
        if (ch !== '&') this.raise(this.pos, 'Entity must start with an ampersand');
        var startPos = ++this.pos;
        while (this.pos < this.input.length && count++ < 10) {
          ch = this.input[this.pos++];
          if (ch === ';') {
            if (str[0] === '#') {
              if (str[1] === 'x') {
                str = str.substr(2);
                if (hexNumber.test(str)) entity = String.fromCharCode(parseInt(str, 16));
              } else {
                str = str.substr(1);
                if (decimalNumber.test(str)) entity = String.fromCharCode(parseInt(str, 10));
              }
            } else {
              entity = XHTMLEntities[str];
            }
            break;
          }
          str += ch;
        }
        if (!entity) {
          this.pos = startPos;
          return '&';
        }
        return entity;
      };

      // Read a JSX identifier (valid tag or attribute name).
      //
      // Optimized version since JSX identifiers can't contain
      // escape characters and so can be read as single slice.
      // Also assumes that first character was already checked
      // by isIdentifierStart in readToken.

      pp.jsx_readWord = function () {
        var ch,
            start = this.pos;
        do {
          ch = this.input.charCodeAt(++this.pos);
        } while (acorn.isIdentifierChar(ch) || ch === 45); // '-'
        return this.finishToken(tt.jsxName, this.input.slice(start, this.pos));
      };

      // Transforms JSX element name to string.

      function getQualifiedJSXName(object) {
        if (object.type === 'JSXIdentifier') return object.name;

        if (object.type === 'JSXNamespacedName') return object.namespace.name + ':' + object.name.name;

        if (object.type === 'JSXMemberExpression') return getQualifiedJSXName(object.object) + '.' + getQualifiedJSXName(object.property);
      }

      // Parse next token as JSX identifier

      pp.jsx_parseIdentifier = function () {
        var node = this.startNode();
        if (this.type === tt.jsxName) node.name = this.value;else if (this.type.keyword) node.name = this.type.keyword;else this.unexpected();
        this.next();
        return this.finishNode(node, 'JSXIdentifier');
      };

      // Parse namespaced identifier.

      pp.jsx_parseNamespacedName = function () {
        var startPos = this.start,
            startLoc = this.startLoc;
        var name = this.jsx_parseIdentifier();
        if (!this.options.plugins.jsx.allowNamespaces || !this.eat(tt.colon)) return name;
        var node = this.startNodeAt(startPos, startLoc);
        node.namespace = name;
        node.name = this.jsx_parseIdentifier();
        return this.finishNode(node, 'JSXNamespacedName');
      };

      // Parses element name in any form - namespaced, member
      // or single identifier.

      pp.jsx_parseElementName = function () {
        var startPos = this.start,
            startLoc = this.startLoc;
        var node = this.jsx_parseNamespacedName();
        if (this.type === tt.dot && node.type === 'JSXNamespacedName' && !this.options.plugins.jsx.allowNamespacedObjects) {
          this.unexpected();
        }
        while (this.eat(tt.dot)) {
          var newNode = this.startNodeAt(startPos, startLoc);
          newNode.object = node;
          newNode.property = this.jsx_parseIdentifier();
          node = this.finishNode(newNode, 'JSXMemberExpression');
        }
        return node;
      };

      // Parses any type of JSX attribute value.

      pp.jsx_parseAttributeValue = function () {
        switch (this.type) {
          case tt.braceL:
            var node = this.jsx_parseExpressionContainer();
            if (node.expression.type === 'JSXEmptyExpression') this.raise(node.start, 'JSX attributes must only be assigned a non-empty expression');
            return node;

          case tt.jsxTagStart:
          case tt.string:
            return this.parseExprAtom();

          default:
            this.raise(this.start, 'JSX value should be either an expression or a quoted JSX text');
        }
      };

      // JSXEmptyExpression is unique type since it doesn't actually parse anything,
      // and so it should start at the end of last read token (left brace) and finish
      // at the beginning of the next one (right brace).

      pp.jsx_parseEmptyExpression = function () {
        var node = this.startNodeAt(this.lastTokEnd, this.lastTokEndLoc);
        return this.finishNodeAt(node, 'JSXEmptyExpression', this.start, this.startLoc);
      };

      // Parses JSX expression enclosed into curly brackets.


      pp.jsx_parseExpressionContainer = function () {
        var node = this.startNode();
        this.next();
        node.expression = this.type === tt.braceR ? this.jsx_parseEmptyExpression() : this.parseExpression();
        this.expect(tt.braceR);
        return this.finishNode(node, 'JSXExpressionContainer');
      };

      // Parses following JSX attribute name-value pair.

      pp.jsx_parseAttribute = function () {
        var node = this.startNode();
        if (this.eat(tt.braceL)) {
          this.expect(tt.ellipsis);
          node.argument = this.parseMaybeAssign();
          this.expect(tt.braceR);
          return this.finishNode(node, 'JSXSpreadAttribute');
        }
        node.name = this.jsx_parseNamespacedName();
        node.value = this.eat(tt.eq) ? this.jsx_parseAttributeValue() : null;
        return this.finishNode(node, 'JSXAttribute');
      };

      // Parses JSX opening tag starting after '<'.

      pp.jsx_parseOpeningElementAt = function (startPos, startLoc) {
        var node = this.startNodeAt(startPos, startLoc);
        node.attributes = [];
        node.name = this.jsx_parseElementName();
        while (this.type !== tt.slash && this.type !== tt.jsxTagEnd) {
          node.attributes.push(this.jsx_parseAttribute());
        }node.selfClosing = this.eat(tt.slash);
        this.expect(tt.jsxTagEnd);
        return this.finishNode(node, 'JSXOpeningElement');
      };

      // Parses JSX closing tag starting after '</'.

      pp.jsx_parseClosingElementAt = function (startPos, startLoc) {
        var node = this.startNodeAt(startPos, startLoc);
        node.name = this.jsx_parseElementName();
        this.expect(tt.jsxTagEnd);
        return this.finishNode(node, 'JSXClosingElement');
      };

      // Parses entire JSX element, including it's opening tag
      // (starting after '<'), attributes, contents and closing tag.

      pp.jsx_parseElementAt = function (startPos, startLoc) {
        var node = this.startNodeAt(startPos, startLoc);
        var children = [];
        var openingElement = this.jsx_parseOpeningElementAt(startPos, startLoc);
        var closingElement = null;

        if (!openingElement.selfClosing) {
          contents: for (;;) {
            switch (this.type) {
              case tt.jsxTagStart:
                startPos = this.start;startLoc = this.startLoc;
                this.next();
                if (this.eat(tt.slash)) {
                  closingElement = this.jsx_parseClosingElementAt(startPos, startLoc);
                  break contents;
                }
                children.push(this.jsx_parseElementAt(startPos, startLoc));
                break;

              case tt.jsxText:
                children.push(this.parseExprAtom());
                break;

              case tt.braceL:
                children.push(this.jsx_parseExpressionContainer());
                break;

              default:
                this.unexpected();
            }
          }
          if (getQualifiedJSXName(closingElement.name) !== getQualifiedJSXName(openingElement.name)) {
            this.raise(closingElement.start, 'Expected corresponding JSX closing tag for <' + getQualifiedJSXName(openingElement.name) + '>');
          }
        }

        node.openingElement = openingElement;
        node.closingElement = closingElement;
        node.children = children;
        if (this.type === tt.relational && this.value === "<") {
          this.raise(this.start, "Adjacent JSX elements must be wrapped in an enclosing tag");
        }
        return this.finishNode(node, 'JSXElement');
      };

      // Parses entire JSX element from current position.

      pp.jsx_parseElement = function () {
        var startPos = this.start,
            startLoc = this.startLoc;
        this.next();
        return this.jsx_parseElementAt(startPos, startLoc);
      };

      acorn.plugins.jsx = function (instance, opts) {
        if (!opts) {
          return;
        }

        if ((typeof opts === 'undefined' ? 'undefined' : _typeof(opts)) !== 'object') {
          opts = {};
        }

        instance.options.plugins.jsx = {
          allowNamespaces: opts.allowNamespaces !== false,
          allowNamespacedObjects: !!opts.allowNamespacedObjects
        };

        instance.extend('parseExprAtom', function (inner) {
          return function (refShortHandDefaultPos) {
            if (this.type === tt.jsxText) return this.parseLiteral(this.value);else if (this.type === tt.jsxTagStart) return this.jsx_parseElement();else return inner.call(this, refShortHandDefaultPos);
          };
        });

        instance.extend('readToken', function (inner) {
          return function (code) {
            var context = this.curContext();

            if (context === tc.j_expr) return this.jsx_readToken();

            if (context === tc.j_oTag || context === tc.j_cTag) {
              if (acorn.isIdentifierStart(code)) return this.jsx_readWord();

              if (code == 62) {
                ++this.pos;
                return this.finishToken(tt.jsxTagEnd);
              }

              if ((code === 34 || code === 39) && context == tc.j_oTag) return this.jsx_readString(code);
            }

            if (code === 60 && this.exprAllowed) {
              ++this.pos;
              return this.finishToken(tt.jsxTagStart);
            }
            return inner.call(this, code);
          };
        });

        instance.extend('updateContext', function (inner) {
          return function (prevType) {
            if (this.type == tt.braceL) {
              var curContext = this.curContext();
              if (curContext == tc.j_oTag) this.context.push(tc.b_expr);else if (curContext == tc.j_expr) this.context.push(tc.b_tmpl);else inner.call(this, prevType);
              this.exprAllowed = true;
            } else if (this.type === tt.slash && prevType === tt.jsxTagStart) {
              this.context.length -= 2; // do not consider JSX expr -> JSX open tag -> ... anymore
              this.context.push(tc.j_cTag); // reconsider as closing tag context
              this.exprAllowed = false;
            } else {
              return inner.call(this, prevType);
            }
          };
        });
      };

      return acorn;
    };
  });

  var acornJsx = inject && (typeof inject === 'undefined' ? 'undefined' : _typeof(inject)) === 'object' && 'default' in inject ? inject['default'] : inject;

  var inject$1 = __commonjs(function (module) {
    'use strict';

    module.exports = function (acorn) {
      var tt = acorn.tokTypes;
      var pp = acorn.Parser.prototype;

      // this is the same parseObj that acorn has with...
      function parseObj(isPattern, refDestructuringErrors) {
        var this$1 = this;

        var node = this.startNode(),
            first = true,
            propHash = {};
        node.properties = [];
        this.next();
        while (!this$1.eat(tt.braceR)) {
          if (!first) {
            this$1.expect(tt.comma);
            if (this$1.afterTrailingComma(tt.braceR)) break;
          } else first = false;

          var prop = this$1.startNode(),
              isGenerator,
              startPos,
              startLoc;
          if (this$1.options.ecmaVersion >= 6) {
            // ...the spread logic borrowed from babylon :)
            if (this$1.type === tt.ellipsis) {
              prop = this$1.parseSpread();
              prop.type = isPattern ? "RestProperty" : "SpreadProperty";
              node.properties.push(prop);
              continue;
            }

            prop.method = false;
            prop.shorthand = false;
            if (isPattern || refDestructuringErrors) {
              startPos = this$1.start;
              startLoc = this$1.startLoc;
            }
            if (!isPattern) isGenerator = this$1.eat(tt.star);
          }
          this$1.parsePropertyName(prop);
          this$1.parsePropertyValue(prop, isPattern, isGenerator, startPos, startLoc, refDestructuringErrors);
          this$1.checkPropClash(prop, propHash);
          node.properties.push(this$1.finishNode(prop, "Property"));
        }
        return this.finishNode(node, isPattern ? "ObjectPattern" : "ObjectExpression");
      }

      acorn.plugins.objectSpread = function objectSpreadPlugin(instance) {
        pp.parseObj = parseObj;
      };

      return acorn;
    };
  });

  var acornObjectSpread = inject$1 && (typeof inject$1 === 'undefined' ? 'undefined' : _typeof(inject$1)) === 'object' && 'default' in inject$1 ? inject$1['default'] : inject$1;

  var charToInteger = {};
  var integerToChar = {};

  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/='.split('').forEach(function (char, i) {
    charToInteger[char] = i;
    integerToChar[i] = char;
  });

  function encode(value) {
    var result, i;

    if (typeof value === 'number') {
      result = encodeInteger(value);
    } else {
      result = '';
      for (i = 0; i < value.length; i += 1) {
        result += encodeInteger(value[i]);
      }
    }

    return result;
  }

  function encodeInteger(num) {
    var result = '',
        clamped;

    if (num < 0) {
      num = -num << 1 | 1;
    } else {
      num <<= 1;
    }

    do {
      clamped = num & 31;
      num >>= 5;

      if (num > 0) {
        clamped |= 32;
      }

      result += integerToChar[clamped];
    } while (num > 0);

    return result;
  }

  function Chunk(start, end, content) {
    this.start = start;
    this.end = end;
    this.original = content;

    this.intro = '';
    this.outro = '';

    this.content = content;
    this.storeName = false;
    this.edited = false;

    // we make these non-enumerable, for sanity while debugging
    Object.defineProperties(this, {
      previous: { writable: true, value: null },
      next: { writable: true, value: null }
    });
  }

  Chunk.prototype = {
    append: function append(content) {
      this.outro += content;
    },

    clone: function clone() {
      var chunk = new Chunk(this.start, this.end, this.original);

      chunk.intro = this.intro;
      chunk.outro = this.outro;
      chunk.content = this.content;
      chunk.storeName = this.storeName;
      chunk.edited = this.edited;

      return chunk;
    },

    contains: function contains(index) {
      return this.start < index && index < this.end;
    },

    eachNext: function eachNext(fn) {
      var chunk = this;
      while (chunk) {
        fn(chunk);
        chunk = chunk.next;
      }
    },

    eachPrevious: function eachPrevious(fn) {
      var chunk = this;
      while (chunk) {
        fn(chunk);
        chunk = chunk.previous;
      }
    },

    edit: function edit(content, storeName) {
      this.content = content;
      this.storeName = storeName;

      this.edited = true;

      return this;
    },

    prepend: function prepend(content) {
      this.intro = content + this.intro;
    },

    split: function split(index) {
      var sliceIndex = index - this.start;

      var originalBefore = this.original.slice(0, sliceIndex);
      var originalAfter = this.original.slice(sliceIndex);

      this.original = originalBefore;

      var newChunk = new Chunk(index, this.end, originalAfter);
      newChunk.outro = this.outro;
      this.outro = '';

      this.end = index;

      if (this.edited) {
        // TODO is this block necessary?...
        newChunk.edit('', false);
        this.content = '';
      } else {
        this.content = originalBefore;
      }

      newChunk.next = this.next;
      if (newChunk.next) newChunk.next.previous = newChunk;
      newChunk.previous = this;
      this.next = newChunk;

      return newChunk;
    },

    toString: function toString() {
      return this.intro + this.content + this.outro;
    },

    trimEnd: function trimEnd(rx) {
      this.outro = this.outro.replace(rx, '');
      if (this.outro.length) return true;

      var trimmed = this.content.replace(rx, '');

      if (trimmed.length) {
        if (trimmed !== this.content) {
          this.split(this.start + trimmed.length).edit('', false);
        }

        return true;
      } else {
        this.edit('', false);

        this.intro = this.intro.replace(rx, '');
        if (this.intro.length) return true;
      }
    },

    trimStart: function trimStart(rx) {
      this.intro = this.intro.replace(rx, '');
      if (this.intro.length) return true;

      var trimmed = this.content.replace(rx, '');

      if (trimmed.length) {
        if (trimmed !== this.content) {
          this.split(this.end - trimmed.length);
          this.edit('', false);
        }

        return true;
      } else {
        this.edit('', false);

        this.outro = this.outro.replace(rx, '');
        if (this.outro.length) return true;
      }
    }
  };

  var _btoa;

  if (typeof window !== 'undefined' && typeof window.btoa === 'function') {
    _btoa = window.btoa;
  } else if (typeof Buffer === 'function') {
    _btoa = function _btoa(str) {
      return new Buffer(str).toString('base64');
    };
  } else {
    _btoa = function _btoa() {
      throw new Error('Unsupported environment: `window.btoa` or `Buffer` should be supported.');
    };
  }

  var btoa = _btoa;

  function SourceMap(properties) {
    this.version = 3;

    this.file = properties.file;
    this.sources = properties.sources;
    this.sourcesContent = properties.sourcesContent;
    this.names = properties.names;
    this.mappings = properties.mappings;
  }

  SourceMap.prototype = {
    toString: function toString() {
      return JSON.stringify(this);
    },

    toUrl: function toUrl() {
      return 'data:application/json;charset=utf-8;base64,' + btoa(this.toString());
    }
  };

  function guessIndent(code) {
    var lines = code.split('\n');

    var tabbed = lines.filter(function (line) {
      return (/^\t+/.test(line)
      );
    });
    var spaced = lines.filter(function (line) {
      return (/^ {2,}/.test(line)
      );
    });

    if (tabbed.length === 0 && spaced.length === 0) {
      return null;
    }

    // More lines tabbed than spaced? Assume tabs, and
    // default to tabs in the case of a tie (or nothing
    // to go on)
    if (tabbed.length >= spaced.length) {
      return '\t';
    }

    // Otherwise, we need to guess the multiple
    var min = spaced.reduce(function (previous, current) {
      var numSpaces = /^ +/.exec(current)[0].length;
      return Math.min(numSpaces, previous);
    }, Infinity);

    return new Array(min + 1).join(' ');
  }

  function getLocator(source) {
    var originalLines = source.split('\n');

    var start = 0;
    var lineRanges = originalLines.map(function (line, i) {
      var end = start + line.length + 1;
      var range = { start: start, end: end, line: i };

      start = end;
      return range;
    });

    var i = 0;

    function rangeContains(range, index) {
      return range.start <= index && index < range.end;
    }

    function getLocation(range, index) {
      return { line: range.line, column: index - range.start };
    }

    return function locate(index) {
      var range = lineRanges[i];

      var d = index >= range.end ? 1 : -1;

      while (range) {
        if (rangeContains(range, index)) return getLocation(range, index);

        i += d;
        range = lineRanges[i];
      }
    };
  }

  function encodeMappings(original, intro, chunk, hires, sourcemapLocations, sourceIndex, offsets, names) {
    var rawLines = [];

    var generatedCodeLine = intro.split('\n').length - 1;
    var rawSegments = rawLines[generatedCodeLine] = [];

    var generatedCodeColumn = 0;

    var locate = getLocator(original);

    function addEdit(content, original, loc, nameIndex, i) {
      if (i || content.length) {
        rawSegments.push({
          generatedCodeLine: generatedCodeLine,
          generatedCodeColumn: generatedCodeColumn,
          sourceCodeLine: loc.line,
          sourceCodeColumn: loc.column,
          sourceCodeName: nameIndex,
          sourceIndex: sourceIndex
        });
      }

      var lines = content.split('\n');
      var lastLine = lines.pop();

      if (lines.length) {
        generatedCodeLine += lines.length;
        rawLines[generatedCodeLine] = rawSegments = [];
        generatedCodeColumn = lastLine.length;
      } else {
        generatedCodeColumn += lastLine.length;
      }

      lines = original.split('\n');
      lastLine = lines.pop();

      if (lines.length) {
        loc.line += lines.length;
        loc.column = lastLine.length;
      } else {
        loc.column += lastLine.length;
      }
    }

    function addUneditedChunk(chunk, loc) {
      var originalCharIndex = chunk.start;
      var first = true;

      while (originalCharIndex < chunk.end) {
        if (hires || first || sourcemapLocations[originalCharIndex]) {
          rawSegments.push({
            generatedCodeLine: generatedCodeLine,
            generatedCodeColumn: generatedCodeColumn,
            sourceCodeLine: loc.line,
            sourceCodeColumn: loc.column,
            sourceCodeName: -1,
            sourceIndex: sourceIndex
          });
        }

        if (original[originalCharIndex] === '\n') {
          loc.line += 1;
          loc.column = 0;
          generatedCodeLine += 1;
          rawLines[generatedCodeLine] = rawSegments = [];
          generatedCodeColumn = 0;
        } else {
          loc.column += 1;
          generatedCodeColumn += 1;
        }

        originalCharIndex += 1;
        first = false;
      }
    }

    while (chunk) {
      var loc = locate(chunk.start);

      if (chunk.intro.length) {
        addEdit(chunk.intro, '', loc, -1, !!chunk.previous);
      }

      if (chunk.edited) {
        addEdit(chunk.content, chunk.original, loc, chunk.storeName ? names.indexOf(chunk.original) : -1, !!chunk.previous);
      } else {
        addUneditedChunk(chunk, loc);
      }

      if (chunk.outro.length) {
        addEdit(chunk.outro, '', loc, -1, !!chunk.previous);
      }

      var nextChunk = chunk.next;
      chunk = nextChunk;
    }

    offsets.sourceIndex = offsets.sourceIndex || 0;
    offsets.sourceCodeLine = offsets.sourceCodeLine || 0;
    offsets.sourceCodeColumn = offsets.sourceCodeColumn || 0;
    offsets.sourceCodeName = offsets.sourceCodeName || 0;

    var encoded = rawLines.map(function (segments) {
      var generatedCodeColumn = 0;

      return segments.map(function (segment) {
        var arr = [segment.generatedCodeColumn - generatedCodeColumn, segment.sourceIndex - offsets.sourceIndex, segment.sourceCodeLine - offsets.sourceCodeLine, segment.sourceCodeColumn - offsets.sourceCodeColumn];

        generatedCodeColumn = segment.generatedCodeColumn;
        offsets.sourceIndex = segment.sourceIndex;
        offsets.sourceCodeLine = segment.sourceCodeLine;
        offsets.sourceCodeColumn = segment.sourceCodeColumn;

        if (~segment.sourceCodeName) {
          arr.push(segment.sourceCodeName - offsets.sourceCodeName);
          offsets.sourceCodeName = segment.sourceCodeName;
        }

        return encode(arr);
      }).join(',');
    }).join(';');

    return encoded;
  }

  function getRelativePath(from, to) {
    var fromParts = from.split(/[\/\\]/);
    var toParts = to.split(/[\/\\]/);

    fromParts.pop(); // get dirname

    while (fromParts[0] === toParts[0]) {
      fromParts.shift();
      toParts.shift();
    }

    if (fromParts.length) {
      var i = fromParts.length;
      while (i--) {
        fromParts[i] = '..';
      }
    }

    return fromParts.concat(toParts).join('/');
  }

  var toString = Object.prototype.toString;

  function isObject(thing) {
    return toString.call(thing) === '[object Object]';
  }

  function MagicString(string, options) {
    if (options === void 0) options = {};

    var chunk = new Chunk(0, string.length, string);

    Object.defineProperties(this, {
      original: { writable: true, value: string },
      outro: { writable: true, value: '' },
      intro: { writable: true, value: '' },
      firstChunk: { writable: true, value: chunk },
      lastChunk: { writable: true, value: chunk },
      lastSearchedChunk: { writable: true, value: chunk },
      byStart: { writable: true, value: {} },
      byEnd: { writable: true, value: {} },
      filename: { writable: true, value: options.filename },
      indentExclusionRanges: { writable: true, value: options.indentExclusionRanges },
      sourcemapLocations: { writable: true, value: {} },
      storedNames: { writable: true, value: {} },
      indentStr: { writable: true, value: guessIndent(string) }
    });

    if (false) {}

    this.byStart[0] = chunk;
    this.byEnd[string.length] = chunk;
  }

  MagicString.prototype = {
    addSourcemapLocation: function addSourcemapLocation(char) {
      this.sourcemapLocations[char] = true;
    },

    append: function append(content) {
      if (typeof content !== 'string') throw new TypeError('outro content must be a string');

      this.outro += content;
      return this;
    },

    clone: function clone() {
      var cloned = new MagicString(this.original, { filename: this.filename });

      var originalChunk = this.firstChunk;
      var clonedChunk = cloned.firstChunk = cloned.lastSearchedChunk = originalChunk.clone();

      while (originalChunk) {
        cloned.byStart[clonedChunk.start] = clonedChunk;
        cloned.byEnd[clonedChunk.end] = clonedChunk;

        var nextOriginalChunk = originalChunk.next;
        var nextClonedChunk = nextOriginalChunk && nextOriginalChunk.clone();

        if (nextClonedChunk) {
          clonedChunk.next = nextClonedChunk;
          nextClonedChunk.previous = clonedChunk;

          clonedChunk = nextClonedChunk;
        }

        originalChunk = nextOriginalChunk;
      }

      cloned.lastChunk = clonedChunk;

      if (this.indentExclusionRanges) {
        cloned.indentExclusionRanges = typeof this.indentExclusionRanges[0] === 'number' ? [this.indentExclusionRanges[0], this.indentExclusionRanges[1]] : this.indentExclusionRanges.map(function (range) {
          return [range.start, range.end];
        });
      }

      Object.keys(this.sourcemapLocations).forEach(function (loc) {
        cloned.sourcemapLocations[loc] = true;
      });

      return cloned;
    },

    generateMap: function generateMap(options) {
      options = options || {};

      var names = Object.keys(this.storedNames);

      if (false) {}
      var map = new SourceMap({
        file: options.file ? options.file.split(/[\/\\]/).pop() : null,
        sources: [options.source ? getRelativePath(options.file || '', options.source) : null],
        sourcesContent: options.includeContent ? [this.original] : [null],
        names: names,
        mappings: this.getMappings(options.hires, 0, {}, names)
      });
      if (false) {}

      return map;
    },

    getIndentString: function getIndentString() {
      return this.indentStr === null ? '\t' : this.indentStr;
    },

    getMappings: function getMappings(hires, sourceIndex, offsets, names) {
      return encodeMappings(this.original, this.intro, this.firstChunk, hires, this.sourcemapLocations, sourceIndex, offsets, names);
    },

    indent: function indent(indentStr, options) {
      var this$1 = this;

      var pattern = /^[^\r\n]/gm;

      if (isObject(indentStr)) {
        options = indentStr;
        indentStr = undefined;
      }

      indentStr = indentStr !== undefined ? indentStr : this.indentStr || '\t';

      if (indentStr === '') return this; // noop

      options = options || {};

      // Process exclusion ranges
      var isExcluded = {};

      if (options.exclude) {
        var exclusions = typeof options.exclude[0] === 'number' ? [options.exclude] : options.exclude;
        exclusions.forEach(function (exclusion) {
          for (var i = exclusion[0]; i < exclusion[1]; i += 1) {
            isExcluded[i] = true;
          }
        });
      }

      var shouldIndentNextCharacter = options.indentStart !== false;
      var replacer = function replacer(match) {
        if (shouldIndentNextCharacter) return "" + indentStr + match;
        shouldIndentNextCharacter = true;
        return match;
      };

      this.intro = this.intro.replace(pattern, replacer);

      var charIndex = 0;

      var chunk = this.firstChunk;

      while (chunk) {
        var end = chunk.end;

        if (chunk.edited) {
          if (!isExcluded[charIndex]) {
            chunk.content = chunk.content.replace(pattern, replacer);

            if (chunk.content.length) {
              shouldIndentNextCharacter = chunk.content[chunk.content.length - 1] === '\n';
            }
          }
        } else {
          charIndex = chunk.start;

          while (charIndex < end) {
            if (!isExcluded[charIndex]) {
              var char = this$1.original[charIndex];

              if (char === '\n') {
                shouldIndentNextCharacter = true;
              } else if (char !== '\r' && shouldIndentNextCharacter) {
                shouldIndentNextCharacter = false;

                if (charIndex === chunk.start) {
                  chunk.prepend(indentStr);
                } else {
                  var rhs = chunk.split(charIndex);
                  rhs.prepend(indentStr);

                  this$1.byStart[charIndex] = rhs;
                  this$1.byEnd[charIndex] = chunk;

                  chunk = rhs;
                }
              }
            }

            charIndex += 1;
          }
        }

        charIndex = chunk.end;
        chunk = chunk.next;
      }

      this.outro = this.outro.replace(pattern, replacer);

      return this;
    },

    insert: function insert() {
      throw new Error('magicString.insert(...) is deprecated. Use insertRight(...) or insertLeft(...)');
    },

    insertLeft: function insertLeft(index, content) {
      if (typeof content !== 'string') throw new TypeError('inserted content must be a string');

      if (false) {}

      this._split(index);

      var chunk = this.byEnd[index];

      if (chunk) {
        chunk.append(content);
      } else {
        this.intro += content;
      }

      if (false) {}
      return this;
    },

    insertRight: function insertRight(index, content) {
      if (typeof content !== 'string') throw new TypeError('inserted content must be a string');

      if (false) {}

      this._split(index);

      var chunk = this.byStart[index];

      if (chunk) {
        chunk.prepend(content);
      } else {
        this.outro += content;
      }

      if (false) {}
      return this;
    },

    move: function move(start, end, index) {
      if (index >= start && index <= end) throw new Error('Cannot move a selection inside itself');

      if (false) {}

      this._split(start);
      this._split(end);
      this._split(index);

      var first = this.byStart[start];
      var last = this.byEnd[end];

      var oldLeft = first.previous;
      var oldRight = last.next;

      var newRight = this.byStart[index];
      if (!newRight && last === this.lastChunk) return this;
      var newLeft = newRight ? newRight.previous : this.lastChunk;

      if (oldLeft) oldLeft.next = oldRight;
      if (oldRight) oldRight.previous = oldLeft;

      if (newLeft) newLeft.next = first;
      if (newRight) newRight.previous = last;

      if (!first.previous) this.firstChunk = last.next;
      if (!last.next) {
        this.lastChunk = first.previous;
        this.lastChunk.next = null;
      }

      first.previous = newLeft;
      last.next = newRight;

      if (!newLeft) this.firstChunk = first;
      if (!newRight) this.lastChunk = last;

      if (false) {}
      return this;
    },

    overwrite: function overwrite(start, end, content, storeName) {
      var this$1 = this;

      if (typeof content !== 'string') throw new TypeError('replacement content must be a string');

      while (start < 0) {
        start += this$1.original.length;
      }while (end < 0) {
        end += this$1.original.length;
      }if (end > this.original.length) throw new Error('end is out of bounds');
      if (start === end) throw new Error('Cannot overwrite a zero-length range – use insertLeft or insertRight instead');

      if (false) {}

      this._split(start);
      this._split(end);

      if (storeName) {
        var original = this.original.slice(start, end);
        this.storedNames[original] = true;
      }

      var first = this.byStart[start];
      var last = this.byEnd[end];

      if (first) {
        first.edit(content, storeName);

        if (first !== last) {
          first.outro = '';

          var chunk = first.next;
          while (chunk !== last) {
            chunk.edit('', false);
            chunk.intro = chunk.outro = '';
            chunk = chunk.next;
          }

          chunk.edit('', false);
          chunk.intro = '';
        }
      } else {
        // must be inserting at the end
        var newChunk = new Chunk(start, end, '').edit(content, storeName);

        // TODO last chunk in the array may not be the last chunk, if it's moved...
        last.next = newChunk;
        newChunk.previous = last;
      }

      if (false) {}
      return this;
    },

    prepend: function prepend(content) {
      if (typeof content !== 'string') throw new TypeError('outro content must be a string');

      this.intro = content + this.intro;
      return this;
    },

    remove: function remove(start, end) {
      var this$1 = this;

      while (start < 0) {
        start += this$1.original.length;
      }while (end < 0) {
        end += this$1.original.length;
      }if (start === end) return this;

      if (start < 0 || end > this.original.length) throw new Error('Character is out of bounds');
      if (start > end) throw new Error('end must be greater than start');

      return this.overwrite(start, end, '', false);
    },

    slice: function slice(start, end) {
      var this$1 = this;
      if (start === void 0) start = 0;
      if (end === void 0) end = this.original.length;

      while (start < 0) {
        start += this$1.original.length;
      }while (end < 0) {
        end += this$1.original.length;
      }var result = '';

      // find start chunk
      var chunk = this.firstChunk;
      while (chunk && (chunk.start > start || chunk.end <= start)) {

        // found end chunk before start
        if (chunk.start < end && chunk.end >= end) {
          return result;
        }

        chunk = chunk.next;
      }

      if (chunk && chunk.edited && chunk.start !== start) throw new Error("Cannot use replaced character " + start + " as slice start anchor.");

      var startChunk = chunk;
      while (chunk) {
        if (chunk.intro && (startChunk !== chunk || chunk.start === start)) {
          result += chunk.intro;
        }

        var containsEnd = chunk.start < end && chunk.end >= end;
        if (containsEnd && chunk.edited && chunk.end !== end) throw new Error("Cannot use replaced character " + end + " as slice end anchor.");

        var sliceStart = startChunk === chunk ? start - chunk.start : 0;
        var sliceEnd = containsEnd ? chunk.content.length + end - chunk.end : chunk.content.length;

        result += chunk.content.slice(sliceStart, sliceEnd);

        if (chunk.outro && (!containsEnd || chunk.end === end)) {
          result += chunk.outro;
        }

        if (containsEnd) {
          break;
        }

        chunk = chunk.next;
      }

      return result;
    },

    // TODO deprecate this? not really very useful
    snip: function snip(start, end) {
      var clone = this.clone();
      clone.remove(0, start);
      clone.remove(end, clone.original.length);

      return clone;
    },

    _split: function _split(index) {
      var this$1 = this;

      if (this.byStart[index] || this.byEnd[index]) return;

      if (false) {}

      var chunk = this.lastSearchedChunk;
      var searchForward = index > chunk.end;

      while (true) {
        if (chunk.contains(index)) return this$1._splitChunk(chunk, index);

        chunk = searchForward ? this$1.byStart[chunk.end] : this$1.byEnd[chunk.start];
      }
    },

    _splitChunk: function _splitChunk(chunk, index) {
      if (chunk.edited && chunk.content.length) {
        // zero-length edited chunks are a special case (overlapping replacements)
        var loc = getLocator(this.original)(index);
        throw new Error("Cannot split a chunk that has already been edited (" + loc.line + ":" + loc.column + " – \"" + chunk.original + "\")");
      }

      var newChunk = chunk.split(index);

      this.byEnd[index] = chunk;
      this.byStart[index] = newChunk;
      this.byEnd[newChunk.end] = newChunk;

      if (chunk === this.lastChunk) this.lastChunk = newChunk;

      this.lastSearchedChunk = chunk;
      if (false) {}
      return true;
    },

    toString: function toString() {
      var str = this.intro;

      var chunk = this.firstChunk;
      while (chunk) {
        str += chunk.toString();
        chunk = chunk.next;
      }

      return str + this.outro;
    },

    trimLines: function trimLines() {
      return this.trim('[\\r\\n]');
    },

    trim: function trim(charType) {
      return this.trimStart(charType).trimEnd(charType);
    },

    trimEnd: function trimEnd(charType) {
      var this$1 = this;

      var rx = new RegExp((charType || '\\s') + '+$');

      this.outro = this.outro.replace(rx, '');
      if (this.outro.length) return this;

      var chunk = this.lastChunk;

      do {
        var end = chunk.end;
        var aborted = chunk.trimEnd(rx);

        // if chunk was trimmed, we have a new lastChunk
        if (chunk.end !== end) {
          this$1.lastChunk = chunk.next;

          this$1.byEnd[chunk.end] = chunk;
          this$1.byStart[chunk.next.start] = chunk.next;
        }

        if (aborted) return this$1;
        chunk = chunk.previous;
      } while (chunk);

      return this;
    },

    trimStart: function trimStart(charType) {
      var this$1 = this;

      var rx = new RegExp('^' + (charType || '\\s') + '+');

      this.intro = this.intro.replace(rx, '');
      if (this.intro.length) return this;

      var chunk = this.firstChunk;

      do {
        var end = chunk.end;
        var aborted = chunk.trimStart(rx);

        if (chunk.end !== end) {
          // special case...
          if (chunk === this$1.lastChunk) this$1.lastChunk = chunk.next;

          this$1.byEnd[chunk.end] = chunk;
          this$1.byStart[chunk.next.start] = chunk.next;
        }

        if (aborted) return this$1;
        chunk = chunk.next;
      } while (chunk);

      return this;
    }
  };

  var hasOwnProp = Object.prototype.hasOwnProperty;

  function Bundle(options) {
    if (options === void 0) options = {};

    this.intro = options.intro || '';
    this.separator = options.separator !== undefined ? options.separator : '\n';

    this.sources = [];

    this.uniqueSources = [];
    this.uniqueSourceIndexByFilename = {};
  }

  Bundle.prototype = {
    addSource: function addSource(source) {
      if (source instanceof MagicString) {
        return this.addSource({
          content: source,
          filename: source.filename,
          separator: this.separator
        });
      }

      if (!isObject(source) || !source.content) {
        throw new Error('bundle.addSource() takes an object with a `content` property, which should be an instance of MagicString, and an optional `filename`');
      }

      ['filename', 'indentExclusionRanges', 'separator'].forEach(function (option) {
        if (!hasOwnProp.call(source, option)) source[option] = source.content[option];
      });

      if (source.separator === undefined) {
        // TODO there's a bunch of this sort of thing, needs cleaning up
        source.separator = this.separator;
      }

      if (source.filename) {
        if (!hasOwnProp.call(this.uniqueSourceIndexByFilename, source.filename)) {
          this.uniqueSourceIndexByFilename[source.filename] = this.uniqueSources.length;
          this.uniqueSources.push({ filename: source.filename, content: source.content.original });
        } else {
          var uniqueSource = this.uniqueSources[this.uniqueSourceIndexByFilename[source.filename]];
          if (source.content.original !== uniqueSource.content) {
            throw new Error("Illegal source: same filename (" + source.filename + "), different contents");
          }
        }
      }

      this.sources.push(source);
      return this;
    },

    append: function append(str, options) {
      this.addSource({
        content: new MagicString(str),
        separator: options && options.separator || ''
      });

      return this;
    },

    clone: function clone() {
      var bundle = new Bundle({
        intro: this.intro,
        separator: this.separator
      });

      this.sources.forEach(function (source) {
        bundle.addSource({
          filename: source.filename,
          content: source.content.clone(),
          separator: source.separator
        });
      });

      return bundle;
    },

    generateMap: function generateMap(options) {
      var this$1 = this;

      var offsets = {};

      var names = [];
      this.sources.forEach(function (source) {
        Object.keys(source.content.storedNames).forEach(function (name) {
          if (!~names.indexOf(name)) names.push(name);
        });
      });

      var encoded = getSemis(this.intro) + this.sources.map(function (source, i) {
        var prefix = i > 0 ? getSemis(source.separator) || ',' : '';
        var mappings;

        // we don't bother encoding sources without a filename
        if (!source.filename) {
          mappings = getSemis(source.content.toString());
        } else {
          var sourceIndex = this$1.uniqueSourceIndexByFilename[source.filename];
          mappings = source.content.getMappings(options.hires, sourceIndex, offsets, names);
        }

        return prefix + mappings;
      }).join('');

      return new SourceMap({
        file: options.file ? options.file.split(/[\/\\]/).pop() : null,
        sources: this.uniqueSources.map(function (source) {
          return options.file ? getRelativePath(options.file, source.filename) : source.filename;
        }),
        sourcesContent: this.uniqueSources.map(function (source) {
          return options.includeContent ? source.content : null;
        }),
        names: names,
        mappings: encoded
      });
    },

    getIndentString: function getIndentString() {
      var indentStringCounts = {};

      this.sources.forEach(function (source) {
        var indentStr = source.content.indentStr;

        if (indentStr === null) return;

        if (!indentStringCounts[indentStr]) indentStringCounts[indentStr] = 0;
        indentStringCounts[indentStr] += 1;
      });

      return Object.keys(indentStringCounts).sort(function (a, b) {
        return indentStringCounts[a] - indentStringCounts[b];
      })[0] || '\t';
    },

    indent: function indent(indentStr) {
      var this$1 = this;

      if (!arguments.length) {
        indentStr = this.getIndentString();
      }

      if (indentStr === '') return this; // noop

      var trailingNewline = !this.intro || this.intro.slice(-1) === '\n';

      this.sources.forEach(function (source, i) {
        var separator = source.separator !== undefined ? source.separator : this$1.separator;
        var indentStart = trailingNewline || i > 0 && /\r?\n$/.test(separator);

        source.content.indent(indentStr, {
          exclude: source.indentExclusionRanges,
          indentStart: indentStart //: trailingNewline || /\r?\n$/.test( separator )  //true///\r?\n/.test( separator )
        });

        // TODO this is a very slow way to determine this
        trailingNewline = source.content.toString().slice(0, -1) === '\n';
      });

      if (this.intro) {
        this.intro = indentStr + this.intro.replace(/^[^\n]/gm, function (match, index) {
          return index > 0 ? indentStr + match : match;
        });
      }

      return this;
    },

    prepend: function prepend(str) {
      this.intro = str + this.intro;
      return this;
    },

    toString: function toString() {
      var this$1 = this;

      var body = this.sources.map(function (source, i) {
        var separator = source.separator !== undefined ? source.separator : this$1.separator;
        var str = (i > 0 ? separator : '') + source.content.toString();

        return str;
      }).join('');

      return this.intro + body;
    },

    trimLines: function trimLines() {
      return this.trim('[\\r\\n]');
    },

    trim: function trim(charType) {
      return this.trimStart(charType).trimEnd(charType);
    },

    trimStart: function trimStart(charType) {
      var this$1 = this;

      var rx = new RegExp('^' + (charType || '\\s') + '+');
      this.intro = this.intro.replace(rx, '');

      if (!this.intro) {
        var source;
        var i = 0;

        do {
          source = this$1.sources[i];

          if (!source) {
            break;
          }

          source.content.trimStart(charType);
          i += 1;
        } while (source.content.toString() === ''); // TODO faster way to determine non-empty source?
      }

      return this;
    },

    trimEnd: function trimEnd(charType) {
      var this$1 = this;

      var rx = new RegExp((charType || '\\s') + '+$');

      var source;
      var i = this.sources.length - 1;

      do {
        source = this$1.sources[i];

        if (!source) {
          this$1.intro = this$1.intro.replace(rx, '');
          break;
        }

        source.content.trimEnd(charType);
        i -= 1;
      } while (source.content.toString() === ''); // TODO faster way to determine non-empty source?

      return this;
    }
  };

  function getSemis(str) {
    return new Array(str.split('\n').length).join(';');
  }

  MagicString.Bundle = Bundle;

  var keys = {
    Program: ['body'],
    Literal: []
  };

  // used for debugging, without the noise created by
  // circular references
  function toJSON(node) {
    var obj = {};

    Object.keys(node).forEach(function (key) {
      if (key === 'parent' || key === 'program' || key === 'keys' || key === '__wrapped') return;

      if (Array.isArray(node[key])) {
        obj[key] = node[key].map(toJSON);
      } else if (node[key] && node[key].toJSON) {
        obj[key] = node[key].toJSON();
      } else {
        obj[key] = node[key];
      }
    });

    return obj;
  }

  var Node = function Node(raw, parent) {
    raw.parent = parent;
    raw.program = parent.program || parent;
    raw.depth = parent.depth + 1;
    raw.keys = keys[raw.type];
    raw.indentation = undefined;

    for (var i = 0, list = keys[raw.type]; i < list.length; i += 1) {
      var key = list[i];

      wrap(raw[key], raw);
    }

    raw.program.magicString.addSourcemapLocation(raw.start);
    raw.program.magicString.addSourcemapLocation(raw.end);
  };

  Node.prototype.ancestor = function ancestor(level) {
    var node = this;
    while (level--) {
      node = node.parent;
      if (!node) return null;
    }

    return node;
  };

  Node.prototype.contains = function contains(node) {
    var this$1 = this;

    while (node) {
      if (node === this$1) return true;
      node = node.parent;
    }

    return false;
  };

  Node.prototype.findLexicalBoundary = function findLexicalBoundary() {
    return this.parent.findLexicalBoundary();
  };

  Node.prototype.findNearest = function findNearest(type) {
    if (typeof type === 'string') type = new RegExp("^" + type + "$");
    if (type.test(this.type)) return this;
    return this.parent.findNearest(type);
  };

  Node.prototype.unparenthesizedParent = function unparenthesizedParent() {
    var node = this.parent;
    while (node && node.type === 'ParenthesizedExpression') {
      node = node.parent;
    }
    return node;
  };

  Node.prototype.unparenthesize = function unparenthesize() {
    var node = this;
    while (node.type === 'ParenthesizedExpression') {
      node = node.expression;
    }
    return node;
  };

  Node.prototype.findScope = function findScope(functionScope) {
    return this.parent.findScope(functionScope);
  };

  Node.prototype.getIndentation = function getIndentation() {
    return this.parent.getIndentation();
  };

  Node.prototype.initialise = function initialise(transforms) {
    for (var i = 0, list = this.keys; i < list.length; i += 1) {
      var key = list[i];

      var value = this[key];

      if (Array.isArray(value)) {
        value.forEach(function (node) {
          return node && node.initialise(transforms);
        });
      } else if (value && (typeof value === 'undefined' ? 'undefined' : _typeof(value)) === 'object') {
        value.initialise(transforms);
      }
    }
  };

  Node.prototype.toJSON = function toJSON$1() {
    return toJSON(this);
  };

  Node.prototype.toString = function toString() {
    return this.program.magicString.original.slice(this.start, this.end);
  };

  Node.prototype.transpile = function transpile(code, transforms) {
    for (var i = 0, list = this.keys; i < list.length; i += 1) {
      var key = list[i];

      var value = this[key];

      if (Array.isArray(value)) {
        value.forEach(function (node) {
          return node && node.transpile(code, transforms);
        });
      } else if (value && (typeof value === 'undefined' ? 'undefined' : _typeof(value)) === 'object') {
        value.transpile(code, transforms);
      }
    }
  };

  function isArguments(node) {
    return node.type === 'Identifier' && node.name === 'arguments';
  }

  function spread(code, elements, start, argumentsArrayAlias, isNew) {
    var i = elements.length;
    var firstSpreadIndex = -1;

    while (i--) {
      var element$1 = elements[i];
      if (element$1 && element$1.type === 'SpreadElement') {
        if (isArguments(element$1.argument)) {
          code.overwrite(element$1.argument.start, element$1.argument.end, argumentsArrayAlias);
        }

        firstSpreadIndex = i;
      }
    }

    if (firstSpreadIndex === -1) return false; // false indicates no spread elements

    if (isNew) {
      for (i = 0; i < elements.length; i += 1) {
        var element$2 = elements[i];
        if (element$2.type === 'SpreadElement') {
          code.remove(element$2.start, element$2.argument.start);
        } else {
          code.insertRight(element$2.start, '[');
          code.insertRight(element$2.end, ']');
        }
      }

      return true; // true indicates some spread elements
    }

    var element = elements[firstSpreadIndex];
    var previousElement = elements[firstSpreadIndex - 1];

    if (!previousElement) {
      code.remove(start, element.start);
      code.overwrite(element.end, elements[1].start, '.concat( ');
    } else {
      code.overwrite(previousElement.end, element.start, ' ].concat( ');
    }

    for (i = firstSpreadIndex; i < elements.length; i += 1) {
      element = elements[i];

      if (element) {
        if (element.type === 'SpreadElement') {
          code.remove(element.start, element.argument.start);
        } else {
          code.insertLeft(element.start, '[');
          code.insertLeft(element.end, ']');
        }
      }
    }

    return true; // true indicates some spread elements
  }

  var ArrayExpression = function (Node) {
    function ArrayExpression() {
      Node.apply(this, arguments);
    }

    if (Node) ArrayExpression.__proto__ = Node;
    ArrayExpression.prototype = Object.create(Node && Node.prototype);
    ArrayExpression.prototype.constructor = ArrayExpression;

    ArrayExpression.prototype.initialise = function initialise(transforms) {
      var this$1 = this;

      if (transforms.spreadRest && this.elements.length) {
        var lexicalBoundary = this.findLexicalBoundary();

        var i = this.elements.length;
        while (i--) {
          var element = this$1.elements[i];
          if (element && element.type === 'SpreadElement' && isArguments(element.argument)) {
            this$1.argumentsArrayAlias = lexicalBoundary.getArgumentsArrayAlias();
          }
        }
      }

      Node.prototype.initialise.call(this, transforms);
    };

    ArrayExpression.prototype.transpile = function transpile(code, transforms) {
      if (transforms.spreadRest) {
        // erase trailing comma after last array element if not an array hole
        if (this.elements.length) {
          var lastElement = this.elements[this.elements.length - 1];
          if (lastElement && /\s*,/.test(code.original.slice(lastElement.end, this.end))) {
            code.overwrite(lastElement.end, this.end - 1, ' ');
          }
        }

        if (this.elements.length === 1) {
          var element = this.elements[0];

          if (element && element.type === 'SpreadElement') {
            // special case – [ ...arguments ]
            if (isArguments(element.argument)) {
              code.overwrite(this.start, this.end, "[].concat( " + this.argumentsArrayAlias + " )"); // TODO if this is the only use of argsArray, don't bother concating
            } else {
              code.overwrite(this.start, element.argument.start, '[].concat( ');
              code.overwrite(element.end, this.end, ' )');
            }
          }
        } else {
          var hasSpreadElements = spread(code, this.elements, this.start, this.argumentsArrayAlias);

          if (hasSpreadElements) {
            code.overwrite(this.end - 1, this.end, ')');
          }
        }
      }

      Node.prototype.transpile.call(this, code, transforms);
    };

    return ArrayExpression;
  }(Node);

  var ArrowFunctionExpression = function (Node) {
    function ArrowFunctionExpression() {
      Node.apply(this, arguments);
    }

    if (Node) ArrowFunctionExpression.__proto__ = Node;
    ArrowFunctionExpression.prototype = Object.create(Node && Node.prototype);
    ArrowFunctionExpression.prototype.constructor = ArrowFunctionExpression;

    ArrowFunctionExpression.prototype.initialise = function initialise(transforms) {
      this.body.createScope();
      Node.prototype.initialise.call(this, transforms);
    };

    ArrowFunctionExpression.prototype.transpile = function transpile(code, transforms) {
      if (transforms.arrow) {
        // remove arrow
        var charIndex = this.body.start;
        while (code.original[charIndex] !== '=') {
          charIndex -= 1;
        }
        code.remove(charIndex, this.body.start);

        // wrap naked parameter
        if (this.params.length === 1 && this.start === this.params[0].start) {
          code.insertRight(this.params[0].start, '(');
          code.insertLeft(this.params[0].end, ')');
        }

        // add function
        if (this.parent && this.parent.type === 'ExpressionStatement') {
          // standalone expression statement
          code.insertRight(this.start, '(function');
          code.insertRight(this.end, ')');
        } else {
          code.insertRight(this.start, 'function ');
        }
      }

      Node.prototype.transpile.call(this, code, transforms);
    };

    return ArrowFunctionExpression;
  }(Node);

  function locate(source, index) {
    var lines = source.split('\n');
    var len = lines.length;

    var lineStart = 0;
    var i;

    for (i = 0; i < len; i += 1) {
      var line = lines[i];
      var lineEnd = lineStart + line.length + 1; // +1 for newline

      if (lineEnd > index) {
        return { line: i + 1, column: index - lineStart, char: i };
      }

      lineStart = lineEnd;
    }

    throw new Error('Could not determine location of character');
  }

  function pad(num, len) {
    var result = String(num);
    return result + repeat(' ', len - result.length);
  }

  function repeat(str, times) {
    var result = '';
    while (times--) {
      result += str;
    }return result;
  }

  function getSnippet(source, loc, length) {
    if (length === void 0) length = 1;

    var first = Math.max(loc.line - 5, 0);
    var last = loc.line;

    var numDigits = String(last).length;

    var lines = source.split('\n').slice(first, last);

    var lastLine = lines[lines.length - 1];
    var offset = lastLine.slice(0, loc.column).replace(/\t/g, '  ').length;

    var snippet = lines.map(function (line, i) {
      return pad(i + first + 1, numDigits) + " : " + line.replace(/\t/g, '  ');
    }).join('\n');

    snippet += '\n' + repeat(' ', numDigits + 3 + offset) + repeat('^', length);

    return snippet;
  }

  var CompileError = function (Error) {
    function CompileError(node, message) {
      Error.call(this);

      var source = node.program.magicString.original;
      var loc = locate(source, node.start);

      this.name = 'CompileError';
      this.message = message + " (" + loc.line + ":" + loc.column + ")";

      this.stack = new Error().stack.replace(new RegExp(".+new " + this.name + ".+\\n", 'm'), '');

      this.loc = loc;
      this.snippet = getSnippet(source, loc, node.end - node.start);
    }

    if (Error) CompileError.__proto__ = Error;
    CompileError.prototype = Object.create(Error && Error.prototype);
    CompileError.prototype.constructor = CompileError;

    CompileError.prototype.toString = function toString() {
      return this.name + ": " + this.message + "\n" + this.snippet;
    };

    return CompileError;
  }(Error);

  var AssignmentExpression = function (Node) {
    function AssignmentExpression() {
      Node.apply(this, arguments);
    }

    if (Node) AssignmentExpression.__proto__ = Node;
    AssignmentExpression.prototype = Object.create(Node && Node.prototype);
    AssignmentExpression.prototype.constructor = AssignmentExpression;

    AssignmentExpression.prototype.initialise = function initialise(transforms) {
      if (this.left.type === 'Identifier') {
        var declaration = this.findScope(false).findDeclaration(this.left.name);
        if (declaration && declaration.kind === 'const') {
          throw new CompileError(this.left, this.left.name + " is read-only");
        }

        // special case – https://gitlab.com/Rich-Harris/buble/issues/11
        var statement = declaration && declaration.node.ancestor(3);
        if (statement && statement.type === 'ForStatement' && statement.body.contains(this)) {
          statement.reassigned[this.left.name] = true;
        }
      }

      Node.prototype.initialise.call(this, transforms);
    };

    AssignmentExpression.prototype.transpile = function transpile(code, transforms) {
      if (this.operator === '**=' && transforms.exponentiation) {
        this.transpileExponentiation(code, transforms);
      } else if (/Pattern/.test(this.left.type) && transforms.destructuring) {
        this.transpileDestructuring(code, transforms);
      }

      Node.prototype.transpile.call(this, code, transforms);
    };

    AssignmentExpression.prototype.transpileDestructuring = function transpileDestructuring(code) {
      var scope = this.findScope(true);
      var assign = scope.createIdentifier('assign');
      var temporaries = [assign];

      var start = this.start;

      // We need to pick out some elements from the original code,
      // interleaved with generated code. These helpers are used to
      // easily do that while keeping the order of the output
      // predictable.
      var text = '';
      function use(node) {
        code.insertRight(node.start, text);
        code.move(node.start, node.end, start);
        text = '';
      }
      function write(string) {
        text += string;
      }

      write("(" + assign + " = ");
      use(this.right);

      // Walk `pattern`, generating code that assigns the value in
      // `ref` to it. When `mayDuplicate` is false, the function
      // must take care to only output `ref` once.
      function destructure(pattern, ref, mayDuplicate) {
        if (pattern.type === 'Identifier' || pattern.type === 'MemberExpression') {
          write(', ');
          use(pattern);
          write(" = " + ref);
        } else if (pattern.type === 'AssignmentPattern') {
          if (pattern.left.type === 'Identifier') {
            var target = pattern.left.name;
            var source = ref;
            if (!mayDuplicate) {
              write(", " + target + " = " + ref);
              source = target;
            }
            write(", " + target + " = " + source + " === void 0 ? ");
            use(pattern.right);
            write(" : " + source);
          } else {
            var target$1 = scope.createIdentifier('temp');
            var source$1 = ref;
            temporaries.push(target$1);
            if (!mayDuplicate) {
              write(", " + target$1 + " = " + ref);
              source$1 = target$1;
            }
            write(", " + target$1 + " = " + source$1 + " === void 0 ? ");
            use(pattern.right);
            write(" : " + source$1);
            destructure(pattern.left, target$1, true);
          }
        } else if (pattern.type === 'ArrayPattern') {
          var elements = pattern.elements;
          if (elements.length === 1) {
            destructure(elements[0], ref + "[0]", false);
          } else {
            if (!mayDuplicate) {
              var temp = scope.createIdentifier('array');
              temporaries.push(temp);
              write(", " + temp + " = " + ref);
              ref = temp;
            }
            elements.forEach(function (element, i) {
              if (element) {
                if (element.type === 'RestElement') {
                  destructure(element.argument, ref + ".slice(" + i + ")", false);
                } else {
                  destructure(element, ref + "[" + i + "]", false);
                }
              }
            });
          }
        } else if (pattern.type === 'ObjectPattern') {
          var props = pattern.properties;
          if (props.length == 1) {
            var prop = props[0];
            var value = prop.computed || prop.key.type !== 'Identifier' ? ref + "[" + code.slice(prop.key.start, prop.key.end) + "]" : ref + "." + prop.key.name;
            destructure(prop.value, value, false);
          } else {
            if (!mayDuplicate) {
              var temp$1 = scope.createIdentifier('obj');
              temporaries.push(temp$1);
              write(", " + temp$1 + " = " + ref);
              ref = temp$1;
            }
            props.forEach(function (prop) {
              var value = prop.computed || prop.key.type !== 'Identifier' ? ref + "[" + code.slice(prop.key.start, prop.key.end) + "]" : ref + "." + prop.key.name;
              destructure(prop.value, value, false);
            });
          }
        } else {
          throw new Error("Unexpected node type in destructuring assignment (" + pattern.type + ")");
        }
      }
      destructure(this.left, assign, true);

      if (this.unparenthesizedParent().type === 'ExpressionStatement') {
        // no rvalue needed for expression statement
        code.insertRight(start, text + ")");
      } else {
        // destructuring is part of an expression - need an rvalue
        code.insertRight(start, text + ", " + assign + ")");
      }

      code.remove(start, this.right.start);

      var statement = this.findNearest(/(?:Statement|Declaration)$/);
      code.insertLeft(statement.start, "var " + temporaries.join(', ') + ";\n" + statement.getIndentation());
    };

    AssignmentExpression.prototype.transpileExponentiation = function transpileExponentiation(code) {
      var scope = this.findScope(false);
      var getAlias = function getAlias(name) {
        var declaration = scope.findDeclaration(name);
        return declaration ? declaration.name : name;
      };

      // first, the easy part – `**=` -> `=`
      var charIndex = this.left.end;
      while (code.original[charIndex] !== '*') {
        charIndex += 1;
      }code.remove(charIndex, charIndex + 2);

      // how we do the next part depends on a number of factors – whether
      // this is a top-level statement, and whether we're updating a
      // simple or complex reference
      var base;

      var left = this.left.unparenthesize();

      if (left.type === 'Identifier') {
        base = getAlias(left.name);
      } else if (left.type === 'MemberExpression') {
        var object;
        var needsObjectVar = false;
        var property;
        var needsPropertyVar = false;

        var statement = this.findNearest(/(?:Statement|Declaration)$/);
        var i0 = statement.getIndentation();

        if (left.property.type === 'Identifier') {
          property = left.computed ? getAlias(left.property.name) : left.property.name;
        } else {
          property = scope.createIdentifier('property');
          needsPropertyVar = true;
        }

        if (left.object.type === 'Identifier') {
          object = getAlias(left.object.name);
        } else {
          object = scope.createIdentifier('object');
          needsObjectVar = true;
        }

        if (left.start === statement.start) {
          if (needsObjectVar && needsPropertyVar) {
            code.insertRight(statement.start, "var " + object + " = ");
            code.overwrite(left.object.end, left.property.start, ";\n" + i0 + "var " + property + " = ");
            code.overwrite(left.property.end, left.end, ";\n" + i0 + object + "[" + property + "]");
          } else if (needsObjectVar) {
            code.insertRight(statement.start, "var " + object + " = ");
            code.insertLeft(left.object.end, ";\n" + i0);
            code.insertLeft(left.object.end, object);
          } else if (needsPropertyVar) {
            code.insertRight(left.property.start, "var " + property + " = ");
            code.insertLeft(left.property.end, ";\n" + i0);
            code.move(left.property.start, left.property.end, this.start);

            code.insertLeft(left.object.end, "[" + property + "]");
            code.remove(left.object.end, left.property.start);
            code.remove(left.property.end, left.end);
          }
        } else {
          var declarators = [];
          if (needsObjectVar) declarators.push(object);
          if (needsPropertyVar) declarators.push(property);

          if (declarators.length) {
            code.insertRight(statement.start, "var " + declarators.join(', ') + ";\n" + i0);
          }

          if (needsObjectVar && needsPropertyVar) {
            code.insertRight(left.start, "( " + object + " = ");
            code.overwrite(left.object.end, left.property.start, ", " + property + " = ");
            code.overwrite(left.property.end, left.end, ", " + object + "[" + property + "]");
          } else if (needsObjectVar) {
            code.insertRight(left.start, "( " + object + " = ");
            code.insertLeft(left.object.end, ", " + object);
          } else if (needsPropertyVar) {
            code.insertRight(left.property.start, "( " + property + " = ");
            code.insertLeft(left.property.end, ", ");
            code.move(left.property.start, left.property.end, left.start);

            code.overwrite(left.object.end, left.property.start, "[" + property + "]");
            code.remove(left.property.end, left.end);
          }

          if (needsPropertyVar) {
            code.insertLeft(this.end, " )");
          }
        }

        base = object + (left.computed || needsPropertyVar ? "[" + property + "]" : "." + property);
      }

      code.insertRight(this.right.start, "Math.pow( " + base + ", ");
      code.insertLeft(this.right.end, " )");
    };

    return AssignmentExpression;
  }(Node);

  var BinaryExpression = function (Node) {
    function BinaryExpression() {
      Node.apply(this, arguments);
    }

    if (Node) BinaryExpression.__proto__ = Node;
    BinaryExpression.prototype = Object.create(Node && Node.prototype);
    BinaryExpression.prototype.constructor = BinaryExpression;

    BinaryExpression.prototype.transpile = function transpile(code, transforms) {
      if (this.operator === '**' && transforms.exponentiation) {
        code.insertRight(this.start, "Math.pow( ");
        code.overwrite(this.left.end, this.right.start, ", ");
        code.insertLeft(this.end, " )");
      }
      Node.prototype.transpile.call(this, code, transforms);
    };

    return BinaryExpression;
  }(Node);

  var loopStatement = /(?:For(?:In|Of)?|While)Statement/;

  var BreakStatement = function (Node) {
    function BreakStatement() {
      Node.apply(this, arguments);
    }

    if (Node) BreakStatement.__proto__ = Node;
    BreakStatement.prototype = Object.create(Node && Node.prototype);
    BreakStatement.prototype.constructor = BreakStatement;

    BreakStatement.prototype.initialise = function initialise() {
      var loop = this.findNearest(loopStatement);
      var switchCase = this.findNearest('SwitchCase');

      if (loop && (!switchCase || loop.depth > switchCase.depth)) {
        loop.canBreak = true;
        this.loop = loop;
      }
    };

    BreakStatement.prototype.transpile = function transpile(code) {
      if (this.loop && this.loop.shouldRewriteAsFunction) {
        if (this.label) throw new CompileError(this, 'Labels are not currently supported in a loop with locally-scoped variables');
        code.overwrite(this.start, this.start + 5, "return 'break'");
      }
    };

    return BreakStatement;
  }(Node);

  var CallExpression = function (Node) {
    function CallExpression() {
      Node.apply(this, arguments);
    }

    if (Node) CallExpression.__proto__ = Node;
    CallExpression.prototype = Object.create(Node && Node.prototype);
    CallExpression.prototype.constructor = CallExpression;

    CallExpression.prototype.initialise = function initialise(transforms) {
      var this$1 = this;

      if (transforms.spreadRest && this.arguments.length > 1) {
        var lexicalBoundary = this.findLexicalBoundary();

        var i = this.arguments.length;
        while (i--) {
          var arg = this$1.arguments[i];
          if (arg.type === 'SpreadElement' && isArguments(arg.argument)) {
            this$1.argumentsArrayAlias = lexicalBoundary.getArgumentsArrayAlias();
          }
        }
      }

      Node.prototype.initialise.call(this, transforms);
    };

    CallExpression.prototype.transpile = function transpile(code, transforms) {
      if (transforms.spreadRest && this.arguments.length) {
        var hasSpreadElements = false;
        var context;

        var firstArgument = this.arguments[0];

        if (this.arguments.length === 1) {
          if (firstArgument.type === 'SpreadElement') {
            code.remove(firstArgument.start, firstArgument.argument.start);
            hasSpreadElements = true;
          }
        } else {
          hasSpreadElements = spread(code, this.arguments, firstArgument.start, this.argumentsArrayAlias);
        }

        if (hasSpreadElements) {

          // we need to handle super() and super.method() differently
          // due to its instance
          var _super = null;
          if (this.callee.type === 'Super') {
            _super = this.callee;
          } else if (this.callee.type === 'MemberExpression' && this.callee.object.type === 'Super') {
            _super = this.callee.object;
          }

          if (!_super && this.callee.type === 'MemberExpression') {
            if (this.callee.object.type === 'Identifier') {
              context = this.callee.object.name;
            } else {
              context = this.findScope(true).createIdentifier('ref');
              var callExpression = this.callee.object;
              var enclosure = callExpression.findNearest(/Function/);
              var block = enclosure ? enclosure.body.body : callExpression.findNearest(/^Program$/).body;
              var lastStatementInBlock = block[block.length - 1];
              var i0 = lastStatementInBlock.getIndentation();
              code.insertRight(callExpression.start, "(" + context + " = ");
              code.insertLeft(callExpression.end, ")");
              code.insertLeft(lastStatementInBlock.end, "\n" + i0 + "var " + context + ";");
            }
          } else {
            context = 'void 0';
          }

          code.insertLeft(this.callee.end, '.apply');

          if (_super) {
            _super.noCall = true; // bit hacky...

            if (this.arguments.length > 1) {
              if (firstArgument.type !== 'SpreadElement') {
                code.insertRight(firstArgument.start, "[ ");
              }

              code.insertLeft(this.arguments[this.arguments.length - 1].end, ' )');
            }
          } else if (this.arguments.length === 1) {
            code.insertRight(firstArgument.start, context + ", ");
          } else {
            if (firstArgument.type === 'SpreadElement') {
              code.insertLeft(firstArgument.start, context + ", ");
            } else {
              code.insertLeft(firstArgument.start, context + ", [ ");
            }

            code.insertLeft(this.arguments[this.arguments.length - 1].end, ' )');
          }
        }
      }

      Node.prototype.transpile.call(this, code, transforms);
    };

    return CallExpression;
  }(Node);

  function findIndex(array, fn) {
    for (var i = 0; i < array.length; i += 1) {
      if (fn(array[i], i)) return i;
    }

    return -1;
  }

  var reserved = Object.create(null);
  'do if in for let new try var case else enum eval null this true void with await break catch class const false super throw while yield delete export import public return static switch typeof default extends finally package private continue debugger function arguments interface protected implements instanceof'.split(' ').forEach(function (word) {
    return reserved[word] = true;
  });

  // TODO this code is pretty wild, tidy it up
  var ClassBody = function (Node) {
    function ClassBody() {
      Node.apply(this, arguments);
    }

    if (Node) ClassBody.__proto__ = Node;
    ClassBody.prototype = Object.create(Node && Node.prototype);
    ClassBody.prototype.constructor = ClassBody;

    ClassBody.prototype.transpile = function transpile(code, transforms, inFunctionExpression, superName) {
      var this$1 = this;

      if (transforms.classes) {
        var name = this.parent.name;

        var indentStr = code.getIndentString();
        var i0 = this.getIndentation() + (inFunctionExpression ? indentStr : '');
        var i1 = i0 + indentStr;

        var constructorIndex = findIndex(this.body, function (node) {
          return node.kind === 'constructor';
        });
        var constructor = this.body[constructorIndex];

        var introBlock = '';
        var outroBlock = '';

        if (this.body.length) {
          code.remove(this.start, this.body[0].start);
          code.remove(this.body[this.body.length - 1].end, this.end);
        } else {
          code.remove(this.start, this.end);
        }

        if (constructor) {
          constructor.value.body.isConstructorBody = true;

          var previousMethod = this.body[constructorIndex - 1];
          var nextMethod = this.body[constructorIndex + 1];

          // ensure constructor is first
          if (constructorIndex > 0) {
            code.remove(previousMethod.end, constructor.start);
            code.move(constructor.start, nextMethod ? nextMethod.start : this.end - 1, this.body[0].start);
          }

          if (!inFunctionExpression) code.insertLeft(constructor.end, ';');
        }

        var namedFunctions = this.program.options.namedFunctionExpressions !== false;
        var namedConstructor = namedFunctions || this.parent.superClass || this.parent.type !== 'ClassDeclaration';
        if (this.parent.superClass) {
          var inheritanceBlock = "if ( " + superName + " ) " + name + ".__proto__ = " + superName + ";\n" + i0 + name + ".prototype = Object.create( " + superName + " && " + superName + ".prototype );\n" + i0 + name + ".prototype.constructor = " + name + ";";

          if (constructor) {
            introBlock += "\n\n" + i0 + inheritanceBlock;
          } else {
            var fn = "function " + name + " () {" + (superName ? "\n" + i1 + superName + ".apply(this, arguments);\n" + i0 + "}" : "}") + (inFunctionExpression ? '' : ';') + (this.body.length ? "\n\n" + i0 : '');

            inheritanceBlock = fn + inheritanceBlock;
            introBlock += inheritanceBlock + "\n\n" + i0;
          }
        } else if (!constructor) {
          var fn$1 = 'function ' + (namedConstructor ? name + ' ' : '') + '() {}';
          if (this.parent.type === 'ClassDeclaration') fn$1 += ';';
          if (this.body.length) fn$1 += "\n\n" + i0;

          introBlock += fn$1;
        }

        var scope = this.findScope(false);

        var prototypeGettersAndSetters = [];
        var staticGettersAndSetters = [];
        var prototypeAccessors;
        var staticAccessors;

        this.body.forEach(function (method, i) {
          if (method.kind === 'constructor') {
            var constructorName = namedConstructor ? ' ' + name : '';
            code.overwrite(method.key.start, method.key.end, "function" + constructorName);
            return;
          }

          if (method.static) {
            var len = code.original[method.start + 6] == ' ' ? 7 : 6;
            code.remove(method.start, method.start + len);
          }

          var isAccessor = method.kind !== 'method';
          var lhs;

          var methodName = method.key.name;
          if (reserved[methodName] || method.value.body.scope.references[methodName]) {
            methodName = scope.createIdentifier(methodName);
          }

          // when method name is a string or a number let's pretend it's a computed method

          var fake_computed = false;
          if (!method.computed && method.key.type === 'Literal') {
            fake_computed = true;
            method.computed = true;
          }

          if (isAccessor) {
            if (method.computed) {
              throw new Error('Computed accessor properties are not currently supported');
            }

            code.remove(method.start, method.key.start);

            if (method.static) {
              if (!~staticGettersAndSetters.indexOf(method.key.name)) staticGettersAndSetters.push(method.key.name);
              if (!staticAccessors) staticAccessors = scope.createIdentifier('staticAccessors');

              lhs = "" + staticAccessors;
            } else {
              if (!~prototypeGettersAndSetters.indexOf(method.key.name)) prototypeGettersAndSetters.push(method.key.name);
              if (!prototypeAccessors) prototypeAccessors = scope.createIdentifier('prototypeAccessors');

              lhs = "" + prototypeAccessors;
            }
          } else {
            lhs = method.static ? "" + name : name + ".prototype";
          }

          if (!method.computed) lhs += '.';

          var insertNewlines = constructorIndex > 0 && i === constructorIndex + 1 || i === 0 && constructorIndex === this$1.body.length - 1;

          if (insertNewlines) lhs = "\n\n" + i0 + lhs;

          var c = method.key.end;
          if (method.computed) {
            if (fake_computed) {
              code.insertRight(method.key.start, '[');
              code.insertLeft(method.key.end, ']');
            } else {
              while (code.original[c] !== ']') {
                c += 1;
              }c += 1;
            }
          }

          code.insertRight(method.start, lhs);

          var funcName = method.computed || isAccessor || !namedFunctions ? '' : methodName + " ";
          var rhs = (isAccessor ? "." + method.kind : '') + " = function" + (method.value.generator ? '* ' : ' ') + funcName;
          code.remove(c, method.value.start);
          code.insertRight(method.value.start, rhs);
          code.insertLeft(method.end, ';');

          if (method.value.generator) code.remove(method.start, method.key.start);
        });

        if (prototypeGettersAndSetters.length || staticGettersAndSetters.length) {
          var intro = [];
          var outro = [];

          if (prototypeGettersAndSetters.length) {
            intro.push("var " + prototypeAccessors + " = { " + prototypeGettersAndSetters.map(function (name) {
              return name + ": {}";
            }).join(',') + " };");
            outro.push("Object.defineProperties( " + name + ".prototype, " + prototypeAccessors + " );");
          }

          if (staticGettersAndSetters.length) {
            intro.push("var " + staticAccessors + " = { " + staticGettersAndSetters.map(function (name) {
              return name + ": {}";
            }).join(',') + " };");
            outro.push("Object.defineProperties( " + name + ", " + staticAccessors + " );");
          }

          if (constructor) introBlock += "\n\n" + i0;
          introBlock += intro.join("\n" + i0);
          if (!constructor) introBlock += "\n\n" + i0;

          outroBlock += "\n\n" + i0 + outro.join("\n" + i0);
        }

        if (constructor) {
          code.insertLeft(constructor.end, introBlock);
        } else {
          code.insertRight(this.start, introBlock);
        }

        code.insertLeft(this.end, outroBlock);
      }

      Node.prototype.transpile.call(this, code, transforms);
    };

    return ClassBody;
  }(Node);

  // TODO this function is slightly flawed – it works on the original string,
  // not its current edited state.
  // That's not a problem for the way that it's currently used, but it could
  // be in future...
  function deindent(node, code) {
    var start = node.start;
    var end = node.end;

    var indentStr = code.getIndentString();
    var indentStrLen = indentStr.length;
    var indentStart = start - indentStrLen;

    if (!node.program.indentExclusions[indentStart] && code.original.slice(indentStart, start) === indentStr) {
      code.remove(indentStart, start);
    }

    var pattern = new RegExp(indentStr + '\\S', 'g');
    var slice = code.original.slice(start, end);
    var match;

    while (match = pattern.exec(slice)) {
      var removeStart = start + match.index;
      if (!node.program.indentExclusions[removeStart]) {
        code.remove(removeStart, removeStart + indentStrLen);
      }
    }
  }

  var ClassDeclaration = function (Node) {
    function ClassDeclaration() {
      Node.apply(this, arguments);
    }

    if (Node) ClassDeclaration.__proto__ = Node;
    ClassDeclaration.prototype = Object.create(Node && Node.prototype);
    ClassDeclaration.prototype.constructor = ClassDeclaration;

    ClassDeclaration.prototype.initialise = function initialise(transforms) {
      this.name = this.id.name;
      this.findScope(true).addDeclaration(this.id, 'class');

      Node.prototype.initialise.call(this, transforms);
    };

    ClassDeclaration.prototype.transpile = function transpile(code, transforms) {
      if (transforms.classes) {
        if (!this.superClass) deindent(this.body, code);

        var superName = this.superClass && (this.superClass.name || 'superclass');

        var i0 = this.getIndentation();
        var i1 = i0 + code.getIndentString();

        // if this is an export default statement, we have to move the export to
        // after the declaration, because `export default var Foo = ...` is illegal
        var syntheticDefaultExport = this.parent.type === 'ExportDefaultDeclaration' ? "\n\n" + i0 + "export default " + this.id.name + ";" : '';

        if (syntheticDefaultExport) code.remove(this.parent.start, this.start);

        code.overwrite(this.start, this.id.start, 'var ');

        if (this.superClass) {
          if (this.superClass.end === this.body.start) {
            code.remove(this.id.end, this.superClass.start);
            code.insertLeft(this.id.end, " = (function (" + superName + ") {\n" + i1);
          } else {
            code.overwrite(this.id.end, this.superClass.start, ' = ');
            code.overwrite(this.superClass.end, this.body.start, "(function (" + superName + ") {\n" + i1);
          }
        } else {
          if (this.id.end === this.body.start) {
            code.insertLeft(this.id.end, ' = ');
          } else {
            code.overwrite(this.id.end, this.body.start, ' = ');
          }
        }

        this.body.transpile(code, transforms, !!this.superClass, superName);

        if (this.superClass) {
          code.insertLeft(this.end, "\n\n" + i1 + "return " + this.name + ";\n" + i0 + "}(");
          code.move(this.superClass.start, this.superClass.end, this.end);
          code.insertRight(this.end, "));" + syntheticDefaultExport);
        } else if (syntheticDefaultExport) {
          code.insertRight(this.end, syntheticDefaultExport);
        }
      } else {
        this.body.transpile(code, transforms, false, null);
      }
    };

    return ClassDeclaration;
  }(Node);

  var ClassExpression = function (Node) {
    function ClassExpression() {
      Node.apply(this, arguments);
    }

    if (Node) ClassExpression.__proto__ = Node;
    ClassExpression.prototype = Object.create(Node && Node.prototype);
    ClassExpression.prototype.constructor = ClassExpression;

    ClassExpression.prototype.initialise = function initialise(transforms) {
      this.name = this.id ? this.id.name : this.parent.type === 'VariableDeclarator' ? this.parent.id.name : this.parent.type === 'AssignmentExpression' ? this.parent.left.name : this.findScope(true).createIdentifier('anonymous');

      Node.prototype.initialise.call(this, transforms);
    };

    ClassExpression.prototype.transpile = function transpile(code, transforms) {
      if (transforms.classes) {
        var superName = this.superClass && (this.superClass.name || 'superclass');

        var i0 = this.getIndentation();
        var i1 = i0 + code.getIndentString();

        if (this.superClass) {
          code.remove(this.start, this.superClass.start);
          code.remove(this.superClass.end, this.body.start);
          code.insertLeft(this.start, "(function (" + superName + ") {\n" + i1);
        } else {
          code.overwrite(this.start, this.body.start, "(function () {\n" + i1);
        }

        this.body.transpile(code, transforms, true, superName);

        var outro = "\n\n" + i1 + "return " + this.name + ";\n" + i0 + "}(";

        if (this.superClass) {
          code.insertLeft(this.end, outro);
          code.move(this.superClass.start, this.superClass.end, this.end);
          code.insertRight(this.end, '))');
        } else {
          code.insertLeft(this.end, "\n\n" + i1 + "return " + this.name + ";\n" + i0 + "}())");
        }
      } else {
        this.body.transpile(code, transforms, false);
      }
    };

    return ClassExpression;
  }(Node);

  var ContinueStatement = function (Node) {
    function ContinueStatement() {
      Node.apply(this, arguments);
    }

    if (Node) ContinueStatement.__proto__ = Node;
    ContinueStatement.prototype = Object.create(Node && Node.prototype);
    ContinueStatement.prototype.constructor = ContinueStatement;

    ContinueStatement.prototype.transpile = function transpile(code) {
      var loop = this.findNearest(loopStatement);
      if (loop.shouldRewriteAsFunction) {
        if (this.label) throw new CompileError(this, 'Labels are not currently supported in a loop with locally-scoped variables');
        code.overwrite(this.start, this.start + 8, 'return');
      }
    };

    return ContinueStatement;
  }(Node);

  var ExportDefaultDeclaration = function (Node) {
    function ExportDefaultDeclaration() {
      Node.apply(this, arguments);
    }

    if (Node) ExportDefaultDeclaration.__proto__ = Node;
    ExportDefaultDeclaration.prototype = Object.create(Node && Node.prototype);
    ExportDefaultDeclaration.prototype.constructor = ExportDefaultDeclaration;

    ExportDefaultDeclaration.prototype.initialise = function initialise(transforms) {
      if (transforms.moduleExport) throw new CompileError(this, 'export is not supported');
      Node.prototype.initialise.call(this, transforms);
    };

    return ExportDefaultDeclaration;
  }(Node);

  var ExportNamedDeclaration = function (Node) {
    function ExportNamedDeclaration() {
      Node.apply(this, arguments);
    }

    if (Node) ExportNamedDeclaration.__proto__ = Node;
    ExportNamedDeclaration.prototype = Object.create(Node && Node.prototype);
    ExportNamedDeclaration.prototype.constructor = ExportNamedDeclaration;

    ExportNamedDeclaration.prototype.initialise = function initialise(transforms) {
      if (transforms.moduleExport) throw new CompileError(this, 'export is not supported');
      Node.prototype.initialise.call(this, transforms);
    };

    return ExportNamedDeclaration;
  }(Node);

  var LoopStatement = function (Node) {
    function LoopStatement() {
      Node.apply(this, arguments);
    }

    if (Node) LoopStatement.__proto__ = Node;
    LoopStatement.prototype = Object.create(Node && Node.prototype);
    LoopStatement.prototype.constructor = LoopStatement;

    LoopStatement.prototype.findScope = function findScope(functionScope) {
      return functionScope || !this.createdScope ? this.parent.findScope(functionScope) : this.body.scope;
    };

    LoopStatement.prototype.initialise = function initialise(transforms) {
      var this$1 = this;

      this.body.createScope();
      this.createdScope = true;

      // this is populated as and when reassignments occur
      this.reassigned = Object.create(null);
      this.aliases = Object.create(null);

      Node.prototype.initialise.call(this, transforms);

      if (transforms.letConst) {
        // see if any block-scoped declarations are referenced
        // inside function expressions
        var names = Object.keys(this.body.scope.declarations);

        var i = names.length;
        while (i--) {
          var name = names[i];
          var declaration = this$1.body.scope.declarations[name];

          var j = declaration.instances.length;
          while (j--) {
            var instance = declaration.instances[j];
            var nearestFunctionExpression = instance.findNearest(/Function/);

            if (nearestFunctionExpression && nearestFunctionExpression.depth > this$1.depth) {
              this$1.shouldRewriteAsFunction = true;
              break;
            }
          }

          if (this$1.shouldRewriteAsFunction) break;
        }
      }
    };

    LoopStatement.prototype.transpile = function transpile(code, transforms) {
      var needsBlock = this.type != 'ForOfStatement' && (this.body.type !== 'BlockStatement' || this.body.type === 'BlockStatement' && this.body.synthetic);

      if (this.shouldRewriteAsFunction) {
        var i0 = this.getIndentation();
        var i1 = i0 + code.getIndentString();

        var argString = this.args ? " " + this.args.join(', ') + " " : '';
        var paramString = this.params ? " " + this.params.join(', ') + " " : '';

        var functionScope = this.findScope(true);
        var loop = functionScope.createIdentifier('loop');

        var before = "var " + loop + " = function (" + paramString + ") " + (this.body.synthetic ? "{\n" + i0 + code.getIndentString() : '');
        var after = (this.body.synthetic ? "\n" + i0 + "}" : '') + ";\n\n" + i0;

        code.insertRight(this.body.start, before);
        code.insertLeft(this.body.end, after);
        code.move(this.start, this.body.start, this.body.end);

        if (this.canBreak || this.canReturn) {
          var returned = functionScope.createIdentifier('returned');

          var insert = "{\n" + i1 + "var " + returned + " = " + loop + "(" + argString + ");\n";
          if (this.canBreak) insert += "\n" + i1 + "if ( " + returned + " === 'break' ) break;";
          if (this.canReturn) insert += "\n" + i1 + "if ( " + returned + " ) return " + returned + ".v;";
          insert += "\n" + i0 + "}";

          code.insertRight(this.body.end, insert);
        } else {
          var callExpression = loop + "(" + argString + ");";

          if (this.type === 'DoWhileStatement') {
            code.overwrite(this.start, this.body.start, "do {\n" + i1 + callExpression + "\n" + i0 + "}");
          } else {
            code.insertRight(this.body.end, callExpression);
          }
        }
      } else if (needsBlock) {
        code.insertLeft(this.body.start, '{ ');
        code.insertRight(this.body.end, ' }');
      }

      Node.prototype.transpile.call(this, code, transforms);
    };

    return LoopStatement;
  }(Node);

  function extractNames(node) {
    var names = [];
    extractors[node.type](names, node);
    return names;
  }

  var extractors = {
    Identifier: function Identifier(names, node) {
      names.push(node);
    },

    ObjectPattern: function ObjectPattern(names, node) {
      for (var i = 0, list = node.properties; i < list.length; i += 1) {
        var prop = list[i];

        extractors[prop.value.type](names, prop.value);
      }
    },

    ArrayPattern: function ArrayPattern(names, node) {
      for (var i = 0, list = node.elements; i < list.length; i += 1) {
        var element = list[i];

        if (element) extractors[element.type](names, element);
      }
    },

    RestElement: function RestElement(names, node) {
      extractors[node.argument.type](names, node.argument);
    },

    AssignmentPattern: function AssignmentPattern(names, node) {
      extractors[node.left.type](names, node.left);
    }
  };

  var ForStatement = function (LoopStatement) {
    function ForStatement() {
      LoopStatement.apply(this, arguments);
    }

    if (LoopStatement) ForStatement.__proto__ = LoopStatement;
    ForStatement.prototype = Object.create(LoopStatement && LoopStatement.prototype);
    ForStatement.prototype.constructor = ForStatement;

    ForStatement.prototype.findScope = function findScope(functionScope) {
      return functionScope || !this.createdScope ? this.parent.findScope(functionScope) : this.body.scope;
    };

    ForStatement.prototype.transpile = function transpile(code, transforms) {
      var this$1 = this;

      var i1 = this.getIndentation() + code.getIndentString();

      if (this.shouldRewriteAsFunction) {
        // which variables are declared in the init statement?
        var names = this.init.type === 'VariableDeclaration' ? [].concat.apply([], this.init.declarations.map(function (declarator) {
          return extractNames(declarator.id);
        })) : [];

        var aliases = this.aliases;

        this.args = names.map(function (name) {
          return name in this$1.aliases ? this$1.aliases[name].outer : name;
        });
        this.params = names.map(function (name) {
          return name in this$1.aliases ? this$1.aliases[name].inner : name;
        });

        var updates = Object.keys(this.reassigned).map(function (name) {
          return aliases[name].outer + " = " + aliases[name].inner + ";";
        });

        if (updates.length) {
          if (this.body.synthetic) {
            code.insertLeft(this.body.body[0].end, "; " + updates.join(" "));
          } else {
            var lastStatement = this.body.body[this.body.body.length - 1];
            code.insertLeft(lastStatement.end, "\n\n" + i1 + updates.join("\n" + i1));
          }
        }
      }

      LoopStatement.prototype.transpile.call(this, code, transforms);
    };

    return ForStatement;
  }(LoopStatement);

  var ForInStatement = function (LoopStatement) {
    function ForInStatement() {
      LoopStatement.apply(this, arguments);
    }

    if (LoopStatement) ForInStatement.__proto__ = LoopStatement;
    ForInStatement.prototype = Object.create(LoopStatement && LoopStatement.prototype);
    ForInStatement.prototype.constructor = ForInStatement;

    ForInStatement.prototype.findScope = function findScope(functionScope) {
      return functionScope || !this.createdScope ? this.parent.findScope(functionScope) : this.body.scope;
    };

    ForInStatement.prototype.transpile = function transpile(code, transforms) {
      var this$1 = this;

      if (this.shouldRewriteAsFunction) {
        // which variables are declared in the init statement?
        var names = this.left.type === 'VariableDeclaration' ? [].concat.apply([], this.left.declarations.map(function (declarator) {
          return extractNames(declarator.id);
        })) : [];

        this.args = names.map(function (name) {
          return name in this$1.aliases ? this$1.aliases[name].outer : name;
        });
        this.params = names.map(function (name) {
          return name in this$1.aliases ? this$1.aliases[name].inner : name;
        });
      }

      LoopStatement.prototype.transpile.call(this, code, transforms);
    };

    return ForInStatement;
  }(LoopStatement);

  var handlers = {
    Identifier: destructureIdentifier,
    AssignmentPattern: destructureAssignmentPattern,
    ArrayPattern: destructureArrayPattern,
    ObjectPattern: destructureObjectPattern
  };

  function destructure(code, scope, node, ref, inline, statementGenerators) {
    handlers[node.type](code, scope, node, ref, inline, statementGenerators);
  }

  function destructureIdentifier(code, scope, node, ref, inline, statementGenerators) {
    statementGenerators.push(function (start, prefix, suffix) {
      code.insertRight(node.start, inline ? prefix : prefix + "var ");
      code.insertLeft(node.end, " = " + ref + suffix);
      code.move(node.start, node.end, start);
    });
  }

  function destructureAssignmentPattern(code, scope, node, ref, inline, statementGenerators) {
    var isIdentifier = node.left.type === 'Identifier';
    var name = isIdentifier ? node.left.name : ref;

    if (!inline) {
      statementGenerators.push(function (start, prefix, suffix) {
        code.insertRight(node.left.end, prefix + "if ( " + name + " === void 0 ) " + name);
        code.move(node.left.end, node.right.end, start);
        code.insertLeft(node.right.end, suffix);
      });
    }

    if (!isIdentifier) {
      destructure(code, scope, node.left, ref, inline, statementGenerators);
    }
  }

  function destructureArrayPattern(code, scope, node, ref, inline, statementGenerators) {
    var c = node.start;

    node.elements.forEach(function (element, i) {
      if (!element) return;

      if (element.type === 'RestElement') {
        handleProperty(code, scope, c, element.argument, ref + ".slice(" + i + ")", inline, statementGenerators);
      } else {
        handleProperty(code, scope, c, element, ref + "[" + i + "]", inline, statementGenerators);
      }
      c = element.end;
    });

    code.remove(c, node.end);
  }

  function destructureObjectPattern(code, scope, node, ref, inline, statementGenerators) {
    var c = node.start;

    node.properties.forEach(function (prop) {
      var value = prop.computed || prop.key.type !== 'Identifier' ? ref + "[" + code.slice(prop.key.start, prop.key.end) + "]" : ref + "." + prop.key.name;
      handleProperty(code, scope, c, prop.value, value, inline, statementGenerators);
      c = prop.end;
    });

    code.remove(c, node.end);
  }

  function handleProperty(code, scope, c, node, value, inline, statementGenerators) {
    switch (node.type) {
      case 'Identifier':
        {
          code.remove(c, node.start);
          destructureIdentifier(code, scope, node, value, inline, statementGenerators);
          break;
        }

      case 'AssignmentPattern':
        {
          var name;

          var isIdentifier = node.left.type === 'Identifier';

          if (isIdentifier) {
            name = node.left.name;
            var declaration = scope.findDeclaration(name);
            if (declaration) name = declaration.name;
          } else {
            name = scope.createIdentifier(value);
          }

          statementGenerators.push(function (start, prefix, suffix) {
            if (inline) {
              code.insertRight(node.right.start, name + " = " + value + " === undefined ? ");
              code.insertLeft(node.right.end, " : " + value);
            } else {
              code.insertRight(node.right.start, prefix + "var " + name + " = " + value + "; if ( " + name + " === void 0 ) " + name + " = ");
              code.insertLeft(node.right.end, suffix);
            }

            code.move(node.right.start, node.right.end, start);
          });

          if (isIdentifier) {
            code.remove(c, node.right.start);
          } else {
            code.remove(c, node.left.start);
            code.remove(node.left.end, node.right.start);
            handleProperty(code, scope, c, node.left, name, inline, statementGenerators);
          }

          break;
        }

      case 'ObjectPattern':
        {
          code.remove(c, c = node.start);

          if (node.properties.length > 1) {
            var ref = scope.createIdentifier(value);

            statementGenerators.push(function (start, prefix, suffix) {
              // this feels a tiny bit hacky, but we can't do a
              // straightforward insertLeft and keep correct order...
              code.insertRight(node.start, prefix + "var " + ref + " = ");
              code.overwrite(node.start, c = node.start + 1, value);
              code.insertLeft(c, suffix);

              code.move(node.start, c, start);
            });

            node.properties.forEach(function (prop) {
              var value = prop.computed || prop.key.type !== 'Identifier' ? ref + "[" + code.slice(prop.key.start, prop.key.end) + "]" : ref + "." + prop.key.name;
              handleProperty(code, scope, c, prop.value, value, inline, statementGenerators);
              c = prop.end;
            });
          } else {
            var prop = node.properties[0];
            var value_suffix = prop.computed || prop.key.type !== 'Identifier' ? "[" + code.slice(prop.key.start, prop.key.end) + "]" : "." + prop.key.name;
            handleProperty(code, scope, c, prop.value, "" + value + value_suffix, inline, statementGenerators);
            c = prop.end;
          }

          code.remove(c, node.end);
          break;
        }

      case 'ArrayPattern':
        {
          code.remove(c, c = node.start);

          if (node.elements.filter(Boolean).length > 1) {
            var ref$1 = scope.createIdentifier(value);

            statementGenerators.push(function (start, prefix, suffix) {
              code.insertRight(node.start, prefix + "var " + ref$1 + " = ");
              code.overwrite(node.start, c = node.start + 1, value);
              code.insertLeft(c, suffix);

              code.move(node.start, c, start);
            });

            node.elements.forEach(function (element, i) {
              if (!element) return;

              if (element.type === 'RestElement') {
                handleProperty(code, scope, c, element.argument, ref$1 + ".slice(" + i + ")", inline, statementGenerators);
              } else {
                handleProperty(code, scope, c, element, ref$1 + "[" + i + "]", inline, statementGenerators);
              }
              c = element.end;
            });
          } else {
            var index = findIndex(node.elements, Boolean);
            var element = node.elements[index];
            if (element.type === 'RestElement') {
              handleProperty(code, scope, c, element.argument, value + ".slice(" + index + ")", inline, statementGenerators);
            } else {
              handleProperty(code, scope, c, element, value + "[" + index + "]", inline, statementGenerators);
            }
            c = element.end;
          }

          code.remove(c, node.end);
          break;
        }

      default:
        {
          throw new Error("Unexpected node type in destructuring (" + node.type + ")");
        }
    }
  }

  var ForOfStatement = function (LoopStatement) {
    function ForOfStatement() {
      LoopStatement.apply(this, arguments);
    }

    if (LoopStatement) ForOfStatement.__proto__ = LoopStatement;
    ForOfStatement.prototype = Object.create(LoopStatement && LoopStatement.prototype);
    ForOfStatement.prototype.constructor = ForOfStatement;

    ForOfStatement.prototype.initialise = function initialise(transforms) {
      if (transforms.forOf && !transforms.dangerousForOf) throw new CompileError(this, 'for...of statements are not supported. Use `transforms: { forOf: false }` to skip transformation and disable this error, or `transforms: { dangerousForOf: true }` if you know what you\'re doing');
      LoopStatement.prototype.initialise.call(this, transforms);
    };

    ForOfStatement.prototype.transpile = function transpile(code, transforms) {
      if (!transforms.dangerousForOf) {
        LoopStatement.prototype.transpile.call(this, code, transforms);
        return;
      }

      // edge case (#80)
      if (!this.body.body[0]) {
        if (this.left.type === 'VariableDeclaration' && this.left.kind === 'var') {
          code.remove(this.start, this.left.start);
          code.insertLeft(this.left.end, ';');
          code.remove(this.left.end, this.end);
        } else {
          code.remove(this.start, this.end);
        }

        return;
      }

      var scope = this.findScope(true);
      var i0 = this.getIndentation();
      var i1 = i0 + code.getIndentString();

      var key = scope.createIdentifier('i');
      var list = scope.createIdentifier('list');

      if (this.body.synthetic) {
        code.insertRight(this.left.start, "{\n" + i1);
        code.insertLeft(this.body.body[0].end, "\n" + i0 + "}");
      }

      var bodyStart = this.body.body[0].start;

      code.remove(this.left.end, this.right.start);
      code.move(this.left.start, this.left.end, bodyStart);

      code.insertRight(this.right.start, "var " + key + " = 0, " + list + " = ");
      code.insertLeft(this.right.end, "; " + key + " < " + list + ".length; " + key + " += 1");

      // destructuring. TODO non declaration destructuring
      var declarator = this.left.type === 'VariableDeclaration' && this.left.declarations[0];
      if (declarator && declarator.id.type !== 'Identifier') {
        var statementGenerators = [];
        var ref = scope.createIdentifier('ref');
        destructure(code, scope, declarator.id, ref, false, statementGenerators);

        var suffix = ";\n" + i1;
        statementGenerators.forEach(function (fn, i) {
          if (i === statementGenerators.length - 1) {
            suffix = ";\n\n" + i1;
          }

          fn(bodyStart, '', suffix);
        });

        code.insertLeft(this.left.start + this.left.kind.length + 1, ref);
        code.insertLeft(this.left.end, " = " + list + "[" + key + "];\n" + i1);
      } else {
        code.insertLeft(this.left.end, " = " + list + "[" + key + "];\n\n" + i1);
      }

      LoopStatement.prototype.transpile.call(this, code, transforms);
    };

    return ForOfStatement;
  }(LoopStatement);

  var FunctionDeclaration = function (Node) {
    function FunctionDeclaration() {
      Node.apply(this, arguments);
    }

    if (Node) FunctionDeclaration.__proto__ = Node;
    FunctionDeclaration.prototype = Object.create(Node && Node.prototype);
    FunctionDeclaration.prototype.constructor = FunctionDeclaration;

    FunctionDeclaration.prototype.initialise = function initialise(transforms) {
      if (this.generator && transforms.generator) {
        throw new CompileError(this, 'Generators are not supported');
      }

      this.body.createScope();

      this.findScope(true).addDeclaration(this.id, 'function');
      Node.prototype.initialise.call(this, transforms);
    };

    return FunctionDeclaration;
  }(Node);

  var FunctionExpression = function (Node) {
    function FunctionExpression() {
      Node.apply(this, arguments);
    }

    if (Node) FunctionExpression.__proto__ = Node;
    FunctionExpression.prototype = Object.create(Node && Node.prototype);
    FunctionExpression.prototype.constructor = FunctionExpression;

    FunctionExpression.prototype.initialise = function initialise(transforms) {
      if (this.generator && transforms.generator) {
        throw new CompileError(this, 'Generators are not supported');
      }

      this.body.createScope();

      if (this.id) {
        // function expression IDs belong to the child scope...
        this.body.scope.addDeclaration(this.id, 'function');
      }

      Node.prototype.initialise.call(this, transforms);

      var parent = this.parent;
      var methodName;

      if (transforms.conciseMethodProperty && parent.type === 'Property' && parent.kind === 'init' && parent.method && parent.key.type === 'Identifier') {
        // object literal concise method
        methodName = parent.key.name;
      } else if (transforms.classes && parent.type === 'MethodDefinition' && parent.kind === 'method' && parent.key.type === 'Identifier') {
        // method definition in a class
        methodName = parent.key.name;
      } else if (this.id && this.id.type === 'Identifier') {
        // naked function expression
        methodName = this.id.alias || this.id.name;
      }

      if (methodName) {
        for (var i = 0, list = this.params; i < list.length; i += 1) {
          var param = list[i];

          if (param.type === 'Identifier' && methodName === param.name) {
            // workaround for Safari 9/WebKit bug:
            // https://gitlab.com/Rich-Harris/buble/issues/154
            // change parameter name when same as method name

            var scope = this.body.scope;
            var declaration = scope.declarations[methodName];

            var alias = scope.createIdentifier(methodName);
            param.alias = alias;

            for (var i$1 = 0, list$1 = declaration.instances; i$1 < list$1.length; i$1 += 1) {
              var identifier = list$1[i$1];

              identifier.alias = alias;
            }

            break;
          }
        }
      }
    };

    return FunctionExpression;
  }(Node);

  function isReference(node, parent) {
    if (node.type === 'MemberExpression') {
      return !node.computed && isReference(node.object, node);
    }

    if (node.type === 'Identifier') {
      // the only time we could have an identifier node without a parent is
      // if it's the entire body of a function without a block statement –
      // i.e. an arrow function expression like `a => a`
      if (!parent) return true;

      if (/(Function|Class)Expression/.test(parent.type)) return false;

      if (parent.type === 'VariableDeclarator') return node === parent.init;

      // TODO is this right?
      if (parent.type === 'MemberExpression' || parent.type === 'MethodDefinition') {
        return parent.computed || node === parent.object;
      }

      if (parent.type === 'ArrayPattern') return false;

      // disregard the `bar` in `{ bar: foo }`, but keep it in `{ [bar]: foo }`
      if (parent.type === 'Property') {
        if (parent.parent.type === 'ObjectPattern') return false;
        return parent.computed || node === parent.value;
      }

      // disregard the `bar` in `class Foo { bar () {...} }`
      if (parent.type === 'MethodDefinition') return false;

      // disregard the `bar` in `export { foo as bar }`
      if (parent.type === 'ExportSpecifier' && node !== parent.local) return false;

      return true;
    }
  }

  var Identifier = function (Node) {
    function Identifier() {
      Node.apply(this, arguments);
    }

    if (Node) Identifier.__proto__ = Node;
    Identifier.prototype = Object.create(Node && Node.prototype);
    Identifier.prototype.constructor = Identifier;

    Identifier.prototype.findScope = function findScope(functionScope) {
      if (this.parent.params && ~this.parent.params.indexOf(this)) {
        return this.parent.body.scope;
      }

      if (this.parent.type === 'FunctionExpression' && this === this.parent.id) {
        return this.parent.body.scope;
      }

      return this.parent.findScope(functionScope);
    };

    Identifier.prototype.initialise = function initialise(transforms) {
      if (transforms.arrow && isReference(this, this.parent)) {
        if (this.name === 'arguments' && !this.findScope(false).contains(this.name)) {
          var lexicalBoundary = this.findLexicalBoundary();
          var arrowFunction = this.findNearest('ArrowFunctionExpression');
          var loop = this.findNearest(loopStatement);

          if (arrowFunction && arrowFunction.depth > lexicalBoundary.depth) {
            this.alias = lexicalBoundary.getArgumentsAlias();
          }

          if (loop && loop.body.contains(this) && loop.depth > lexicalBoundary.depth) {
            this.alias = lexicalBoundary.getArgumentsAlias();
          }
        }

        this.findScope(false).addReference(this);
      }
    };

    Identifier.prototype.transpile = function transpile(code) {
      if (this.alias) {
        code.overwrite(this.start, this.end, this.alias, true);
      }
    };

    return Identifier;
  }(Node);

  var IfStatement = function (Node) {
    function IfStatement() {
      Node.apply(this, arguments);
    }

    if (Node) IfStatement.__proto__ = Node;
    IfStatement.prototype = Object.create(Node && Node.prototype);
    IfStatement.prototype.constructor = IfStatement;

    IfStatement.prototype.initialise = function initialise(transforms) {
      Node.prototype.initialise.call(this, transforms);
    };

    IfStatement.prototype.transpile = function transpile(code, transforms) {
      if (this.consequent.type !== 'BlockStatement' || this.consequent.type === 'BlockStatement' && this.consequent.synthetic) {
        code.insertLeft(this.consequent.start, '{ ');
        code.insertRight(this.consequent.end, ' }');
      }

      if (this.alternate && this.alternate.type !== 'IfStatement' && (this.alternate.type !== 'BlockStatement' || this.alternate.type === 'BlockStatement' && this.alternate.synthetic)) {
        code.insertLeft(this.alternate.start, '{ ');
        code.insertRight(this.alternate.end, ' }');
      }

      Node.prototype.transpile.call(this, code, transforms);
    };

    return IfStatement;
  }(Node);

  var ImportDeclaration = function (Node) {
    function ImportDeclaration() {
      Node.apply(this, arguments);
    }

    if (Node) ImportDeclaration.__proto__ = Node;
    ImportDeclaration.prototype = Object.create(Node && Node.prototype);
    ImportDeclaration.prototype.constructor = ImportDeclaration;

    ImportDeclaration.prototype.initialise = function initialise(transforms) {
      if (transforms.moduleImport) throw new CompileError(this, 'import is not supported');
      Node.prototype.initialise.call(this, transforms);
    };

    return ImportDeclaration;
  }(Node);

  var ImportDefaultSpecifier = function (Node) {
    function ImportDefaultSpecifier() {
      Node.apply(this, arguments);
    }

    if (Node) ImportDefaultSpecifier.__proto__ = Node;
    ImportDefaultSpecifier.prototype = Object.create(Node && Node.prototype);
    ImportDefaultSpecifier.prototype.constructor = ImportDefaultSpecifier;

    ImportDefaultSpecifier.prototype.initialise = function initialise(transforms) {
      this.findScope(true).addDeclaration(this.local, 'import');
      Node.prototype.initialise.call(this, transforms);
    };

    return ImportDefaultSpecifier;
  }(Node);

  var ImportSpecifier = function (Node) {
    function ImportSpecifier() {
      Node.apply(this, arguments);
    }

    if (Node) ImportSpecifier.__proto__ = Node;
    ImportSpecifier.prototype = Object.create(Node && Node.prototype);
    ImportSpecifier.prototype.constructor = ImportSpecifier;

    ImportSpecifier.prototype.initialise = function initialise(transforms) {
      this.findScope(true).addDeclaration(this.local, 'import');
      Node.prototype.initialise.call(this, transforms);
    };

    return ImportSpecifier;
  }(Node);

  var IS_DATA_ATTRIBUTE = /-/;

  var JSXAttribute = function (Node) {
    function JSXAttribute() {
      Node.apply(this, arguments);
    }

    if (Node) JSXAttribute.__proto__ = Node;
    JSXAttribute.prototype = Object.create(Node && Node.prototype);
    JSXAttribute.prototype.constructor = JSXAttribute;

    JSXAttribute.prototype.transpile = function transpile(code, transforms) {
      if (this.value) {
        code.overwrite(this.name.end, this.value.start, ': ');
      } else {
        // tag without value
        code.overwrite(this.name.start, this.name.end, this.name.name + ": true");
      }

      if (IS_DATA_ATTRIBUTE.test(this.name.name)) {
        code.overwrite(this.name.start, this.name.end, "'" + this.name.name + "'");
      }

      Node.prototype.transpile.call(this, code, transforms);
    };

    return JSXAttribute;
  }(Node);

  function containsNewLine(node) {
    return node.type === 'Literal' && !/\S/.test(node.value) && /\n/.test(node.value);
  }

  var JSXClosingElement = function (Node) {
    function JSXClosingElement() {
      Node.apply(this, arguments);
    }

    if (Node) JSXClosingElement.__proto__ = Node;
    JSXClosingElement.prototype = Object.create(Node && Node.prototype);
    JSXClosingElement.prototype.constructor = JSXClosingElement;

    JSXClosingElement.prototype.transpile = function transpile(code) {
      var spaceBeforeParen = true;

      var lastChild = this.parent.children[this.parent.children.length - 1];

      // omit space before closing paren if
      //   a) this is on a separate line, or
      //   b) there are no children but there are attributes
      if (lastChild && containsNewLine(lastChild) || this.parent.openingElement.attributes.length) {
        spaceBeforeParen = false;
      }

      code.overwrite(this.start, this.end, spaceBeforeParen ? ' )' : ')');
    };

    return JSXClosingElement;
  }(Node);

  function normalise(str, removeTrailingWhitespace) {
    if (removeTrailingWhitespace && /\n/.test(str)) {
      str = str.replace(/\s+$/, '');
    }

    str = str.replace(/^\n\r?\s+/, '') // remove leading newline + space
    .replace(/\s*\n\r?\s*/gm, ' '); // replace newlines with spaces

    // TODO prefer single quotes?
    return JSON.stringify(str);
  }

  var JSXElement = function (Node) {
    function JSXElement() {
      Node.apply(this, arguments);
    }

    if (Node) JSXElement.__proto__ = Node;
    JSXElement.prototype = Object.create(Node && Node.prototype);
    JSXElement.prototype.constructor = JSXElement;

    JSXElement.prototype.transpile = function transpile(code, transforms) {
      Node.prototype.transpile.call(this, code, transforms);

      var children = this.children.filter(function (child) {
        if (child.type !== 'Literal') return true;

        // remove whitespace-only literals, unless on a single line
        return (/\S/.test(child.value) || !/\n/.test(child.value)
        );
      });

      if (children.length) {
        var c = this.openingElement.end;

        var i;
        for (i = 0; i < children.length; i += 1) {
          var child = children[i];

          if (child.type === 'JSXExpressionContainer' && child.expression.type === 'JSXEmptyExpression') {
            // empty block is a no op
          } else {
            var tail = code.original[c] === '\n' && child.type !== 'Literal' ? '' : ' ';
            code.insertLeft(c, "," + tail);
          }

          if (child.type === 'Literal') {
            var str = normalise(child.value, i === children.length - 1);
            code.overwrite(child.start, child.end, str);
          }

          c = child.end;
        }
      }
    };

    return JSXElement;
  }(Node);

  var JSXExpressionContainer = function (Node) {
    function JSXExpressionContainer() {
      Node.apply(this, arguments);
    }

    if (Node) JSXExpressionContainer.__proto__ = Node;
    JSXExpressionContainer.prototype = Object.create(Node && Node.prototype);
    JSXExpressionContainer.prototype.constructor = JSXExpressionContainer;

    JSXExpressionContainer.prototype.transpile = function transpile(code, transforms) {
      code.remove(this.start, this.expression.start);
      code.remove(this.expression.end, this.end);

      Node.prototype.transpile.call(this, code, transforms);
    };

    return JSXExpressionContainer;
  }(Node);

  var JSXOpeningElement = function (Node) {
    function JSXOpeningElement() {
      Node.apply(this, arguments);
    }

    if (Node) JSXOpeningElement.__proto__ = Node;
    JSXOpeningElement.prototype = Object.create(Node && Node.prototype);
    JSXOpeningElement.prototype.constructor = JSXOpeningElement;

    JSXOpeningElement.prototype.transpile = function transpile(code, transforms) {
      var this$1 = this;

      code.overwrite(this.start, this.name.start, this.program.jsx + "( ");

      var html = this.name.type === 'JSXIdentifier' && this.name.name[0] === this.name.name[0].toLowerCase();
      if (html) code.insertRight(this.name.start, "'");

      var len = this.attributes.length;
      var c = this.name.end;

      if (len) {
        var i;

        var hasSpread = false;
        for (i = 0; i < len; i += 1) {
          if (this$1.attributes[i].type === 'JSXSpreadAttribute') {
            hasSpread = true;
            break;
          }
        }

        c = this.attributes[0].end;

        for (i = 0; i < len; i += 1) {
          var attr = this$1.attributes[i];

          if (i > 0) {
            code.overwrite(c, attr.start, ', ');
          }

          if (hasSpread && attr.type !== 'JSXSpreadAttribute') {
            var lastAttr = this$1.attributes[i - 1];
            var nextAttr = this$1.attributes[i + 1];

            if (!lastAttr || lastAttr.type === 'JSXSpreadAttribute') {
              code.insertRight(attr.start, '{ ');
            }

            if (!nextAttr || nextAttr.type === 'JSXSpreadAttribute') {
              code.insertLeft(attr.end, ' }');
            }
          }

          c = attr.end;
        }

        var after;
        var before;
        if (hasSpread) {
          if (len === 1) {
            before = html ? "'," : ',';
          } else {
            if (!this.program.options.objectAssign) {
              throw new CompileError(this, 'Mixed JSX attributes ending in spread requires specified objectAssign option with \'Object.assign\' or polyfill helper.');
            }
            before = html ? "', " + this.program.options.objectAssign + "({}," : ", " + this.program.options.objectAssign + "({},";
            after = ')';
          }
        } else {
          before = html ? "', {" : ', {';
          after = ' }';
        }

        code.insertRight(this.name.end, before);

        if (after) {
          code.insertLeft(this.attributes[len - 1].end, after);
        }
      } else {
        code.insertLeft(this.name.end, html ? "', null" : ", null");
        c = this.name.end;
      }

      Node.prototype.transpile.call(this, code, transforms);

      if (this.selfClosing) {
        code.overwrite(c, this.end, this.attributes.length ? ")" : " )");
      } else {
        code.remove(c, this.end);
      }
    };

    return JSXOpeningElement;
  }(Node);

  var JSXSpreadAttribute = function (Node) {
    function JSXSpreadAttribute() {
      Node.apply(this, arguments);
    }

    if (Node) JSXSpreadAttribute.__proto__ = Node;
    JSXSpreadAttribute.prototype = Object.create(Node && Node.prototype);
    JSXSpreadAttribute.prototype.constructor = JSXSpreadAttribute;

    JSXSpreadAttribute.prototype.transpile = function transpile(code, transforms) {
      code.remove(this.start, this.argument.start);
      code.remove(this.argument.end, this.end);

      Node.prototype.transpile.call(this, code, transforms);
    };

    return JSXSpreadAttribute;
  }(Node);

  var regenerate = __commonjs(function (module, exports, global) {
    /*! https://mths.be/regenerate v1.3.1 by @mathias | MIT license */
    ;(function (root) {

      // Detect free variables `exports`.
      var freeExports = (typeof exports === 'undefined' ? 'undefined' : _typeof(exports)) == 'object' && exports;

      // Detect free variable `module`.
      var freeModule = (typeof module === 'undefined' ? 'undefined' : _typeof(module)) == 'object' && module && module.exports == freeExports && module;

      // Detect free variable `global`, from Node.js/io.js or Browserified code,
      // and use it as `root`.
      var freeGlobal = (typeof global === 'undefined' ? 'undefined' : _typeof(global)) == 'object' && global;
      if (freeGlobal.global === freeGlobal || freeGlobal.window === freeGlobal) {
        root = freeGlobal;
      }

      /*--------------------------------------------------------------------------*/

      var ERRORS = {
        'rangeOrder': 'A range\u2019s `stop` value must be greater than or equal ' + 'to the `start` value.',
        'codePointRange': 'Invalid code point value. Code points range from ' + 'U+000000 to U+10FFFF.'
      };

      // https://mathiasbynens.be/notes/javascript-encoding#surrogate-pairs
      var HIGH_SURROGATE_MIN = 0xD800;
      var HIGH_SURROGATE_MAX = 0xDBFF;
      var LOW_SURROGATE_MIN = 0xDC00;
      var LOW_SURROGATE_MAX = 0xDFFF;

      // In Regenerate output, `\0` is never preceded by `\` because we sort by
      // code point value, so let’s keep this regular expression simple.
      var regexNull = /\\x00([^0123456789]|$)/g;

      var object = {};
      var hasOwnProperty = object.hasOwnProperty;
      var extend = function extend(destination, source) {
        var key;
        for (key in source) {
          if (hasOwnProperty.call(source, key)) {
            destination[key] = source[key];
          }
        }
        return destination;
      };

      var forEach = function forEach(array, callback) {
        var index = -1;
        var length = array.length;
        while (++index < length) {
          callback(array[index], index);
        }
      };

      var toString = object.toString;
      var isArray = function isArray(value) {
        return toString.call(value) == '[object Array]';
      };
      var isNumber = function isNumber(value) {
        return typeof value == 'number' || toString.call(value) == '[object Number]';
      };

      // This assumes that `number` is a positive integer that `toString()`s nicely
      // (which is the case for all code point values).
      var zeroes = '0000';
      var pad = function pad(number, totalCharacters) {
        var string = String(number);
        return string.length < totalCharacters ? (zeroes + string).slice(-totalCharacters) : string;
      };

      var hex = function hex(number) {
        return Number(number).toString(16).toUpperCase();
      };

      var slice = [].slice;

      /*--------------------------------------------------------------------------*/

      var dataFromCodePoints = function dataFromCodePoints(codePoints) {
        var index = -1;
        var length = codePoints.length;
        var max = length - 1;
        var result = [];
        var isStart = true;
        var tmp;
        var previous = 0;
        while (++index < length) {
          tmp = codePoints[index];
          if (isStart) {
            result.push(tmp);
            previous = tmp;
            isStart = false;
          } else {
            if (tmp == previous + 1) {
              if (index != max) {
                previous = tmp;
                continue;
              } else {
                isStart = true;
                result.push(tmp + 1);
              }
            } else {
              // End the previous range and start a new one.
              result.push(previous + 1, tmp);
              previous = tmp;
            }
          }
        }
        if (!isStart) {
          result.push(tmp + 1);
        }
        return result;
      };

      var dataRemove = function dataRemove(data, codePoint) {
        // Iterate over the data per `(start, end)` pair.
        var index = 0;
        var start;
        var end;
        var length = data.length;
        while (index < length) {
          start = data[index];
          end = data[index + 1];
          if (codePoint >= start && codePoint < end) {
            // Modify this pair.
            if (codePoint == start) {
              if (end == start + 1) {
                // Just remove `start` and `end`.
                data.splice(index, 2);
                return data;
              } else {
                // Just replace `start` with a new value.
                data[index] = codePoint + 1;
                return data;
              }
            } else if (codePoint == end - 1) {
              // Just replace `end` with a new value.
              data[index + 1] = codePoint;
              return data;
            } else {
              // Replace `[start, end]` with `[startA, endA, startB, endB]`.
              data.splice(index, 2, start, codePoint, codePoint + 1, end);
              return data;
            }
          }
          index += 2;
        }
        return data;
      };

      var dataRemoveRange = function dataRemoveRange(data, rangeStart, rangeEnd) {
        if (rangeEnd < rangeStart) {
          throw Error(ERRORS.rangeOrder);
        }
        // Iterate over the data per `(start, end)` pair.
        var index = 0;
        var start;
        var end;
        while (index < data.length) {
          start = data[index];
          end = data[index + 1] - 1; // Note: the `- 1` makes `end` inclusive.

          // Exit as soon as no more matching pairs can be found.
          if (start > rangeEnd) {
            return data;
          }

          // Check if this range pair is equal to, or forms a subset of, the range
          // to be removed.
          // E.g. we have `[0, 11, 40, 51]` and want to remove 0-10 → `[40, 51]`.
          // E.g. we have `[40, 51]` and want to remove 0-100 → `[]`.
          if (rangeStart <= start && rangeEnd >= end) {
            // Remove this pair.
            data.splice(index, 2);
            continue;
          }

          // Check if both `rangeStart` and `rangeEnd` are within the bounds of
          // this pair.
          // E.g. we have `[0, 11]` and want to remove 4-6 → `[0, 4, 7, 11]`.
          if (rangeStart >= start && rangeEnd < end) {
            if (rangeStart == start) {
              // Replace `[start, end]` with `[startB, endB]`.
              data[index] = rangeEnd + 1;
              data[index + 1] = end + 1;
              return data;
            }
            // Replace `[start, end]` with `[startA, endA, startB, endB]`.
            data.splice(index, 2, start, rangeStart, rangeEnd + 1, end + 1);
            return data;
          }

          // Check if only `rangeStart` is within the bounds of this pair.
          // E.g. we have `[0, 11]` and want to remove 4-20 → `[0, 4]`.
          if (rangeStart >= start && rangeStart <= end) {
            // Replace `end` with `rangeStart`.
            data[index + 1] = rangeStart;
            // Note: we cannot `return` just yet, in case any following pairs still
            // contain matching code points.
            // E.g. we have `[0, 11, 14, 31]` and want to remove 4-20
            // → `[0, 4, 21, 31]`.
          }

          // Check if only `rangeEnd` is within the bounds of this pair.
          // E.g. we have `[14, 31]` and want to remove 4-20 → `[21, 31]`.
          else if (rangeEnd >= start && rangeEnd <= end) {
              // Just replace `start`.
              data[index] = rangeEnd + 1;
              return data;
            }

          index += 2;
        }
        return data;
      };

      var dataAdd = function dataAdd(data, codePoint) {
        // Iterate over the data per `(start, end)` pair.
        var index = 0;
        var start;
        var end;
        var lastIndex = null;
        var length = data.length;
        if (codePoint < 0x0 || codePoint > 0x10FFFF) {
          throw RangeError(ERRORS.codePointRange);
        }
        while (index < length) {
          start = data[index];
          end = data[index + 1];

          // Check if the code point is already in the set.
          if (codePoint >= start && codePoint < end) {
            return data;
          }

          if (codePoint == start - 1) {
            // Just replace `start` with a new value.
            data[index] = codePoint;
            return data;
          }

          // At this point, if `start` is `greater` than `codePoint`, insert a new
          // `[start, end]` pair before the current pair, or after the current pair
          // if there is a known `lastIndex`.
          if (start > codePoint) {
            data.splice(lastIndex != null ? lastIndex + 2 : 0, 0, codePoint, codePoint + 1);
            return data;
          }

          if (codePoint == end) {
            // Check if adding this code point causes two separate ranges to become
            // a single range, e.g. `dataAdd([0, 4, 5, 10], 4)` → `[0, 10]`.
            if (codePoint + 1 == data[index + 2]) {
              data.splice(index, 4, start, data[index + 3]);
              return data;
            }
            // Else, just replace `end` with a new value.
            data[index + 1] = codePoint + 1;
            return data;
          }
          lastIndex = index;
          index += 2;
        }
        // The loop has finished; add the new pair to the end of the data set.
        data.push(codePoint, codePoint + 1);
        return data;
      };

      var dataAddData = function dataAddData(dataA, dataB) {
        // Iterate over the data per `(start, end)` pair.
        var index = 0;
        var start;
        var end;
        var data = dataA.slice();
        var length = dataB.length;
        while (index < length) {
          start = dataB[index];
          end = dataB[index + 1] - 1;
          if (start == end) {
            data = dataAdd(data, start);
          } else {
            data = dataAddRange(data, start, end);
          }
          index += 2;
        }
        return data;
      };

      var dataRemoveData = function dataRemoveData(dataA, dataB) {
        // Iterate over the data per `(start, end)` pair.
        var index = 0;
        var start;
        var end;
        var data = dataA.slice();
        var length = dataB.length;
        while (index < length) {
          start = dataB[index];
          end = dataB[index + 1] - 1;
          if (start == end) {
            data = dataRemove(data, start);
          } else {
            data = dataRemoveRange(data, start, end);
          }
          index += 2;
        }
        return data;
      };

      var dataAddRange = function dataAddRange(data, rangeStart, rangeEnd) {
        if (rangeEnd < rangeStart) {
          throw Error(ERRORS.rangeOrder);
        }
        if (rangeStart < 0x0 || rangeStart > 0x10FFFF || rangeEnd < 0x0 || rangeEnd > 0x10FFFF) {
          throw RangeError(ERRORS.codePointRange);
        }
        // Iterate over the data per `(start, end)` pair.
        var index = 0;
        var start;
        var end;
        var added = false;
        var length = data.length;
        while (index < length) {
          start = data[index];
          end = data[index + 1];

          if (added) {
            // The range has already been added to the set; at this point, we just
            // need to get rid of the following ranges in case they overlap.

            // Check if this range can be combined with the previous range.
            if (start == rangeEnd + 1) {
              data.splice(index - 1, 2);
              return data;
            }

            // Exit as soon as no more possibly overlapping pairs can be found.
            if (start > rangeEnd) {
              return data;
            }

            // E.g. `[0, 11, 12, 16]` and we’ve added 5-15, so we now have
            // `[0, 16, 12, 16]`. Remove the `12,16` part, as it lies within the
            // `0,16` range that was previously added.
            if (start >= rangeStart && start <= rangeEnd) {
              // `start` lies within the range that was previously added.

              if (end > rangeStart && end - 1 <= rangeEnd) {
                // `end` lies within the range that was previously added as well,
                // so remove this pair.
                data.splice(index, 2);
                index -= 2;
                // Note: we cannot `return` just yet, as there may still be other
                // overlapping pairs.
              } else {
                // `start` lies within the range that was previously added, but
                // `end` doesn’t. E.g. `[0, 11, 12, 31]` and we’ve added 5-15, so
                // now we have `[0, 16, 12, 31]`. This must be written as `[0, 31]`.
                // Remove the previously added `end` and the current `start`.
                data.splice(index - 1, 2);
                index -= 2;
              }

              // Note: we cannot return yet.
            }
          } else if (start == rangeEnd + 1) {
            data[index] = rangeStart;
            return data;
          }

          // Check if a new pair must be inserted *before* the current one.
          else if (start > rangeEnd) {
              data.splice(index, 0, rangeStart, rangeEnd + 1);
              return data;
            } else if (rangeStart >= start && rangeStart < end && rangeEnd + 1 <= end) {
              // The new range lies entirely within an existing range pair. No action
              // needed.
              return data;
            } else if (
            // E.g. `[0, 11]` and you add 5-15 → `[0, 16]`.
            rangeStart >= start && rangeStart < end ||
            // E.g. `[0, 3]` and you add 3-6 → `[0, 7]`.
            end == rangeStart) {
              // Replace `end` with the new value.
              data[index + 1] = rangeEnd + 1;
              // Make sure the next range pair doesn’t overlap, e.g. `[0, 11, 12, 14]`
              // and you add 5-15 → `[0, 16]`, i.e. remove the `12,14` part.
              added = true;
              // Note: we cannot `return` just yet.
            } else if (rangeStart <= start && rangeEnd + 1 >= end) {
              // The new range is a superset of the old range.
              data[index] = rangeStart;
              data[index + 1] = rangeEnd + 1;
              added = true;
            }

          index += 2;
        }
        // The loop has finished without doing anything; add the new pair to the end
        // of the data set.
        if (!added) {
          data.push(rangeStart, rangeEnd + 1);
        }
        return data;
      };

      var dataContains = function dataContains(data, codePoint) {
        var index = 0;
        var length = data.length;
        // Exit early if `codePoint` is not within `data`’s overall range.
        var start = data[index];
        var end = data[length - 1];
        if (length >= 2) {
          if (codePoint < start || codePoint > end) {
            return false;
          }
        }
        // Iterate over the data per `(start, end)` pair.
        while (index < length) {
          start = data[index];
          end = data[index + 1];
          if (codePoint >= start && codePoint < end) {
            return true;
          }
          index += 2;
        }
        return false;
      };

      var dataIntersection = function dataIntersection(data, codePoints) {
        var index = 0;
        var length = codePoints.length;
        var codePoint;
        var result = [];
        while (index < length) {
          codePoint = codePoints[index];
          if (dataContains(data, codePoint)) {
            result.push(codePoint);
          }
          ++index;
        }
        return dataFromCodePoints(result);
      };

      var dataIsEmpty = function dataIsEmpty(data) {
        return !data.length;
      };

      var dataIsSingleton = function dataIsSingleton(data) {
        // Check if the set only represents a single code point.
        return data.length == 2 && data[0] + 1 == data[1];
      };

      var dataToArray = function dataToArray(data) {
        // Iterate over the data per `(start, end)` pair.
        var index = 0;
        var start;
        var end;
        var result = [];
        var length = data.length;
        while (index < length) {
          start = data[index];
          end = data[index + 1];
          while (start < end) {
            result.push(start);
            ++start;
          }
          index += 2;
        }
        return result;
      };

      /*--------------------------------------------------------------------------*/

      // https://mathiasbynens.be/notes/javascript-encoding#surrogate-formulae
      var floor = Math.floor;
      var highSurrogate = function highSurrogate(codePoint) {
        return parseInt(floor((codePoint - 0x10000) / 0x400) + HIGH_SURROGATE_MIN, 10);
      };

      var lowSurrogate = function lowSurrogate(codePoint) {
        return parseInt((codePoint - 0x10000) % 0x400 + LOW_SURROGATE_MIN, 10);
      };

      var stringFromCharCode = String.fromCharCode;
      var codePointToString = function codePointToString(codePoint) {
        var string;
        // https://mathiasbynens.be/notes/javascript-escapes#single
        // Note: the `\b` escape sequence for U+0008 BACKSPACE in strings has a
        // different meaning in regular expressions (word boundary), so it cannot
        // be used here.
        if (codePoint == 0x09) {
          string = '\\t';
        }
        // Note: IE < 9 treats `'\v'` as `'v'`, so avoid using it.
        // else if (codePoint == 0x0B) {
        // 	string = '\\v';
        // }
        else if (codePoint == 0x0A) {
            string = '\\n';
          } else if (codePoint == 0x0C) {
            string = '\\f';
          } else if (codePoint == 0x0D) {
            string = '\\r';
          } else if (codePoint == 0x5C) {
            string = '\\\\';
          } else if (codePoint == 0x24 || codePoint >= 0x28 && codePoint <= 0x2B || codePoint == 0x2D || codePoint == 0x2E || codePoint == 0x3F || codePoint >= 0x5B && codePoint <= 0x5E || codePoint >= 0x7B && codePoint <= 0x7D) {
            // The code point maps to an unsafe printable ASCII character;
            // backslash-escape it. Here’s the list of those symbols:
            //
            //     $()*+-.?[\]^{|}
            //
            // See #7 for more info.
            string = '\\' + stringFromCharCode(codePoint);
          } else if (codePoint >= 0x20 && codePoint <= 0x7E) {
            // The code point maps to one of these printable ASCII symbols
            // (including the space character):
            //
            //      !"#%&',/0123456789:;<=>@ABCDEFGHIJKLMNO
            //     PQRSTUVWXYZ_`abcdefghijklmnopqrstuvwxyz~
            //
            // These can safely be used directly.
            string = stringFromCharCode(codePoint);
          } else if (codePoint <= 0xFF) {
            // https://mathiasbynens.be/notes/javascript-escapes#hexadecimal
            string = '\\x' + pad(hex(codePoint), 2);
          } else {
            // `codePoint <= 0xFFFF` holds true.
            // https://mathiasbynens.be/notes/javascript-escapes#unicode
            string = '\\u' + pad(hex(codePoint), 4);
          }

        // There’s no need to account for astral symbols / surrogate pairs here,
        // since `codePointToString` is private and only used for BMP code points.
        // But if that’s what you need, just add an `else` block with this code:
        //
        //     string = '\\u' + pad(hex(highSurrogate(codePoint)), 4)
        //     	+ '\\u' + pad(hex(lowSurrogate(codePoint)), 4);

        return string;
      };

      var codePointToStringUnicode = function codePointToStringUnicode(codePoint) {
        if (codePoint <= 0xFFFF) {
          return codePointToString(codePoint);
        }
        return '\\u{' + codePoint.toString(16).toUpperCase() + '}';
      };

      var symbolToCodePoint = function symbolToCodePoint(symbol) {
        var length = symbol.length;
        var first = symbol.charCodeAt(0);
        var second;
        if (first >= HIGH_SURROGATE_MIN && first <= HIGH_SURROGATE_MAX && length > 1 // There is a next code unit.
        ) {
            // `first` is a high surrogate, and there is a next character. Assume
            // it’s a low surrogate (else it’s invalid usage of Regenerate anyway).
            second = symbol.charCodeAt(1);
            // https://mathiasbynens.be/notes/javascript-encoding#surrogate-formulae
            return (first - HIGH_SURROGATE_MIN) * 0x400 + second - LOW_SURROGATE_MIN + 0x10000;
          }
        return first;
      };

      var createBMPCharacterClasses = function createBMPCharacterClasses(data) {
        // Iterate over the data per `(start, end)` pair.
        var result = '';
        var index = 0;
        var start;
        var end;
        var length = data.length;
        if (dataIsSingleton(data)) {
          return codePointToString(data[0]);
        }
        while (index < length) {
          start = data[index];
          end = data[index + 1] - 1; // Note: the `- 1` makes `end` inclusive.
          if (start == end) {
            result += codePointToString(start);
          } else if (start + 1 == end) {
            result += codePointToString(start) + codePointToString(end);
          } else {
            result += codePointToString(start) + '-' + codePointToString(end);
          }
          index += 2;
        }
        return '[' + result + ']';
      };

      var createUnicodeCharacterClasses = function createUnicodeCharacterClasses(data) {
        // Iterate over the data per `(start, end)` pair.
        var result = '';
        var index = 0;
        var start;
        var end;
        var length = data.length;
        if (dataIsSingleton(data)) {
          return codePointToStringUnicode(data[0]);
        }
        while (index < length) {
          start = data[index];
          end = data[index + 1] - 1; // Note: the `- 1` makes `end` inclusive.
          if (start == end) {
            result += codePointToStringUnicode(start);
          } else if (start + 1 == end) {
            result += codePointToStringUnicode(start) + codePointToStringUnicode(end);
          } else {
            result += codePointToStringUnicode(start) + '-' + codePointToStringUnicode(end);
          }
          index += 2;
        }
        return '[' + result + ']';
      };

      var splitAtBMP = function splitAtBMP(data) {
        // Iterate over the data per `(start, end)` pair.
        var loneHighSurrogates = [];
        var loneLowSurrogates = [];
        var bmp = [];
        var astral = [];
        var index = 0;
        var start;
        var end;
        var length = data.length;
        while (index < length) {
          start = data[index];
          end = data[index + 1] - 1; // Note: the `- 1` makes `end` inclusive.

          if (start < HIGH_SURROGATE_MIN) {

            // The range starts and ends before the high surrogate range.
            // E.g. (0, 0x10).
            if (end < HIGH_SURROGATE_MIN) {
              bmp.push(start, end + 1);
            }

            // The range starts before the high surrogate range and ends within it.
            // E.g. (0, 0xD855).
            if (end >= HIGH_SURROGATE_MIN && end <= HIGH_SURROGATE_MAX) {
              bmp.push(start, HIGH_SURROGATE_MIN);
              loneHighSurrogates.push(HIGH_SURROGATE_MIN, end + 1);
            }

            // The range starts before the high surrogate range and ends in the low
            // surrogate range. E.g. (0, 0xDCFF).
            if (end >= LOW_SURROGATE_MIN && end <= LOW_SURROGATE_MAX) {
              bmp.push(start, HIGH_SURROGATE_MIN);
              loneHighSurrogates.push(HIGH_SURROGATE_MIN, HIGH_SURROGATE_MAX + 1);
              loneLowSurrogates.push(LOW_SURROGATE_MIN, end + 1);
            }

            // The range starts before the high surrogate range and ends after the
            // low surrogate range. E.g. (0, 0x10FFFF).
            if (end > LOW_SURROGATE_MAX) {
              bmp.push(start, HIGH_SURROGATE_MIN);
              loneHighSurrogates.push(HIGH_SURROGATE_MIN, HIGH_SURROGATE_MAX + 1);
              loneLowSurrogates.push(LOW_SURROGATE_MIN, LOW_SURROGATE_MAX + 1);
              if (end <= 0xFFFF) {
                bmp.push(LOW_SURROGATE_MAX + 1, end + 1);
              } else {
                bmp.push(LOW_SURROGATE_MAX + 1, 0xFFFF + 1);
                astral.push(0xFFFF + 1, end + 1);
              }
            }
          } else if (start >= HIGH_SURROGATE_MIN && start <= HIGH_SURROGATE_MAX) {

            // The range starts and ends in the high surrogate range.
            // E.g. (0xD855, 0xD866).
            if (end >= HIGH_SURROGATE_MIN && end <= HIGH_SURROGATE_MAX) {
              loneHighSurrogates.push(start, end + 1);
            }

            // The range starts in the high surrogate range and ends in the low
            // surrogate range. E.g. (0xD855, 0xDCFF).
            if (end >= LOW_SURROGATE_MIN && end <= LOW_SURROGATE_MAX) {
              loneHighSurrogates.push(start, HIGH_SURROGATE_MAX + 1);
              loneLowSurrogates.push(LOW_SURROGATE_MIN, end + 1);
            }

            // The range starts in the high surrogate range and ends after the low
            // surrogate range. E.g. (0xD855, 0x10FFFF).
            if (end > LOW_SURROGATE_MAX) {
              loneHighSurrogates.push(start, HIGH_SURROGATE_MAX + 1);
              loneLowSurrogates.push(LOW_SURROGATE_MIN, LOW_SURROGATE_MAX + 1);
              if (end <= 0xFFFF) {
                bmp.push(LOW_SURROGATE_MAX + 1, end + 1);
              } else {
                bmp.push(LOW_SURROGATE_MAX + 1, 0xFFFF + 1);
                astral.push(0xFFFF + 1, end + 1);
              }
            }
          } else if (start >= LOW_SURROGATE_MIN && start <= LOW_SURROGATE_MAX) {

            // The range starts and ends in the low surrogate range.
            // E.g. (0xDCFF, 0xDDFF).
            if (end >= LOW_SURROGATE_MIN && end <= LOW_SURROGATE_MAX) {
              loneLowSurrogates.push(start, end + 1);
            }

            // The range starts in the low surrogate range and ends after the low
            // surrogate range. E.g. (0xDCFF, 0x10FFFF).
            if (end > LOW_SURROGATE_MAX) {
              loneLowSurrogates.push(start, LOW_SURROGATE_MAX + 1);
              if (end <= 0xFFFF) {
                bmp.push(LOW_SURROGATE_MAX + 1, end + 1);
              } else {
                bmp.push(LOW_SURROGATE_MAX + 1, 0xFFFF + 1);
                astral.push(0xFFFF + 1, end + 1);
              }
            }
          } else if (start > LOW_SURROGATE_MAX && start <= 0xFFFF) {

            // The range starts and ends after the low surrogate range.
            // E.g. (0xFFAA, 0x10FFFF).
            if (end <= 0xFFFF) {
              bmp.push(start, end + 1);
            } else {
              bmp.push(start, 0xFFFF + 1);
              astral.push(0xFFFF + 1, end + 1);
            }
          } else {

            // The range starts and ends in the astral range.
            astral.push(start, end + 1);
          }

          index += 2;
        }
        return {
          'loneHighSurrogates': loneHighSurrogates,
          'loneLowSurrogates': loneLowSurrogates,
          'bmp': bmp,
          'astral': astral
        };
      };

      var optimizeSurrogateMappings = function optimizeSurrogateMappings(surrogateMappings) {
        var result = [];
        var tmpLow = [];
        var addLow = false;
        var mapping;
        var nextMapping;
        var highSurrogates;
        var lowSurrogates;
        var nextHighSurrogates;
        var nextLowSurrogates;
        var index = -1;
        var length = surrogateMappings.length;
        while (++index < length) {
          mapping = surrogateMappings[index];
          nextMapping = surrogateMappings[index + 1];
          if (!nextMapping) {
            result.push(mapping);
            continue;
          }
          highSurrogates = mapping[0];
          lowSurrogates = mapping[1];
          nextHighSurrogates = nextMapping[0];
          nextLowSurrogates = nextMapping[1];

          // Check for identical high surrogate ranges.
          tmpLow = lowSurrogates;
          while (nextHighSurrogates && highSurrogates[0] == nextHighSurrogates[0] && highSurrogates[1] == nextHighSurrogates[1]) {
            // Merge with the next item.
            if (dataIsSingleton(nextLowSurrogates)) {
              tmpLow = dataAdd(tmpLow, nextLowSurrogates[0]);
            } else {
              tmpLow = dataAddRange(tmpLow, nextLowSurrogates[0], nextLowSurrogates[1] - 1);
            }
            ++index;
            mapping = surrogateMappings[index];
            highSurrogates = mapping[0];
            lowSurrogates = mapping[1];
            nextMapping = surrogateMappings[index + 1];
            nextHighSurrogates = nextMapping && nextMapping[0];
            nextLowSurrogates = nextMapping && nextMapping[1];
            addLow = true;
          }
          result.push([highSurrogates, addLow ? tmpLow : lowSurrogates]);
          addLow = false;
        }
        return optimizeByLowSurrogates(result);
      };

      var optimizeByLowSurrogates = function optimizeByLowSurrogates(surrogateMappings) {
        if (surrogateMappings.length == 1) {
          return surrogateMappings;
        }
        var index = -1;
        var innerIndex = -1;
        while (++index < surrogateMappings.length) {
          var mapping = surrogateMappings[index];
          var lowSurrogates = mapping[1];
          var lowSurrogateStart = lowSurrogates[0];
          var lowSurrogateEnd = lowSurrogates[1];
          innerIndex = index; // Note: the loop starts at the next index.
          while (++innerIndex < surrogateMappings.length) {
            var otherMapping = surrogateMappings[innerIndex];
            var otherLowSurrogates = otherMapping[1];
            var otherLowSurrogateStart = otherLowSurrogates[0];
            var otherLowSurrogateEnd = otherLowSurrogates[1];
            if (lowSurrogateStart == otherLowSurrogateStart && lowSurrogateEnd == otherLowSurrogateEnd) {
              // Add the code points in the other item to this one.
              if (dataIsSingleton(otherMapping[0])) {
                mapping[0] = dataAdd(mapping[0], otherMapping[0][0]);
              } else {
                mapping[0] = dataAddRange(mapping[0], otherMapping[0][0], otherMapping[0][1] - 1);
              }
              // Remove the other, now redundant, item.
              surrogateMappings.splice(innerIndex, 1);
              --innerIndex;
            }
          }
        }
        return surrogateMappings;
      };

      var surrogateSet = function surrogateSet(data) {
        // Exit early if `data` is an empty set.
        if (!data.length) {
          return [];
        }

        // Iterate over the data per `(start, end)` pair.
        var index = 0;
        var start;
        var end;
        var startHigh;
        var startLow;
        var prevStartHigh = 0;
        var prevEndHigh = 0;
        var tmpLow = [];
        var endHigh;
        var endLow;
        var surrogateMappings = [];
        var length = data.length;
        var dataHigh = [];
        while (index < length) {
          start = data[index];
          end = data[index + 1] - 1;

          startHigh = highSurrogate(start);
          startLow = lowSurrogate(start);
          endHigh = highSurrogate(end);
          endLow = lowSurrogate(end);

          var startsWithLowestLowSurrogate = startLow == LOW_SURROGATE_MIN;
          var endsWithHighestLowSurrogate = endLow == LOW_SURROGATE_MAX;
          var complete = false;

          // Append the previous high-surrogate-to-low-surrogate mappings.
          // Step 1: `(startHigh, startLow)` to `(startHigh, LOW_SURROGATE_MAX)`.
          if (startHigh == endHigh || startsWithLowestLowSurrogate && endsWithHighestLowSurrogate) {
            surrogateMappings.push([[startHigh, endHigh + 1], [startLow, endLow + 1]]);
            complete = true;
          } else {
            surrogateMappings.push([[startHigh, startHigh + 1], [startLow, LOW_SURROGATE_MAX + 1]]);
          }

          // Step 2: `(startHigh + 1, LOW_SURROGATE_MIN)` to
          // `(endHigh - 1, LOW_SURROGATE_MAX)`.
          if (!complete && startHigh + 1 < endHigh) {
            if (endsWithHighestLowSurrogate) {
              // Combine step 2 and step 3.
              surrogateMappings.push([[startHigh + 1, endHigh + 1], [LOW_SURROGATE_MIN, endLow + 1]]);
              complete = true;
            } else {
              surrogateMappings.push([[startHigh + 1, endHigh], [LOW_SURROGATE_MIN, LOW_SURROGATE_MAX + 1]]);
            }
          }

          // Step 3. `(endHigh, LOW_SURROGATE_MIN)` to `(endHigh, endLow)`.
          if (!complete) {
            surrogateMappings.push([[endHigh, endHigh + 1], [LOW_SURROGATE_MIN, endLow + 1]]);
          }

          prevStartHigh = startHigh;
          prevEndHigh = endHigh;

          index += 2;
        }

        // The format of `surrogateMappings` is as follows:
        //
        //     [ surrogateMapping1, surrogateMapping2 ]
        //
        // i.e.:
        //
        //     [
        //       [ highSurrogates1, lowSurrogates1 ],
        //       [ highSurrogates2, lowSurrogates2 ]
        //     ]
        return optimizeSurrogateMappings(surrogateMappings);
      };

      var createSurrogateCharacterClasses = function createSurrogateCharacterClasses(surrogateMappings) {
        var result = [];
        forEach(surrogateMappings, function (surrogateMapping) {
          var highSurrogates = surrogateMapping[0];
          var lowSurrogates = surrogateMapping[1];
          result.push(createBMPCharacterClasses(highSurrogates) + createBMPCharacterClasses(lowSurrogates));
        });
        return result.join('|');
      };

      var createCharacterClassesFromData = function createCharacterClassesFromData(data, bmpOnly, hasUnicodeFlag) {
        if (hasUnicodeFlag) {
          return createUnicodeCharacterClasses(data);
        }
        var result = [];

        var parts = splitAtBMP(data);
        var loneHighSurrogates = parts.loneHighSurrogates;
        var loneLowSurrogates = parts.loneLowSurrogates;
        var bmp = parts.bmp;
        var astral = parts.astral;
        var hasAstral = !dataIsEmpty(parts.astral);
        var hasLoneHighSurrogates = !dataIsEmpty(loneHighSurrogates);
        var hasLoneLowSurrogates = !dataIsEmpty(loneLowSurrogates);

        var surrogateMappings = surrogateSet(astral);

        if (bmpOnly) {
          bmp = dataAddData(bmp, loneHighSurrogates);
          hasLoneHighSurrogates = false;
          bmp = dataAddData(bmp, loneLowSurrogates);
          hasLoneLowSurrogates = false;
        }

        if (!dataIsEmpty(bmp)) {
          // The data set contains BMP code points that are not high surrogates
          // needed for astral code points in the set.
          result.push(createBMPCharacterClasses(bmp));
        }
        if (surrogateMappings.length) {
          // The data set contains astral code points; append character classes
          // based on their surrogate pairs.
          result.push(createSurrogateCharacterClasses(surrogateMappings));
        }
        // https://gist.github.com/mathiasbynens/bbe7f870208abcfec860
        if (hasLoneHighSurrogates) {
          result.push(createBMPCharacterClasses(loneHighSurrogates) +
          // Make sure the high surrogates aren’t part of a surrogate pair.
          '(?![\\uDC00-\\uDFFF])');
        }
        if (hasLoneLowSurrogates) {
          result.push(
          // It is not possible to accurately assert the low surrogates aren’t
          // part of a surrogate pair, since JavaScript regular expressions do
          // not support lookbehind.
          '(?:[^\\uD800-\\uDBFF]|^)' + createBMPCharacterClasses(loneLowSurrogates));
        }
        return result.join('|');
      };

      /*--------------------------------------------------------------------------*/

      // `regenerate` can be used as a constructor (and new methods can be added to
      // its prototype) but also as a regular function, the latter of which is the
      // documented and most common usage. For that reason, it’s not capitalized.
      var regenerate = function regenerate(value) {
        if (arguments.length > 1) {
          value = slice.call(arguments);
        }
        if (this instanceof regenerate) {
          this.data = [];
          return value ? this.add(value) : this;
        }
        return new regenerate().add(value);
      };

      regenerate.version = '1.3.1';

      var proto = regenerate.prototype;
      extend(proto, {
        'add': function add(value) {
          var $this = this;
          if (value == null) {
            return $this;
          }
          if (value instanceof regenerate) {
            // Allow passing other Regenerate instances.
            $this.data = dataAddData($this.data, value.data);
            return $this;
          }
          if (arguments.length > 1) {
            value = slice.call(arguments);
          }
          if (isArray(value)) {
            forEach(value, function (item) {
              $this.add(item);
            });
            return $this;
          }
          $this.data = dataAdd($this.data, isNumber(value) ? value : symbolToCodePoint(value));
          return $this;
        },
        'remove': function remove(value) {
          var $this = this;
          if (value == null) {
            return $this;
          }
          if (value instanceof regenerate) {
            // Allow passing other Regenerate instances.
            $this.data = dataRemoveData($this.data, value.data);
            return $this;
          }
          if (arguments.length > 1) {
            value = slice.call(arguments);
          }
          if (isArray(value)) {
            forEach(value, function (item) {
              $this.remove(item);
            });
            return $this;
          }
          $this.data = dataRemove($this.data, isNumber(value) ? value : symbolToCodePoint(value));
          return $this;
        },
        'addRange': function addRange(start, end) {
          var $this = this;
          $this.data = dataAddRange($this.data, isNumber(start) ? start : symbolToCodePoint(start), isNumber(end) ? end : symbolToCodePoint(end));
          return $this;
        },
        'removeRange': function removeRange(start, end) {
          var $this = this;
          var startCodePoint = isNumber(start) ? start : symbolToCodePoint(start);
          var endCodePoint = isNumber(end) ? end : symbolToCodePoint(end);
          $this.data = dataRemoveRange($this.data, startCodePoint, endCodePoint);
          return $this;
        },
        'intersection': function intersection(argument) {
          var $this = this;
          // Allow passing other Regenerate instances.
          // TODO: Optimize this by writing and using `dataIntersectionData()`.
          var array = argument instanceof regenerate ? dataToArray(argument.data) : argument;
          $this.data = dataIntersection($this.data, array);
          return $this;
        },
        'contains': function contains(codePoint) {
          return dataContains(this.data, isNumber(codePoint) ? codePoint : symbolToCodePoint(codePoint));
        },
        'clone': function clone() {
          var set = new regenerate();
          set.data = this.data.slice(0);
          return set;
        },
        'toString': function toString(options) {
          var result = createCharacterClassesFromData(this.data, options ? options.bmpOnly : false, options ? options.hasUnicodeFlag : false);
          if (!result) {
            // For an empty set, return something that can be inserted `/here/` to
            // form a valid regular expression. Avoid `(?:)` since that matches the
            // empty string.
            return '[]';
          }
          // Use `\0` instead of `\x00` where possible.
          return result.replace(regexNull, '\\0$1');
        },
        'toRegExp': function toRegExp(flags) {
          var pattern = this.toString(flags && flags.indexOf('u') != -1 ? { 'hasUnicodeFlag': true } : null);
          return RegExp(pattern, flags || '');
        },
        'valueOf': function valueOf() {
          // Note: `valueOf` is aliased as `toArray`.
          return dataToArray(this.data);
        }
      });

      proto.toArray = proto.valueOf;

      // Some AMD build optimizers, like r.js, check for specific condition patterns
      // like the following:
      if (typeof define == 'function' && _typeof(define.amd) == 'object' && define.amd) {
        define(function () {
          return regenerate;
        });
      } else if (freeExports && !freeExports.nodeType) {
        if (freeModule) {
          // in Node.js, io.js, or RingoJS v0.8.0+
          freeModule.exports = regenerate;
        } else {
          // in Narwhal or RingoJS v0.7.0-
          freeExports.regenerate = regenerate;
        }
      } else {
        // in Rhino or a web browser
        root.regenerate = regenerate;
      }
    })(__commonjs_global);
  });

  var require$$0$2 = regenerate && (typeof regenerate === 'undefined' ? 'undefined' : _typeof(regenerate)) === 'object' && 'default' in regenerate ? regenerate['default'] : regenerate;

  var characterClassEscapeSets = __commonjs(function (module, exports) {
    // Generated by `/scripts/character-class-escape-sets.js`. Do not edit.
    var regenerate = require$$0$2;

    exports.REGULAR = {
      'd': regenerate().addRange(0x30, 0x39),
      'D': regenerate().addRange(0x0, 0x2F).addRange(0x3A, 0xFFFF),
      's': regenerate(0x20, 0xA0, 0x1680, 0x202F, 0x205F, 0x3000, 0xFEFF).addRange(0x9, 0xD).addRange(0x2000, 0x200A).addRange(0x2028, 0x2029),
      'S': regenerate().addRange(0x0, 0x8).addRange(0xE, 0x1F).addRange(0x21, 0x9F).addRange(0xA1, 0x167F).addRange(0x1681, 0x1FFF).addRange(0x200B, 0x2027).addRange(0x202A, 0x202E).addRange(0x2030, 0x205E).addRange(0x2060, 0x2FFF).addRange(0x3001, 0xFEFE).addRange(0xFF00, 0xFFFF),
      'w': regenerate(0x5F).addRange(0x30, 0x39).addRange(0x41, 0x5A).addRange(0x61, 0x7A),
      'W': regenerate(0x60).addRange(0x0, 0x2F).addRange(0x3A, 0x40).addRange(0x5B, 0x5E).addRange(0x7B, 0xFFFF)
    };

    exports.UNICODE = {
      'd': regenerate().addRange(0x30, 0x39),
      'D': regenerate().addRange(0x0, 0x2F).addRange(0x3A, 0x10FFFF),
      's': regenerate(0x20, 0xA0, 0x1680, 0x202F, 0x205F, 0x3000, 0xFEFF).addRange(0x9, 0xD).addRange(0x2000, 0x200A).addRange(0x2028, 0x2029),
      'S': regenerate().addRange(0x0, 0x8).addRange(0xE, 0x1F).addRange(0x21, 0x9F).addRange(0xA1, 0x167F).addRange(0x1681, 0x1FFF).addRange(0x200B, 0x2027).addRange(0x202A, 0x202E).addRange(0x2030, 0x205E).addRange(0x2060, 0x2FFF).addRange(0x3001, 0xFEFE).addRange(0xFF00, 0x10FFFF),
      'w': regenerate(0x5F).addRange(0x30, 0x39).addRange(0x41, 0x5A).addRange(0x61, 0x7A),
      'W': regenerate(0x60).addRange(0x0, 0x2F).addRange(0x3A, 0x40).addRange(0x5B, 0x5E).addRange(0x7B, 0x10FFFF)
    };

    exports.UNICODE_IGNORE_CASE = {
      'd': regenerate().addRange(0x30, 0x39),
      'D': regenerate().addRange(0x0, 0x2F).addRange(0x3A, 0x10FFFF),
      's': regenerate(0x20, 0xA0, 0x1680, 0x202F, 0x205F, 0x3000, 0xFEFF).addRange(0x9, 0xD).addRange(0x2000, 0x200A).addRange(0x2028, 0x2029),
      'S': regenerate().addRange(0x0, 0x8).addRange(0xE, 0x1F).addRange(0x21, 0x9F).addRange(0xA1, 0x167F).addRange(0x1681, 0x1FFF).addRange(0x200B, 0x2027).addRange(0x202A, 0x202E).addRange(0x2030, 0x205E).addRange(0x2060, 0x2FFF).addRange(0x3001, 0xFEFE).addRange(0xFF00, 0x10FFFF),
      'w': regenerate(0x5F, 0x17F, 0x212A).addRange(0x30, 0x39).addRange(0x41, 0x5A).addRange(0x61, 0x7A),
      'W': regenerate(0x4B, 0x53, 0x60).addRange(0x0, 0x2F).addRange(0x3A, 0x40).addRange(0x5B, 0x5E).addRange(0x7B, 0x10FFFF)
    };
  });

  var require$$0$1 = characterClassEscapeSets && (typeof characterClassEscapeSets === 'undefined' ? 'undefined' : _typeof(characterClassEscapeSets)) === 'object' && 'default' in characterClassEscapeSets ? characterClassEscapeSets['default'] : characterClassEscapeSets;

  var require$$1 = {
    "75": 8490,
    "83": 383,
    "107": 8490,
    "115": 383,
    "181": 924,
    "197": 8491,
    "383": 83,
    "452": 453,
    "453": 452,
    "455": 456,
    "456": 455,
    "458": 459,
    "459": 458,
    "497": 498,
    "498": 497,
    "837": 8126,
    "914": 976,
    "917": 1013,
    "920": 1012,
    "921": 8126,
    "922": 1008,
    "924": 181,
    "928": 982,
    "929": 1009,
    "931": 962,
    "934": 981,
    "937": 8486,
    "962": 931,
    "976": 914,
    "977": 1012,
    "981": 934,
    "982": 928,
    "1008": 922,
    "1009": 929,
    "1012": [920, 977],
    "1013": 917,
    "7776": 7835,
    "7835": 7776,
    "8126": [837, 921],
    "8486": 937,
    "8490": 75,
    "8491": 197,
    "66560": 66600,
    "66561": 66601,
    "66562": 66602,
    "66563": 66603,
    "66564": 66604,
    "66565": 66605,
    "66566": 66606,
    "66567": 66607,
    "66568": 66608,
    "66569": 66609,
    "66570": 66610,
    "66571": 66611,
    "66572": 66612,
    "66573": 66613,
    "66574": 66614,
    "66575": 66615,
    "66576": 66616,
    "66577": 66617,
    "66578": 66618,
    "66579": 66619,
    "66580": 66620,
    "66581": 66621,
    "66582": 66622,
    "66583": 66623,
    "66584": 66624,
    "66585": 66625,
    "66586": 66626,
    "66587": 66627,
    "66588": 66628,
    "66589": 66629,
    "66590": 66630,
    "66591": 66631,
    "66592": 66632,
    "66593": 66633,
    "66594": 66634,
    "66595": 66635,
    "66596": 66636,
    "66597": 66637,
    "66598": 66638,
    "66599": 66639,
    "66600": 66560,
    "66601": 66561,
    "66602": 66562,
    "66603": 66563,
    "66604": 66564,
    "66605": 66565,
    "66606": 66566,
    "66607": 66567,
    "66608": 66568,
    "66609": 66569,
    "66610": 66570,
    "66611": 66571,
    "66612": 66572,
    "66613": 66573,
    "66614": 66574,
    "66615": 66575,
    "66616": 66576,
    "66617": 66577,
    "66618": 66578,
    "66619": 66579,
    "66620": 66580,
    "66621": 66581,
    "66622": 66582,
    "66623": 66583,
    "66624": 66584,
    "66625": 66585,
    "66626": 66586,
    "66627": 66587,
    "66628": 66588,
    "66629": 66589,
    "66630": 66590,
    "66631": 66591,
    "66632": 66592,
    "66633": 66593,
    "66634": 66594,
    "66635": 66595,
    "66636": 66596,
    "66637": 66597,
    "66638": 66598,
    "66639": 66599,
    "68736": 68800,
    "68737": 68801,
    "68738": 68802,
    "68739": 68803,
    "68740": 68804,
    "68741": 68805,
    "68742": 68806,
    "68743": 68807,
    "68744": 68808,
    "68745": 68809,
    "68746": 68810,
    "68747": 68811,
    "68748": 68812,
    "68749": 68813,
    "68750": 68814,
    "68751": 68815,
    "68752": 68816,
    "68753": 68817,
    "68754": 68818,
    "68755": 68819,
    "68756": 68820,
    "68757": 68821,
    "68758": 68822,
    "68759": 68823,
    "68760": 68824,
    "68761": 68825,
    "68762": 68826,
    "68763": 68827,
    "68764": 68828,
    "68765": 68829,
    "68766": 68830,
    "68767": 68831,
    "68768": 68832,
    "68769": 68833,
    "68770": 68834,
    "68771": 68835,
    "68772": 68836,
    "68773": 68837,
    "68774": 68838,
    "68775": 68839,
    "68776": 68840,
    "68777": 68841,
    "68778": 68842,
    "68779": 68843,
    "68780": 68844,
    "68781": 68845,
    "68782": 68846,
    "68783": 68847,
    "68784": 68848,
    "68785": 68849,
    "68786": 68850,
    "68800": 68736,
    "68801": 68737,
    "68802": 68738,
    "68803": 68739,
    "68804": 68740,
    "68805": 68741,
    "68806": 68742,
    "68807": 68743,
    "68808": 68744,
    "68809": 68745,
    "68810": 68746,
    "68811": 68747,
    "68812": 68748,
    "68813": 68749,
    "68814": 68750,
    "68815": 68751,
    "68816": 68752,
    "68817": 68753,
    "68818": 68754,
    "68819": 68755,
    "68820": 68756,
    "68821": 68757,
    "68822": 68758,
    "68823": 68759,
    "68824": 68760,
    "68825": 68761,
    "68826": 68762,
    "68827": 68763,
    "68828": 68764,
    "68829": 68765,
    "68830": 68766,
    "68831": 68767,
    "68832": 68768,
    "68833": 68769,
    "68834": 68770,
    "68835": 68771,
    "68836": 68772,
    "68837": 68773,
    "68838": 68774,
    "68839": 68775,
    "68840": 68776,
    "68841": 68777,
    "68842": 68778,
    "68843": 68779,
    "68844": 68780,
    "68845": 68781,
    "68846": 68782,
    "68847": 68783,
    "68848": 68784,
    "68849": 68785,
    "68850": 68786,
    "71840": 71872,
    "71841": 71873,
    "71842": 71874,
    "71843": 71875,
    "71844": 71876,
    "71845": 71877,
    "71846": 71878,
    "71847": 71879,
    "71848": 71880,
    "71849": 71881,
    "71850": 71882,
    "71851": 71883,
    "71852": 71884,
    "71853": 71885,
    "71854": 71886,
    "71855": 71887,
    "71856": 71888,
    "71857": 71889,
    "71858": 71890,
    "71859": 71891,
    "71860": 71892,
    "71861": 71893,
    "71862": 71894,
    "71863": 71895,
    "71864": 71896,
    "71865": 71897,
    "71866": 71898,
    "71867": 71899,
    "71868": 71900,
    "71869": 71901,
    "71870": 71902,
    "71871": 71903,
    "71872": 71840,
    "71873": 71841,
    "71874": 71842,
    "71875": 71843,
    "71876": 71844,
    "71877": 71845,
    "71878": 71846,
    "71879": 71847,
    "71880": 71848,
    "71881": 71849,
    "71882": 71850,
    "71883": 71851,
    "71884": 71852,
    "71885": 71853,
    "71886": 71854,
    "71887": 71855,
    "71888": 71856,
    "71889": 71857,
    "71890": 71858,
    "71891": 71859,
    "71892": 71860,
    "71893": 71861,
    "71894": 71862,
    "71895": 71863,
    "71896": 71864,
    "71897": 71865,
    "71898": 71866,
    "71899": 71867,
    "71900": 71868,
    "71901": 71869,
    "71902": 71870,
    "71903": 71871
  };

  var parser = __commonjs(function (module) {
    // regjsparser
    //
    // ==================================================================
    //
    // See ECMA-262 Standard: 15.10.1
    //
    // NOTE: The ECMA-262 standard uses the term "Assertion" for /^/. Here the
    //   term "Anchor" is used.
    //
    // Pattern ::
    //      Disjunction
    //
    // Disjunction ::
    //      Alternative
    //      Alternative | Disjunction
    //
    // Alternative ::
    //      [empty]
    //      Alternative Term
    //
    // Term ::
    //      Anchor
    //      Atom
    //      Atom Quantifier
    //
    // Anchor ::
    //      ^
    //      $
    //      \ b
    //      \ B
    //      ( ? = Disjunction )
    //      ( ? ! Disjunction )
    //
    // Quantifier ::
    //      QuantifierPrefix
    //      QuantifierPrefix ?
    //
    // QuantifierPrefix ::
    //      *
    //      +
    //      ?
    //      { DecimalDigits }
    //      { DecimalDigits , }
    //      { DecimalDigits , DecimalDigits }
    //
    // Atom ::
    //      PatternCharacter
    //      .
    //      \ AtomEscape
    //      CharacterClass
    //      ( Disjunction )
    //      ( ? : Disjunction )
    //
    // PatternCharacter ::
    //      SourceCharacter but not any of: ^ $ \ . * + ? ( ) [ ] { } |
    //
    // AtomEscape ::
    //      DecimalEscape
    //      CharacterEscape
    //      CharacterClassEscape
    //
    // CharacterEscape[U] ::
    //      ControlEscape
    //      c ControlLetter
    //      HexEscapeSequence
    //      RegExpUnicodeEscapeSequence[?U] (ES6)
    //      IdentityEscape[?U]
    //
    // ControlEscape ::
    //      one of f n r t v
    // ControlLetter ::
    //      one of
    //          a b c d e f g h i j k l m n o p q r s t u v w x y z
    //          A B C D E F G H I J K L M N O P Q R S T U V W X Y Z
    //
    // IdentityEscape ::
    //      SourceCharacter but not IdentifierPart
    //      <ZWJ>
    //      <ZWNJ>
    //
    // DecimalEscape ::
    //      DecimalIntegerLiteral [lookahead ∉ DecimalDigit]
    //
    // CharacterClassEscape ::
    //      one of d D s S w W
    //
    // CharacterClass ::
    //      [ [lookahead ∉ {^}] ClassRanges ]
    //      [ ^ ClassRanges ]
    //
    // ClassRanges ::
    //      [empty]
    //      NonemptyClassRanges
    //
    // NonemptyClassRanges ::
    //      ClassAtom
    //      ClassAtom NonemptyClassRangesNoDash
    //      ClassAtom - ClassAtom ClassRanges
    //
    // NonemptyClassRangesNoDash ::
    //      ClassAtom
    //      ClassAtomNoDash NonemptyClassRangesNoDash
    //      ClassAtomNoDash - ClassAtom ClassRanges
    //
    // ClassAtom ::
    //      -
    //      ClassAtomNoDash
    //
    // ClassAtomNoDash ::
    //      SourceCharacter but not one of \ or ] or -
    //      \ ClassEscape
    //
    // ClassEscape ::
    //      DecimalEscape
    //      b
    //      CharacterEscape
    //      CharacterClassEscape

    (function () {

      function parse(str, flags) {
        function addRaw(node) {
          node.raw = str.substring(node.range[0], node.range[1]);
          return node;
        }

        function updateRawStart(node, start) {
          node.range[0] = start;
          return addRaw(node);
        }

        function createAnchor(kind, rawLength) {
          return addRaw({
            type: 'anchor',
            kind: kind,
            range: [pos - rawLength, pos]
          });
        }

        function createValue(kind, codePoint, from, to) {
          return addRaw({
            type: 'value',
            kind: kind,
            codePoint: codePoint,
            range: [from, to]
          });
        }

        function createEscaped(kind, codePoint, value, fromOffset) {
          fromOffset = fromOffset || 0;
          return createValue(kind, codePoint, pos - (value.length + fromOffset), pos);
        }

        function createCharacter(matches) {
          var _char = matches[0];
          var first = _char.charCodeAt(0);
          if (hasUnicodeFlag) {
            var second;
            if (_char.length === 1 && first >= 0xD800 && first <= 0xDBFF) {
              second = lookahead().charCodeAt(0);
              if (second >= 0xDC00 && second <= 0xDFFF) {
                // Unicode surrogate pair
                pos++;
                return createValue('symbol', (first - 0xD800) * 0x400 + second - 0xDC00 + 0x10000, pos - 2, pos);
              }
            }
          }
          return createValue('symbol', first, pos - 1, pos);
        }

        function createDisjunction(alternatives, from, to) {
          return addRaw({
            type: 'disjunction',
            body: alternatives,
            range: [from, to]
          });
        }

        function createDot() {
          return addRaw({
            type: 'dot',
            range: [pos - 1, pos]
          });
        }

        function createCharacterClassEscape(value) {
          return addRaw({
            type: 'characterClassEscape',
            value: value,
            range: [pos - 2, pos]
          });
        }

        function createReference(matchIndex) {
          return addRaw({
            type: 'reference',
            matchIndex: parseInt(matchIndex, 10),
            range: [pos - 1 - matchIndex.length, pos]
          });
        }

        function createGroup(behavior, disjunction, from, to) {
          return addRaw({
            type: 'group',
            behavior: behavior,
            body: disjunction,
            range: [from, to]
          });
        }

        function createQuantifier(min, max, from, to) {
          if (to == null) {
            from = pos - 1;
            to = pos;
          }

          return addRaw({
            type: 'quantifier',
            min: min,
            max: max,
            greedy: true,
            body: null, // set later on
            range: [from, to]
          });
        }

        function createAlternative(terms, from, to) {
          return addRaw({
            type: 'alternative',
            body: terms,
            range: [from, to]
          });
        }

        function createCharacterClass(classRanges, negative, from, to) {
          return addRaw({
            type: 'characterClass',
            body: classRanges,
            negative: negative,
            range: [from, to]
          });
        }

        function createClassRange(min, max, from, to) {
          // See 15.10.2.15:
          if (min.codePoint > max.codePoint) {
            bail('invalid range in character class', min.raw + '-' + max.raw, from, to);
          }

          return addRaw({
            type: 'characterClassRange',
            min: min,
            max: max,
            range: [from, to]
          });
        }

        function flattenBody(body) {
          if (body.type === 'alternative') {
            return body.body;
          } else {
            return [body];
          }
        }

        function isEmpty(obj) {
          return obj.type === 'empty';
        }

        function incr(amount) {
          amount = amount || 1;
          var res = str.substring(pos, pos + amount);
          pos += amount || 1;
          return res;
        }

        function skip(value) {
          if (!match(value)) {
            bail('character', value);
          }
        }

        function match(value) {
          if (str.indexOf(value, pos) === pos) {
            return incr(value.length);
          }
        }

        function lookahead() {
          return str[pos];
        }

        function current(value) {
          return str.indexOf(value, pos) === pos;
        }

        function next(value) {
          return str[pos + 1] === value;
        }

        function matchReg(regExp) {
          var subStr = str.substring(pos);
          var res = subStr.match(regExp);
          if (res) {
            res.range = [];
            res.range[0] = pos;
            incr(res[0].length);
            res.range[1] = pos;
          }
          return res;
        }

        function parseDisjunction() {
          // Disjunction ::
          //      Alternative
          //      Alternative | Disjunction
          var res = [],
              from = pos;
          res.push(parseAlternative());

          while (match('|')) {
            res.push(parseAlternative());
          }

          if (res.length === 1) {
            return res[0];
          }

          return createDisjunction(res, from, pos);
        }

        function parseAlternative() {
          var res = [],
              from = pos;
          var term;

          // Alternative ::
          //      [empty]
          //      Alternative Term
          while (term = parseTerm()) {
            res.push(term);
          }

          if (res.length === 1) {
            return res[0];
          }

          return createAlternative(res, from, pos);
        }

        function parseTerm() {
          // Term ::
          //      Anchor
          //      Atom
          //      Atom Quantifier

          if (pos >= str.length || current('|') || current(')')) {
            return null; /* Means: The term is empty */
          }

          var anchor = parseAnchor();

          if (anchor) {
            return anchor;
          }

          var atom = parseAtom();
          if (!atom) {
            bail('Expected atom');
          }
          var quantifier = parseQuantifier() || false;
          if (quantifier) {
            quantifier.body = flattenBody(atom);
            // The quantifier contains the atom. Therefore, the beginning of the
            // quantifier range is given by the beginning of the atom.
            updateRawStart(quantifier, atom.range[0]);
            return quantifier;
          }
          return atom;
        }

        function parseGroup(matchA, typeA, matchB, typeB) {
          var type = null,
              from = pos;

          if (match(matchA)) {
            type = typeA;
          } else if (match(matchB)) {
            type = typeB;
          } else {
            return false;
          }

          var body = parseDisjunction();
          if (!body) {
            bail('Expected disjunction');
          }
          skip(')');
          var group = createGroup(type, flattenBody(body), from, pos);

          if (type == 'normal') {
            // Keep track of the number of closed groups. This is required for
            // parseDecimalEscape(). In case the string is parsed a second time the
            // value already holds the total count and no incrementation is required.
            if (firstIteration) {
              closedCaptureCounter++;
            }
          }
          return group;
        }

        function parseAnchor() {
          // Anchor ::
          //      ^
          //      $
          //      \ b
          //      \ B
          //      ( ? = Disjunction )
          //      ( ? ! Disjunction )
          var res,
              from = pos;

          if (match('^')) {
            return createAnchor('start', 1 /* rawLength */);
          } else if (match('$')) {
            return createAnchor('end', 1 /* rawLength */);
          } else if (match('\\b')) {
            return createAnchor('boundary', 2 /* rawLength */);
          } else if (match('\\B')) {
            return createAnchor('not-boundary', 2 /* rawLength */);
          } else {
            return parseGroup('(?=', 'lookahead', '(?!', 'negativeLookahead');
          }
        }

        function parseQuantifier() {
          // Quantifier ::
          //      QuantifierPrefix
          //      QuantifierPrefix ?
          //
          // QuantifierPrefix ::
          //      *
          //      +
          //      ?
          //      { DecimalDigits }
          //      { DecimalDigits , }
          //      { DecimalDigits , DecimalDigits }

          var res,
              from = pos;
          var quantifier;
          var min, max;

          if (match('*')) {
            quantifier = createQuantifier(0);
          } else if (match('+')) {
            quantifier = createQuantifier(1);
          } else if (match('?')) {
            quantifier = createQuantifier(0, 1);
          } else if (res = matchReg(/^\{([0-9]+)\}/)) {
            min = parseInt(res[1], 10);
            quantifier = createQuantifier(min, min, res.range[0], res.range[1]);
          } else if (res = matchReg(/^\{([0-9]+),\}/)) {
            min = parseInt(res[1], 10);
            quantifier = createQuantifier(min, undefined, res.range[0], res.range[1]);
          } else if (res = matchReg(/^\{([0-9]+),([0-9]+)\}/)) {
            min = parseInt(res[1], 10);
            max = parseInt(res[2], 10);
            if (min > max) {
              bail('numbers out of order in {} quantifier', '', from, pos);
            }
            quantifier = createQuantifier(min, max, res.range[0], res.range[1]);
          }

          if (quantifier) {
            if (match('?')) {
              quantifier.greedy = false;
              quantifier.range[1] += 1;
            }
          }

          return quantifier;
        }

        function parseAtom() {
          // Atom ::
          //      PatternCharacter
          //      .
          //      \ AtomEscape
          //      CharacterClass
          //      ( Disjunction )
          //      ( ? : Disjunction )

          var res;

          // jviereck: allow ']', '}' here as well to be compatible with browser's
          //   implementations: ']'.match(/]/);
          // if (res = matchReg(/^[^^$\\.*+?()[\]{}|]/)) {
          if (res = matchReg(/^[^^$\\.*+?(){[|]/)) {
            //      PatternCharacter
            return createCharacter(res);
          } else if (match('.')) {
            //      .
            return createDot();
          } else if (match('\\')) {
            //      \ AtomEscape
            res = parseAtomEscape();
            if (!res) {
              bail('atomEscape');
            }
            return res;
          } else if (res = parseCharacterClass()) {
            return res;
          } else {
            //      ( Disjunction )
            //      ( ? : Disjunction )
            return parseGroup('(?:', 'ignore', '(', 'normal');
          }
        }

        function parseUnicodeSurrogatePairEscape(firstEscape) {
          if (hasUnicodeFlag) {
            var first, second;
            if (firstEscape.kind == 'unicodeEscape' && (first = firstEscape.codePoint) >= 0xD800 && first <= 0xDBFF && current('\\') && next('u')) {
              var prevPos = pos;
              pos++;
              var secondEscape = parseClassEscape();
              if (secondEscape.kind == 'unicodeEscape' && (second = secondEscape.codePoint) >= 0xDC00 && second <= 0xDFFF) {
                // Unicode surrogate pair
                firstEscape.range[1] = secondEscape.range[1];
                firstEscape.codePoint = (first - 0xD800) * 0x400 + second - 0xDC00 + 0x10000;
                firstEscape.type = 'value';
                firstEscape.kind = 'unicodeCodePointEscape';
                addRaw(firstEscape);
              } else {
                pos = prevPos;
              }
            }
          }
          return firstEscape;
        }

        function parseClassEscape() {
          return parseAtomEscape(true);
        }

        function parseAtomEscape(insideCharacterClass) {
          // AtomEscape ::
          //      DecimalEscape
          //      CharacterEscape
          //      CharacterClassEscape

          var res,
              from = pos;

          res = parseDecimalEscape();
          if (res) {
            return res;
          }

          // For ClassEscape
          if (insideCharacterClass) {
            if (match('b')) {
              // 15.10.2.19
              // The production ClassEscape :: b evaluates by returning the
              // CharSet containing the one character <BS> (Unicode value 0008).
              return createEscaped('singleEscape', 0x0008, '\\b');
            } else if (match('B')) {
              bail('\\B not possible inside of CharacterClass', '', from);
            }
          }

          res = parseCharacterEscape();

          return res;
        }

        function parseDecimalEscape() {
          // DecimalEscape ::
          //      DecimalIntegerLiteral [lookahead ∉ DecimalDigit]
          //      CharacterClassEscape :: one of d D s S w W

          var res, match;

          if (res = matchReg(/^(?!0)\d+/)) {
            match = res[0];
            var refIdx = parseInt(res[0], 10);
            if (refIdx <= closedCaptureCounter) {
              // If the number is smaller than the normal-groups found so
              // far, then it is a reference...
              return createReference(res[0]);
            } else {
              // ... otherwise it needs to be interpreted as a octal (if the
              // number is in an octal format). If it is NOT octal format,
              // then the slash is ignored and the number is matched later
              // as normal characters.

              // Recall the negative decision to decide if the input must be parsed
              // a second time with the total normal-groups.
              backrefDenied.push(refIdx);

              // Reset the position again, as maybe only parts of the previous
              // matched numbers are actual octal numbers. E.g. in '019' only
              // the '01' should be matched.
              incr(-res[0].length);
              if (res = matchReg(/^[0-7]{1,3}/)) {
                return createEscaped('octal', parseInt(res[0], 8), res[0], 1);
              } else {
                // If we end up here, we have a case like /\91/. Then the
                // first slash is to be ignored and the 9 & 1 to be treated
                // like ordinary characters. Create a character for the
                // first number only here - other number-characters
                // (if available) will be matched later.
                res = createCharacter(matchReg(/^[89]/));
                return updateRawStart(res, res.range[0] - 1);
              }
            }
          }
          // Only allow octal numbers in the following. All matched numbers start
          // with a zero (if the do not, the previous if-branch is executed).
          // If the number is not octal format and starts with zero (e.g. `091`)
          // then only the zeros `0` is treated here and the `91` are ordinary
          // characters.
          // Example:
          //   /\091/.exec('\091')[0].length === 3
          else if (res = matchReg(/^[0-7]{1,3}/)) {
              match = res[0];
              if (/^0{1,3}$/.test(match)) {
                // If they are all zeros, then only take the first one.
                return createEscaped('null', 0x0000, '0', match.length + 1);
              } else {
                return createEscaped('octal', parseInt(match, 8), match, 1);
              }
            } else if (res = matchReg(/^[dDsSwW]/)) {
              return createCharacterClassEscape(res[0]);
            }
          return false;
        }

        function parseCharacterEscape() {
          // CharacterEscape ::
          //      ControlEscape
          //      c ControlLetter
          //      HexEscapeSequence
          //      UnicodeEscapeSequence
          //      IdentityEscape

          var res;
          if (res = matchReg(/^[fnrtv]/)) {
            // ControlEscape
            var codePoint = 0;
            switch (res[0]) {
              case 't':
                codePoint = 0x009;break;
              case 'n':
                codePoint = 0x00A;break;
              case 'v':
                codePoint = 0x00B;break;
              case 'f':
                codePoint = 0x00C;break;
              case 'r':
                codePoint = 0x00D;break;
            }
            return createEscaped('singleEscape', codePoint, '\\' + res[0]);
          } else if (res = matchReg(/^c([a-zA-Z])/)) {
            // c ControlLetter
            return createEscaped('controlLetter', res[1].charCodeAt(0) % 32, res[1], 2);
          } else if (res = matchReg(/^x([0-9a-fA-F]{2})/)) {
            // HexEscapeSequence
            return createEscaped('hexadecimalEscape', parseInt(res[1], 16), res[1], 2);
          } else if (res = matchReg(/^u([0-9a-fA-F]{4})/)) {
            // UnicodeEscapeSequence
            return parseUnicodeSurrogatePairEscape(createEscaped('unicodeEscape', parseInt(res[1], 16), res[1], 2));
          } else if (hasUnicodeFlag && (res = matchReg(/^u\{([0-9a-fA-F]+)\}/))) {
            // RegExpUnicodeEscapeSequence (ES6 Unicode code point escape)
            return createEscaped('unicodeCodePointEscape', parseInt(res[1], 16), res[1], 4);
          } else {
            // IdentityEscape
            return parseIdentityEscape();
          }
        }

        // Taken from the Esprima parser.
        function isIdentifierPart(ch) {
          // Generated by `tools/generate-identifier-regex.js`.
          var NonAsciiIdentifierPart = new RegExp('[\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0300-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u0483-\u0487\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u05D0-\u05EA\u05F0-\u05F2\u0610-\u061A\u0620-\u0669\u066E-\u06D3\u06D5-\u06DC\u06DF-\u06E8\u06EA-\u06FC\u06FF\u0710-\u074A\u074D-\u07B1\u07C0-\u07F5\u07FA\u0800-\u082D\u0840-\u085B\u08A0-\u08B2\u08E4-\u0963\u0966-\u096F\u0971-\u0983\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BC-\u09C4\u09C7\u09C8\u09CB-\u09CE\u09D7\u09DC\u09DD\u09DF-\u09E3\u09E6-\u09F1\u0A01-\u0A03\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A59-\u0A5C\u0A5E\u0A66-\u0A75\u0A81-\u0A83\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABC-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AD0\u0AE0-\u0AE3\u0AE6-\u0AEF\u0B01-\u0B03\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3C-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B56\u0B57\u0B5C\u0B5D\u0B5F-\u0B63\u0B66-\u0B6F\u0B71\u0B82\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD0\u0BD7\u0BE6-\u0BEF\u0C00-\u0C03\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C58\u0C59\u0C60-\u0C63\u0C66-\u0C6F\u0C81-\u0C83\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBC-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CDE\u0CE0-\u0CE3\u0CE6-\u0CEF\u0CF1\u0CF2\u0D01-\u0D03\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D-\u0D44\u0D46-\u0D48\u0D4A-\u0D4E\u0D57\u0D60-\u0D63\u0D66-\u0D6F\u0D7A-\u0D7F\u0D82\u0D83\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2\u0DF3\u0E01-\u0E3A\u0E40-\u0E4E\u0E50-\u0E59\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB9\u0EBB-\u0EBD\u0EC0-\u0EC4\u0EC6\u0EC8-\u0ECD\u0ED0-\u0ED9\u0EDC-\u0EDF\u0F00\u0F18\u0F19\u0F20-\u0F29\u0F35\u0F37\u0F39\u0F3E-\u0F47\u0F49-\u0F6C\u0F71-\u0F84\u0F86-\u0F97\u0F99-\u0FBC\u0FC6\u1000-\u1049\u1050-\u109D\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u135D-\u135F\u1380-\u138F\u13A0-\u13F4\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1714\u1720-\u1734\u1740-\u1753\u1760-\u176C\u176E-\u1770\u1772\u1773\u1780-\u17D3\u17D7\u17DC\u17DD\u17E0-\u17E9\u180B-\u180D\u1810-\u1819\u1820-\u1877\u1880-\u18AA\u18B0-\u18F5\u1900-\u191E\u1920-\u192B\u1930-\u193B\u1946-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u19D0-\u19D9\u1A00-\u1A1B\u1A20-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AA7\u1AB0-\u1ABD\u1B00-\u1B4B\u1B50-\u1B59\u1B6B-\u1B73\u1B80-\u1BF3\u1C00-\u1C37\u1C40-\u1C49\u1C4D-\u1C7D\u1CD0-\u1CD2\u1CD4-\u1CF6\u1CF8\u1CF9\u1D00-\u1DF5\u1DFC-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u200C\u200D\u203F\u2040\u2054\u2071\u207F\u2090-\u209C\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D7F-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2DE0-\u2DFF\u2E2F\u3005-\u3007\u3021-\u302F\u3031-\u3035\u3038-\u303C\u3041-\u3096\u3099\u309A\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312D\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FCC\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA62B\uA640-\uA66F\uA674-\uA67D\uA67F-\uA69D\uA69F-\uA6F1\uA717-\uA71F\uA722-\uA788\uA78B-\uA78E\uA790-\uA7AD\uA7B0\uA7B1\uA7F7-\uA827\uA840-\uA873\uA880-\uA8C4\uA8D0-\uA8D9\uA8E0-\uA8F7\uA8FB\uA900-\uA92D\uA930-\uA953\uA960-\uA97C\uA980-\uA9C0\uA9CF-\uA9D9\uA9E0-\uA9FE\uAA00-\uAA36\uAA40-\uAA4D\uAA50-\uAA59\uAA60-\uAA76\uAA7A-\uAAC2\uAADB-\uAADD\uAAE0-\uAAEF\uAAF2-\uAAF6\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB5F\uAB64\uAB65\uABC0-\uABEA\uABEC\uABED\uABF0-\uABF9\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE00-\uFE0F\uFE20-\uFE2D\uFE33\uFE34\uFE4D-\uFE4F\uFE70-\uFE74\uFE76-\uFEFC\uFF10-\uFF19\uFF21-\uFF3A\uFF3F\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]');

          return ch === 36 || ch === 95 || // $ (dollar) and _ (underscore)
          ch >= 65 && ch <= 90 || // A..Z
          ch >= 97 && ch <= 122 || // a..z
          ch >= 48 && ch <= 57 || // 0..9
          ch === 92 || // \ (backslash)
          ch >= 0x80 && NonAsciiIdentifierPart.test(String.fromCharCode(ch));
        }

        function parseIdentityEscape() {
          // IdentityEscape ::
          //      SourceCharacter but not IdentifierPart
          //      <ZWJ>
          //      <ZWNJ>

          var ZWJ = '\u200C';
          var ZWNJ = '\u200D';

          var tmp;

          if (!isIdentifierPart(lookahead())) {
            tmp = incr();
            return createEscaped('identifier', tmp.charCodeAt(0), tmp, 1);
          }

          if (match(ZWJ)) {
            // <ZWJ>
            return createEscaped('identifier', 0x200C, ZWJ);
          } else if (match(ZWNJ)) {
            // <ZWNJ>
            return createEscaped('identifier', 0x200D, ZWNJ);
          }

          return null;
        }

        function parseCharacterClass() {
          // CharacterClass ::
          //      [ [lookahead ∉ {^}] ClassRanges ]
          //      [ ^ ClassRanges ]

          var res,
              from = pos;
          if (res = matchReg(/^\[\^/)) {
            res = parseClassRanges();
            skip(']');
            return createCharacterClass(res, true, from, pos);
          } else if (match('[')) {
            res = parseClassRanges();
            skip(']');
            return createCharacterClass(res, false, from, pos);
          }

          return null;
        }

        function parseClassRanges() {
          // ClassRanges ::
          //      [empty]
          //      NonemptyClassRanges

          var res;
          if (current(']')) {
            // Empty array means nothing insinde of the ClassRange.
            return [];
          } else {
            res = parseNonemptyClassRanges();
            if (!res) {
              bail('nonEmptyClassRanges');
            }
            return res;
          }
        }

        function parseHelperClassRanges(atom) {
          var from, to, res;
          if (current('-') && !next(']')) {
            // ClassAtom - ClassAtom ClassRanges
            skip('-');

            res = parseClassAtom();
            if (!res) {
              bail('classAtom');
            }
            to = pos;
            var classRanges = parseClassRanges();
            if (!classRanges) {
              bail('classRanges');
            }
            from = atom.range[0];
            if (classRanges.type === 'empty') {
              return [createClassRange(atom, res, from, to)];
            }
            return [createClassRange(atom, res, from, to)].concat(classRanges);
          }

          res = parseNonemptyClassRangesNoDash();
          if (!res) {
            bail('nonEmptyClassRangesNoDash');
          }

          return [atom].concat(res);
        }

        function parseNonemptyClassRanges() {
          // NonemptyClassRanges ::
          //      ClassAtom
          //      ClassAtom NonemptyClassRangesNoDash
          //      ClassAtom - ClassAtom ClassRanges

          var atom = parseClassAtom();
          if (!atom) {
            bail('classAtom');
          }

          if (current(']')) {
            // ClassAtom
            return [atom];
          }

          // ClassAtom NonemptyClassRangesNoDash
          // ClassAtom - ClassAtom ClassRanges
          return parseHelperClassRanges(atom);
        }

        function parseNonemptyClassRangesNoDash() {
          // NonemptyClassRangesNoDash ::
          //      ClassAtom
          //      ClassAtomNoDash NonemptyClassRangesNoDash
          //      ClassAtomNoDash - ClassAtom ClassRanges

          var res = parseClassAtom();
          if (!res) {
            bail('classAtom');
          }
          if (current(']')) {
            //      ClassAtom
            return res;
          }

          // ClassAtomNoDash NonemptyClassRangesNoDash
          // ClassAtomNoDash - ClassAtom ClassRanges
          return parseHelperClassRanges(res);
        }

        function parseClassAtom() {
          // ClassAtom ::
          //      -
          //      ClassAtomNoDash
          if (match('-')) {
            return createCharacter('-');
          } else {
            return parseClassAtomNoDash();
          }
        }

        function parseClassAtomNoDash() {
          // ClassAtomNoDash ::
          //      SourceCharacter but not one of \ or ] or -
          //      \ ClassEscape

          var res;
          if (res = matchReg(/^[^\\\]-]/)) {
            return createCharacter(res[0]);
          } else if (match('\\')) {
            res = parseClassEscape();
            if (!res) {
              bail('classEscape');
            }

            return parseUnicodeSurrogatePairEscape(res);
          }
        }

        function bail(message, details, from, to) {
          from = from == null ? pos : from;
          to = to == null ? from : to;

          var contextStart = Math.max(0, from - 10);
          var contextEnd = Math.min(to + 10, str.length);

          // Output a bit of context and a line pointing to where our error is.
          //
          // We are assuming that there are no actual newlines in the content as this is a regular expression.
          var context = '    ' + str.substring(contextStart, contextEnd);
          var pointer = '    ' + new Array(from - contextStart + 1).join(' ') + '^';

          throw SyntaxError(message + ' at position ' + from + (details ? ': ' + details : '') + '\n' + context + '\n' + pointer);
        }

        var backrefDenied = [];
        var closedCaptureCounter = 0;
        var firstIteration = true;
        var hasUnicodeFlag = (flags || "").indexOf("u") !== -1;
        var pos = 0;

        // Convert the input to a string and treat the empty string special.
        str = String(str);
        if (str === '') {
          str = '(?:)';
        }

        var result = parseDisjunction();

        if (result.range[1] !== str.length) {
          bail('Could not parse entire input - got stuck', '', result.range[1]);
        }

        // The spec requires to interpret the `\2` in `/\2()()/` as backreference.
        // As the parser collects the number of capture groups as the string is
        // parsed it is impossible to make these decisions at the point when the
        // `\2` is handled. In case the local decision turns out to be wrong after
        // the parsing has finished, the input string is parsed a second time with
        // the total number of capture groups set.
        //
        // SEE: https://github.com/jviereck/regjsparser/issues/70
        for (var i = 0; i < backrefDenied.length; i++) {
          if (backrefDenied[i] <= closedCaptureCounter) {
            // Parse the input a second time.
            pos = 0;
            firstIteration = false;
            return parseDisjunction();
          }
        }

        return result;
      }

      var regjsparser = {
        parse: parse
      };

      if (typeof module !== 'undefined' && module.exports) {
        module.exports = regjsparser;
      } else {
        window.regjsparser = regjsparser;
      }
    })();
  });

  var require$$3 = parser && (typeof parser === 'undefined' ? 'undefined' : _typeof(parser)) === 'object' && 'default' in parser ? parser['default'] : parser;

  var regjsgen = __commonjs(function (module, exports, global) {
    /*!
     * RegJSGen
     * Copyright 2014 Benjamin Tan <https://d10.github.io/>
     * Available under MIT license <http://d10.mit-license.org/>
     */
    ;(function () {
      'use strict';

      /** Used to determine if values are of the language type `Object` */

      var objectTypes = {
        'function': true,
        'object': true
      };

      /** Used as a reference to the global object */
      var root = objectTypes[typeof window === 'undefined' ? 'undefined' : _typeof(window)] && window || this;

      /** Backup possible global object */
      var oldRoot = root;

      /** Detect free variable `exports` */
      var freeExports = objectTypes[typeof exports === 'undefined' ? 'undefined' : _typeof(exports)] && exports;

      /** Detect free variable `module` */
      var freeModule = objectTypes[typeof module === 'undefined' ? 'undefined' : _typeof(module)] && module && !module.nodeType && module;

      /** Detect free variable `global` from Node.js or Browserified code and use it as `root` */
      var freeGlobal = freeExports && freeModule && (typeof global === 'undefined' ? 'undefined' : _typeof(global)) == 'object' && global;
      if (freeGlobal && (freeGlobal.global === freeGlobal || freeGlobal.window === freeGlobal || freeGlobal.self === freeGlobal)) {
        root = freeGlobal;
      }

      /*--------------------------------------------------------------------------*/

      /*! Based on https://mths.be/fromcodepoint v0.2.0 by @mathias */

      var stringFromCharCode = String.fromCharCode;
      var floor = Math.floor;
      function fromCodePoint() {
        var MAX_SIZE = 0x4000;
        var codeUnits = [];
        var highSurrogate;
        var lowSurrogate;
        var index = -1;
        var length = arguments.length;
        if (!length) {
          return '';
        }
        var result = '';
        while (++index < length) {
          var codePoint = Number(arguments[index]);
          if (!isFinite(codePoint) || // `NaN`, `+Infinity`, or `-Infinity`
          codePoint < 0 || // not a valid Unicode code point
          codePoint > 0x10FFFF || // not a valid Unicode code point
          floor(codePoint) != codePoint // not an integer
          ) {
              throw RangeError('Invalid code point: ' + codePoint);
            }
          if (codePoint <= 0xFFFF) {
            // BMP code point
            codeUnits.push(codePoint);
          } else {
            // Astral code point; split in surrogate halves
            // http://mathiasbynens.be/notes/javascript-encoding#surrogate-formulae
            codePoint -= 0x10000;
            highSurrogate = (codePoint >> 10) + 0xD800;
            lowSurrogate = codePoint % 0x400 + 0xDC00;
            codeUnits.push(highSurrogate, lowSurrogate);
          }
          if (index + 1 == length || codeUnits.length > MAX_SIZE) {
            result += stringFromCharCode.apply(null, codeUnits);
            codeUnits.length = 0;
          }
        }
        return result;
      }

      function assertType(type, expected) {
        if (expected.indexOf('|') == -1) {
          if (type == expected) {
            return;
          }

          throw Error('Invalid node type: ' + type);
        }

        expected = assertType.hasOwnProperty(expected) ? assertType[expected] : assertType[expected] = RegExp('^(?:' + expected + ')$');

        if (expected.test(type)) {
          return;
        }

        throw Error('Invalid node type: ' + type);
      }

      /*--------------------------------------------------------------------------*/

      function generate(node) {
        var type = node.type;

        if (generate.hasOwnProperty(type) && typeof generate[type] == 'function') {
          return generate[type](node);
        }

        throw Error('Invalid node type: ' + type);
      }

      /*--------------------------------------------------------------------------*/

      function generateAlternative(node) {
        assertType(node.type, 'alternative');

        var terms = node.body,
            length = terms ? terms.length : 0;

        if (length == 1) {
          return generateTerm(terms[0]);
        } else {
          var i = -1,
              result = '';

          while (++i < length) {
            result += generateTerm(terms[i]);
          }

          return result;
        }
      }

      function generateAnchor(node) {
        assertType(node.type, 'anchor');

        switch (node.kind) {
          case 'start':
            return '^';
          case 'end':
            return '$';
          case 'boundary':
            return '\\b';
          case 'not-boundary':
            return '\\B';
          default:
            throw Error('Invalid assertion');
        }
      }

      function generateAtom(node) {
        assertType(node.type, 'anchor|characterClass|characterClassEscape|dot|group|reference|value');

        return generate(node);
      }

      function generateCharacterClass(node) {
        assertType(node.type, 'characterClass');

        var classRanges = node.body,
            length = classRanges ? classRanges.length : 0;

        var i = -1,
            result = '[';

        if (node.negative) {
          result += '^';
        }

        while (++i < length) {
          result += generateClassAtom(classRanges[i]);
        }

        result += ']';

        return result;
      }

      function generateCharacterClassEscape(node) {
        assertType(node.type, 'characterClassEscape');

        return '\\' + node.value;
      }

      function generateCharacterClassRange(node) {
        assertType(node.type, 'characterClassRange');

        var min = node.min,
            max = node.max;

        if (min.type == 'characterClassRange' || max.type == 'characterClassRange') {
          throw Error('Invalid character class range');
        }

        return generateClassAtom(min) + '-' + generateClassAtom(max);
      }

      function generateClassAtom(node) {
        assertType(node.type, 'anchor|characterClassEscape|characterClassRange|dot|value');

        return generate(node);
      }

      function generateDisjunction(node) {
        assertType(node.type, 'disjunction');

        var body = node.body,
            length = body ? body.length : 0;

        if (length == 0) {
          throw Error('No body');
        } else if (length == 1) {
          return generate(body[0]);
        } else {
          var i = -1,
              result = '';

          while (++i < length) {
            if (i != 0) {
              result += '|';
            }
            result += generate(body[i]);
          }

          return result;
        }
      }

      function generateDot(node) {
        assertType(node.type, 'dot');

        return '.';
      }

      function generateGroup(node) {
        assertType(node.type, 'group');

        var result = '(';

        switch (node.behavior) {
          case 'normal':
            break;
          case 'ignore':
            result += '?:';
            break;
          case 'lookahead':
            result += '?=';
            break;
          case 'negativeLookahead':
            result += '?!';
            break;
          default:
            throw Error('Invalid behaviour: ' + node.behaviour);
        }

        var body = node.body,
            length = body ? body.length : 0;

        if (length == 1) {
          result += generate(body[0]);
        } else {
          var i = -1;

          while (++i < length) {
            result += generate(body[i]);
          }
        }

        result += ')';

        return result;
      }

      function generateQuantifier(node) {
        assertType(node.type, 'quantifier');

        var quantifier = '',
            min = node.min,
            max = node.max;

        switch (max) {
          case undefined:
          case null:
            switch (min) {
              case 0:
                quantifier = '*';
                break;
              case 1:
                quantifier = '+';
                break;
              default:
                quantifier = '{' + min + ',}';
                break;
            }
            break;
          default:
            if (min == max) {
              quantifier = '{' + min + '}';
            } else if (min == 0 && max == 1) {
              quantifier = '?';
            } else {
              quantifier = '{' + min + ',' + max + '}';
            }
            break;
        }

        if (!node.greedy) {
          quantifier += '?';
        }

        return generateAtom(node.body[0]) + quantifier;
      }

      function generateReference(node) {
        assertType(node.type, 'reference');

        return '\\' + node.matchIndex;
      }

      function generateTerm(node) {
        assertType(node.type, 'anchor|characterClass|characterClassEscape|empty|group|quantifier|reference|value');

        return generate(node);
      }

      function generateValue(node) {
        assertType(node.type, 'value');

        var kind = node.kind,
            codePoint = node.codePoint;

        switch (kind) {
          case 'controlLetter':
            return '\\c' + fromCodePoint(codePoint + 64);
          case 'hexadecimalEscape':
            return '\\x' + ('00' + codePoint.toString(16).toUpperCase()).slice(-2);
          case 'identifier':
            return '\\' + fromCodePoint(codePoint);
          case 'null':
            return '\\' + codePoint;
          case 'octal':
            return '\\' + codePoint.toString(8);
          case 'singleEscape':
            switch (codePoint) {
              case 0x0008:
                return '\\b';
              case 0x009:
                return '\\t';
              case 0x00A:
                return '\\n';
              case 0x00B:
                return '\\v';
              case 0x00C:
                return '\\f';
              case 0x00D:
                return '\\r';
              default:
                throw Error('Invalid codepoint: ' + codePoint);
            }
          case 'symbol':
            return fromCodePoint(codePoint);
          case 'unicodeEscape':
            return '\\u' + ('0000' + codePoint.toString(16).toUpperCase()).slice(-4);
          case 'unicodeCodePointEscape':
            return '\\u{' + codePoint.toString(16).toUpperCase() + '}';
          default:
            throw Error('Unsupported node kind: ' + kind);
        }
      }

      /*--------------------------------------------------------------------------*/

      generate.alternative = generateAlternative;
      generate.anchor = generateAnchor;
      generate.characterClass = generateCharacterClass;
      generate.characterClassEscape = generateCharacterClassEscape;
      generate.characterClassRange = generateCharacterClassRange;
      generate.disjunction = generateDisjunction;
      generate.dot = generateDot;
      generate.group = generateGroup;
      generate.quantifier = generateQuantifier;
      generate.reference = generateReference;
      generate.value = generateValue;

      /*--------------------------------------------------------------------------*/

      // export regjsgen
      // some AMD build optimizers, like r.js, check for condition patterns like the following:
      if (typeof define == 'function' && _typeof(define.amd) == 'object' && define.amd) {
        // define as an anonymous module so, through path mapping, it can be aliased
        define(function () {
          return {
            'generate': generate
          };
        });
      }
      // check for `exports` after `define` in case a build optimizer adds an `exports` object
      else if (freeExports && freeModule) {
          // in Narwhal, Node.js, Rhino -require, or RingoJS
          freeExports.generate = generate;
        }
        // in a browser or Rhino
        else {
            root.regjsgen = {
              'generate': generate
            };
          }
    }).call(__commonjs_global);
  });

  var require$$4 = regjsgen && (typeof regjsgen === 'undefined' ? 'undefined' : _typeof(regjsgen)) === 'object' && 'default' in regjsgen ? regjsgen['default'] : regjsgen;

  var rewritePattern = __commonjs(function (module) {
    var generate = require$$4.generate;
    var parse = require$$3.parse;
    var regenerate = require$$0$2;
    var iuMappings = require$$1;
    var ESCAPE_SETS = require$$0$1;

    function getCharacterClassEscapeSet(character) {
      if (unicode) {
        if (ignoreCase) {
          return ESCAPE_SETS.UNICODE_IGNORE_CASE[character];
        }
        return ESCAPE_SETS.UNICODE[character];
      }
      return ESCAPE_SETS.REGULAR[character];
    }

    var object = {};
    var hasOwnProperty = object.hasOwnProperty;
    function has(object, property) {
      return hasOwnProperty.call(object, property);
    }

    // Prepare a Regenerate set containing all code points, used for negative
    // character classes (if any).
    var UNICODE_SET = regenerate().addRange(0x0, 0x10FFFF);
    // Without the `u` flag, the range stops at 0xFFFF.
    // https://mths.be/es6#sec-pattern-semantics
    var BMP_SET = regenerate().addRange(0x0, 0xFFFF);

    // Prepare a Regenerate set containing all code points that are supposed to be
    // matched by `/./u`. https://mths.be/es6#sec-atom
    var DOT_SET_UNICODE = UNICODE_SET.clone() // all Unicode code points
    .remove(
    // minus `LineTerminator`s (https://mths.be/es6#sec-line-terminators):
    0x000A, // Line Feed <LF>
    0x000D, // Carriage Return <CR>
    0x2028, // Line Separator <LS>
    0x2029 // Paragraph Separator <PS>
    );
    // Prepare a Regenerate set containing all code points that are supposed to be
    // matched by `/./` (only BMP code points).
    var DOT_SET = DOT_SET_UNICODE.clone().intersection(BMP_SET);

    // Add a range of code points + any case-folded code points in that range to a
    // set.
    regenerate.prototype.iuAddRange = function (min, max) {
      var $this = this;
      do {
        var folded = caseFold(min);
        if (folded) {
          $this.add(folded);
        }
      } while (++min <= max);
      return $this;
    };

    function assign(target, source) {
      for (var key in source) {
        // Note: `hasOwnProperty` is not needed here.
        target[key] = source[key];
      }
    }

    function update(item, pattern) {
      // TODO: Test if memoizing `pattern` here is worth the effort.
      if (!pattern) {
        return;
      }
      var tree = parse(pattern, '');
      switch (tree.type) {
        case 'characterClass':
        case 'group':
        case 'value':
          // No wrapping needed.
          break;
        default:
          // Wrap the pattern in a non-capturing group.
          tree = wrap(tree, pattern);
      }
      assign(item, tree);
    }

    function wrap(tree, pattern) {
      // Wrap the pattern in a non-capturing group.
      return {
        'type': 'group',
        'behavior': 'ignore',
        'body': [tree],
        'raw': '(?:' + pattern + ')'
      };
    }

    function caseFold(codePoint) {
      return has(iuMappings, codePoint) ? iuMappings[codePoint] : false;
    }

    var ignoreCase = false;
    var unicode = false;
    function processCharacterClass(characterClassItem) {
      var set = regenerate();
      var body = characterClassItem.body.forEach(function (item) {
        switch (item.type) {
          case 'value':
            set.add(item.codePoint);
            if (ignoreCase && unicode) {
              var folded = caseFold(item.codePoint);
              if (folded) {
                set.add(folded);
              }
            }
            break;
          case 'characterClassRange':
            var min = item.min.codePoint;
            var max = item.max.codePoint;
            set.addRange(min, max);
            if (ignoreCase && unicode) {
              set.iuAddRange(min, max);
            }
            break;
          case 'characterClassEscape':
            set.add(getCharacterClassEscapeSet(item.value));
            break;
          // The `default` clause is only here as a safeguard; it should never be
          // reached. Code coverage tools should ignore it.
          /* istanbul ignore next */
          default:
            throw Error('Unknown term type: ' + item.type);
        }
      });
      if (characterClassItem.negative) {
        set = (unicode ? UNICODE_SET : BMP_SET).clone().remove(set);
      }
      update(characterClassItem, set.toString());
      return characterClassItem;
    }

    function processTerm(item) {
      switch (item.type) {
        case 'dot':
          update(item, (unicode ? DOT_SET_UNICODE : DOT_SET).toString());
          break;
        case 'characterClass':
          item = processCharacterClass(item);
          break;
        case 'characterClassEscape':
          update(item, getCharacterClassEscapeSet(item.value).toString());
          break;
        case 'alternative':
        case 'disjunction':
        case 'group':
        case 'quantifier':
          item.body = item.body.map(processTerm);
          break;
        case 'value':
          var codePoint = item.codePoint;
          var set = regenerate(codePoint);
          if (ignoreCase && unicode) {
            var folded = caseFold(codePoint);
            if (folded) {
              set.add(folded);
            }
          }
          update(item, set.toString());
          break;
        case 'anchor':
        case 'empty':
        case 'group':
        case 'reference':
          // Nothing to do here.
          break;
        // The `default` clause is only here as a safeguard; it should never be
        // reached. Code coverage tools should ignore it.
        /* istanbul ignore next */
        default:
          throw Error('Unknown term type: ' + item.type);
      }
      return item;
    };

    module.exports = function (pattern, flags) {
      var tree = parse(pattern, flags);
      ignoreCase = flags ? flags.indexOf('i') > -1 : false;
      unicode = flags ? flags.indexOf('u') > -1 : false;
      assign(tree, processTerm(tree));
      return generate(tree);
    };
  });

  var rewritePattern$1 = rewritePattern && (typeof rewritePattern === 'undefined' ? 'undefined' : _typeof(rewritePattern)) === 'object' && 'default' in rewritePattern ? rewritePattern['default'] : rewritePattern;

  var Literal = function (Node) {
    function Literal() {
      Node.apply(this, arguments);
    }

    if (Node) Literal.__proto__ = Node;
    Literal.prototype = Object.create(Node && Node.prototype);
    Literal.prototype.constructor = Literal;

    Literal.prototype.initialise = function initialise() {
      if (typeof this.value === 'string') {
        this.program.indentExclusionElements.push(this);
      }
    };

    Literal.prototype.transpile = function transpile(code, transforms) {
      if (transforms.numericLiteral) {
        var leading = this.raw.slice(0, 2);
        if (leading === '0b' || leading === '0o') {
          code.overwrite(this.start, this.end, String(this.value), true);
        }
      }

      if (this.regex) {
        var ref = this.regex;
        var pattern = ref.pattern;
        var flags = ref.flags;

        if (transforms.stickyRegExp && /y/.test(flags)) throw new CompileError(this, 'Regular expression sticky flag is not supported');
        if (transforms.unicodeRegExp && /u/.test(flags)) {
          code.overwrite(this.start, this.end, "/" + rewritePattern$1(pattern, flags) + "/" + flags.replace('u', ''));
        }
      }
    };

    return Literal;
  }(Node);

  var MemberExpression = function (Node) {
    function MemberExpression() {
      Node.apply(this, arguments);
    }

    if (Node) MemberExpression.__proto__ = Node;
    MemberExpression.prototype = Object.create(Node && Node.prototype);
    MemberExpression.prototype.constructor = MemberExpression;

    MemberExpression.prototype.transpile = function transpile(code, transforms) {
      if (transforms.reservedProperties && reserved[this.property.name]) {
        code.overwrite(this.object.end, this.property.start, "['");
        code.insertLeft(this.property.end, "']");
      }

      Node.prototype.transpile.call(this, code, transforms);
    };

    return MemberExpression;
  }(Node);

  var NewExpression = function (Node) {
    function NewExpression() {
      Node.apply(this, arguments);
    }

    if (Node) NewExpression.__proto__ = Node;
    NewExpression.prototype = Object.create(Node && Node.prototype);
    NewExpression.prototype.constructor = NewExpression;

    NewExpression.prototype.initialise = function initialise(transforms) {
      var this$1 = this;

      if (transforms.spreadRest && this.arguments.length) {
        var lexicalBoundary = this.findLexicalBoundary();

        var i = this.arguments.length;
        while (i--) {
          var arg = this$1.arguments[i];
          if (arg.type === 'SpreadElement' && isArguments(arg.argument)) {
            this$1.argumentsArrayAlias = lexicalBoundary.getArgumentsArrayAlias();
            break;
          }
        }
      }

      Node.prototype.initialise.call(this, transforms);
    };

    NewExpression.prototype.transpile = function transpile(code, transforms) {
      if (transforms.spreadRest && this.arguments.length) {
        var firstArgument = this.arguments[0];
        var isNew = true;
        var hasSpreadElements = spread(code, this.arguments, firstArgument.start, this.argumentsArrayAlias, isNew);

        if (hasSpreadElements) {
          code.insertRight(this.start + 'new'.length, ' (Function.prototype.bind.apply(');
          code.overwrite(this.callee.end, firstArgument.start, ', [ null ].concat( ');
          code.insertLeft(this.end, ' ))');
        }
      }

      Node.prototype.transpile.call(this, code, transforms);
    };

    return NewExpression;
  }(Node);

  var ObjectExpression = function (Node) {
    function ObjectExpression() {
      Node.apply(this, arguments);
    }

    if (Node) ObjectExpression.__proto__ = Node;
    ObjectExpression.prototype = Object.create(Node && Node.prototype);
    ObjectExpression.prototype.constructor = ObjectExpression;

    ObjectExpression.prototype.transpile = function transpile(code, transforms) {
      var this$1 = this;

      Node.prototype.transpile.call(this, code, transforms);

      var firstPropertyStart = this.start + 1;
      var regularPropertyCount = 0;
      var spreadPropertyCount = 0;
      var computedPropertyCount = 0;

      for (var i$2 = 0, list = this.properties; i$2 < list.length; i$2 += 1) {
        var prop = list[i$2];

        if (prop.type === 'SpreadProperty') {
          spreadPropertyCount += 1;
        } else if (prop.computed) {
          computedPropertyCount += 1;
        } else if (prop.type === 'Property') {
          regularPropertyCount += 1;
        }
      }

      if (spreadPropertyCount) {
        if (!this.program.options.objectAssign) {
          throw new CompileError(this, 'Object spread operator requires specified objectAssign option with \'Object.assign\' or polyfill helper.');
        }
        // enclose run of non-spread properties in curlies
        var i = this.properties.length;
        if (regularPropertyCount) {
          while (i--) {
            var prop$1 = this$1.properties[i];

            if (prop$1.type === 'Property' && !prop$1.computed) {
              var lastProp = this$1.properties[i - 1];
              var nextProp = this$1.properties[i + 1];

              if (!lastProp || lastProp.type !== 'Property' || lastProp.computed) {
                code.insertRight(prop$1.start, '{');
              }

              if (!nextProp || nextProp.type !== 'Property' || nextProp.computed) {
                code.insertLeft(prop$1.end, '}');
              }
            }
          }
        }

        // wrap the whole thing in Object.assign
        firstPropertyStart = this.properties[0].start;
        code.overwrite(this.start, firstPropertyStart, this.program.options.objectAssign + "({}, ");
        code.overwrite(this.properties[this.properties.length - 1].end, this.end, ')');
      }

      if (computedPropertyCount && transforms.computedProperty) {
        var i0 = this.getIndentation();

        var isSimpleAssignment;
        var name;

        if (this.parent.type === 'VariableDeclarator' && this.parent.parent.declarations.length === 1) {
          isSimpleAssignment = true;
          name = this.parent.id.alias || this.parent.id.name; // TODO is this right?
        } else if (this.parent.type === 'AssignmentExpression' && this.parent.parent.type === 'ExpressionStatement' && this.parent.left.type === 'Identifier') {
          isSimpleAssignment = true;
          name = this.parent.left.alias || this.parent.left.name; // TODO is this right?
        } else if (this.parent.type === 'AssignmentPattern' && this.parent.left.type === 'Identifier') {
          isSimpleAssignment = true;
          name = this.parent.left.alias || this.parent.left.name; // TODO is this right?
        }

        // handle block scoping
        var declaration = this.findScope(false).findDeclaration(name);
        if (declaration) name = declaration.name;

        var start = firstPropertyStart;
        var end = this.end;

        if (isSimpleAssignment) {
          // ???
        } else {
          name = this.findScope(true).createIdentifier('obj');

          var statement = this.findNearest(/(?:Statement|Declaration)$/);
          code.insertLeft(statement.end, "\n" + i0 + "var " + name + ";");

          code.insertRight(this.start, "( " + name + " = ");
        }

        var len = this.properties.length;
        var lastComputedProp;
        var sawNonComputedProperty = false;

        for (var i$1 = 0; i$1 < len; i$1 += 1) {
          var prop$2 = this$1.properties[i$1];

          if (prop$2.computed) {
            lastComputedProp = prop$2;
            var moveStart = i$1 > 0 ? this$1.properties[i$1 - 1].end : start;

            var propId = isSimpleAssignment ? ";\n" + i0 + name : ", " + name;

            if (moveStart < prop$2.start) {
              code.overwrite(moveStart, prop$2.start, propId);
            } else {
              code.insertRight(prop$2.start, propId);
            }

            var c = prop$2.key.end;
            while (code.original[c] !== ']') {
              c += 1;
            }c += 1;

            if (prop$2.value.start > c) code.remove(c, prop$2.value.start);
            code.insertLeft(c, ' = ');
            code.move(moveStart, prop$2.end, end);

            if (i$1 < len - 1 && !sawNonComputedProperty) {
              // remove trailing comma
              c = prop$2.end;
              while (code.original[c] !== ',') {
                c += 1;
              }code.remove(prop$2.end, c + 1);
            }

            if (prop$2.method && transforms.conciseMethodProperty) {
              code.insertRight(prop$2.value.start, 'function ');
            }
          } else {
            sawNonComputedProperty = true;
          }
        }

        // special case
        if (computedPropertyCount === len) {
          code.remove(this.properties[len - 1].end, this.end - 1);
        }

        if (!isSimpleAssignment) {
          code.insertLeft(lastComputedProp.end, ", " + name + " )");
        }
      }
    };

    return ObjectExpression;
  }(Node);

  var Property = function (Node) {
    function Property() {
      Node.apply(this, arguments);
    }

    if (Node) Property.__proto__ = Node;
    Property.prototype = Object.create(Node && Node.prototype);
    Property.prototype.constructor = Property;

    Property.prototype.transpile = function transpile(code, transforms) {
      if (transforms.conciseMethodProperty && !this.computed && this.parent.type !== 'ObjectPattern') {
        if (this.shorthand) {
          code.insertRight(this.start, this.key.name + ": ");
        } else if (this.method) {
          var name = '';
          if (this.program.options.namedFunctionExpressions !== false) {
            if (this.key.type === 'Literal' && typeof this.key.value === 'number') {
              name = "";
            } else if (this.key.type === 'Identifier') {
              if (reserved[this.key.name] || !/^[a-z_$][a-z0-9_$]*$/i.test(this.key.name) || this.value.body.scope.references[this.key.name]) {
                name = this.findScope(true).createIdentifier(this.key.name);
              } else {
                name = this.key.name;
              }
            } else {
              name = this.findScope(true).createIdentifier(this.key.value);
            }
            name = ' ' + name;
          }

          if (this.value.generator) code.remove(this.start, this.key.start);
          code.insertLeft(this.key.end, ": function" + (this.value.generator ? '*' : '') + name);
        }
      }

      if (transforms.reservedProperties && reserved[this.key.name]) {
        code.insertRight(this.key.start, "'");
        code.insertLeft(this.key.end, "'");
      }

      Node.prototype.transpile.call(this, code, transforms);
    };

    return Property;
  }(Node);

  var ReturnStatement = function (Node) {
    function ReturnStatement() {
      Node.apply(this, arguments);
    }

    if (Node) ReturnStatement.__proto__ = Node;
    ReturnStatement.prototype = Object.create(Node && Node.prototype);
    ReturnStatement.prototype.constructor = ReturnStatement;

    ReturnStatement.prototype.initialise = function initialise(transforms) {
      this.loop = this.findNearest(loopStatement);
      this.nearestFunction = this.findNearest(/Function/);

      if (this.loop && (!this.nearestFunction || this.loop.depth > this.nearestFunction.depth)) {
        this.loop.canReturn = true;
        this.shouldWrap = true;
      }

      if (this.argument) this.argument.initialise(transforms);
    };

    ReturnStatement.prototype.transpile = function transpile(code, transforms) {
      var shouldWrap = this.shouldWrap && this.loop && this.loop.shouldRewriteAsFunction;

      if (this.argument) {
        if (shouldWrap) code.insertRight(this.argument.start, "{ v: ");
        this.argument.transpile(code, transforms);
        if (shouldWrap) code.insertLeft(this.argument.end, " }");
      } else if (shouldWrap) {
        code.insertLeft(this.start + 6, ' {}');
      }
    };

    return ReturnStatement;
  }(Node);

  var SpreadProperty = function (Node) {
    function SpreadProperty() {
      Node.apply(this, arguments);
    }

    if (Node) SpreadProperty.__proto__ = Node;
    SpreadProperty.prototype = Object.create(Node && Node.prototype);
    SpreadProperty.prototype.constructor = SpreadProperty;

    SpreadProperty.prototype.transpile = function transpile(code, transforms) {
      code.remove(this.start, this.argument.start);
      code.remove(this.argument.end, this.end);

      Node.prototype.transpile.call(this, code, transforms);
    };

    return SpreadProperty;
  }(Node);

  var Super = function (Node) {
    function Super() {
      Node.apply(this, arguments);
    }

    if (Node) Super.__proto__ = Node;
    Super.prototype = Object.create(Node && Node.prototype);
    Super.prototype.constructor = Super;

    Super.prototype.initialise = function initialise(transforms) {
      if (transforms.classes) {
        this.method = this.findNearest('MethodDefinition');
        if (!this.method) throw new CompileError(this, 'use of super outside class method');

        var parentClass = this.findNearest('ClassBody').parent;
        this.superClassName = parentClass.superClass && (parentClass.superClass.name || 'superclass');

        if (!this.superClassName) throw new CompileError(this, 'super used in base class');

        this.isCalled = this.parent.type === 'CallExpression' && this === this.parent.callee;

        if (this.method.kind !== 'constructor' && this.isCalled) {
          throw new CompileError(this, 'super() not allowed outside class constructor');
        }

        this.isMember = this.parent.type === 'MemberExpression';

        if (!this.isCalled && !this.isMember) {
          throw new CompileError(this, 'Unexpected use of `super` (expected `super(...)` or `super.*`)');
        }
      }

      if (transforms.arrow) {
        var lexicalBoundary = this.findLexicalBoundary();
        var arrowFunction = this.findNearest('ArrowFunctionExpression');
        var loop = this.findNearest(loopStatement);

        if (arrowFunction && arrowFunction.depth > lexicalBoundary.depth) {
          this.thisAlias = lexicalBoundary.getThisAlias();
        }

        if (loop && loop.body.contains(this) && loop.depth > lexicalBoundary.depth) {
          this.thisAlias = lexicalBoundary.getThisAlias();
        }
      }
    };

    Super.prototype.transpile = function transpile(code, transforms) {
      if (transforms.classes) {
        var expression = this.isCalled || this.method.static ? this.superClassName : this.superClassName + ".prototype";

        code.overwrite(this.start, this.end, expression, true);

        var callExpression = this.isCalled ? this.parent : this.parent.parent;

        if (callExpression && callExpression.type === 'CallExpression') {
          if (!this.noCall) {
            // special case – `super( ...args )`
            code.insertLeft(callExpression.callee.end, '.call');
          }

          var thisAlias = this.thisAlias || 'this';

          if (callExpression.arguments.length) {
            code.insertLeft(callExpression.arguments[0].start, thisAlias + ", ");
          } else {
            code.insertLeft(callExpression.end - 1, "" + thisAlias);
          }
        }
      }
    };

    return Super;
  }(Node);

  var TaggedTemplateExpression = function (Node) {
    function TaggedTemplateExpression() {
      Node.apply(this, arguments);
    }

    if (Node) TaggedTemplateExpression.__proto__ = Node;
    TaggedTemplateExpression.prototype = Object.create(Node && Node.prototype);
    TaggedTemplateExpression.prototype.constructor = TaggedTemplateExpression;

    TaggedTemplateExpression.prototype.initialise = function initialise(transforms) {
      if (transforms.templateString && !transforms.dangerousTaggedTemplateString) {
        throw new CompileError(this, 'Tagged template strings are not supported. Use `transforms: { templateString: false }` to skip transformation and disable this error, or `transforms: { dangerousTaggedTemplateString: true }` if you know what you\'re doing');
      }

      Node.prototype.initialise.call(this, transforms);
    };

    TaggedTemplateExpression.prototype.transpile = function transpile(code, transforms) {
      if (transforms.templateString && transforms.dangerousTaggedTemplateString) {
        var ordered = this.quasi.expressions.concat(this.quasi.quasis).sort(function (a, b) {
          return a.start - b.start;
        });

        // insert strings at start
        var templateStrings = this.quasi.quasis.map(function (quasi) {
          return JSON.stringify(quasi.value.cooked);
        });
        code.overwrite(this.tag.end, ordered[0].start, "([" + templateStrings.join(', ') + "]");

        var lastIndex = ordered[0].start;
        ordered.forEach(function (node) {
          if (node.type === 'TemplateElement') {
            code.remove(lastIndex, node.end);
          } else {
            code.overwrite(lastIndex, node.start, ', ');
          }

          lastIndex = node.end;
        });

        code.overwrite(lastIndex, this.end, ')');
      }

      Node.prototype.transpile.call(this, code, transforms);
    };

    return TaggedTemplateExpression;
  }(Node);

  var TemplateElement = function (Node) {
    function TemplateElement() {
      Node.apply(this, arguments);
    }

    if (Node) TemplateElement.__proto__ = Node;
    TemplateElement.prototype = Object.create(Node && Node.prototype);
    TemplateElement.prototype.constructor = TemplateElement;

    TemplateElement.prototype.initialise = function initialise() {
      this.program.indentExclusionElements.push(this);
    };

    return TemplateElement;
  }(Node);

  var TemplateLiteral = function (Node) {
    function TemplateLiteral() {
      Node.apply(this, arguments);
    }

    if (Node) TemplateLiteral.__proto__ = Node;
    TemplateLiteral.prototype = Object.create(Node && Node.prototype);
    TemplateLiteral.prototype.constructor = TemplateLiteral;

    TemplateLiteral.prototype.transpile = function transpile(code, transforms) {
      if (transforms.templateString && this.parent.type !== 'TaggedTemplateExpression') {
        var ordered = this.expressions.concat(this.quasis).sort(function (a, b) {
          return a.start - b.start || a.end - b.end;
        }).filter(function (node, i) {
          // include all expressions
          if (node.type !== 'TemplateElement') return true;

          // include all non-empty strings
          if (node.value.raw) return true;

          // exclude all empty strings not at the head
          return !i;
        });

        // special case – we may be able to skip the first element,
        // if it's the empty string, but only if the second and
        // third elements aren't both expressions (since they maybe
        // be numeric, and `1 + 2 + '3' === '33'`)
        if (ordered.length >= 3) {
          var first = ordered[0];
          var third = ordered[2];
          if (first.type === 'TemplateElement' && first.value.raw === '' && third.type === 'TemplateElement') {
            ordered.shift();
          }
        }

        var parenthesise = (this.quasis.length !== 1 || this.expressions.length !== 0) && this.parent.type !== 'AssignmentExpression' && this.parent.type !== 'AssignmentPattern' && this.parent.type !== 'VariableDeclarator' && (this.parent.type !== 'BinaryExpression' || this.parent.operator !== '+');

        if (parenthesise) code.insertRight(this.start, '(');

        var lastIndex = this.start;

        ordered.forEach(function (node, i) {
          if (node.type === 'TemplateElement') {
            var replacement = '';
            if (i) replacement += ' + ';
            replacement += JSON.stringify(node.value.cooked);

            code.overwrite(lastIndex, node.end, replacement);
          } else {
            var parenthesise = node.type !== 'Identifier'; // TODO other cases where it's safe

            var replacement$1 = '';
            if (i) replacement$1 += ' + ';
            if (parenthesise) replacement$1 += '(';

            code.overwrite(lastIndex, node.start, replacement$1);

            if (parenthesise) code.insertLeft(node.end, ')');
          }

          lastIndex = node.end;
        });

        var close = '';
        if (parenthesise) close += ')';

        code.overwrite(lastIndex, this.end, close);
      }

      Node.prototype.transpile.call(this, code, transforms);
    };

    return TemplateLiteral;
  }(Node);

  var ThisExpression = function (Node) {
    function ThisExpression() {
      Node.apply(this, arguments);
    }

    if (Node) ThisExpression.__proto__ = Node;
    ThisExpression.prototype = Object.create(Node && Node.prototype);
    ThisExpression.prototype.constructor = ThisExpression;

    ThisExpression.prototype.initialise = function initialise(transforms) {
      if (transforms.arrow) {
        var lexicalBoundary = this.findLexicalBoundary();
        var arrowFunction = this.findNearest('ArrowFunctionExpression');
        var loop = this.findNearest(loopStatement);

        if (arrowFunction && arrowFunction.depth > lexicalBoundary.depth || loop && loop.body.contains(this) && loop.depth > lexicalBoundary.depth || loop && loop.right && loop.right.contains(this)) {
          this.alias = lexicalBoundary.getThisAlias();
        }
      }
    };

    ThisExpression.prototype.transpile = function transpile(code) {
      if (this.alias) {
        code.overwrite(this.start, this.end, this.alias, true);
      }
    };

    return ThisExpression;
  }(Node);

  var UpdateExpression = function (Node) {
    function UpdateExpression() {
      Node.apply(this, arguments);
    }

    if (Node) UpdateExpression.__proto__ = Node;
    UpdateExpression.prototype = Object.create(Node && Node.prototype);
    UpdateExpression.prototype.constructor = UpdateExpression;

    UpdateExpression.prototype.initialise = function initialise(transforms) {
      if (this.argument.type === 'Identifier') {
        var declaration = this.findScope(false).findDeclaration(this.argument.name);
        if (declaration && declaration.kind === 'const') {
          throw new CompileError(this, this.argument.name + " is read-only");
        }

        // special case – https://gitlab.com/Rich-Harris/buble/issues/150
        var statement = declaration && declaration.node.ancestor(3);
        if (statement && statement.type === 'ForStatement' && statement.body.contains(this)) {
          statement.reassigned[this.argument.name] = true;
        }
      }

      Node.prototype.initialise.call(this, transforms);
    };

    return UpdateExpression;
  }(Node);

  var VariableDeclaration = function (Node) {
    function VariableDeclaration() {
      Node.apply(this, arguments);
    }

    if (Node) VariableDeclaration.__proto__ = Node;
    VariableDeclaration.prototype = Object.create(Node && Node.prototype);
    VariableDeclaration.prototype.constructor = VariableDeclaration;

    VariableDeclaration.prototype.initialise = function initialise(transforms) {
      this.scope = this.findScope(this.kind === 'var');
      this.declarations.forEach(function (declarator) {
        return declarator.initialise(transforms);
      });
    };

    VariableDeclaration.prototype.transpile = function transpile(code, transforms) {
      var this$1 = this;

      var i0 = this.getIndentation();
      var kind = this.kind;

      if (transforms.letConst && kind !== 'var') {
        kind = 'var';
        code.overwrite(this.start, this.start + this.kind.length, kind, true);
      }

      if (transforms.destructuring && this.parent.type !== 'ForOfStatement') {
        var c = this.start;
        var lastDeclaratorIsPattern;

        this.declarations.forEach(function (declarator, i) {
          if (declarator.id.type === 'Identifier') {
            if (i > 0 && this$1.declarations[i - 1].id.type !== 'Identifier') {
              code.overwrite(c, declarator.id.start, "var ");
            }
          } else {
            var inline = loopStatement.test(this$1.parent.type);

            if (i === 0) {
              code.remove(c, declarator.id.start);
            } else {
              code.overwrite(c, declarator.id.start, ";\n" + i0);
            }

            var simple = declarator.init.type === 'Identifier' && !declarator.init.rewritten;

            var name = simple ? declarator.init.name : declarator.findScope(true).createIdentifier('ref');

            var c$1 = declarator.start;

            var statementGenerators = [];

            if (simple) {
              code.remove(declarator.id.end, declarator.end);
            } else {
              statementGenerators.push(function (start, prefix, suffix) {
                code.insertRight(declarator.id.end, "var " + name);
                code.insertLeft(declarator.init.end, "" + suffix);
                code.move(declarator.id.end, declarator.end, start);
              });
            }

            destructure(code, declarator.findScope(false), declarator.id, name, inline, statementGenerators);

            var prefix = inline ? 'var ' : '';
            var suffix = inline ? ", " : ";\n" + i0;
            statementGenerators.forEach(function (fn, j) {
              if (i === this$1.declarations.length - 1 && j === statementGenerators.length - 1) {
                suffix = inline ? '' : ';';
              }

              fn(declarator.start, j === 0 ? prefix : '', suffix);
            });
          }

          declarator.transpile(code, transforms);

          c = declarator.end;
          lastDeclaratorIsPattern = declarator.id.type !== 'Identifier';
        });

        if (lastDeclaratorIsPattern) {
          code.remove(c, this.end);
        }
      } else {
        this.declarations.forEach(function (declarator) {
          declarator.transpile(code, transforms);
        });
      }
    };

    return VariableDeclaration;
  }(Node);

  var VariableDeclarator = function (Node) {
    function VariableDeclarator() {
      Node.apply(this, arguments);
    }

    if (Node) VariableDeclarator.__proto__ = Node;
    VariableDeclarator.prototype = Object.create(Node && Node.prototype);
    VariableDeclarator.prototype.constructor = VariableDeclarator;

    VariableDeclarator.prototype.initialise = function initialise(transforms) {
      var kind = this.parent.kind;
      if (kind === 'let' && this.parent.parent.type === 'ForStatement') {
        kind = 'for.let'; // special case...
      }

      this.parent.scope.addDeclaration(this.id, kind);
      Node.prototype.initialise.call(this, transforms);
    };

    VariableDeclarator.prototype.transpile = function transpile(code, transforms) {
      if (!this.init && transforms.letConst && this.parent.kind !== 'var') {
        var inLoop = this.findNearest(/Function|^For(In|Of)?Statement|^(?:Do)?WhileStatement/);
        if (inLoop && !/Function/.test(inLoop.type) && !this.isLeftDeclaratorOfLoop()) {
          code.insertLeft(this.id.end, ' = (void 0)');
        }
      }

      if (this.id) this.id.transpile(code, transforms);
      if (this.init) this.init.transpile(code, transforms);
    };

    VariableDeclarator.prototype.isLeftDeclaratorOfLoop = function isLeftDeclaratorOfLoop() {
      return this.parent && this.parent.type === 'VariableDeclaration' && this.parent.parent && (this.parent.parent.type === 'ForInStatement' || this.parent.parent.type === 'ForOfStatement') && this.parent.parent.left && this.parent.parent.left.declarations[0] === this;
    };

    return VariableDeclarator;
  }(Node);

  var types = {
    ArrayExpression: ArrayExpression,
    ArrowFunctionExpression: ArrowFunctionExpression,
    AssignmentExpression: AssignmentExpression,
    BinaryExpression: BinaryExpression,
    BreakStatement: BreakStatement,
    CallExpression: CallExpression,
    ClassBody: ClassBody,
    ClassDeclaration: ClassDeclaration,
    ClassExpression: ClassExpression,
    ContinueStatement: ContinueStatement,
    DoWhileStatement: LoopStatement,
    ExportNamedDeclaration: ExportNamedDeclaration,
    ExportDefaultDeclaration: ExportDefaultDeclaration,
    ForStatement: ForStatement,
    ForInStatement: ForInStatement,
    ForOfStatement: ForOfStatement,
    FunctionDeclaration: FunctionDeclaration,
    FunctionExpression: FunctionExpression,
    Identifier: Identifier,
    IfStatement: IfStatement,
    ImportDeclaration: ImportDeclaration,
    ImportDefaultSpecifier: ImportDefaultSpecifier,
    ImportSpecifier: ImportSpecifier,
    JSXAttribute: JSXAttribute,
    JSXClosingElement: JSXClosingElement,
    JSXElement: JSXElement,
    JSXExpressionContainer: JSXExpressionContainer,
    JSXOpeningElement: JSXOpeningElement,
    JSXSpreadAttribute: JSXSpreadAttribute,
    Literal: Literal,
    MemberExpression: MemberExpression,
    NewExpression: NewExpression,
    ObjectExpression: ObjectExpression,
    Property: Property,
    ReturnStatement: ReturnStatement,
    SpreadProperty: SpreadProperty,
    Super: Super,
    TaggedTemplateExpression: TaggedTemplateExpression,
    TemplateElement: TemplateElement,
    TemplateLiteral: TemplateLiteral,
    ThisExpression: ThisExpression,
    UpdateExpression: UpdateExpression,
    VariableDeclaration: VariableDeclaration,
    VariableDeclarator: VariableDeclarator,
    WhileStatement: LoopStatement
  };

  var statementsWithBlocks = {
    IfStatement: 'consequent',
    ForStatement: 'body',
    ForInStatement: 'body',
    ForOfStatement: 'body',
    WhileStatement: 'body',
    DoWhileStatement: 'body',
    ArrowFunctionExpression: 'body'
  };

  function wrap(raw, parent) {
    if (!raw) return;

    if ('length' in raw) {
      var i = raw.length;
      while (i--) {
        wrap(raw[i], parent);
      }return;
    }

    // with e.g. shorthand properties, key and value are
    // the same node. We don't want to wrap an object twice
    if (raw.__wrapped) return;
    raw.__wrapped = true;

    if (!keys[raw.type]) {
      keys[raw.type] = Object.keys(raw).filter(function (key) {
        return _typeof(raw[key]) === 'object';
      });
    }

    // special case – body-less if/for/while statements. TODO others?
    var bodyType = statementsWithBlocks[raw.type];
    if (bodyType && raw[bodyType].type !== 'BlockStatement') {
      var expression = raw[bodyType];

      // create a synthetic block statement, otherwise all hell
      // breaks loose when it comes to block scoping
      raw[bodyType] = {
        start: expression.start,
        end: expression.end,
        type: 'BlockStatement',
        body: [expression],
        synthetic: true
      };
    }

    new Node(raw, parent);

    var type = (raw.type === 'BlockStatement' ? BlockStatement : types[raw.type]) || Node;
    raw.__proto__ = type.prototype;
  }

  var letConst = /^(?:let|const)$/;

  function Scope(options) {
    options = options || {};

    this.parent = options.parent;
    this.isBlockScope = !!options.block;

    var scope = this;
    while (scope.isBlockScope) {
      scope = scope.parent;
    }this.functionScope = scope;

    this.identifiers = [];
    this.declarations = Object.create(null);
    this.references = Object.create(null);
    this.blockScopedDeclarations = this.isBlockScope ? null : Object.create(null);
    this.aliases = this.isBlockScope ? null : Object.create(null);
  }

  Scope.prototype = {
    addDeclaration: function addDeclaration(node, kind) {
      for (var i = 0, list = extractNames(node); i < list.length; i += 1) {
        var identifier = list[i];

        var name = identifier.name;
        var existingDeclaration = this.declarations[name];
        if (existingDeclaration && (letConst.test(kind) || letConst.test(existingDeclaration.kind))) {
          // TODO warn about double var declarations?
          throw new CompileError(identifier, name + " is already declared");
        }

        var declaration = { name: name, node: identifier, kind: kind, instances: [] };
        this.declarations[name] = declaration;

        if (this.isBlockScope) {
          if (!this.functionScope.blockScopedDeclarations[name]) this.functionScope.blockScopedDeclarations[name] = [];
          this.functionScope.blockScopedDeclarations[name].push(declaration);
        }
      }
    },

    addReference: function addReference(identifier) {
      if (this.consolidated) {
        this.consolidateReference(identifier);
      } else {
        this.identifiers.push(identifier);
      }
    },

    consolidate: function consolidate() {
      var this$1 = this;

      for (var i = 0; i < this$1.identifiers.length; i += 1) {
        // we might push to the array during consolidation, so don't cache length
        var identifier = this$1.identifiers[i];
        this$1.consolidateReference(identifier);
      }

      this.consolidated = true; // TODO understand why this is necessary... seems bad
    },

    consolidateReference: function consolidateReference(identifier) {
      var declaration = this.declarations[identifier.name];
      if (declaration) {
        declaration.instances.push(identifier);
      } else {
        this.references[identifier.name] = true;
        if (this.parent) this.parent.addReference(identifier);
      }
    },

    contains: function contains(name) {
      return this.declarations[name] || (this.parent ? this.parent.contains(name) : false);
    },

    createIdentifier: function createIdentifier(base) {
      var this$1 = this;

      if (typeof base === 'number') base = base.toString();

      base = base.replace(/\s/g, '').replace(/\[([^\]]+)\]/g, '_$1').replace(/[^a-zA-Z0-9_$]/g, '_').replace(/_{2,}/, '_');

      var name = base;
      var counter = 1;

      while (this$1.declarations[name] || this$1.references[name] || this$1.aliases[name] || name in reserved) {
        name = base + "$" + counter++;
      }

      this.aliases[name] = true;
      return name;
    },

    findDeclaration: function findDeclaration(name) {
      return this.declarations[name] || this.parent && this.parent.findDeclaration(name);
    }
  };

  function isUseStrict(node) {
    if (!node) return false;
    if (node.type !== 'ExpressionStatement') return false;
    if (node.expression.type !== 'Literal') return false;
    return node.expression.value === 'use strict';
  }

  var BlockStatement = function (Node) {
    function BlockStatement() {
      Node.apply(this, arguments);
    }

    if (Node) BlockStatement.__proto__ = Node;
    BlockStatement.prototype = Object.create(Node && Node.prototype);
    BlockStatement.prototype.constructor = BlockStatement;

    BlockStatement.prototype.createScope = function createScope() {
      var this$1 = this;

      this.parentIsFunction = /Function/.test(this.parent.type);
      this.isFunctionBlock = this.parentIsFunction || this.parent.type === 'Root';
      this.scope = new Scope({
        block: !this.isFunctionBlock,
        parent: this.parent.findScope(false)
      });

      if (this.parentIsFunction) {
        this.parent.params.forEach(function (node) {
          this$1.scope.addDeclaration(node, 'param');
        });
      }
    };

    BlockStatement.prototype.initialise = function initialise(transforms) {
      this.thisAlias = null;
      this.argumentsAlias = null;
      this.defaultParameters = [];

      // normally the scope gets created here, during initialisation,
      // but in some cases (e.g. `for` statements), we need to create
      // the scope early, as it pertains to both the init block and
      // the body of the statement
      if (!this.scope) this.createScope();

      this.body.forEach(function (node) {
        return node.initialise(transforms);
      });

      this.scope.consolidate();
    };

    BlockStatement.prototype.findLexicalBoundary = function findLexicalBoundary() {
      if (this.type === 'Program') return this;
      if (/^Function/.test(this.parent.type)) return this;

      return this.parent.findLexicalBoundary();
    };

    BlockStatement.prototype.findScope = function findScope(functionScope) {
      if (functionScope && !this.isFunctionBlock) return this.parent.findScope(functionScope);
      return this.scope;
    };

    BlockStatement.prototype.getArgumentsAlias = function getArgumentsAlias() {
      if (!this.argumentsAlias) {
        this.argumentsAlias = this.scope.createIdentifier('arguments');
      }

      return this.argumentsAlias;
    };

    BlockStatement.prototype.getArgumentsArrayAlias = function getArgumentsArrayAlias() {
      if (!this.argumentsArrayAlias) {
        this.argumentsArrayAlias = this.scope.createIdentifier('argsArray');
      }

      return this.argumentsArrayAlias;
    };

    BlockStatement.prototype.getThisAlias = function getThisAlias() {
      if (!this.thisAlias) {
        this.thisAlias = this.scope.createIdentifier('this');
      }

      return this.thisAlias;
    };

    BlockStatement.prototype.getIndentation = function getIndentation() {
      var this$1 = this;

      if (this.indentation === undefined) {
        var source = this.program.magicString.original;

        var useOuter = this.synthetic || !this.body.length;
        var c = useOuter ? this.start : this.body[0].start;

        while (c && source[c] !== '\n') {
          c -= 1;
        }this.indentation = '';

        while (true) {
          // eslint-disable-line no-constant-condition
          c += 1;
          var char = source[c];

          if (char !== ' ' && char !== '\t') break;

          this$1.indentation += char;
        }

        var indentString = this.program.magicString.getIndentString();

        // account for dedented class constructors
        var parent = this.parent;
        while (parent) {
          if (parent.kind === 'constructor' && !parent.parent.parent.superClass) {
            this$1.indentation = this$1.indentation.replace(indentString, '');
          }

          parent = parent.parent;
        }

        if (useOuter) this.indentation += indentString;
      }

      return this.indentation;
    };

    BlockStatement.prototype.transpile = function transpile(code, transforms) {
      var this$1 = this;

      var indentation = this.getIndentation();

      var introStatementGenerators = [];

      if (this.argumentsAlias) {
        introStatementGenerators.push(function (start, prefix, suffix) {
          var assignment = prefix + "var " + this$1.argumentsAlias + " = arguments" + suffix;
          code.insertLeft(start, assignment);
        });
      }

      if (this.thisAlias) {
        introStatementGenerators.push(function (start, prefix, suffix) {
          var assignment = prefix + "var " + this$1.thisAlias + " = this" + suffix;
          code.insertLeft(start, assignment);
        });
      }

      if (this.argumentsArrayAlias) {
        introStatementGenerators.push(function (start, prefix, suffix) {
          var i = this$1.scope.createIdentifier('i');
          var assignment = prefix + "var " + i + " = arguments.length, " + this$1.argumentsArrayAlias + " = Array(" + i + ");\n" + indentation + "while ( " + i + "-- ) " + this$1.argumentsArrayAlias + "[" + i + "] = arguments[" + i + "]" + suffix;
          code.insertLeft(start, assignment);
        });
      }

      if (/Function/.test(this.parent.type)) {
        this.transpileParameters(code, transforms, indentation, introStatementGenerators);
      }

      if (transforms.letConst && this.isFunctionBlock) {
        this.transpileBlockScopedIdentifiers(code);
      }

      Node.prototype.transpile.call(this, code, transforms);

      if (this.synthetic) {
        if (this.parent.type === 'ArrowFunctionExpression') {
          var expr = this.body[0];

          if (introStatementGenerators.length) {
            code.insertLeft(this.start, "{").insertRight(this.end, this.parent.getIndentation() + "}");

            code.insertRight(expr.start, "\n" + indentation + "return ");
            code.insertLeft(expr.end, ";\n");
          } else if (transforms.arrow) {
            code.insertLeft(expr.start, "{ return ");
            code.insertLeft(expr.end, "; }");
          }
        } else if (introStatementGenerators.length) {
          code.insertLeft(this.start, "{").insertRight(this.end, "}");
        }
      }

      var start;
      if (isUseStrict(this.body[0])) {
        start = this.body[0].end;
      } else if (this.synthetic || this.parent.type === 'Root') {
        start = this.start;
      } else {
        start = this.start + 1;
      }

      var prefix = "\n" + indentation;
      var suffix = ';';
      introStatementGenerators.forEach(function (fn, i) {
        if (i === introStatementGenerators.length - 1) suffix = ";\n";
        fn(start, prefix, suffix);
      });
    };

    BlockStatement.prototype.transpileParameters = function transpileParameters(code, transforms, indentation, introStatementGenerators) {
      var this$1 = this;

      var params = this.parent.params;

      params.forEach(function (param) {
        if (param.type === 'AssignmentPattern' && param.left.type === 'Identifier') {
          if (transforms.defaultParameter) {
            introStatementGenerators.push(function (start, prefix, suffix) {
              var lhs = prefix + "if ( " + param.left.name + " === void 0 ) " + param.left.name;

              code.insertRight(param.left.end, lhs).move(param.left.end, param.right.end, start).insertLeft(param.right.end, suffix);
            });
          }
        } else if (param.type === 'RestElement') {
          if (transforms.spreadRest) {
            introStatementGenerators.push(function (start, prefix, suffix) {
              var penultimateParam = params[params.length - 2];

              if (penultimateParam) {
                code.remove(penultimateParam ? penultimateParam.end : param.start, param.end);
              } else {
                var start$1 = param.start,
                    end = param.end; // TODO https://gitlab.com/Rich-Harris/buble/issues/8

                while (/\s/.test(code.original[start$1 - 1])) {
                  start$1 -= 1;
                }while (/\s/.test(code.original[end])) {
                  end += 1;
                }code.remove(start$1, end);
              }

              var name = param.argument.name;
              var len = this$1.scope.createIdentifier('len');
              var count = params.length - 1;

              if (count) {
                code.insertLeft(start, prefix + "var " + name + " = [], " + len + " = arguments.length - " + count + ";\n" + indentation + "while ( " + len + "-- > 0 ) " + name + "[ " + len + " ] = arguments[ " + len + " + " + count + " ]" + suffix);
              } else {
                code.insertLeft(start, prefix + "var " + name + " = [], " + len + " = arguments.length;\n" + indentation + "while ( " + len + "-- ) " + name + "[ " + len + " ] = arguments[ " + len + " ]" + suffix);
              }
            });
          }
        } else if (param.type !== 'Identifier') {
          if (transforms.parameterDestructuring) {
            var ref = this$1.scope.createIdentifier('ref');
            destructure(code, this$1.scope, param, ref, false, introStatementGenerators);
            code.insertLeft(param.start, ref);
          }
        }
      });
    };

    BlockStatement.prototype.transpileBlockScopedIdentifiers = function transpileBlockScopedIdentifiers(code) {
      var this$1 = this;

      Object.keys(this.scope.blockScopedDeclarations).forEach(function (name) {
        var declarations = this$1.scope.blockScopedDeclarations[name];

        for (var i = 0, list = declarations; i < list.length; i += 1) {
          var declaration = list[i];

          var cont = false; // TODO implement proper continue...

          if (declaration.kind === 'for.let') {
            // special case
            var forStatement = declaration.node.findNearest('ForStatement');

            if (forStatement.shouldRewriteAsFunction) {
              var outerAlias = this$1.scope.createIdentifier(name);
              var innerAlias = forStatement.reassigned[name] ? this$1.scope.createIdentifier(name) : name;

              declaration.name = outerAlias;
              code.overwrite(declaration.node.start, declaration.node.end, outerAlias, true);

              forStatement.aliases[name] = {
                outer: outerAlias,
                inner: innerAlias
              };

              for (var i$1 = 0, list$1 = declaration.instances; i$1 < list$1.length; i$1 += 1) {
                var identifier = list$1[i$1];

                var alias = forStatement.body.contains(identifier) ? innerAlias : outerAlias;

                if (name !== alias) {
                  code.overwrite(identifier.start, identifier.end, alias, true);
                }
              }

              cont = true;
            }
          }

          if (!cont) {
            var alias$1 = this$1.scope.createIdentifier(name);

            if (name !== alias$1) {
              declaration.name = alias$1;
              code.overwrite(declaration.node.start, declaration.node.end, alias$1, true);

              for (var i$2 = 0, list$2 = declaration.instances; i$2 < list$2.length; i$2 += 1) {
                var identifier$1 = list$2[i$2];

                identifier$1.rewritten = true;
                code.overwrite(identifier$1.start, identifier$1.end, alias$1, true);
              }
            }
          }
        }
      });
    };

    return BlockStatement;
  }(Node);

  function Program(source, ast, transforms, options) {
    var this$1 = this;

    this.type = 'Root';

    // options
    this.jsx = options.jsx || 'React.createElement';
    this.options = options;

    this.source = source;
    this.magicString = new MagicString(source);

    this.ast = ast;
    this.depth = 0;

    wrap(this.body = ast, this);
    this.body.__proto__ = BlockStatement.prototype;

    this.indentExclusionElements = [];
    this.body.initialise(transforms);

    this.indentExclusions = Object.create(null);
    for (var i$1 = 0, list = this.indentExclusionElements; i$1 < list.length; i$1 += 1) {
      var node = list[i$1];

      for (var i = node.start; i < node.end; i += 1) {
        this$1.indentExclusions[i] = true;
      }
    }

    this.body.transpile(this.magicString, transforms);
  }

  Program.prototype = {
    export: function export$1(options) {
      if (options === void 0) options = {};

      return {
        code: this.magicString.toString(),
        map: this.magicString.generateMap({
          file: options.file,
          source: options.source,
          includeContent: options.includeContent !== false
        })
      };
    },

    findNearest: function findNearest() {
      return null;
    },

    findScope: function findScope() {
      return null;
    }
  };

  var matrix = {
    chrome: {
      48: 1333689725,
      49: 1342078975,
      50: 1610514431,
      51: 1610514431,
      52: 2147385343
    },
    firefox: {
      43: 1207307741,
      44: 1207307741,
      45: 1207307741,
      46: 1476267485,
      47: 1476296671,
      48: 1476296671
    },
    safari: {
      8: 1073741824,
      9: 1328940894
    },
    ie: {
      8: 0,
      9: 1073741824,
      10: 1073741824,
      11: 1073770592
    },
    edge: {
      12: 1591620701,
      13: 1608400479
    },
    node: {
      '0.10': 1075052608,
      '0.12': 1091830852,
      4: 1327398527,
      5: 1327398527,
      6: 1610514431
    }
  };

  var features = ['arrow', 'classes', 'collections', 'computedProperty', 'conciseMethodProperty', 'constLoop', 'constRedef', 'defaultParameter', 'destructuring', 'extendNatives', 'forOf', 'generator', 'letConst', 'letLoop', 'letLoopScope', 'moduleExport', 'moduleImport', 'numericLiteral', 'objectProto', 'objectSuper', 'oldOctalLiteral', 'parameterDestructuring', 'spreadRest', 'stickyRegExp', 'symbol', 'templateString', 'unicodeEscape', 'unicodeIdentifier', 'unicodeRegExp',

  // ES2016
  'exponentiation',

  // additional transforms, not from
  // https://featuretests.io
  'reservedProperties'];

  var version = "0.15.2";

  var ref = [acornObjectSpread, acornJsx].reduce(function (final, plugin) {
    return plugin(final);
  }, acorn$1);
  var parse = ref.parse;

  var dangerousTransforms = ['dangerousTaggedTemplateString', 'dangerousForOf'];

  function target(target) {
    var targets = Object.keys(target);
    var bitmask = targets.length ? 2147483647 : 1073741824;

    Object.keys(target).forEach(function (environment) {
      var versions = matrix[environment];
      if (!versions) throw new Error("Unknown environment '" + environment + "'. Please raise an issue at https://gitlab.com/Rich-Harris/buble/issues");

      var targetVersion = target[environment];
      if (!(targetVersion in versions)) throw new Error("Support data exists for the following versions of " + environment + ": " + Object.keys(versions).join(', ') + ". Please raise an issue at https://gitlab.com/Rich-Harris/buble/issues");
      var support = versions[targetVersion];

      bitmask &= support;
    });

    var transforms = Object.create(null);
    features.forEach(function (name, i) {
      transforms[name] = !(bitmask & 1 << i);
    });

    dangerousTransforms.forEach(function (name) {
      transforms[name] = false;
    });

    return transforms;
  }

  function transform(source, options) {
    if (options === void 0) options = {};

    var ast;

    try {
      ast = parse(source, {
        ecmaVersion: 7,
        preserveParens: true,
        sourceType: 'module',
        plugins: {
          jsx: true,
          objectSpread: true
        }
      });
    } catch (err) {
      err.snippet = getSnippet(source, err.loc);
      err.toString = function () {
        return err.name + ": " + err.message + "\n" + err.snippet;
      };
      throw err;
    }

    var transforms = target(options.target || {});
    Object.keys(options.transforms || {}).forEach(function (name) {
      if (name === 'modules') {
        if (!('moduleImport' in options.transforms)) transforms.moduleImport = options.transforms.modules;
        if (!('moduleExport' in options.transforms)) transforms.moduleExport = options.transforms.modules;
        return;
      }

      if (!(name in transforms)) throw new Error("Unknown transform '" + name + "'");
      transforms[name] = options.transforms[name];
    });

    return new Program(source, ast, transforms, options).export(options);
  }

  exports.target = target;
  exports.transform = transform;
  exports.VERSION = version;

  Object.defineProperty(exports, '__esModule', { value: true });
});


}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {},require("buffer").Buffer)
},{"buffer":4}],109:[function(require,module,exports){
'use strict';

require('promise/polyfill');
(function (root, factory) {
	if (typeof define === 'function' && define.amd) {
		define(['vue'], factory);
	} else {
		root.VueRequire = factory(root.Vue);
	}
})(undefined || window, function (Vue) {
	var request = require('./request');
	var requireHelper = require('./requireHelper');
	var Compiler = require('./Compiler');

	var parser = new DOMParser();

	function parse(fragment) {
		var doc = parser.parseFromString('<!doctype html><html><head></head><body>' + fragment + '</body></html>', 'text/html');
		return doc.body;
	}

	var VueRequire = {
		options: {},
		_createRequire: function _createRequire(options) {
			var require = options.require || requireHelper.buildDependencyRequire({
				require: function (_require) {
					function require(_x, _x2, _x3) {
						return _require.apply(this, arguments);
					}

					require.toString = function () {
						return _require.toString();
					};

					return require;
				}(function (deps, cb, errCb) {
					var dep = deps[0];
					if (dep.substr(0, 2) === 'v!') {
						var path = dep.substr(2);
						var name = VueRequire.pathToName(path);
						cb(VueRequire.createLazyComponent(path + '.vue', { name: name, require: require }));
						return;
					}
					if (options.map && options.map[dep]) cb(g[options.map[dep]]);else if (VueRequire.options.map && VueRequire.options.map[dep]) cb(g[VueRequire.options.map[dep]]);else cb(g[dep]);
				})
			});
			return require;
		},
		registerAllComponentsTags: function registerAllComponentsTags(options) {
			options = options || {};
			var links = document.getElementsByTagName('link');
			var tags = [];
			var g = options.global || window;
			var require = VueRequire._createRequire(options);
			for (var i = 0, len = links.length; i < len; ++i) {
				var link = links[i];
				if (link.rel === 'template/vue' || link.type === 'text/vue') {
					var name = link.getAttribute('name') || this.pathToName(link.href);
					Vue.component(name, VueRequire.createLazyComponent(link.href, { name: name, require: require }));
				}
			}
			return Promise.resolve();
		},
		createLazyComponent: function createLazyComponent(path, options) {
			return function (resolve, reject) {
				return VueRequire.loadComponent(path, options);
			};
		},
		loadComponent: function loadComponent(path, options) {
			options = options || {};
			options = {
				name: options.name,
				require: this._createRequire(options)
			};
			return request(path).then(function (res) {
				var vueComponentElement = parse(res);
				var compiler = new Compiler(vueComponentElement);
				return compiler.compile(options).then(function (component) {
					return component;
				});
			});
		},
		pathToName: function pathToName(path) {
			return path;
		},
		load: function load(name, req, onload, config) {
			var require = requireHelper.buildDependencyRequire({ require: req });
			onload(VueRequire.createLazyComponent(name + '.vue', { name: name, config: config, require: require }));
		}
	};
	return VueRequire;
});

},{"./Compiler":107,"./request":110,"./requireHelper":111,"promise/polyfill":106}],110:[function(require,module,exports){
'use strict';

require('promise/polyfill');
function request(url) {
	return new Promise(function (resolve, reject) {
		var xhr = new XMLHttpRequest();
		xhr.onreadystatechange = function () {
			if (xhr.readyState >= 4) {
				if (xhr.status == 200) resolve(xhr.responseText);else reject(new Error());
			}
		};
		xhr.open('GET', url);
		xhr.send();
	});;
};
module.exports = request;

},{"promise/polyfill":106}],111:[function(require,module,exports){
"use strict";

function buildDependencyRequire(options) {
	options = options || {};
	var req = options.require;
	return function (deps) {
		deps = deps || [];

		var resolvedMap = {};
		var module = deps.map(function (dep, i) {
			return new Promise(function (resolve, reject) {
				req([dep], function (v) {
					resolvedMap[dep] = v;
					resolve();
				}, reject);
			});
		});
		return Promise.all(module).then(function (d) {
			return function (name) {
				return resolvedMap[name];
			};
		});
		;
	};
}

module.exports = {
	buildDependencyRequire: buildDependencyRequire
};

},{}]},{},[109]);
