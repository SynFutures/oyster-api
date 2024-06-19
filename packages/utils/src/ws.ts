/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-explicit-any */
import EventEmitter from 'events';
import WS from 'ws';
import { error, warn, debug } from '@synfutures/logger';

export interface WebSocketConfig {
    // remote server URL
    url: string;

    // reconnection will happen after the reconnection delay
    reconnectDelay: number;

    // period for sending ping packets
    keepAliveInterval: number;

    // timeout for accepting pong packets
    keepAliveTimeout: number;
}

const defaultConfig: Partial<WebSocketConfig> = {
    reconnectDelay: 1000,
    keepAliveInterval: 3000,
    keepAliveTimeout: 1000,
};

/**
 * Simple encapsulation of `ws`, implement keep alive and reconnection
 */
export class WebSocket extends EventEmitter {
    private config: WebSocketConfig;

    private ws?: WS;
    private connected = false;
    private closing = false;
    private queue: string[] = [];
    private reconnecting?: NodeJS.Timeout;

    constructor(config: Partial<WebSocketConfig>) {
        super();
        this.config = {
            ...defaultConfig,
            ...config,
        } as WebSocketConfig;
    }

    private _reconnect() {
        if (!this.closing && !this.reconnecting) {
            debug('WebSocket', 'reconnecting...');

            this.reconnecting = setTimeout(() => {
                this.reconnecting = undefined;
                if (!this.closing) {
                    this.connect();
                }
            }, this.config.reconnectDelay);
        }
    }

    /**
     * whether it is connected
     */
    get isConnected() {
        return this.ws && this.connected;
    }

    /**
     * Send data to remote
     * @param data Data
     */
    send(data: string) {
        if (this.ws && this.connected) {
            this.ws.send(data);
        } else {
            this.queue.push(data);
        }
    }

    /**
     * Connect with remote server
     */
    connect() {
        if (this.ws) {
            throw new Error('already connected');
        }

        const ws = new WS(this.config.url);

        let interval: NodeJS.Timeout | undefined;
        let timeOut: NodeJS.Timeout | undefined;
        let onClose: () => void;
        let onError: (err: any) => void;
        let onOpen: () => void;
        let onPong: (() => void) | undefined;
        let onMessage: ((data: WS.RawData) => void) | undefined;

        const off = () => {
            ws.off('close', onClose);
            ws.off('error', onError);
            ws.off('open', onOpen);
            if (onPong) {
                ws.off('pong', onPong);
            }
            if (onMessage) {
                ws.off('message', onMessage);
            }
            if (interval) {
                clearInterval(interval);
                interval = undefined;
            }
            if (timeOut) {
                clearTimeout(timeOut);
                timeOut = undefined;
            }
        };

        const reconnect = () => {
            // remove all listeners and timers
            off();

            // terminate
            ws.terminate();

            if (this.ws === ws) {
                // clearup and reconnect
                this.ws = undefined;
                this.connected = false;

                this._reconnect();

                this.emit('closed');
            }
        };

        ws.on(
            'close',
            (onClose = () => {
                reconnect();
            }),
        );
        ws.on(
            'error',
            (onError = (err) => {
                error('WebSocket', 'error:', err);

                reconnect();
            }),
        );
        ws.on(
            'open',
            (onOpen = () => {
                debug('WebSocket', 'connected');

                ws.on(
                    'pong',
                    (onPong = () => {
                        if (timeOut) {
                            clearTimeout(timeOut);
                            timeOut = undefined;
                        }
                    }),
                );
                ws.on(
                    'message',
                    (onMessage = (data) => {
                        this.emit('message', data);
                    }),
                );

                // start a interval to keep alive
                interval = setInterval(() => {
                    if (!timeOut) {
                        ws.ping();
                        timeOut = setTimeout(() => {
                            debug('WebSocket', 'loss connection...');

                            // send loss event
                            this.emit('loss');

                            // start reconnecting
                            reconnect();
                        }, this.config.keepAliveTimeout);
                    }
                }, this.config.keepAliveInterval);

                // mark self as connected,
                // prepare to write data
                this.connected = true;

                // send cached messages
                this.queue.forEach((data) => ws.send(data));
                this.queue = [];

                this.emit('connected');
            }),
        );

        this.ws = ws;
    }

    /**
     * Disconnect with remote server
     */
    disconnect() {
        if (!this.closing) {
            this.closing = true;
            if (this.ws) {
                this.ws.close();
            }
            if (this.reconnecting) {
                clearTimeout(this.reconnecting);
                this.reconnecting = undefined;
            }
        }
    }

    /**
     * Immediately disconnect and reconnect
     */
    reconnect() {
        if (!this.closing) {
            this.disconnect();
            this.once('closed', () => {
                this.closing = false;
                this._reconnect();
            });
        }
    }
}

type Request = {
    timeOut: NodeJS.Timeout;
    resolve: (response: any) => void;
    reject: (reason?: any) => void;
};

/**
 * Support JSON RPC protocol, base on `WebSocket`
 */
export class JSONRPCWebSocket extends EventEmitter {
    private id = Number.MIN_SAFE_INTEGER;
    private requests = new Map<string, Request>();

    constructor(public ws: WebSocket) {
        super();
    }

    // Generate unique JSON RPC id
    private genId() {
        return (this.id++).toString();
    }

    private onLoss = () => {
        for (const { timeOut, reject } of this.requests.values()) {
            reject(new Error('loss connection'));
            clearTimeout(timeOut);
        }
        this.requests.clear();
    };

    // handle underlying messages
    private onMessage = (data: WS.RawData) => {
        try {
            const json = JSON.parse(data.toString());
            const { jsonrpc, id, result, error, method, params } = json;

            // check format
            if (jsonrpc !== '2.0') {
                warn('JSONRPCWebSocket', 'invalid JSON RPC version:', jsonrpc);
                return;
            }

            if (id !== undefined) {
                // it is a response
                const request = this.requests.get(id);
                if (request) {
                    clearTimeout(request.timeOut);
                    if (error !== undefined) {
                        request.reject(error);
                    } else {
                        request.resolve(result);
                    }
                    this.requests.delete(id);
                } else {
                    warn('JSONRPCWebSocket', 'unknown response');
                }
                return;
            }

            if (method && params) {
                // it is a notify
                this.emit('notify', method, params);
                return;
            }

            warn('JSONRPCWebSocket', 'unknown data');
        } catch (err) {
            error('JSONRPCWebSocket', 'error:', err);
        }
    };

    /**
     * Send a request to remote and wait for response
     * @param method Method name
     * @param params Method params
     * @param timeOut Time out, default: 3s
     * @returns Response
     */
    request(method: string, params: any, timeOut = 3000) {
        const id = this.genId();
        this.ws.send(
            JSON.stringify({
                id,
                jsonrpc: '2.0',
                method,
                params,
            }),
        );
        return new Promise<any>((resolve, reject) => {
            this.requests.set(id, {
                timeOut: setTimeout(() => {
                    reject(new Error('JSON RPC timeout'));
                }, timeOut),
                resolve,
                reject,
            });
        });
    }

    /**
     * Start running
     */
    start() {
        this.ws.on('loss', this.onLoss);
        this.ws.on('message', this.onMessage);
        this.ws.connect();
    }

    /**
     * Stop running
     */
    stop() {
        this.ws.off('loss', this.onLoss);
        this.ws.off('message', this.onMessage);
        this.ws.disconnect();
        for (const { timeOut, reject } of this.requests.values()) {
            reject(new Error('JSON RPC closed'));
            clearTimeout(timeOut);
        }
        this.requests.clear();
    }
}
