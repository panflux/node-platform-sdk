/*
 * Panflux Node Platform SDK
 * (c) Omines Internetbureau B.V. - https://omines.nl/
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

const Conf = require('conf');
const Panflux = require('@panflux/platform').Platform;

const _ = require('lodash');
const chalk = require('chalk');
const fork = require('child_process').fork;
const inquirer = require('inquirer');
const path = require('path');
const vorpal = require('vorpal')();
const watch = require('watch');

const config = new Conf();
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

let timeout; let proc; let platform;

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
        proc.send({name: 'stop'});
        setTimeout(() => {
            if (proc) proc.kill('SIGHUP');
        }, RESTART_DELAY / 2);
        delayedRestart();
        return;
    }

    platform = Panflux.load(home);
    vorpal.log(`Starting platform '${platform.config.name}' (${platform.config.friendly_name})...`);

    proc = fork(path.join(__dirname, 'fork.js'));
    proc.on('exit', (code, signal) => {
        vorpal.log('Platform exited with ' + (null === code ? `signal ${signal}` : `exit code ${code}`));
        proc = null;
    });
    proc.on('message', (msg) => {
        const args = msg.args;
        switch (msg.name) {
        case 'log':
            vorpal.log((LOG_COLORS[args.level] || chalk.default)(`[${args.level}] ${args.message}`));
            break;
        case 'data':
            // console.log(msg);
            vorpal.log('Receiving data');
            break;
        case 'discovery':
            // Kick discoveries back into the platform as new devices to process
            proc.send({name: 'adopt', args});
            break;
        default:
            vorpal.log('Unknown message', msg);
            break;
        }
    });

    proc.send({name: 'start'});
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
    .action(function(args, callback) {
        restart();
        callback();
    });

vorpal
    .command('pause', 'Pauses the platform')
    .action((args, callback) => {
        proc.send({name: 'stop'});
        vorpal.log('Sent stop request');
        config.set('platform.start', false);
        callback();
    });

vorpal
    .command('start', 'Starts the platform if paused')
    .action((args, callback) => {
        restart();
        vorpal.log('Sent start request');
        config.set('platform.start', true);
        callback();
    });

vorpal
    .command('add', 'Manually add a new entity.')
    .action((args, callback) => {
        const types = platform.config.types;
        switch (_.size(types)) {
        case 0:
            vorpal.log(chalk.red('Define some entity types first in your platform definition'));
            callback();
            break;
        case 1:
            addEntity(Object.keys(types)[0], Object.values(types)[0])
                .then(callback);
            break;
        default:
            inquirer.prompt([{
                message: 'Select the type of entity you wish to add',
                type: 'list',
                name: 'type',
                choices: Object.keys(platform.config.types),
            }])
                .then((answers) => addEntity(answers.type, types[answers.type]))
                .then(callback);
            break;
        }
    });

vorpal
    .command('discover', 'Requests the platform to start a discovery run.')
    .alias('d')
    .action(function(args, callback) {
        if (proc) {
            proc.send({name: 'discover'});
        } else {
            vorpal.log(chalk.red('Discovery requires a running platform'));
        }

        callback();
    });

vorpal.log('', 'Panflux Platform SDK');
vorpal.execSync('help');

vorpal
    .delimiter(path.basename(home) + '$')
    .show();

if (config.get('platform.start')) {
    restart();
}

// Helper functions

/**
 * @param {string} name
 * @param {object} definition
 * @return {Promise}
 */
function addEntity(name, definition) {
    return new Promise((resolve) => {
        vorpal.log(`Creating new entity of type '${name}'...`);
        console.log(definition);
        resolve();
    });
}
