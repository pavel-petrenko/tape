'use strict';

var deepEqual = require('deep-equal');
var defined = require('defined');
var path = require('path');
var inherits = require('inherits');
var EventEmitter = require('events').EventEmitter;
var hasOwn = require('hasown');
var isRegExp = require('is-regex');
var trim = require('string.prototype.trim');
var callBind = require('call-bind');
var callBound = require('call-bound');
var forEach = require('for-each');
var inspect = require('object-inspect');
var is = require('object-is/polyfill')();
var objectKeys = require('object-keys');
var every = require('array.prototype.every');
var mockProperty = require('mock-property');

var isEnumerable = callBound('Object.prototype.propertyIsEnumerable');
var toLowerCase = callBound('String.prototype.toLowerCase');
var isProto = callBound('Object.prototype.isPrototypeOf');
var $exec = callBound('RegExp.prototype.exec');
var objectToString = callBound('Object.prototype.toString');
var $split = callBound('String.prototype.split');
var $replace = callBound('String.prototype.replace');
var $strSlice = callBound('String.prototype.slice');
var $shift = callBound('Array.prototype.shift');
var $slice = callBound('Array.prototype.slice');

var nextTick = typeof setImmediate !== 'undefined'
	? setImmediate
	: process.nextTick;
var safeSetTimeout = setTimeout;
var safeClearTimeout = clearTimeout;

var isErrorConstructor = isProto(Error, TypeError) // IE 8 is `false` here
	? function isErrorConstructor(C) {
		return isProto(Error, C);
	}
	: function isErrorConstructor(C) {
		return isProto(Error, C)
			|| isProto(TypeError, C)
			|| isProto(RangeError, C)
			|| isProto(SyntaxError, C)
			|| isProto(ReferenceError, C)
			|| isProto(EvalError, C)
			|| isProto(URIError, C);
	};

// eslint-disable-next-line no-unused-vars
function getTestArgs(name_, opts_, cb_) {
	var name = '(anonymous)';
	var opts = {};
	var cb;

	for (var i = 0; i < arguments.length; i++) {
		var arg = arguments[i];
		if (typeof arg === 'string') {
			name = arg;
		} else if (typeof arg === 'object') {
			opts = arg || opts;
		} else if (typeof arg === 'function') {
			cb = arg;
		}
	}
	return {
		name: name,
		opts: opts,
		cb: cb
	};
}

function Test(name_, opts_, cb_) {
	if (!(this instanceof Test)) {
		return new Test(name_, opts_, cb_);
	}

	var args = getTestArgs(name_, opts_, cb_);

	this.readable = true;
	this.name = args.name || '(anonymous)';
	this.assertCount = 0;
	this.pendingCount = 0;
	this._skip = args.opts.skip || false;
	this._todo = args.opts.todo || false;
	this._timeout = args.opts.timeout;
	this._plan = undefined;
	this._cb = args.cb;
	this.ended = false;
	this._progeny = [];
	this._teardown = [];
	this._ok = true;
	this._objectPrintDepth = 5;
	var depthEnvVar = process.env.NODE_TAPE_OBJECT_PRINT_DEPTH;
	if (args.opts.objectPrintDepth) {
		this._objectPrintDepth = args.opts.objectPrintDepth;
	} else if (depthEnvVar) {
		if (toLowerCase(depthEnvVar) === 'infinity') {
			this._objectPrintDepth = Infinity;
		} else {
			this._objectPrintDepth = depthEnvVar;
		}
	}

	for (var prop in this) {
		if (typeof this[prop] === 'function') {
			this[prop] = callBind(this[prop], this);
		}
	}
}

inherits(Test, EventEmitter);

function isPromiseLike(x) {
	return x && typeof x.then === 'function';
}

