#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Core } from '@synfutures/fx-core';
import { error, info, LogLevel, setLogLevel } from '@synfutures/logger';
import { plugins } from '@synfutures/base-plugins';
import { Server } from './server';
import { Handler } from './handler';
import { Subscriber } from './subscriber';

// eslint-disable-next-line @typescript-eslint/no-floating-promises
yargs(hideBin(process.argv))
    .command(
        'start',
        'Start API server',
        (args) =>
            args
                .option('port', {
                    alias: 'p',
                    demandOption: false,
                    type: 'number',
                    default: 43210,
                    describe: 'Synfutures V3 API port',
                })
                .option('host', {
                    alias: 'h',
                    demandOption: false,
                    type: 'string',
                    default: '0.0.0.0',
                    describe: 'Synfutures V3 API host',
                })
                .option('network', {
                    alias: 'n',
                    demandOption: true,
                    type: 'string',
                    describe: 'Ethereum network',
                })
                .option('log-level', {
                    alias: 'l',
                    default: LogLevel.Info,
                    type: 'number',
                    describe: `Log level, silent: ${LogLevel.Silent}, info: ${LogLevel.Info}, debug: ${LogLevel.Debug}`,
                })
                .option('disable-websocket', {
                    type: 'boolean',
                    describe: 'Disable websocket subscription',
                })
                .option('readonly', {
                    type: 'boolean',
                    describe: 'Enable readonly mode, will not sync new logs',
                })
                .option('confirmation', {
                    alias: 'm',
                    demandOption: false,
                    type: 'number',
                    default: 2,
                    describe: 'Confirmation block number',
                })
                .option('from-block-number', {
                    alias: 'f',
                    type: 'number',
                    describe: 'Explicitly specify the block number to start syncing',
                })
                .option('snapshot-interval', {
                    alias: 'i',
                    type: 'number',
                    default: 1800,
                    describe: 'The block number interval between two snapshots',
                })
                .option('snapshot-outdated', {
                    alias: 'o',
                    type: 'number',
                    default: 43200,
                    describe: 'Snapshot outdated duration, outdated snapshots will be automatically deleted',
                }),
        async (args) => {
            // set log level by config
            setLogLevel(args.logLevel);

            // create core instance
            const core = new Core('oyster-api');

            const databaseUrl = process.env['API_DB_URL'];
            if (!databaseUrl) {
                throw new Error('missing database url');
            }

            const amqpUrl = process.env['AMQP_URL'];
            if (!amqpUrl) {
                throw new Error('missing amqp url');
            }

            // create plugins
            core.createPlugin(plugins.DB, { url: databaseUrl });
            core.createPlugin(plugins.Common, { network: args.network });
            core.createPlugin(plugins.Blocks);
            core.createPlugin(plugins.Snapshots, {
                interval: args.snapshotInterval,
                outdated: args.snapshotOutdated,
            });

            if (!args.readonly) {
                core.createPlugin(plugins.Storage, { explicitlyFromBlockNumber: args.fromBlockNumber });
                core.createPlugin(plugins.Source, {
                    confirmation: args.confirmation,
                    mode: args.disableWebsocket ? 'fetch' : 'subscribe',
                });

                // in order to ensure that the reorg logic will not affect the latest events,
                // double the number of confirmed blocks
                core.createPlugin(plugins.Reorg, {
                    delay: args.confirmation * 2,
                });
            }

            core.createPlugin(Handler);
            core.createPlugin(Subscriber, { url: amqpUrl });
            core.createPlugin(Server, {
                port: args.port,
                host: args.host,
            });

            // handle signal
            let exiting = false;
            // eslint-disable-next-line @typescript-eslint/no-misused-promises
            process.on('SIGINT', async () => {
                if (!exiting) {
                    exiting = true;
                    info('Main', 'exiting...');
                    try {
                        await core.stop();
                        await core.destroy();
                        info('Main', 'exited');
                        process.exit(0);
                    } catch (err) {
                        error('Main', 'error:', err);
                        process.exit(1);
                    }
                }
            });

            // catch errors...
            process.on('uncaughtException', (err) => {
                error('Main', 'uncaught exception:', err);
            });

            process.on('unhandledRejection', (err) => {
                error('Main', 'unhandled rejection:', err);
            });

            // start working...
            try {
                await core.init();
                await core.start();
            } catch (err) {
                error('Main', 'error:', err);
                process.exit(1);
            }
        },
    )
    .parse();
