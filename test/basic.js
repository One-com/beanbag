/*globals before, describe, it*/
var BB = require('../lib/BeanBag'),
    expect = require('expect.js');

describe('BeanBag({url: ..., illegalProperty: 1})', function () {
    var bag;
    before(function () {
        bag = new BB({
            url: 'http://localhost',
            illegalProperty: 1
        });
    });

    it('Shold be a BeanBag instance', function () {
        expect(bag).to.be.an(BB);
    });

    it('Should not have illegalProperty set', function () {
        expect(bag).not.to.have.property('illegalProperty');
    });
});



