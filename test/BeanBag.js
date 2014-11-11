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
        it('should substitute a placeholder with a value found in the options object passed to request', function (done) {
            new BeanBag({
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
    });
});
