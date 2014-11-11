/*globals before, describe, it*/
var BeanBag = require('../lib/BeanBag'),
    expect = require('unexpected'),
    MockRequest = require('mockrequest');

describe('BeanBag', function () {
    describe('with an unsupported property passed to the constructor', function () {
        var beanBag;
        before(function () {
            beanBag = new BeanBag({
                url: 'http://localhost',
                illegalProperty: 1
            });
        });

        it('Should be a BeanBag instance', function () {
            expect(beanBag, 'to be a', BeanBag);
        });

        it('Should not have illegalProperty set', function () {
            expect(beanBag, 'not to have property', 'illegalProperty');
        });
    });

    describe('with a url containing placeholders', function () {
        it('should substitute a placeholder with a value found in the options object passed to request', function (done) {
            var beanBag = new BeanBag({url: 'http://{domainName}.contacts/foo/'});
            beanBag.requestLibrary = new MockRequest({
                request: {
                    url: 'http://centersurf.net.contacts/foo/hey'
                }
            });
            beanBag.request({
                domainName: 'centersurf.net',
                path: 'hey'
            }, done);
        });
    });
});
