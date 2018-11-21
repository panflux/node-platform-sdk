/*
 * Panflux Node Platform SDK
 * (c) Omines Internetbureau B.V. - https://omines.nl/
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

const {platform, logger} = require('@panflux/platform');

logger.info('Foo');
platform.on('load', () => {
    logger.warn('Loaded');
});