Test.prototype.run = function run() {
	this.emit('prerun');
	if (!this._cb || this._skip) {
		this._end();
		return;
	}
	if (this._timeout != null) {
		this.timeoutAfter(this._timeout);
	}

	var callbackReturn = this._cb(this);

	if (typeof Promise === 'function' && isPromiseLike(callbackReturn)) {
		var self = this;
		Promise.resolve(callbackReturn).then(
			function onResolve() {
				if (!self.calledEnd) {
					self.end();
				}
			},
			function onError(err) {
				if (err instanceof Error || objectToString(err) === '[object Error]') {
					self.ifError(err);
				} else {
					self.fail(err);
				}
				self.end();
			}
		);
		return;
	}

	this.emit('run');
};

Test.prototype.test = function test(name, opts, cb) {
	var self = this;
	var t = new Test(name, opts, cb);
	this._progeny[this._progeny.length] = t;
	this.pendingCount++;
	this.emit('test', t);
	t.on('prerun', function () {
		self.assertCount++;
	});

	if (!self._pendingAsserts()) {
		nextTick(function () {
			self._end();
		});
	}

	nextTick(function () {
		if (!self._plan && self.pendingCount == self._progeny.length) {
			self._end();
		}
	});
};

Test.prototype.comment = function comment(msg) {
	var that = this;
	forEach($split(trim(msg), '\n'), function (aMsg) {
		that.emit('result', $replace(trim(aMsg), /^#\s*/, ''));
	});
};

Test.prototype.plan = function plan(n) {
	this._plan = n;
	this.emit('plan', n);
};

Test.prototype.timeoutAfter = function timeoutAfter(ms) {
	if (!ms) { throw new Error('timeoutAfter requires a timespan'); }
	var self = this;
	var timeout = safeSetTimeout(function () {
		self.fail(self.name + ' timed out after ' + ms + 'ms');
		self.end();
	}, ms);
	this.once('end', function () {
		safeClearTimeout(timeout);
	});
};

Test.prototype.end = function end(err) {
	if (arguments.length >= 1 && !!err) {
		this.ifError(err);
	}

	if (this.calledEnd) {
		this.fail('.end() already called');
	}
	this.calledEnd = true;
	this._end();
};

Test.prototype.teardown = function teardown(fn) {
	if (typeof fn !== 'function') {
		this.fail('teardown: ' + inspect(fn) + ' is not a function');
	} else {
		this._teardown.push(fn);
	}
};

function wrapFunction(original) {
	if (typeof original !== 'undefined' && typeof original !== 'function') {
		throw new TypeError('`original` must be a function or `undefined`');
	}

	var bound = original && callBind.apply(original);

	var calls = [];

	var wrapObject = {
		__proto__: null,
		wrapped: function wrapped() {
			var args = $slice(arguments);
			var completed = false;
			try {
				var returned = bound ? bound(this, arguments) : void undefined;
				calls[calls.length] = { args: args, receiver: this, returned: returned };
				completed = true;
				return returned;
			} finally {
				if (!completed) {
					calls[calls.length] = { args: args, receiver: this, threw: true };
				}
			}
		},
		calls: calls,
		results: function results() {
			try {
				return calls;
			} finally {
				calls = [];
				wrapObject.calls = calls;
			}
		}
	};
	return wrapObject;
}

Test.prototype.capture = function capture(obj, method) {
	if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) {
		throw new TypeError('`obj` must be an object');
	}
	if (typeof method !== 'string' && typeof method !== 'symbol') {
		throw new TypeError('`method` must be a string or a symbol');
	}
	var implementation = arguments.length > 2 ? arguments[2] : void undefined;
	if (typeof implementation !== 'undefined' && typeof implementation !== 'function') {
		throw new TypeError('`implementation`, if provided, must be a function');
	}

	var wrapper = wrapFunction(implementation);
	var restore = mockProperty(obj, method, { value: wrapper.wrapped });
	this.teardown(restore);

	wrapper.results.restore = restore;

	return wrapper.results;
};

Test.prototype.captureFn = function captureFn(original) {
	if (typeof original !== 'function') {
		throw new TypeError('`original` must be a function');
	}

	var wrapObject = wrapFunction(original);
	wrapObject.wrapped.calls = wrapObject.calls;
	return wrapObject.wrapped;
};

Test.prototype.intercept = function intercept(obj, property) {
	if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) {
		throw new TypeError('`obj` must be an object');
	}
	if (typeof property !== 'string' && typeof property !== 'symbol') {
		throw new TypeError('`property` must be a string or a symbol');
	}
	var desc = arguments.length > 2 ? arguments[2] : { __proto__: null };
	if (typeof desc !== 'undefined' && (!desc || typeof desc !== 'object')) {
		throw new TypeError('`desc`, if provided, must be an object');
	}
	if ('configurable' in desc && !desc.configurable) {
		throw new TypeError('`desc.configurable`, if provided, must be `true`, so that the interception can be restored later');
	}
	var isData = 'writable' in desc || 'value' in desc;
	var isAccessor = 'get' in desc || 'set' in desc;
	if (isData && isAccessor) {
		throw new TypeError('`value` and `writable` can not be mixed with `get` and `set`');
	}
	var strictMode = arguments.length > 3 ? arguments[3] : true;
	if (typeof strictMode !== 'boolean') {
		throw new TypeError('`strictMode`, if provided, must be a boolean');
	}

	var calls = [];
	var getter = desc.get && callBind.apply(desc.get);
	var setter = desc.set && callBind.apply(desc.set);
	var value = !isAccessor ? desc.value : void undefined;
	var writable = !!desc.writable;

	function getInterceptor() {
		var args = $slice(arguments);
		if (isAccessor) {
			if (getter) {
				var completed = false;
				try {
					var returned = getter(this, arguments);
					completed = true;
					calls[calls.length] = { type: 'get', success: true, value: returned, args: args, receiver: this };
					return returned;
				} finally {
					if (!completed) {
						calls[calls.length] = { type: 'get', success: false, threw: true, args: args, receiver: this };
					}
				}
			}
		}
		calls[calls.length] = { type: 'get', success: true, value: value, args: args, receiver: this };
		return value;
	}

	function setInterceptor(v) {
		var args = $slice(arguments);
		if (isAccessor && setter) {
			var completed = false;
			try {
				var returned = setter(this, arguments);
				completed = true;
				calls[calls.length] = { type: 'set', success: true, value: v, args: args, receiver: this };
				return returned;
			} finally {
				if (!completed) {
					calls[calls.length] = { type: 'set', success: false, threw: true, args: args, receiver: this };
				}
			}
		}
		var canSet = isAccessor || writable;
		if (canSet) {
			value = v;
		}
		calls[calls.length] = { type: 'set', success: !!canSet, value: value, args: args, receiver: this };

		if (!canSet && strictMode) {
			throw new TypeError('Cannot assign to read only property `' + inspect(property) + '` of object `' + inspect(obj) + '`');
		}
		return value;
	}

	var restore = mockProperty(obj, property, {
		nonEnumerable: !!desc.enumerable,
		get: getInterceptor,
		set: setInterceptor
	});
	this.teardown(restore);

	function results() {
		try {
			return calls;
		} finally {
			calls = [];
		}
	}
	results.restore = restore;

	return results;
};

