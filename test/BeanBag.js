/*globals describe, it, emit*/
var BeanBag = require('../lib/BeanBag'),
    expect = require('unexpected'),
    MockRequest = require('mockrequest'),
    passError = require('passerror');

describe('BeanBag', function () {
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
            new BeanBag({
                domainName: 'the.wrong.one',
                url: 'http://{domainName}.contacts/foo/',
                requestLibrary: new MockRequest({
                    request: {
                        url: 'http://example.com.contacts/foo/hey'
                    }
                })
            }).request({
                domainName: 'example.com',
                path: 'hey'
            }, done);
        });

        it('should substitute a complex expression in a placeholder', function (done) {
            var beanBag = new BeanBag({
                url: 'http://couchdb{{partitionNumber} === 0 ? 3 : 4}.example.com/contacts{partitionNumber}',
                partitionPoints: ['info'],
                requestLibrary: new MockRequest([
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
                ])
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

            beanBag.request({
                domainName: 'example.com',
                path: 'hey'
            }, passError(done, function () {
                beanBag.request({
                    domainName: 'example.info',
                    path: 'there'
                }, done);
            }));
        });

        it('should support passing a falsy value in request options', function (done) {
            var beanBag = new BeanBag({
                url: 'http://couchdb{{partitionNumber} === 0 ? 3 : 4}.example.com/contacts{partitionNumber}',
                partitionPoints: ['info'],
                requestLibrary: new MockRequest([
                    {
                        request: {
                            url: 'http://couchdb3.example.com/contacts0/hey'
                        }
                    }
                ])
            });

            beanBag.request({
                partitionNumber: 0,
                path: 'hey'
            }, done);
        });

        it('should substitute a placeholder with a value found in the options object passed to the constructor', function (done) {
            new BeanBag({
                domainName: 'example.com',
                url: 'http://{domainName}.contacts/foo/',
                requestLibrary: new MockRequest({
                    request: {
                        url: 'http://example.com.contacts/foo/hey'
                    }
                })
            }).request({path: 'hey'}, done);
        });

        it('should substitute a placeholder with the result of calling a function of that name passed to the request method', function (done) {
            new BeanBag({
                domainName: function (requestOptions, placeholderName) {
                    return requestOptions.owner.replace(/^.*@/, '');
                },
                url: 'http://{domainName}.contacts/foo/',
                requestLibrary: new MockRequest({
                    request: {
                        url: 'http://example.com.contacts/foo/hey'
                    }
                })
            }).request({path: 'hey', owner: 'andreas@example.com'}, done);
        });

        it('should substitute a placeholder with a value found in the options object passed to queryDesignDocument', function (done) {
            new BeanBag({
                designDocument: {
                    views: {
                        foo: {
                            map: function () {
                                emit('foo');
                            }
                        }
                    }
                },
                url: 'http://{domainName}.contacts/foo/',
                requestLibrary: new MockRequest({
                    request: {
                        url: 'http://example.com.contacts/foo/_design/c5f85a319e5af7e66e88b89782890461/_view/foo'
                    }
                })
            }).queryDesignDocument({
                viewName: 'foo',
                domainName: 'example.com',
                path: 'hey'
            }, done);
        });

        it('should substitute a placeholder with a value found in the options object passed to queryDesignDocument when the design document does not exist yet', function (done) {
            new BeanBag({
                designDocument: {
                    views: {
                        foo: {
                            map: function () {
                                emit('foo');
                            }
                        }
                    }
                },
                url: 'http://{domainName}.contacts/foo/',
                requestLibrary: new MockRequest([
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
                ])
            }).queryDesignDocument({
                viewName: 'foo',
                domainName: 'example.com',
                path: 'hey'
            }, done);
        });
    });
});
