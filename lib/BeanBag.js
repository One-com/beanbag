var EventEmitter = require('events').EventEmitter,
    util = require('util'),
    URL = require('url'),
    _ = require('underscore'),
    requestLibrary = require('request'),
    lines = require('lines'),
    crypto = require('crypto'),
    httpErrors = require('httperrors'),
    passError = require('passerror');

function extractNonRequestOptions(obj) {
    var result = {};
    if (obj) {
        Object.keys(obj).forEach(function (key) {
            if (key !== 'method' && key !== 'headers' && key !== 'path' && key !== 'query' && key !== 'streamRows' && key !== 'eventEmitter' && key !== 'url' && key !== 'path') {
                result[key] = obj[key];
            }
        });
    }
    return result;
}

/*
 * config.url            {String|Array} The complete url to the database. Round-robins if it's an array.
 * config.designDocument {Object} (optional) The design document as an object with "real" functions (require-friendly). If not provided,
 *                                           the 'queryDesignDocument' method won't work.
 * config.trustViewETags {Boolean} (optional) Whether to support conditional GET on views. Defaults to true.
 *                                            This can be problematic in some development settings where database are deleted
 *                                            and recreated, see https://issues.apache.org/jira/browse/COUCHDB-909
 * config.numRetries     {Number} (optional) The number of times to retry an operation if it fails due to a non-HTTP error such
 *                                           as a socket timeout. Defaults to 0.
 */
function BeanBag(config) {
    EventEmitter.call(this);

    if (config) {
        Object.keys(config).forEach(function (key) {
            if (typeof this[key] === 'undefined' || key === 'requestLibrary') {
                this[key] = config[key];
            } else {
                throw new Error('Unsupported config option: ' + key + ' (would conflict with built-in property)');
            }
        }, this);
    }

    // Ensure no trailing slash:
    if (Array.isArray(this.url)) {
        this.url = this.url.map(function (url) {
            return url.replace(/\/$/, '');
        });
    } else if (typeof this.url === 'string') {
        this.url = this.url.replace(/\/$/, '');
    } else {
        throw new Error('config.url is required');
    }

    this.numRetries = this.numRetries || 0;

    if (this.designDocument) {
        this.designDocumentVersion = crypto.createHash('md5').update(this.objToCouchJson(this.designDocument, 'utf-8')).digest('hex');
    }
}

util.inherits(BeanBag, EventEmitter);