Test.prototype._end = function _end(err) {
	var self = this;

	if (!this._cb && !this._todo && !this._skip) {
		this.fail('# TODO ' + this.name);
	}

	if (this._progeny.length) {
		var t = $shift(this._progeny);
		t.on('end', function () { self._end(); });
		t.run();
		return;
	}

	function completeEnd() {
		if (!self.ended) { self.emit('end'); }
		var pendingAsserts = self._pendingAsserts();
		if (!self._planError && self._plan !== undefined && pendingAsserts) {
			self._planError = true;
			self.fail('plan != count', {
				expected: self._plan,
				actual: self.assertCount
			});
		}
		self.ended = true;
	}

	function next() {
		if (self._teardown.length === 0) {
			completeEnd();
			return;
		}
		var fn = self._teardown.shift();
		var res;
		try {
			res = fn();
		} catch (e) {
			self.fail(e);
		}
		if (isPromiseLike(res)) {
			res.then(next, function (_err) {
				// TODO: wth?
				err = err || _err;
			});
		} else {
			next();
		}
	}

	next();
};

Test.prototype._exit = function _exit() {
	if (this._plan !== undefined && !this._planError && this.assertCount !== this._plan) {
		this._planError = true;
		this.fail('plan != count', {
			expected: this._plan,
			actual: this.assertCount,
			exiting: true
		});
	} else if (!this.ended) {
		this.fail('test exited without ending: ' + this.name, {
			exiting: true
		});
	}
};

