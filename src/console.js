/*
 * Panflux Node Platform SDK
 * (c) Omines Internetbureau B.V. - https://omines.nl/
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

const Conf = require('conf');
const Panflux = require('@panflux/platform');

const _ = require('lodash');
const chalk = require('chalk');
const fork = require('child_process').fork;
const inquirer = require('inquirer');
const path = require('path');
const vorpal = require('vorpal')();
const watch = require('watch');

const config = new Conf({
    started: false,
    entities: [],
    logLevel: 'debug',
    count: 0,
});
const home = process.cwd();

const RESTART_DELAY = 250;
const LOG_COLORS = {
    error: chalk.bold.red,
    warn: chalk.bold.yellow,
    info: chalk.green,
    verbose: chalk.magenta,
    debug: chalk.blue,
    silly: chalk.gray,
};
const LOG_LEVELS = Object.keys(LOG_COLORS);

let timeout;
let proc;

/** @var {panflux.Platform} */
let platform;

const entities = config.get('entities') || [];

/**
 * Restart the platform code after a short delay.
 */
function delayedRestart() {
    clearTimeout(timeout);
    timeout = setTimeout(restart, RESTART_DELAY);
}

/**
 * Restart the platform.
 */
function restart() {
    if (proc) {
        try {
            proc.send({name: 'stop'});
        } catch (err) {
            // Ignore - Node doesn't clean its plumbing all that well
        }
        setTimeout(() => {
            if (proc) proc.kill('SIGHUP');
        }, RESTART_DELAY / 2);
        delayedRestart();
        return;
    }

    try {
        platform = Panflux.Platform.load(home);
    } catch (err) {
        vorpal.log(chalk.red('Failed to load platform'));
        vorpal.log(err);
        return;
    }
    vorpal.log(`Starting platform '${platform.config.name}' (${platform.config.friendly_name})...`);

    proc = fork(path.join(__dirname, 'fork.js'));
    proc.on('exit', (code, signal) => {
        vorpal.log('Platform exited with ' + (null === code ? `signal ${signal}` : `exit code ${code}`));
        proc = null;
    });
    proc.on('message', (msg) => {
        const args = msg.args;
        switch (msg.name) {
        case 'start':
            vorpal.log('Started');
            break;
        case 'log':
            vorpal.log((LOG_COLORS[args.level] || chalk.default)(`[${args.level}] ${args.message}`));
            break;
        case 'data':
            vorpal.log(chalk.bold('Receiving data: ' + JSON.stringify(args)));
            break;
        case 'discovery':
            // Kick discoveries back into the platform as new devices to process
            proc.send({name: 'adopt', args});
            break;
        case 'pendingChanges':
            proc.send({name: 'processChangeQueue'});
            break;
        default:
            vorpal.log('Unknown message', msg);
            break;
        }
    });

    proc.send({name: 'start'});
    proc.send({name: 'setLogLevel', args: config.get('logLevel', 'debug')});
    entities.forEach((entity) => proc.send({name: 'adopt', args: entity}));

    config.set('started', true);
}

watch.createMonitor(home, {interval: 1}, (monitor) => {
    ['created', 'changed', 'removed'].forEach((e) => monitor.on(e, (f) => {
        const local = path.relative(home, f);
        if (local.indexOf('.git') !== -1) return;
        vorpal.log(`./${local} was ${e}...`);
        delayedRestart();
    }));
});

vorpal
    .command('restart', 'Restarts the platform.')
    .alias('r')
    .action((args, callback) => {
        restart();
        callback();
    });

vorpal
    .command('pause', 'Pauses the platform')
    .action((args, callback) => {
        proc.send({name: 'stop'});
        vorpal.log('Sent stop request');
        config.set('started', false);
        callback();
    });

vorpal
    .command('start', 'Starts the platform if paused')
    .action((args, callback) => {
        restart();
        vorpal.log('Sent start request');
        callback();
    });

