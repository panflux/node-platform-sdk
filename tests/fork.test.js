/*
 * Panflux Node Platform SDK
 * (c) Omines Internetbureau B.V. - https://omines.nl/
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

const path = require('path');

const rootdir = path.resolve(__dirname, '..');

test.skip('Fork runs platform', () => {
    let message = {};

    process.send = (msg) => {
        message = msg;
    };

    process.chdir(path.join(__dirname, 'fixtures/platform'));
    require(path.join(rootdir, 'src', 'fork'));

    expect(message.name).toEqual('log');
    expect(message.args.message).toEqual('Foo');
});