Test.prototype._pendingAsserts = function _pendingAsserts() {
	if (this._plan === undefined) {
		return 1;
	}
	return this._plan - (this._progeny.length + this.assertCount);
};

Test.prototype._assert = function assert(ok, opts) {
	var self = this;
	var extra = opts.extra || {};

	var actualOK = !!ok || !!extra.skip;

	var name = defined(extra.message, opts.message, '(unnamed assert)');
	if (this.calledEnd && opts.operator !== 'fail') {
		this.fail('.end() already called: ' + name);
		return;
	}

	var res = {
		id: self.assertCount++,
		ok: actualOK,
		skip: defined(extra.skip, opts.skip),
		todo: defined(extra.todo, opts.todo, self._todo),
		name: name,
		operator: defined(extra.operator, opts.operator),
		objectPrintDepth: self._objectPrintDepth
	};
	if (hasOwn(opts, 'actual') || hasOwn(extra, 'actual')) {
		res.actual = defined(extra.actual, opts.actual);
	}
	if (hasOwn(opts, 'expected') || hasOwn(extra, 'expected')) {
		res.expected = defined(extra.expected, opts.expected);
	}
	this._ok = !!(this._ok && actualOK);

	if (!actualOK && !res.todo) {
		res.error = defined(extra.error, opts.error, new Error(res.name));
	}

	if (!actualOK) {
		var e = new Error('exception');
		var err = $split(e.stack || '', '\n');
		var tapeDir = __dirname + path.sep;

		for (var i = 0; i < err.length; i++) {
			/*
                Stack trace lines may resemble one of the following.
				We need to correctly extract a function name (if any) and path / line number for each line.

                    at myFunction (/path/to/file.js:123:45)
                    at myFunction (/path/to/file.other-ext:123:45)
                    at myFunction (/path to/file.js:123:45)
                    at myFunction (C:\path\to\file.js:123:45)
                    at myFunction (/path/to/file.js:123)
                    at Test.<anonymous> (/path/to/file.js:123:45)
                    at Test.bound [as run] (/path/to/file.js:123:45)
                    at /path/to/file.js:123:45

                Regex has three parts. First is non-capturing group for 'at ' (plus anything preceding it).

                    /^(?:[^\s]*\s*\bat\s+)/

                Second captures function call description (optional).
				This is not necessarily a valid JS function name, but just what the stack trace is using to represent a function call.
				It may look like `<anonymous>` or 'Test.bound [as run]'.

                For our purposes, we assume that, if there is a function name, it's everything leading up to the first open parentheses (trimmed) before our pathname.

                    /(?:(.*)\s+\()?/

                Last part captures file path plus line no (and optional column no).

                    /((?:[/\\]|[a-zA-Z]:\\)[^:\)]+:(\d+)(?::(\d+))?)\)?/

				In the future, if node supports more ESM URL protocols than `file`, the `file:` below will need to be expanded.
            */
			var re = /^(?:[^\s]*\s*\bat\s+)(?:(.*)\s+\()?((?:[/\\]|[a-zA-Z]:\\|file:\/\/)[^:)]+:(\d+)(?::(\d+))?)\)?$/;
			// first tokenize the PWD, then tokenize tape
			var lineWithTokens = $replace(
				$replace(
					err[i],
					process.cwd(),
					path.sep + '$CWD'
				),
				tapeDir,
				path.sep + '$TEST' + path.sep
			);
			var m = re.exec(lineWithTokens);

			if (!m) {
				continue;
			}

			var callDescription = m[1] || '<anonymous>';
			// first untokenize tape, and then untokenize the PWD, then strip the line/column
			var filePath = $replace(
				$replace(
					$replace(m[2], path.sep + '$TEST' + path.sep, tapeDir),
					path.sep + '$CWD',
					process.cwd()
				),
				/:\d+:\d+$/,
				''
			);

			if ($strSlice(filePath, 0, tapeDir.length) === tapeDir) {
				continue;
			}

			// Function call description may not (just) be a function name.
			// Try to extract function name by looking at first "word" only.
			res.functionName = $split(callDescription, /\s+/)[0];
			res.file = filePath;
			res.line = Number(m[3]);
			if (m[4]) { res.column = Number(m[4]); }

			res.at = callDescription + ' (' + filePath + ':' + res.line + (res.column ? ':' + res.column : '') + ')';
			break;
		}
	}

	self.emit('result', res);

	var pendingAsserts = self._pendingAsserts();
	if (!pendingAsserts) {
		if (extra.exiting) {
			self._end();
		} else {
			nextTick(function () {
				self._end();
			});
		}
	}

	if (!self._planError && pendingAsserts < 0) {
		self._planError = true;
		self.fail('plan != count', {
			expected: self._plan,
			actual: self._plan - pendingAsserts
		});
	}
};

