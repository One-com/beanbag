/*globals before, describe, it*/
var BeanBag = require('../lib/BeanBag'),
    expect = require('unexpected');

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
});
