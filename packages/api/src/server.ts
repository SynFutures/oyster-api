import http from 'http';
import express from 'express';
import expressWs from 'express-ws';
import { Counter } from '@synfutures/utils';
import { Core, Plugin } from '@synfutures/fx-core';
import { error, info } from '@synfutures/logger';

type ServerConfig = {
    host: string;
    port: number;
};

/**
 * Websocket server
 */
export class Server extends Plugin {
    private server: http.Server;
    private ws: expressWs.Instance;
    private counter = new Counter();
    private aborters = new Set<AbortController>();

    constructor(core: Core, private config: ServerConfig) {
        super(core);
    }

    private get handler() {
        const handler = this.core.getPlugin('Handler');
        if (!handler) {
            throw new Error('Handler plugin is not loaded');
        }
        return handler;
    }

    /**
     * Lifecycle function
     */
    async onStart() {
        this.ws = expressWs(express());

        this.ws.app.ws('/', (ws, req) => {
            if (this.stopped) {
                // we are closing, ignore new connections
                ws.close();

                return;
            }

            const from = req.headers['x-forwarded-for'] ?? req.socket.remoteAddress;

            info('Server', 'incoming websocket:', from);

            const aborter = new AbortController();

            this.aborters.add(aborter);

            const combinedSignal = this.core.combineSignals(aborter.signal);

            ws.on('close', () => {
                aborter.abort(new Error('websocket client disconnected'));

                this.aborters.delete(aborter);

                info('Server', 'closed websocket:', from);
            });

            ws.on('message', (msg) => {
                if (this.stopped) {
                    // we are closing, ignore new messages
                    return;
                }

                this.counter.increase();

                this.handler
                    .handle(msg.toString(), combinedSignal)
                    .then((response) => ws.send(response))
                    .catch((err) => error('Server', 'catch error:', err))
                    .finally(() => this.counter.decrease());
            });
        });

        this.server = await new Promise<http.Server>((r, j) => {
            const onError = (err: Error) => {
                j(err);
            };

            this.ws.app.once('error', onError);

            const server = this.ws.app.listen(this.config.port, this.config.host, () => {
                this.ws.app.off('error', onError);

                info('Server', `listening at: ${this.config.host}:${this.config.port}`);

                r(server);
            });
        });
    }

    /**
     * Lifecycle function
     */
    async onStop() {
        for (const aborter of this.aborters) {
            aborter.abort();
        }

        // stop accepting new connection
        if (this.server) {
            this.server.close();
        }

        // wait for all requests to be processed
        await this.counter.wait();

        if (this.ws) {
            // close all clients
            for (const ws of this.ws.getWss().clients) {
                ws.close();
            }
        }
    }
}