vorpal
    .command('add', 'Manually add a new entity.')
    .alias('a')
    .action((args, callback) => {
        const types = platform.config.types;
        switch (platform.types.size) {
        case 0:
            vorpal.log(chalk.red('Define some entity types first in your platform definition'));
            callback();
            break;
        case 1:
            vorpal.log('Only one entity type defined, skipping selection');
            addEntity(Object.keys(types)[0], Object.values(types)[0])
                .then(callback);
            break;
        default:
            inquirer.prompt([{
                message: 'Select the type of entity you wish to add',
                type: 'list',
                name: 'type',
                choices: Array.from(platform.types.keys()),
            }])
                .then((answers) => addEntity(answers.type, types[answers.type]))
                .then(callback);
            break;
        }
    });

vorpal
    .command('list', 'Lists known entities')
    .alias('l')
    .action((args, callback) => {
        vorpal.log(chalk.yellow('Known entities:'), '');
        entities.forEach((entity) => {
            vorpal.log(chalk` ID: {bold ${entity.id}}`);
            vorpal.log(chalk` Type: {bold ${entity.type}}`);
            vorpal.log(chalk` Config: {bold ${JSON.stringify(entity.config)}}`);
            vorpal.log('');
        });
        callback();
    });

vorpal
    .command('discover', 'Requests the platform to start a discovery run.')
    .alias('d')
    .action((args, callback) => {
        if (proc) {
            proc.send({name: 'discover'});
        } else {
            vorpal.log(chalk.red('Discovery requires a running platform'));
        }

        callback();
    });

vorpal
    .command('loglevel <level>', 'Changes the log level dumped to your console.')
    .alias('log')
    .action((args, callback) => {
        if (LOG_LEVELS.indexOf(args.level) === -1) {
            vorpal.log(chalk.red(`Invalid log level, valid levels are: ${LOG_LEVELS.join(', ')}`));
        } else {
            config.set('logLevel', args.level);
            proc.send({name: 'setLogLevel', args: args.level});
            vorpal.log('Log level changed');
        }
        callback();
    });

vorpal.log('', 'Panflux Platform SDK');
vorpal.execSync('help');

vorpal
    .delimiter(path.basename(home) + '$')
    .show();

// Autostart the platform if it was active last time
if (config.get('started')) {
    restart();
}

/**
 * @param {string} name
 * @param {object} definition
 * @return {Promise}
 */
function addEntity(name, definition) {
    return new Promise((resolve) => {
        vorpal.log(`Creating new entity of type '${name}'...`);

        const questions = [];
        _.forOwn(definition.config, (entry, name) => {
            // No need to check for errors as we have already validated the platform definition as a whole, but
            // we double validate for the normalization
            const schema = Panflux.Schema.createValueSchema(Panflux.Schema.types.typeSchema.validate(entry).value);
            const meta = schema.describe();
            let message = name;
            if (meta.flags && meta.flags.description) {
                message += `: ${meta.flags.description}`;
            }
            if (meta.flags && meta.flags.default !== undefined) {
                message += ` (default=${meta.flags.default})`;
            } else if (!meta.flags || meta.flags.presence !== 'required') {
                message += ` (optional)`;
            }
            message += ':';
            questions.push({
                type: 'input',
                name,
                message,
                filter: (val) => {
                    return val !== '' ? val : undefined;
                },
                validate: (val) => {
                    const {error} = schema.validate(val !== '' ? val : undefined);
                    return error ? error : true;
                },
            });
        });
        inquirer.prompt(questions)
            .then((answers) => {
                config.set('count', (config.get('count') || 0) + 1);

                const entity = {
                    id: `${config.get('count')}`,
                    type: name,
                    // Remove undefined values (optional/default)
                    config: _.pickBy(answers, (val) => val !== undefined),
                };
                entities.push(entity);
                config.set('entities', entities);

                proc.send({name: 'adopt', args: entity});
            })
            .then(resolve);
    });
}
