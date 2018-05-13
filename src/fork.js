/*
 * Panflux Node Platform SDK
 * (c) Omines Internetbureau B.V. - https://omines.nl/
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

const {Platform, ProcessTransport} = require('@panflux/platform');

Platform.load(process.cwd()).run(new ProcessTransport);