Test.prototype.fail = function fail(msg, extra) {
	this._assert(false, {
		message: msg,
		operator: 'fail',
		extra: extra
	});
};

Test.prototype.pass = function pass(msg, extra) {
	this._assert(true, {
		message: msg,
		operator: 'pass',
		extra: extra
	});
};

Test.prototype.skip = function skip(msg, extra) {
	this._assert(true, {
		message: msg,
		operator: 'skip',
		skip: true,
		extra: extra
	});
};

var testAssert = function assert(value, msg, extra) { // eslint-disable-line func-style
	this._assert(value, {
		message: defined(msg, 'should be truthy'),
		operator: 'ok',
		expected: true,
		actual: value,
		extra: extra
	});
};
Test.prototype.ok
= Test.prototype['true']
= Test.prototype.assert
= testAssert;

function notOK(value, msg, extra) {
	this._assert(!value, {
		message: defined(msg, 'should be falsy'),
		operator: 'notOk',
		expected: false,
		actual: value,
		extra: extra
	});
}
Test.prototype.notOk
= Test.prototype['false']
= Test.prototype.notok
= notOK;

function error(err, msg, extra) {
	this._assert(!err, {
		message: defined(msg, String(err)),
		operator: 'error',
		error: err,
		extra: extra
	});
}
Test.prototype.error
= Test.prototype.ifError
= Test.prototype.ifErr
= Test.prototype.iferror
= error;

function strictEqual(a, b, msg, extra) {
	if (arguments.length < 2) {
		throw new TypeError('two arguments must be provided to compare');
	}
	this._assert(is(a, b), {
		message: defined(msg, 'should be strictly equal'),
		operator: 'equal',
		actual: a,
		expected: b,
		extra: extra
	});
}
Test.prototype.equal
= Test.prototype.equals
= Test.prototype.isEqual
= Test.prototype.strictEqual
= Test.prototype.strictEquals
= Test.prototype.is
= strictEqual;

function notStrictEqual(a, b, msg, extra) {
	if (arguments.length < 2) {
		throw new TypeError('two arguments must be provided to compare');
	}
	this._assert(!is(a, b), {
		message: defined(msg, 'should not be strictly equal'),
		operator: 'notEqual',
		actual: a,
		expected: b,
		extra: extra
	});
}

Test.prototype.notEqual
= Test.prototype.notEquals
= Test.prototype.isNotEqual
= Test.prototype.doesNotEqual
= Test.prototype.isInequal
= Test.prototype.notStrictEqual
= Test.prototype.notStrictEquals
= Test.prototype.isNot
= Test.prototype.not
= notStrictEqual;

function looseEqual(a, b, msg, extra) {
	if (arguments.length < 2) {
		throw new TypeError('two arguments must be provided to compare');
	}
	this._assert(a == b, {
		message: defined(msg, 'should be loosely equal'),
		operator: 'looseEqual',
		actual: a,
		expected: b,
		extra: extra
	});
}

Test.prototype.looseEqual
= Test.prototype.looseEquals
= looseEqual;

