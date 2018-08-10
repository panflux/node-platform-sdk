/*
 * Panflux Node Platform SDK
 * (c) Omines Internetbureau B.V. - https://omines.nl/
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

const chalk = require('chalk');
const fork = require('child_process').fork;
const path = require('path');
const vorpal = require('vorpal')();
const watch = require('watch');

const home = process.cwd();

const LOG_COLORS = {
    error: chalk.bold.red,
    warn: chalk.bold.yellow,
    info: chalk.green,
};

let timeout;
let proc;

/**
 * Restart the platform code after a short delay.
 */
function delayedRestart() {
    clearTimeout(timeout);
    timeout = setTimeout(restart, 250);
}

/**
 * Restart the platform.
 */
function restart() {
    if (proc) {
        proc.kill('SIGHUP');
        delayedRestart();
        return;
    }
    vorpal.log('Starting platform...');

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
        case 'discovery':
            vorpal.log(chalk.magenta(args));
            break;
        default:
            vorpal.log('Unknown message', msg);
            break;
        }
    });
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
    .command('discover', 'Requests the platform to start a discovery run.')
    .alias('d')
    .action(function(args, callback) {
        proc.send({name: 'discover'});
        callback();
    });

vorpal.log('', 'Panflux Platform SDK');
vorpal.execSync('help');

vorpal
    .delimiter(path.basename(home) + '$')
    .show();

restart();