_.extend(BeanBag.prototype, {
    requestLibrary: requestLibrary,

    // The same as JSON.stringify except functions are converted to strings
    objToCouchJson: function (obj) {
        return JSON.stringify(obj, function (key, val) {
            if (typeof val === 'function') {
                return val.toString();
            }
            return val;
        });
    },

    /*
     * Perform a request
     *
     * options.headers    {Object} (optional) The HTTP headers for the request.
     * options.path       {String} (optional) The path relative to the database url.
     * options.query      {Object} (optional) The query string (objects will be JSON.stringify'ed)
     * options.body       {String|Object|Buffer|Stream} (optional) What to send. Streams are streamed, objects will be serialized as JSON,
     *                                                             and buffers are sent as-is.
     * options.numRetries {Number} (optional) The number of times to retry an operation if it fails due to a non-HTTP error such
     *                                        as a socket timeout. Defaults to the numRetries parameter given to the constructor
     *                                        (which defaults to 0). Has no effect with the onResponse and streamRows options.
     * options.onResponse {Boolean} (optional) Whether the callback will be called as soon as a response headers are available so that the
     *                                         response body can be streamed. This emulates the pre-2.9.200 request API. Defaults to false.
     * options.streamRows {Boolean} (optional) If specified, an event emitter will be returned that emits error/metadata/row/end events.
     *                                         This is useful for big responses that you don't want to parse in one go. Defaults to false.
     */
    request: function (options, cb) {
        var that = this,
            numRetries = typeof options.numRetries !== 'undefined' ? options.numRetries : that.numRetries;
        options = _.extend({}, options);
        options.headers = _.extend({}, options.headers);
        if (options.onResponse || options.streamRows) {
            numRetries = 0;
        }
        if (Array.isArray(that.url)) {
            // Round-robin
            options.url = that.url[0];
            that.url.push(that.url.shift());
        } else {
            options.url = that.url;
        }
        options.url = options.url.replace(/\{([^\}]+)\}/g, function ($0, placeholderName) {
            var replacementValue;
            if (/^\w+$/.test(placeholderName)) {
                replacementValue = options[placeholderName] || that[placeholderName] || $0;
            } else {
                var methodName = '__placeholder_fn_' + placeholderName;
                if (!that[methodName]) {
                    that[methodName] = new Function('requestOptions', 'return ' + placeholderName + ';');
                }
                replacementValue = that[methodName](options);
            }
            if (typeof replacementValue === 'function') {
                replacementValue = replacementValue.call(that, options, placeholderName);
            }
            return replacementValue;
        });
        if (options.path) {
            if (/^[\/\.]/.test(options.path)) {
                // options.path is root-relative or begins with a dot, treat it as a relative url that needs to be resolved:
                options.url = URL.resolve(options.url + '/', options.path);
            } else {
                options.url += '/' + options.path;
            }
        }
        if (options.query) {
            options.url += (options.url.indexOf('?') !== -1) ? '&' : '?';
            if (_.isString(options.query)) {
                options.url += options.query;
            } else {
                // Assume object
                var params = [];
                _.each(options.query, function (value, key) {
                    if (Array.isArray(value)) {
                        // Turn query: {foo: ['a', 'b']} into ?foo=a&foo=b
                        value.forEach(function (valueArrayItem) {
                            params.push(encodeURIComponent(key) + '=' + encodeURIComponent(JSON.stringify(valueArrayItem)));
                        });
                    } else if (typeof value !== 'undefined') {
                        params.push(encodeURIComponent(key) + '=' + encodeURIComponent(JSON.stringify(value)));
                    }
                });
                options.url += params.join('&');
            }
        }
        if (typeof options.body === 'object' && !Buffer.isBuffer(options.body)) {
            options.body = that.objToCouchJson(options.body);
            options.headers['content-type'] = 'application/json';
        }
        if (!('accept' in options.headers)) {
            options.headers.accept = 'application/json';
        }

        function handleResponse(err, response, body) {
            if (err) {
                // Non-HTTP error (ECONNRESET, ETIMEDOUT, etc.)
                // Try again (up to numRetries times). Warning: This doesn't work when piping into the returned request,
                // so please specify numRetries:0 if you intend to do that.
                that.emit('afterRequest', options, err, response, body, numRetries);
                if (numRetries > 0) {
                    numRetries -= 1;
                    if (options.onResponse) {
                        return makeRequest(handleResponse);
                    } else {
                        return that.requestLibrary(options, handleResponse);
                    }
                } else {
                    return cb(err);
                }
            } else {
                that.emit('afterRequest', options, null, response, body);
                response.cacheInfo = {
                    headers: {}
                };
                if (response.statusCode >= 400) {
                    return cb(new httpErrors[response.statusCode]());
                } else if (response.statusCode === 304) {
                    response.cacheInfo.notModified = true;
                    body = null;
                }
                ['last-modified', 'etag', 'expires', 'cache-control', 'content-type'].forEach(function (headerName) {
                    if (headerName in response.headers) {
                        response.cacheInfo.headers[headerName] = response.headers[headerName];
                    }
                });
                if (body && response.headers['content-type'] === 'application/json') {
                    try {
                        body = JSON.parse(body);
                    } catch (e) {
                        return cb(new httpErrors.BadGateway());
                    }
                }
                cb(null, response, body);
            }
        }

        function makeRequest(callback) {
            var seenResponse = false;

            return that.requestLibrary(options).on('response', function (response) {
                seenResponse = true;
                callback(null, response);
            }).on('error', function (err) {
                // Non-HTTP error handled if the response event has not fired
                if (!seenResponse) {
                    callback(err);
                }
            });
        }

        if (options.onResponse) {
            return makeRequest(handleResponse);
        } else if (options.streamRows) {
            // Ignore cb and return an EventEmitter
            var eventEmitter = options.eventEmitter || new EventEmitter();
            cb = function (err, response) {
                if (err) {
                    eventEmitter.emit('error', err);
                } else {
                    eventEmitter.emit('response', response);
                    response.setEncoding('utf-8');
                    lines(response);
                    var ended = false;
                    response.on('line', function (str) {
                        if (ended) {
                            return;
                        }

                        // use a regex to match the JSON metadata row and emit it
                        // both populated and empty result cases are handled
                        var matchFirstLine = str.match(/^\{(.*)"rows":\s*\[(?:\]\}|)$/);
                        if (matchFirstLine) {
                            eventEmitter.emit('metadata', JSON.parse('{' + matchFirstLine[1].replace(/\,\s*$/, '') + '}'));
                        } else if (str === ']}' || str === '') {
                            return;
                        } else {
                            str = str.replace(/,\r?$/, '');
                            var row;
                            try {
                                row = JSON.parse(str);
                            } catch (e) {
                                ended = true;
                                eventEmitter.emit('error', new httpErrors.InternalServerError("Couldn't parse line: " + str));
                            }
                            eventEmitter.emit('row', row);
                        }
                    }).on('end', function () {
                        if (!ended) {
                            ended = true;
                            eventEmitter.emit('end');
                        }
                    }).on('error', function (err) {
                        if (!ended) {
                            ended = true;
                            eventEmitter.emit('error', err);
                        }
                    });
                }
            };

            var upstreamRequest = makeRequest(function (err, response) {
                if (err) {
                    eventEmitter.emit('error', err);
                } else {
                    handleResponse(null, response);
                }
            });

            eventEmitter.abort = function () {
                upstreamRequest.abort();
            };

            return eventEmitter;
        } else {
            return that.requestLibrary(options, handleResponse);
        }
    },

    // private
    installDesignDocument: function (options, cb) {
        var that = this,
            nonRequestOptions = extractNonRequestOptions(options);

        that.request(_.defaults({method: 'PUT', path: '_design/' + that.designDocumentVersion, body: that.designDocument}, nonRequestOptions), function (err) {
            if (!err) {
                // Successfully installed the new design document.
                // Call the callback, then see if there are any old design documents that can be cleaned up.
                cb();
                that.request(_.defaults({path: '_all_docs', query: {startkey: '_design/', endkey: '_design/~'}}, nonRequestOptions), function (err, response, body) {
                    if (err) {
                        return; // Should probably be logged somewhere
                    }
                    (body.rows || []).forEach(function (row) {
                        if (/^_design\//.test(row.id) && row.id !== '_design/' + that.designDocumentVersion) {
                            that.request(_.defaults({method: 'DELETE', path: row.id + '?rev=' + row.value.rev}, nonRequestOptions), function (err) {
                                // Maybe log error
                            });
                        }
                    });
                });
            } else if (err.Conflict) {
                // Just report success if we got a 409 Conflict back (ie. someone else just installed the same design doc)
                cb();
            } else {
                cb(err);
            }
        });
    },

    // Idempotent
    init: function (options, cb) {
        var that = this;
        that.request(_.defaults({method: 'PUT'}, extractNonRequestOptions(options)), function (err) {
            // Don't report an error if the database already exists
            if (err && !err.PreconditionFailed) {
                return cb(err);
            }
            cb();
        });
    },

    queryTemporaryView: function (options, cb) {
        var view = options.view, // {map: function (doc) {...}, reduce: function () {...}}
            query = options.query,
            conditionalHeaders = options.conditionalHeaders,
            onResponse = options.onResponse,
            streamRows = options.streamRows,
            nonRequestOptions = extractNonRequestOptions(options),
            that = this;

        return that.request(_.defaults({
            method: 'POST',
            path: '_temp_view',
            headers: conditionalHeaders,
            body: _.extend({
                language: 'javascript'
            }, view),
            query: query,
            onResponse: onResponse,
            streamRows: streamRows
        }, nonRequestOptions), cb);
    },

    queryDesignDocument: function (options, cb) {
        var listName = options.listName, // optional, not supported for temporary views
            viewName = options.viewName,
            conditionalHeaders = options.conditionalHeaders,
            nonRequestOptions = extractNonRequestOptions(options),
            streamRows = options.streamRows,
            query = options.query,
            that = this;

        if (!that.designDocument || !that.designDocument.views || !that.designDocument.views[viewName]) {
            throw new Error('queryDesignDocument: ' + viewName + ' not found in design document');
        }

        if (options.temporary) {
            if (listName) {
                throw new Error('queryDesignDocument: options.listName not supported when querying a temporary view');
            }
            return that.queryTemporaryView(_.defaults({
                view: that.designDocument[viewName],
                query: query,
                conditionalHeaders: conditionalHeaders
            }, nonRequestOptions), cb);
        } else {
            var eventEmitter;
            if (streamRows) {
                eventEmitter = new EventEmitter();
            }

            if (conditionalHeaders && !that.trustViewETags) {
                // Safeguard against https://issues.apache.org/jira/browse/COUCHDB-909
                delete conditionalHeaders.etag;
            }

            // relax jshint warning about inline function definition
            /*jshint -W082*/
            function performOperation(callback) {
                if (streamRows) {
                    // Hack: If the first event emitted is an error, pass that to the callback instead of emitting it to our caller.
                    // It might be a NotFound for the design document instead, which is handled below.
                    eventEmitter.emit = function (eventName, firstArgument) {
                        eventEmitter.emit = EventEmitter.prototype.emit;
                        if (eventName === 'error') {
                            callback(firstArgument);
                        } else {
                            EventEmitter.prototype.emit.apply(this, arguments);
                        }
                    };
                }

                that.request(_.defaults({
                    headers: conditionalHeaders,
                    path: '_design/' + that.designDocumentVersion + '/' + (listName ? '_list/' + listName + '/' : '_view/') + viewName,
                    query: query,
                    streamRows: streamRows,
                    eventEmitter: eventEmitter
                }, nonRequestOptions), callback);
            }
            /*jshint +W082*/

            performOperation(function (err, response, body) {
                if (err && err.NotFound) {
                    // Design document is missing or it's an old version. Install the newest version and try the request again.
                    that.installDesignDocument(nonRequestOptions, passError(cb, function () {
                        // Retry the operation, but report failure to the original callback this time:
                        performOperation(cb);
                    }));
                } else {
                    if (!that.trustViewETags) {
                        delete response.cacheInfo.headers.etag; // Safeguard against https://issues.apache.org/jira/browse/COUCHDB-909
                    }
                    cb(err, response, body);
                }
            });
            return eventEmitter;
        }
    }
});

module.exports = BeanBag;