function notLooseEqual(a, b, msg, extra) {
	if (arguments.length < 2) {
		throw new TypeError('two arguments must be provided to compare');
	}
	this._assert(a != b, {
		message: defined(msg, 'should not be loosely equal'),
		operator: 'notLooseEqual',
		actual: a,
		expected: b,
		extra: extra
	});
}
Test.prototype.notLooseEqual
= Test.prototype.notLooseEquals
= notLooseEqual;

function tapeDeepEqual(a, b, msg, extra) {
	if (arguments.length < 2) {
		throw new TypeError('two arguments must be provided to compare');
	}
	this._assert(deepEqual(a, b, { strict: true }), {
		message: defined(msg, 'should be deeply equivalent'),
		operator: 'deepEqual',
		actual: a,
		expected: b,
		extra: extra
	});
}
Test.prototype.deepEqual
= Test.prototype.deepEquals
= Test.prototype.isEquivalent
= Test.prototype.same
= tapeDeepEqual;

function notDeepEqual(a, b, msg, extra) {
	if (arguments.length < 2) {
		throw new TypeError('two arguments must be provided to compare');
	}
	this._assert(!deepEqual(a, b, { strict: true }), {
		message: defined(msg, 'should not be deeply equivalent'),
		operator: 'notDeepEqual',
		actual: a,
		expected: b,
		extra: extra
	});
}
Test.prototype.notDeepEqual
= Test.prototype.notDeepEquals
= Test.prototype.notEquivalent
= Test.prototype.notDeeply
= Test.prototype.notSame
= Test.prototype.isNotDeepEqual
= Test.prototype.isNotDeeply
= Test.prototype.isNotEquivalent
= Test.prototype.isInequivalent
= notDeepEqual;

function deepLooseEqual(a, b, msg, extra) {
	if (arguments.length < 2) {
		throw new TypeError('two arguments must be provided to compare');
	}
	this._assert(deepEqual(a, b), {
		message: defined(msg, 'should be loosely deeply equivalent'),
		operator: 'deepLooseEqual',
		actual: a,
		expected: b,
		extra: extra
	});
}

Test.prototype.deepLooseEqual
= deepLooseEqual;

function notDeepLooseEqual(a, b, msg, extra) {
	if (arguments.length < 2) {
		throw new TypeError('two arguments must be provided to compare');
	}
	this._assert(!deepEqual(a, b), {
		message: defined(msg, 'should not be loosely deeply equivalent'),
		operator: 'notDeepLooseEqual',
		actual: a,
		expected: b,
		extra: extra
	});
}
Test.prototype.notDeepLooseEqual
= notDeepLooseEqual;

var isObject = require('./isObject');

Test.prototype['throws'] = function (fn, expected, msg, extra) {
	if (typeof expected === 'string') {
		msg = expected;
		expected = undefined;
	}

	var caught;

	try {
		fn();
	} catch (err) {
		caught = { error: err };
		if (isObject(err) && 'message' in err && (!isEnumerable(err, 'message') || !hasOwn(err, 'message'))) {
			try {
				var message = err.message;
				delete err.message;
				err.message = message;
			} catch (e) { /**/ }
		}
	}

	var passed = caught;

	if (caught) {
		if (typeof expected === 'string' && caught.error && caught.error.message === expected) {
			throw new TypeError('The "error/message" argument is ambiguous. The error message ' + inspect(expected) + ' is identical to the message.');
		}
		if (typeof expected === 'function') {
			if (typeof expected.prototype !== 'undefined' && caught.error instanceof expected) {
				passed = true;
			} else if (isErrorConstructor(expected)) {
				passed = false;
			} else {
				passed = expected.call({}, caught.error) === true;
			}
		} else if (isRegExp(expected)) {
			passed = $exec(expected, caught.error) !== null;
			expected = inspect(expected);
		} else if (expected && typeof expected === 'object') { // Handle validation objects.
			if (caught.error && typeof caught.error === 'object') {
				var keys = objectKeys(expected);
				// Special handle errors to make sure the name and the message are compared as well.
				if (expected instanceof Error) {
					keys[keys.length] = 'name';
					keys[keys.length] = 'message';
				} else if (keys.length === 0) {
					throw new TypeError('`throws` validation object must not be empty');
				}
				passed = every(keys, function (key) {
					if (typeof caught.error[key] === 'string' && isRegExp(expected[key]) && $exec(expected[key], caught.error[key]) !== null) {
						return true;
					}
					if (key in caught.error && deepEqual(caught.error[key], expected[key], { strict: true })) {
						return true;
					}
					return false;
				});
			} else {
				passed = false;
			}
		}
	}

	this._assert(!!passed, {
		message: defined(msg, 'should throw'),
		operator: 'throws',
		actual: caught && caught.error,
		expected: expected,
		error: !passed && caught && caught.error,
		extra: extra
	});
};

