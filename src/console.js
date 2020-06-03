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
const exitHook = require('exit-hook');
const fork = require('child_process').fork;
const humanizeString = require('humanize-string');
const inquirer = require('inquirer');
const path = require('path');
const vorpal = require('vorpal')();
const watch = require('watch');

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

// Load config
const config = new Conf({
    defaults: {
        started: false,
        entities: [],
        logLevel: 'debug',
        count: 0,
    },
    projectName: path.basename(home),
    projectSuffix: 'panflux',
});
process.argv.forEach(function(val, index, array) {
    if (val === '--reset' || val === 'reset') {
        config.clear();
    }
});
let entities = config.get('entities') || [];

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
            if (proc.connected) {
                proc.send({name: 'stop'});
            }
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
            vorpal.log((LOG_COLORS[args.level] || chalk.reset)(`[${args.level}] ${args.message}`));
            break;
        case 'data':
            vorpal.log(chalk.bold(`Data: ${JSON.stringify(args)}`));
            break;
        case 'event':
            vorpal.log(chalk.bold(`Event '${args.name}' on ${args.entityId}: ${JSON.stringify(args.parameters)}`));
            break;
        case 'discovery':
            // Kick discoveries back into the platform as new devices to process
            if (_.findIndex(entities, (val) => args.id === val.id) === -1) {
                registerEntity({
                    id: args.id,
                    name: args.name,
                    type: args.type,
                    config: args.config,
                });
                proc.send({name: 'adopt', args});
            } else {
                vorpal.log(chalk.yellow(`Ignoring known discovery ${args.name} (${args.id}) of type ${args.type}`));
            }
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
    vorpal.show();
}

watch.createMonitor(home, {interval: 1}, (monitor) => {
    ['created', 'changed', 'removed'].forEach((e) => monitor.on(e, (f) => {
        const local = path.relative(home, f);
        if (local.indexOf('.git') !== -1) return;
        vorpal.log(`./${local} was ${e}...`);
        delayedRestart();
    }));
});

exitHook(() => {
    // Node really has terrible plumbing so let's just kill our child process if it exists
    if (proc) {
        proc.kill('SIGKILL');
    }
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
    .command('reset', 'Clears all configuration and restarts the platform')
    .action((args, callback) => {
        config.clear();
        entities = [];
        restart();
        vorpal.log('Restarting with cleared configuration');
        callback();
    });

vorpal
    .command('add', 'Manually add a new entity.')
    .alias('a')
    .action((args, callback) => {
        if (!proc) {
            restart();
        }
        const types = platform.config.types;
        switch (platform.types.size) {
        case 0:
            vorpal.log(chalk.red('Define some entity types first in your platform definition'));
            callback();
            break;
        case 1:
            vorpal.log('Only one entity type defined, skipping selection');
            createEntity(Object.keys(types)[0], Object.values(types)[0])
                .then(callback);
            break;
        default:
            inquirer.prompt([{
                message: 'Select the type of entity you wish to add',
                type: 'list',
                name: 'type',
                choices: Array.from(platform.types.keys()),
            }])
                .then((answers) => createEntity(answers.type, types[answers.type]))
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
            vorpal.log(chalk` Name: {bold ${entity.name}}`);
            vorpal.log(chalk` Type: {bold ${entity.type}}`);
            vorpal.log(chalk` Config: {bold ${JSON.stringify(entity.config)}}`);
            vorpal.log('');
        });
        callback();
    });

vorpal
    .command('call', 'Calls a service on a known entity')
    .alias('c')
    .action((args, callback) => {
        vorpal.hide();
        selectEntity()
            .then((entity) => {
                const services = platform.getEntityType(entity.type).definition.services;
                if (!_.size(services)) {
                    throw new Error('There are no services available on this entity');
                }
                return inquirer.prompt([
                    {
                        type: 'list',
                        name: 'service',
                        message: 'Select service to call:',
                        choices: _.map(services, (parameters, service) => {
                            return {name: service, value: {id: entity.id, service, parameters}};
                        }),
                    },
                ]);
            })
            .then(({service}) => {
                return inquirer.prompt(createSchemaQuestions(service.parameters))
                    .then((answers) => {
                        service.parameters = answers;
                        return service;
                    });
            })
            .then((args) => {
                proc.send({name: 'call', args});
                vorpal.show();
                callback();
            })
            .catch((err) => {
                vorpal.show();
                throw err;
            });
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
 * @param {string} type
 * @param {object} definition
 * @return {Promise}
 */
function createEntity(type, definition) {
    vorpal.log(`Creating new entity of type '${type}'...`);

    return inquirer.prompt(_.concat({
        type: 'input',
        name: '_name',
        message: 'Provide a name for the new entity:',
        default: humanizeString(type),
    }, createSchemaQuestions(definition.config)))
        .then((answers) => registerEntity({
            name: answers._name,
            type,
            config: _.pickBy(answers, (val, key) => (val !== undefined && key[0] !== '_')),
        }))
    ;
}

/**
 * @param {object} entity
 */
function registerEntity(entity) {
    config.set('count', (config.get('count') || 0) + 1);
    if (!entity.id) {
        entity.id = `${config.get('count')}`;
    }
    entities.push(entity);
    config.set('entities', entities);

    proc.send({name: 'adopt', args: entity});
}

/**
 * @return {*|Promise<void>|PromiseLike<any>|Promise<any>}
 */
function selectEntity() {
    return inquirer.prompt([
        {
            type: 'list',
            name: 'entity',
            message: 'Select entity to call service on:',
            choices: entities.map((entity) => {
                return {name: entity.name, value: entity};
            }),
        },
    ]).then((answers) => answers.entity);
}

/**
 * Create an inquirer question array based on a raw definition schema.
 *
 * @param {object} definition
 * @return {Array}
 */
function createSchemaQuestions(definition) {
    return _.map(definition, (entry, name) => {
        // No need to check for errors as we have already validated the platform definition as a whole, but
        // we double validate for the normalization
        const schema = Panflux.Schema.createValueSchema(Panflux.Schema.types.typeSchema.validate(entry).value);
        const meta = schema.describe();
        let message = humanizeString(name);
        if (meta.flags && meta.flags.description) {
            message += `: ${meta.flags.description}`;
        }
        if (meta.flags && meta.flags.default !== undefined) {
            message += ` (default=${meta.flags.default})`;
        } else if (!meta.flags || meta.flags.presence !== 'required') {
            message += ` (optional)`;
        }
        message += ':';
        return {
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
        };
    });
}
