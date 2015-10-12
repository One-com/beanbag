/*global describe, it, emit, setImmediate*/
var BeanBag = require('../lib/BeanBag'),
    unexpected = require('unexpected'),
    stream = require('stream'),
    sinon = require('sinon');

describe('BeanBag', function () {
    var expect = unexpected.clone()
        .installPlugin(require('unexpected-mitm'))
        .installPlugin(require('unexpected-sinon'));

    it('should specify an Accept header with a value of application/json when making a request', function () {
        return expect(function (await) {
            new BeanBag({ url: 'http://localhost:5984/' }).request(await());
        }, 'with http mocked out', {
            request: { headers: { Accept: 'application/json' } },
            response: 200
        }, 'not to error');
    });

    it('should allow specifying the request body as an object, implying JSON with functions stringified', function () {
        return expect(function (await) {
            new BeanBag({ url: 'http://localhost:5984/' }).request({ method: 'POST', path: 'foo', body: { what: 'gives', foo: function () { return 123; } } }, await());
        }, 'with http mocked out', {
            request: {
                url: 'POST http://localhost:5984/foo',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: { what: 'gives', foo: 'function () { return 123; }' }
            },
            response: 200
        }, 'not to error');
    });

    describe('with a query', function () {
        it('should allow specifying the query string as a string', function () {
            return expect(function (await) {
                new BeanBag({ url: 'http://localhost:5984/' }).request({ path: 'bar/quux', query: 'blabla' }, await());
            }, 'with http mocked out', {
                request: 'GET http://localhost:5984/bar/quux?blabla',
                response: 200
            }, 'not to error');
        });

        it('should allow specifying the query string as an object, where the values will be JSON.stringified', function () {
            return expect(function (await) {
                new BeanBag({ url: 'http://localhost:5984/' }).request({ path: 'bar/quux', query: {
                    ascii: 'blabla',
                    nønascïî: 'nønascïî',
                    multiple: [ 'foo', 'nønascïî' ],
                    iAmUndefined: undefined
                }}, await());
            }, 'with http mocked out', {
                request: 'GET http://localhost:5984/bar/quux' +
                    '?ascii=%22blabla%22' +
                    '&n%C3%B8nasc%C3%AF%C3%AE=%22n%C3%B8nasc%C3%AF%C3%AE%22' +
                    '&multiple=%22foo%22' +
                    '&multiple=%22n%C3%B8nasc%C3%AF%C3%AE%22',
                response: 200
            }, 'not to error');
        });
    });

    describe('with a url containing placeholders', function () {
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
                return expect(function (await) {
                    beanBag.queryDesignDocument({
                        viewName: 'foo',
                        domainName: 'example.com',
                        path: 'hey'
                    }, await());
                }, 'with http mocked out', {
                    request: 'http://example.com.contacts/foo/_design/c5f85a319e5af7e66e88b89782890461/_view/foo'
                }, 'not to error');
            });

            it('should substitute a placeholder with a value found in the options object passed to queryDesignDocument when the design document does not exist yet', function () {
                return expect(function (await) {
                    beanBag.queryDesignDocument({
                        viewName: 'foo',
                        domainName: 'example.com',
                        path: 'hey'
                    }, await());
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
                        request: '/foo/_all_docs?startkey=%22_design%2F%22&endkey=%22_design%2F~%22',
                        response: {
                            body: {
                                total_rows: 22341,
                                offset: 0,
                                rows: [
                                    {"id":"_design/0cf4ca6277701a6f42a21491c76f3a71","key":"_design/0cf4ca6277701a6f42a21491c76f3a71","value":{"rev":"2-aaac14323f34540b8084899b55be9b8a"}},
                                    {"id":"_design/c5f85a319e5af7e66e88b89782890461","key":"_design/c5f85a319e5af7e66e88b89782890461","value":{"rev":"1-c3ac14323f34540b8084899b55be9b8a"}}
                                ]
                            }
                        }
                    },
                    {
                        request: 'DELETE /foo/_design/0cf4ca6277701a6f42a21491c76f3a71?rev=2-aaac14323f34540b8084899b55be9b8a'
                    },
                    {
                        request: 'http://example.com.contacts/foo/_design/c5f85a319e5af7e66e88b89782890461/_view/foo'
                    }
                ], 'not to error');
            });
        });
    });

    describe('with the streamRows option', function () {
        it('should fire a "metadata" event and a "row" event for each row', function () {
            var rows = [];
            var metadataSpy = sinon.spy();
            return expect(function (await) {
                new BeanBag({ url: 'http://localhost:5984/hey/there' })
                    .request({ path: 'quux', streamRows: true })
                    .on('row', function (row) {
                        rows.push(row);
                    })
                    .on('metadata', metadataSpy)
                    .on('error', await.reject)
                    .on('end', await());
            }, 'with http mocked out', {
                response: {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: '{"total_rows":2,"offset":0,"rows":[\r\n{"id":"uk.co.domain.odd.an@a.weird.email:existingContactId1","key":"uk.co.domain.odd.an@a.weird.email:existingContactId1","value":{"rev":"1-ceb8e8aa27abe5170c3ff1c54491927c"}},\r\n{"id":"uk.co.domain.odd.an@a.weird.email:existingContactId2","key":"uk.co.domain.odd.an@a.weird.email:existingContactId2","value":{"rev":"1-0cf4ca6277701a6f42a21491c76f3a71"}}\r\n]}\n'
                }
            }, 'not to error').then(function () {
                expect(rows, 'to equal', [
                    {
                        id: 'uk.co.domain.odd.an@a.weird.email:existingContactId1',
                        key: 'uk.co.domain.odd.an@a.weird.email:existingContactId1',
                        value: {
                            rev: '1-ceb8e8aa27abe5170c3ff1c54491927c'
                        }
                    },
                    {
                        id: 'uk.co.domain.odd.an@a.weird.email:existingContactId2',
                        key: 'uk.co.domain.odd.an@a.weird.email:existingContactId2',
                        value: {
                            rev: '1-0cf4ca6277701a6f42a21491c76f3a71'
                        }
                    }
                ]);
                expect(metadataSpy, 'was called once');
                expect(metadataSpy, 'was always called with exactly', { total_rows: 2, offset: 0 });
            });
        });

        it('should fire an error event once if the upstream request results in an error', function () {
            var erroringStream = new stream.Readable();
            var rows = [];
            erroringStream._read = function () {
                setImmediate(function () {
                    erroringStream.emit('error', new Error('Fake error'));
                });
            };

            return expect(function (await) {
                new BeanBag({ url: 'http://localhost:5984/hey/there' })
                    .request({ path: '../quux', streamRows: true })
                    .on('row', function (row) {
                        rows.push(row);
                    })
                    .on('error', await.reject)
                    .on('end', await());
            }, 'with http mocked out', {
                response: {
                    statusCode: 200,
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: erroringStream
                }
            }, 'to error with', new BeanBag.httpErrors.InternalServerError('Fake error')).then(function () {
                expect(rows, 'to equal', []);
            });
        });

        it('should fire an error event once if the JSON cannot be parsed', function () {
            var rows = [];
            return expect(function (await) {
                new BeanBag({ url: 'http://localhost:5984/hey/there' })
                    .request({ path: '../quux', streamRows: true })
                    .on('row', function (row) {
                        rows.push(row);
                    })
                    .on('error', await.reject)
                    .on('end', await());
            }, 'with http mocked out', {
                response: {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: 'CQEWCQWEC\r\n'
                }
            }, 'to error with', new BeanBag.httpErrors.InternalServerError('Could not parse line: CQEWCQWEC')).then(function () {
                expect(rows, 'to equal', []);
            });
        });
    });
});