Test.prototype.doesNotThrow = function doesNotThrow(fn, expected, msg, extra) {
	if (typeof expected === 'string') {
		msg = expected;
		expected = undefined;
	}
	var caught;
	try {
		fn();
	} catch (err) {
		caught = { error: err };
	}
	this._assert(!caught, {
		message: defined(msg, 'should not throw'),
		operator: 'throws',
		actual: caught && caught.error,
		expected: expected,
		error: caught && caught.error,
		extra: extra
	});
};

Test.prototype.match = function match(string, regexp, msg, extra) {
	if (!isRegExp(regexp)) {
		this._assert(false, {
			message: defined(msg, 'The "regexp" argument must be an instance of RegExp. Received type ' + typeof regexp + ' (' + inspect(regexp) + ')'),
			operator: 'match',
			actual: objectToString(regexp),
			expected: '[object RegExp]',
			extra: extra
		});
	} else if (typeof string !== 'string') {
		this._assert(false, {
			message: defined(msg, 'The "string" argument must be of type string. Received type ' + typeof string + ' (' + inspect(string) + ')'),
			operator: 'match',
			actual: string === null ? null : typeof string,
			expected: 'string',
			extra: extra
		});
	} else {
		var matches = $exec(regexp, string) !== null;
		var message = defined(
			msg,
			'The input ' + (matches ? 'matched' : 'did not match') + ' the regular expression ' + inspect(regexp) + '. Input: ' + inspect(string)
		);
		this._assert(matches, {
			message: message,
			operator: 'match',
			actual: string,
			expected: regexp,
			extra: extra
		});
	}
};

Test.prototype.doesNotMatch = function doesNotMatch(string, regexp, msg, extra) {
	if (!isRegExp(regexp)) {
		this._assert(false, {
			message: defined(msg, 'The "regexp" argument must be an instance of RegExp. Received type ' + typeof regexp + ' (' + inspect(regexp) + ')'),
			operator: 'doesNotMatch',
			actual: objectToString(regexp),
			expected: '[object RegExp]',
			extra: extra
		});
	} else if (typeof string !== 'string') {
		this._assert(false, {
			message: defined(msg, 'The "string" argument must be of type string. Received type ' + typeof string + ' (' + inspect(string) + ')'),
			operator: 'doesNotMatch',
			actual: string === null ? null : typeof string,
			expected: 'string',
			extra: extra
		});
	} else {
		var matches = $exec(regexp, string) !== null;
		var message = defined(
			msg,
			'The input ' + (matches ? 'was expected to not match' : 'did not match') + ' the regular expression ' + inspect(regexp) + '. Input: ' + inspect(string)
		);
		this._assert(!matches, {
			message: message,
			operator: 'doesNotMatch',
			actual: string,
			expected: regexp,
			extra: extra
		});
	}
};

Test.prototype.assertion = function assertion(fn) {
	return callBind.apply(fn)(this, $slice(arguments, 1));
};

// eslint-disable-next-line no-unused-vars
Test.skip = function skip(name_, _opts, _cb) {
	var args = getTestArgs.apply(null, arguments);
	args.opts.skip = true;
	return new Test(args.name, args.opts, args.cb);
};

module.exports = Test;

// vim: set softtabstop=4 shiftwidth=4:
