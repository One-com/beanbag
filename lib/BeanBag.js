var EventEmitter = require('events').EventEmitter,
    util = require('util'),
    URL = require('url'),
    _ = require('underscore'),
    request = require('request'),
    lines = require('lines'),
    crypto = require('crypto'),
    Buffer = require('buffer').Buffer,
    httpErrors = require('httperrors'),
    passError = require('passerror');

/*
 * config.scheme         {String} (optional) The scheme to use. Defaults to "http" ("https" is also supported). Aliased as config.protocol.
 * config.host           {String} (optional) The server host name, defaults to "localhost".
 * config.port           {Number} (optional) The server port number, defaults to 5984.
 * config.databaseName   {String} (required unless config.url is used) The name of the database to use.
 * config.url            {String|Array} (optional) The complete url to the database. Overrides config.host, config.port, and config.databaseName.
 *                                                 Round-robins if it's an array.
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

    // Extend this with known-good configuration values
    _.extend(this, _.pick(config, [
        'scheme',
        'host',
        'port',
        'databaseName',
        'url',
        'designDocument',
        'trustViewETags',
        'numRetries'
    ]));

    if (this.url) {
        // Ensure no trailing slash:
        if (Array.isArray(this.url)) {
            this.url = this.url.map(function (url) {
                return url.replace(/\/$/, '');
            });
        } else {
            this.url = this.url.replace(/\/$/, '');
        }
    } else {
        if (!this.databaseName) {
            throw new Error('BeanBag: config.databaseName is mandatory unless config.url is provided');
        }
        this.url =
            (this.protocol || this.scheme || 'http').replace(/:$/, '') + '://' +
            (this.host || 'localhost') + ':' + (this.port || 5984) +
            '/' + this.databaseName;
    }

    this.numRetries = this.numRetries || 0;

    if (this.designDocument) {
        this.designDocumentVersion = crypto.createHash('md5').update(this.objToCouchJson(this.designDocument, 'utf-8')).digest('hex');
    }
}

util.inherits(BeanBag, EventEmitter);

_.extend(BeanBag.prototype, {
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
        if (options.onResponse || options.streamRows) {
            numRetries = 0;
        }

        options.headers = options.headers || {};
        if (Array.isArray(that.url)) {
            // Round-robin
            options.url = that.url[0];
            that.url.push(that.url.shift());
        } else {
            options.url = that.url;
        }
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
                    } else {
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
                    return request(options, handleResponse);
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

        if (options.onResponse) {
            // Mock old request API
            var seenResponse = false;
            return request(options, function () {
                if (!seenResponse) {
                    handleResponse.apply(this, arguments);
                }
            }).on('response', function (response) {
                seenResponse = true;
                handleResponse.call(this, null, response);
            });
        } else if (options.streamRows) {
            // Ignore cb and return an EventEmitter
            var eventEmitter = options.eventEmitter || new EventEmitter(),
                oldCb = cb;
            cb = function (err, response) {
                if (err) {
                    if (oldCb) {
                        oldCb(err);
                    } else {
                        eventEmitter.emit('error', err);
                    }
                } else {
                    eventEmitter.emit('response', response);
                    response.setEncoding('utf-8');
                    lines(response);
                    var ended = false;
                    response.on('line', function (str) {
                        if (ended) {
                            return;
                        }
                        var matchFirstLine = str.match(/^\{(.*)"rows":\s*\[$/);
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
                                emit('error', new httpErrors.InternalServerError("Couldn't parse line: " + str));
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
            var seenResponse = false;
            request(options, function () {
                if (!seenResponse) {
                    handleResponse.apply(this, arguments);
                }
            }).on('response', function (response) {
                seenResponse = true;
                handleResponse.call(this, null, response);
            });
            return eventEmitter;
        } else {
            return request(options, handleResponse);
        }
    },

    // private
    installDesignDocument: function (options, cb) {
        var that = this;
        that.request({method: 'PUT', path: '_design/' + that.designDocumentVersion, body: that.designDocument}, function (err) {
            if (!err) {
                // Successfully installed the new design document.
                // Call the callback, then see if there are any old design documents that can be cleaned up.
                cb();
                that.request({path: '_all_docs', query: {startkey: '_design/', endkey: '_design/~'}}, function (err, response, body) {
                    if (err) {
                        return; // Should probably be logged somewhere
                    }
                    (body.rows || []).forEach(function (row) {
                        if (/^_design\//.test(row.id) && row.id !== '_design/' + that.designDocumentVersion) {
                            that.request({method: 'DELETE', path: row.id + '?rev=' + row.value.rev}, function (err) {
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
    init: function (cb) {
        var that = this;
        that.request({method: 'PUT'}, function (err) {
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
            that = this;

        return that.request({
            method: 'POST',
            path: '_temp_view',
            headers: conditionalHeaders,
            body: _.extend({
                language: 'javascript'
            }, view),
            query: query,
            onResponse: onResponse,
            streamRows: streamRows
        }, cb);
    },

    queryDesignDocument: function (options, cb) {
        var listName = options.listName, // optional, not supported for temporary views
            viewName = options.viewName,
            conditionalHeaders = options.conditionalHeaders,
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
            return that.queryTemporaryView({view: that.designDocument[viewName], query: query, conditionalHeaders: conditionalHeaders}, cb);
        } else {
            var eventEmitter;
            if (streamRows) {
                eventEmitter = new EventEmitter();
            }

            if (conditionalHeaders && !that.trustViewETags) {
                // Safeguard against https://issues.apache.org/jira/browse/COUCHDB-909
                delete conditionalHeaders.etag;
            }

            function performOperation(callback) {
                that.request({
                    headers: conditionalHeaders,
                    path: '_design/' + that.designDocumentVersion + '/' + (listName ? '_list/' + listName + '/' : '_view/') + viewName,
                    query: query,
                    streamRows: streamRows,
                    eventEmitter: eventEmitter
                }, callback);
            }

            performOperation(function (err, response, body) {
                if (err && err.NotFound) {
                    // Design document is missing or it's an old version. Install the newest version and try the request again.
                    that.installDesignDocument({}, passError(cb, function () {
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
