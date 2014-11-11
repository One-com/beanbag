/*globals before, describe, it*/
var BeanBag = require('../lib/BeanBag'),
    expect = require('unexpected'),
    MockRequest = require('mockrequest');

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
                        url: 'http://centersurf.net.contacts/foo/hey'
                    }
                })
            }).request({
                domainName: 'centersurf.net',
                path: 'hey'
            }, done);
        });

        it('should substitute a placeholder with a value found in the options object passed to the constructor', function (done) {
            new BeanBag({
                domainName: 'centersurf.net',
                url: 'http://{domainName}.contacts/foo/',
                requestLibrary: new MockRequest({
                    request: {
                        url: 'http://centersurf.net.contacts/foo/hey'
                    }
                })
            }).request({path: 'hey'}, done);
        });

        it('should substitute a placeholder with a value found in the options object passed to the constructor', function (done) {
            new BeanBag({
                domainName: 'centersurf.net',
                url: 'http://{domainName}.contacts/foo/',
                requestLibrary: new MockRequest({
                    request: {
                        url: 'http://centersurf.net.contacts/foo/hey'
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
                        url: 'http://centersurf.net.contacts/foo/hey'
                    }
                })
            }).request({path: 'hey', owner: 'andreas@centersurf.net'}, done);
        });
    });
});
