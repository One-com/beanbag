/*globals describe, it, emit*/
var BeanBag = require('../lib/BeanBag'),
    unexpected = require('unexpected'),
    passError = require('passerror');

describe('BeanBag', function () {
    var expect = unexpected.clone()
        .installPlugin(require('unexpected-messy'))
        .installPlugin(require('unexpected-mitm'))
        .addAssertion('to call the callback with no error', function (expect, subject, done) {
            subject(function (err) {
                try {
                    expect(err, 'to be falsy');
                } catch (e) {
                    return done(e);
                }
                done();
            });
        });

    it('should throw if a property passed to the constructor would conflict with something built-in', function () {
        expect(function () {
            new BeanBag({
                url: 'http://localhost',
                request: 1
            });
        }, 'to throw', 'Unsupported config option: request (would conflict with built-in property)');
    });

    describe('with a url containing placeholders', function () {
        it('should substitute a placeholder with a value found in the options object passed to request (and prefer it over an identically named one passed to the constructor)', function (done) {
            var beanBag = new BeanBag({
                domainName: 'the.wrong.one',
                url: 'http://{domainName}.contacts/foo/'
            });

            expect(function (cb) {
                beanBag.request({
                    domainName: 'example.com',
                    path: 'hey'
                }, cb);
            }, 'with http mocked out', {
                request: {
                    url: 'http://example.com.contacts/foo/hey'
                }
            }, 'to call the callback with no error', done);
        });

        it('should substitute a complex expression in a placeholder', function (done) {
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

            expect(function (cb) {
                beanBag.request({
                    domainName: 'example.com',
                    path: 'hey'
                }, passError(done, function () {
                    beanBag.request({
                        domainName: 'example.info',
                        path: 'there'
                    }, cb);
                }));
            }, 'with http mocked out', [
                {
                    request: {
                        url: 'http://couchdb3.example.com/contacts0/hey'
                    }
                },
                {
                    request: {
                        url: 'http://couchdb4.example.com/contacts1/there'
                    }
                }
            ], 'to call the callback with no error', done);
        });

        it('should support passing a falsy value in request options', function (done) {
            var beanBag = new BeanBag({
                url: 'http://couchdb{{partitionNumber} === 0 ? 3 : 4}.example.com/contacts{partitionNumber}',
                partitionPoints: ['info']
            });
            expect(function (cb) {
                beanBag.request({
                    partitionNumber: 0,
                    path: 'hey'
                }, cb);
            }, 'with http mocked out', [
                {
                    request: {
                        url: 'http://couchdb3.example.com/contacts0/hey'
                    }
                }
            ], 'to call the callback with no error', done);
        });

        it('should substitute a placeholder with a value found in the options object passed to the constructor', function (done) {
            var beanBag = new BeanBag({
                domainName: 'example.com',
                url: 'http://{domainName}.contacts/foo/'
            });
            expect(function (cb) {
                beanBag.request({path: 'hey'}, cb);
            }, 'with http mocked out', {
                request: {
                    url: 'http://example.com.contacts/foo/hey'
                }
            }, 'to call the callback with no error', done);

        });

        it('should substitute a placeholder with the result of calling a function of that name passed to the request method', function (done) {
            var beanBag = new BeanBag({
                domainName: function (requestOptions, placeholderName) {
                    return requestOptions.owner.replace(/^.*@/, '');
                },
                url: 'http://{domainName}.contacts/foo/'
            });
            expect(function (cb) {
                beanBag.request({path: 'hey', owner: 'andreas@example.com'}, cb);
            }, 'with http mocked out', {
                request: {
                    url: 'http://example.com.contacts/foo/hey'
                }
            }, 'to call the callback with no error', done);
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

            it('should substitute a placeholder with a value found in the options object passed to queryDesignDocument', function (done) {
                expect(function (cb) {
                    beanBag.queryDesignDocument({
                        viewName: 'foo',
                        domainName: 'example.com',
                        path: 'hey'
                    }, cb);
                }, 'with http mocked out', {
                    request: {
                        url: 'http://example.com.contacts/foo/_design/c5f85a319e5af7e66e88b89782890461/_view/foo'
                    }
                }, 'to call the callback with no error', done);
            });

            it('should substitute a placeholder with a value found in the options object passed to queryDesignDocument when the design document does not exist yet', function (done) {
                expect(function (cb) {
                    beanBag.queryDesignDocument({
                        viewName: 'foo',
                        domainName: 'example.com',
                        path: 'hey'
                    }, done);
                }, 'with http mocked out', [
                    {
                        request: 'http://example.com.contacts/foo/_design/c5f85a319e5af7e66e88b89782890461/_view/foo',
                        response: 404
                    },
                    {
                        request: 'PUT http://example.com.contacts/foo/_design/c5f85a319e5af7e66e88b89782890461',
                        response: 200
                    },
                    {
                        request: 'http://example.com.contacts/foo/_design/c5f85a319e5af7e66e88b89782890461/_view/foo'
                    },
                    {
                        request: 'http://example.com.contacts/foo/_all_docs?startkey=%22_design%2F%22&endkey=%22_design%2F~%22',
                        response: {
                            body: {
                                rows: []
                            }
                        }
                    }
                ], 'to call the callback with no error', done);
            });
        });
    });
});
