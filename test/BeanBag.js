/*global describe, it, emit, __dirname, JSON*/
var BeanBag = require('../lib/BeanBag'),
    httpErrors = require('httperrors'),
    socketErrors = require('socketerrors'),
    unexpected = require('unexpected'),
    fs = require('fs'),
    stream = require('stream'),
    pathModule = require('path');

describe('BeanBag', function () {
    var expect = unexpected.clone()
        .installPlugin(require('unexpected-mitm'))
        .addAssertion('to call the callback with no error', function (expect, subject, assertFn) {
            this.errorMode = 'nested';
            return expect.promise(function (run) {
                subject(run(function (err, response, body) {
                    if (err) {
                        throw err;
                    }

                    if (assertFn) {
                        assertFn(response, body);
                    }
                }));
            });
        })
        .addAssertion('to call the callback with error', function (expect, subject, expectedError) {
            this.errorMode = 'nested';
            return expect.promise(function (run) {
                subject(run(function (err) {
                    expect(err, 'to equal', expectedError);
                }));
            });
        });

    it('should not overwrite a built-in method with a config object property', function () {
        expect(new BeanBag({
            url: 'http://localhost',
            request: 1
        }).request, 'to be a function');
    });

    it('should perform a simple request', function () {
        return expect(function (cb) {
            new BeanBag({ url: 'http://localhost:5984' }).request({ path: 'bar/quux' }, cb);
        }, 'with http mocked out', {
            request: 'GET http://localhost:5984/bar/quux',
            response: 200
        }, 'to call the callback with no error');
    });

    it('should allow specifying custom headers', function () {
        return expect(function (cb) {
            new BeanBag({ url: 'http://localhost:5984' }).request({ path: 'bar/quux', headers: { Foo: 'bar' } }, cb);
        }, 'with http mocked out', {
            request: {
                url: 'GET http://localhost:5984/bar/quux',
                headers: { Foo: 'bar' }
            },
            response: 200
        }, 'to call the callback with no error');
    });

    it('should resolve the path from the base url', function () {
        return expect(function (cb) {
            new BeanBag({ url: 'http://localhost:5984/hey/there' }).request({ path: '../quux' }, cb);
        }, 'with http mocked out', {
            request: {
                url: 'GET http://localhost:5984/hey/quux'
            },
            response: 200
        }, 'to call the callback with no error');
    });

    it('should allow specifying the request body as a Buffer', function () {
        return expect(function (cb) {
            new BeanBag({ url: 'http://localhost:5984/' }).request({ method: 'POST', path: 'foo', body: new Buffer([1, 2, 3]) }, cb);
        }, 'with http mocked out', {
            request: {
                url: 'POST http://localhost:5984/foo',
                headers: {
                    'Content-Type': undefined
                },
                body: new Buffer([1, 2, 3])
            },
            response: 200
        }, 'to call the callback with no error');
    });

    it('should allow specifying the request body as a string', function () {
        return expect(function (cb) {
            new BeanBag({ url: 'http://localhost:5984/' }).request({ method: 'POST', path: 'foo', body: 'foobar' }, cb);
        }, 'with http mocked out', {
            request: {
                url: 'POST http://localhost:5984/foo',
                headers: {
                    'Content-Type': undefined
                },
                body: new Buffer('foobar', 'utf-8')
            },
            response: 200
        }, 'to call the callback with no error');
    });

    it('should allow specifying the request body as an object, implying JSON', function () {
        return expect(function (cb) {
            new BeanBag({ url: 'http://localhost:5984/' }).request({ method: 'POST', path: 'foo', body: { what: 'gives' } }, cb);
        }, 'with http mocked out', {
            request: {
                url: 'POST http://localhost:5984/foo',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: { what: 'gives' }
            },
            response: 200
        }, 'to call the callback with no error');
    });

    it('should return an object with an abort method', function () {
        return expect(function (cb) {
            expect(new BeanBag({ url: 'http://localhost:5984/' }).request({ method: 'POST', path: 'foo' }, cb), 'to satisfy', {
                abort: expect.it('to be a function')
            });
        }, 'with http mocked out', {
            response: 200
        }, 'to call the callback with no error');
    });

    describe('retrying on failure', function () {
        it('should return a successful response when a failed GET is retried `numRetries` times', function () {
            return expect(function (cb) {
                new BeanBag({ url: 'http://localhost:5984/' }).request({ path: 'foo', numRetries: 2 }, cb);
            }, 'with http mocked out', [
                { response: new socketErrors.ETIMEDOUT() },
                { response: new socketErrors.ETIMEDOUT() },
                { response: 200 }
            ], 'to call the callback with no error');
        });

        it('should give up if the request fails 1 + `numRetries` times', function () {
            return expect(function (cb) {
                new BeanBag({ url: 'http://localhost:5984/' }).request({ path: 'foo', numRetries: 2 }, cb);
            }, 'with http mocked out', [
                { response: new socketErrors.ETIMEDOUT() },
                { response: new socketErrors.ETIMEDOUT() },
                { response: new socketErrors.ETIMEDOUT() }
            ], 'to call the callback with error', new socketErrors.ETIMEDOUT());
        });

        it('should not attempt to retry a request with the body given as a stream, despite a `numRetries` setting', function () {
            return expect(function (cb) {
                new BeanBag({ url: 'http://localhost:5984/' })
                    .request({ method: 'POST', body: fs.createReadStream(pathModule.resolve(__dirname, '..', 'testdata', '0byte')), path: 'foo', numRetries: 2 }, cb);
            }, 'with http mocked out', {
                response: new socketErrors.ETIMEDOUT()
            }, 'to call the callback with error', new socketErrors.ETIMEDOUT());
        });
    });

    it('should handle ECONNREFUSED', function () {
        return expect(function (cb) {
            new BeanBag({ url: 'http://localhost:5984/' }).request({ path: 'foo' }, cb);
        }, 'with http mocked out', {
            response: new socketErrors.ECONNREFUSED('connect ECONNREFUSED')
        }, 'to call the callback with error', new socketErrors.ECONNREFUSED('connect ECONNREFUSED'));
    });

    it('should handle unknown errors', function () {
        var error = new Error('something else');

        return expect(function (cb) {
            new BeanBag({ url: 'http://localhost:5984/' }).request({ path: 'foo' }, cb);
        }, 'with http mocked out', {
            response: error
        }, 'to call the callback with error', new httpErrors[500](error.message));
    });

    describe('with a streamed response', function () {
        it('should handle simple response stream', function () {
            var responseStream = new stream.Readable();
            responseStream._read = function () {
                responseStream.push(new Buffer(JSON.stringify({ a: 1, b: 2 })));
                responseStream.push(null);
            };

            return expect(function (cb) {
                new BeanBag({ url: 'http://localhost:5984/' }).request({ method: 'GET', path: 'foo' }, cb);
            }, 'with http mocked out', {
                request: {
                    url: 'GET http://localhost:5984/foo'
                },
                response: {
                    statusCode: 200,
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: responseStream
                }
            }, 'to call the callback with no error');
        });

        it('should allow any valid formulation of application/json', function () {
            var responseObject = {
                foo: 'bar'
            };
            var responseStream = new stream.Readable();
            responseStream._read = function () {
                responseStream.push(new Buffer(JSON.stringify(responseObject)));
                responseStream.push(null);
            };

            return expect(function (cb) {
                new BeanBag({ url: 'http://localhost:5984/' }).request({ method: 'GET', path: 'foo' }, cb);
            }, 'with http mocked out', {
                request: {
                    url: 'GET http://localhost:5984/foo'
                },
                response: {
                    statusCode: 200,
                    headers: {
                        'Content-Type': 'application/json; charset=utf8'
                    },
                    body: responseStream
                }
            }, 'to call the callback with no error', function (response, body) {
                expect(body, 'to equal', responseObject);
            });
        });

        it('should throw an error on invalid JSON', function () {
            var responseStream = new stream.Readable();
            responseStream._read = function () {
                responseStream.push(new Buffer('{]'));
                responseStream.push(null);
            };

            return expect(function (cb) {
                new BeanBag({ url: 'http://localhost:5984/' }).request({ method: 'GET', path: 'foo' }, cb);
            }, 'with http mocked out', {
                request: {
                    url: 'GET http://localhost:5984/foo'
                },
                response: {
                    statusCode: 200,
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: responseStream
                }
            }, 'to call the callback with error', new httpErrors.BadGateway('Error parsing JSON response body'));
        });
    });

    describe('with a query', function () {
        it('should allow specifying the query string as a string', function () {
            return expect(function (cb) {
                new BeanBag({ url: 'http://localhost:5984/' }).request({ path: 'bar/quux', query: 'blabla' }, cb);
            }, 'with http mocked out', {
                request: 'GET http://localhost:5984/bar/quux?blabla',
                response: 200
            }, 'to call the callback with no error');
        });

        it('should allow specifying the query string as an object', function () {
            return expect(function (cb) {
                new BeanBag({ url: 'http://localhost:5984/' }).request({ path: 'bar/quux', query: {
                    ascii: 'blabla',
                    nønascïî: 'nønascïî',
                    multiple: [ 'foo', 'nønascïî' ],
                    iAmUndefined: undefined
                }}, cb);
            }, 'with http mocked out', {
                request: 'GET http://localhost:5984/bar/quux' +
                    '?ascii=%22blabla%22' +
                    '&n%C3%B8nasc%C3%AF%C3%AE=%22n%C3%B8nasc%C3%AF%C3%AE%22' +
                    '&multiple=%22foo%22' +
                    '&multiple=%22n%C3%B8nasc%C3%AF%C3%AE%22',
                response: 200
            }, 'to call the callback with no error');
        });
    });

    describe('with a url containing placeholders', function () {
        it('should substitute a placeholder with a value found in the options object passed to request (and prefer it over an identically named one passed to the constructor)', function () {
            var beanBag = new BeanBag({
                domainName: 'the.wrong.one',
                url: 'http://{domainName}.contacts/foo/'
            });

            return expect(function (cb) {
                beanBag.request({
                    domainName: 'example.com',
                    path: 'hey'
                }, cb);
            }, 'with http mocked out', {
                request: 'http://example.com.contacts/foo/hey'
            }, 'to call the callback with no error');
        });

        it('should substitute a complex expression in a placeholder', function () {
            var beanBag = new BeanBag({
                url: 'http://couchdb{{partitionNumber} === 0 ? 3 : 4}.example.com/contacts{partitionNumber}',
                partitionPoints: ['info']
            });

            beanBag.partitionNumber = function (requestOptions) {
                var key = requestOptions.domainName.split('.').reverse().join('.'),
                    databaseNumber = 0;
                for (var i = 0 ; i < this.partitionPoints.length ; i += 1) {
                    if (key >= this.partitionPoints[i]) {
                        databaseNumber += 1;
                    } else {
                        break;
                    }
                }
                return databaseNumber;
            };

            return expect(function (cb) {
                beanBag.request({
                    domainName: 'example.com',
                    path: 'hey'
                }, function (err) {
                    if (err) {
                        throw err;
                    }
                    beanBag.request({
                        domainName: 'example.info',
                        path: 'there'
                    }, cb);
                });
            }, 'with http mocked out', [
                { request: 'http://couchdb3.example.com/contacts0/hey' },
                { request: 'http://couchdb4.example.com/contacts1/there' }
            ], 'to call the callback with no error');
        });

        it('should support passing a falsy value in request options', function () {
            var beanBag = new BeanBag({
                url: 'http://couchdb{{partitionNumber} === 0 ? 3 : 4}.example.com/contacts{partitionNumber}',
                partitionPoints: ['info']
            });
            return expect(function (cb) {
                beanBag.request({
                    partitionNumber: 0,
                    path: 'hey'
                }, cb);
            }, 'with http mocked out', {
                request: 'http://couchdb3.example.com/contacts0/hey'
            }, 'to call the callback with no error');
        });

        it('should substitute a placeholder with a value found in the options object passed to the constructor', function () {
            var beanBag = new BeanBag({
                domainName: 'example.com',
                url: 'http://{domainName}.contacts/foo/'
            });

            return expect(function (cb) {
                beanBag.request({path: 'hey'}, cb);
            }, 'with http mocked out', {
                request: 'http://example.com.contacts/foo/hey'
            }, 'to call the callback with no error');
        });

        it('should substitute a placeholder with the result of calling a function of that name passed to the request method', function () {
            var beanBag = new BeanBag({
                domainName: function (requestOptions, placeholderName) {
                    return requestOptions.owner.replace(/^.*@/, '');
                },
                url: 'http://{domainName}.contacts/foo/'
            });

            return expect(function (cb) {
                beanBag.request({path: 'hey', owner: 'andreas@example.com'}, cb);
            }, 'with http mocked out', {
                request: 'http://example.com.contacts/foo/hey'
            }, 'to call the callback with no error');
        });

        describe('with a design document', function () {
            var beanBag = new BeanBag({
                designDocument: {
                    views: {
                        foo: {
                            map: function () {
                                emit('foo');
                            }
                        }
                    }
                },
                url: 'http://{domainName}.contacts/foo/'
            });

            it('should substitute a placeholder with a value found in the options object passed to queryDesignDocument', function () {
                return expect(function (cb) {
                    beanBag.queryDesignDocument({
                        viewName: 'foo',
                        domainName: 'example.com',
                        path: 'hey'
                    }, cb);
                }, 'with http mocked out', {
                    request: 'http://example.com.contacts/foo/_design/c5f85a319e5af7e66e88b89782890461/_view/foo'
                }, 'to call the callback with no error');
            });

            it('should substitute a placeholder with a value found in the options object passed to queryDesignDocument when the design document does not exist yet', function () {
                return expect(function (cb) {
                    beanBag.queryDesignDocument({
                        viewName: 'foo',
                        domainName: 'example.com',
                        path: 'hey'
                    }, cb);
                }, 'with http mocked out', [
                    {
                        request: 'http://example.com.contacts/foo/_design/c5f85a319e5af7e66e88b89782890461/_view/foo',
                        response: 404
                    },
                    {
                        request: {
                            url: 'PUT http://example.com.contacts/foo/_design/c5f85a319e5af7e66e88b89782890461',
                            body: {
                                views: {
                                    foo: {
                                        map: 'function () {\n                                emit(\'foo\');\n                            }'
                                    }
                                }
                            }
                        },
                        response: 201
                    },
                    {
                        request: 'http://example.com.contacts/foo/_design/c5f85a319e5af7e66e88b89782890461/_view/foo'
                    }
                ], 'to call the callback with no error');
            });
        });
    });

    describe('with a client certificate and related properties', function () {
        var zero = new Buffer([0]),
            one = new Buffer([1]),
            two = new Buffer([2]),
            three = new Buffer([3]);

        describe('specified as Buffer instances', function () {
            var beanBag = new BeanBag({cert: zero, key: one, ca: two, url: 'https://example.com:5984/'});
            it('should expose the cert, key, and ca options on the instance', function () {
                expect(beanBag, 'to satisfy', {
                    cert: zero,
                    key: one,
                    ca: two
                });
            });

            it('should make connections using the client certificate', function () {
                return expect(function (cb) {
                    beanBag.request({path: 'foo'}, cb);
                }, 'with http mocked out', {
                    request: {
                        encrypted: true,
                        url: 'GET /foo',
                        cert: zero,
                        key: one,
                        ca: two
                    }
                }, 'to call the callback with no error');
            });
        });

        describe('specified as strings and arrays', function () {
            var beanBag = new BeanBag({
                cert: pathModule.resolve(__dirname, '..', 'testdata', '0byte'),
                key: pathModule.resolve(__dirname, '..', 'testdata', '1byte'),
                ca: [
                    pathModule.resolve(__dirname, '..', 'testdata', '2byte'),
                    pathModule.resolve(__dirname, '..', 'testdata', '3byte')
                ],
                url: 'https://example.com:5984/'
            });

            it('should interpret the options as file names and expose the loaded cert, key, and ca options on the instance', function () {
                expect(beanBag, 'to satisfy', {
                    cert: zero,
                    key: one,
                    ca: [two, three]
                });
            });

            it('should make connections using the client certificate', function () {
                return expect(function (cb) {
                    beanBag.request({path: 'foo'}, cb);
                }, 'with http mocked out', {
                    request: {
                        encrypted: true,
                        url: 'GET /foo',
                        cert: zero,
                        key: one,
                        ca: [two, three]
                    }
                }, 'to call the callback with no error');
            });
        });
    });
});
