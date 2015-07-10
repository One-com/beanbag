/*global JSON*/
var EventEmitter = require('events').EventEmitter,
    Teepee = require('teepee'),
    byLine = require('byline'),
    util = require('util'),
    _ = require('underscore'),
    crypto = require('crypto'),
    passError = require('passerror');

/*
 * config.designDocument {Object}  (optional) The design document as an object with "real" functions (require-friendly). If not provided,
 *                                            the 'queryDesignDocument' method won't work.
 * config.trustViewETags {Boolean} (optional) Whether to support conditional GET on views. Defaults to true.
 *                                            This can be problematic in some development settings where database are deleted
 *                                            and recreated, see https://issues.apache.org/jira/browse/COUCHDB-909
 * Also, all Teepee constructor options are supported.
 */
function BeanBag(config) {
    Teepee.call(this, config);

    if (this.designDocument) {
        this.designDocumentVersion = crypto.createHash('md5').update(this.objToCouchJson(this.designDocument, 'utf-8')).digest('hex');
    }
}

util.inherits(BeanBag, Teepee);

// The same as JSON.stringify except functions are converted to strings
BeanBag.prototype.objToCouchJson = function (obj) {
    return JSON.stringify(obj, function (key, val) {
        if (typeof val === 'function') {
            return val.toString();
        }
        return val;
    });
};

// Override Teepee's implementation so parameters get JSON.stringify'ed:
BeanBag.prototype.preprocessQueryStringParameterValue = JSON.stringify;

// Override Teepee's implementation so functions are stringified (for design documents and the like):
BeanBag.prototype.stringifyJsonRequestBody = function (obj) {
    return this.objToCouchJson(obj);
};

BeanBag.prototype.getPlaceholderValue = function (placeholderName, requestOptions) {
    if (typeof requestOptions[placeholderName] !== 'undefined') {
        return requestOptions[placeholderName];
    } else {
        var type = typeof this[placeholderName];
        if (type === 'undefined') {
            return '{' + placeholderName + '}';
        } else {
            var value = this[placeholderName];
            if (typeof value === 'function') {
                return value.call(this, requestOptions, placeholderName);
            } else {
                return String(value);
            }
        }
    }
};

// private
BeanBag.prototype.installDesignDocument = function (options, cb) {
    var that = this,
        nonRequestOptions = that.extractNonRequestOptions(options);

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
};

// Idempotent
BeanBag.prototype.init = function (options, cb) {
    this.request(_.defaults({method: 'PUT'}, this.extractNonRequestOptions(options)), function (err) {
        // Don't report an error if the database already exists
        if (err && !err.PreconditionFailed) {
            return cb(err);
        }
        cb();
    });
};

BeanBag.prototype.queryTemporaryView = function (options, cb) {
    var view = options.view, // {map: function (doc) {...}, reduce: function () {...}}
        query = options.query,
        conditionalHeaders = options.conditionalHeaders,
        onResponse = options.onResponse,
        streamRows = options.streamRows,
        nonRequestOptions = this.extractNonRequestOptions(options);

    return this.request(_.defaults({
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
};

BeanBag.prototype.queryDesignDocument = function (options, cb) {
    var listName = options.listName, // optional, not supported for temporary views
        viewName = options.viewName,
        conditionalHeaders = options.conditionalHeaders,
        nonRequestOptions = this.extractNonRequestOptions(options),
        streamRows = options.streamRows,
        query = options.query,
        that = this;

    if (!this.designDocument || !this.designDocument.views || !this.designDocument.views[viewName]) {
        throw new Error('queryDesignDocument: ' + viewName + ' not found in design document');
    }

    if (options.temporary) {
        if (listName) {
            throw new Error('queryDesignDocument: options.listName not supported when querying a temporary view');
        }
        return this.queryTemporaryView(_.defaults({
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
};

BeanBag.prototype.request = function (options) {
    var eventEmitter = Teepee.prototype.request.apply(this, arguments);

    // Hopefully we'll come up with a better way of hooking this up:

    if (options && options.streamRows) {
        eventEmitter.on('response', function (response) {
            var lineStream = byLine(response);
            lineStream.setEncoding('utf-8');
            lineStream.on('data', function (str) {
                // use a regex to match the JSON metadata row and emit it
                // both populated and empty result cases are handled
                var matchFirstLine = str.match(/^\{(.*)"(?:rows|results)":\s*\[(?:\]\}|)$/);
                if (matchFirstLine) {
                    if (matchFirstLine[1] !== "") {
                        eventEmitter.emit('metadata', JSON.parse('{' + matchFirstLine[1].replace(/\,\s*$/, '') + '}'));
                    }
                } else {
                    var matchLastLine = str.match(/^(".*)\}$/);
                    if (matchLastLine) {
                        eventEmitter.emit('metadata', JSON.parse('{' + matchLastLine[1] + '}'));
                    } else if (str === ']}' || str === '' || str === '],') {
                        return;
                    } else {
                        str = str.replace(/,\r?$/, '');
                        var row;
                        try {
                            row = JSON.parse(str);
                        } catch (e) {
                            handleError(httpErrors.InternalServerError("Couldn't parse line: " + str), response);
                        }
                        eventEmitter.emit('row', row);
                    }
                }
            });
        });
    }

    return eventEmitter;
};

BeanBag.httpErrors = Teepee.httpErrors;

module.exports = BeanBag;
