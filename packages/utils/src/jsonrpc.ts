import { Counter } from './counter';

type ReqDetail = {
    resolve: (params?: any) => void;
    reject: (reason?: any) => void;
    timeout?: NodeJS.Timeout;
};

export enum JSONRPCErrorCode {
    Parse = -32700,
    InvalidRequest = -32600,
    NotFound = -32601,
    Internal = -32603,
    Sever = -32000,
}

export class JSONRPCError extends Error {
    readonly code: number;

    constructor(code: number, message?: string) {
        super(message);
        this.code = code;
    }
}

export type JSONRPCRequest = { id: any; method: string; params: any };

export type JSONRPCNotify = { id: undefined; method: string; params: any };

export type JSONRPCResponse = { id: any; result?: any; error?: any };

/**
 * Transparent JSONRPC parsing tool
 */
export class JSONRPC {
    private autoId: number = Number.MIN_SAFE_INTEGER;
    private readonly reqs = new Map<string, ReqDetail>();
    private readonly counter = new Counter();

    /**
     * Generate JSONRPC request content
     * @param id JSONRPC id
     * @param method Method name
     * @param params Params
     * @returns Formatted request content
     */
    static formatJSONRPCRequest(id: string, method?: string, params?: any) {
        const req = {
            jsonrpc: '2.0',
            id,
            method,
            params,
        };
        return req;
    }

    /**
     * Generate JSONRPC notify content
     * @param method Method name
     * @param params Params
     * @returns Formatted notify content
     */
    static formatJSONRPCNotify(method: string, params?: any) {
        const req = {
            jsonrpc: '2.0',
            method,
            params,
        };
        return req;
    }

    /**
     * Generate JSONRPC error content
     * @param codeOrError Error or JSONRPC error code
     * @param id JSONRPC id
     * @param message Error message
     * @returns Formatted error content
     */
    static formatJSONRPCError(codeOrError: any, id?: string, message?: string) {
        let req: any;
        if (typeof codeOrError === 'number') {
            req = {
                jsonrpc: '2.0',
                id,
                error: {
                    code: codeOrError,
                    message,
                },
            };
        } else if (typeof codeOrError === 'string') {
            req = {
                jsonrpc: '2.0',
                id,
                error: {
                    code: JSONRPCErrorCode.Internal,
                    message: codeOrError,
                },
            };
        } else if (codeOrError instanceof JSONRPCError) {
            req = {
                jsonrpc: '2.0',
                id,
                error: {
                    code: codeOrError.code,
                    message: codeOrError.message,
                },
            };
        } else if (codeOrError instanceof Error) {
            req = {
                jsonrpc: '2.0',
                id,
                error: {
                    code: JSONRPCErrorCode.Internal,
                    message: codeOrError.message,
                },
            };
        } else {
            req = {
                jsonrpc: '2.0',
                id,
                error: {
                    code: JSONRPCErrorCode.Internal,
                    message: 'internal unknown error',
                },
            };
        }
        return req;
    }

    /**
     * Generate JSONRPC response content
     * @param id JSONRPC id
     * @param result Result
     * @returns Formatted response content
     */
    static formatJSONRPCResult(id: string, result?: any) {
        const req = {
            jsonrpc: '2.0',
            id,
            result,
        };
        return req;
    }

    /**
     * Parse message
     * @param data Message
     * @returns Message type and data
     */
    static parse(data: any): ['request', JSONRPCRequest] | ['response', JSONRPCResponse] | ['notify', JSONRPCNotify] {
        let json: any;
        try {
            // parse JSON
            json = typeof data === 'string' ? JSON.parse(data) : data;
        } catch (err) {
            throw new JSONRPCError(JSONRPCErrorCode.Parse, 'invalid json format');
        }

        // check version
        if (json.jsonrpc !== '2.0') {
            throw new JSONRPCError(JSONRPCErrorCode.InvalidRequest, 'invalid version');
        }

        // parse message
        if (json.method) {
            if (typeof json.method !== 'string') {
                throw new JSONRPCError(JSONRPCErrorCode.InvalidRequest, 'invalid method');
            }
            if (json.id) {
                return ['request', { id: json.id, method: json.method, params: json.params }];
            } else {
                return ['notify', { id: undefined, method: json.method, params: json.params }];
            }
        } else {
            if (!json.result && !json.error) {
                throw new JSONRPCError(JSONRPCErrorCode.InvalidRequest, 'invalid result or error');
            }
            return ['response', { id: json.id, result: json.result, error: json.error }];
        }
    }

    /**
     * Get waiting reqeust count
     */
    get requests() {
        return this.counter.count;
    }

    // generate JSONRPC id
    private genId() {
        const id = this.autoId++;
        if (id === Number.MAX_SAFE_INTEGER) {
            this.autoId = Number.MIN_SAFE_INTEGER;
        }
        return id.toString();
    }

    /**
     * Abort
     * @param reason Abort reason
     */
    abort(reason?: any) {
        for (const [, { reject, timeout }] of this.reqs) {
            this.counter.decrease();
            timeout && clearTimeout(timeout);
            reject(reason);
        }
        this.reqs.clear();
    }

    /**
     * Send request
     * @param method Method
     * @param params Params
     * @param timeout Request timeout
     * @returns Request content and response promise
     */
    request(method: string, params?: any, timeout = 5000) {
        const id = this.genId();
        this.counter.increase();
        return {
            request: JSONRPC.formatJSONRPCRequest(id, method, params),
            getResult: new Promise<any>((resolve, reject) => {
                this.reqs.set(id, {
                    resolve,
                    reject,
                    timeout:
                        timeout === -1
                            ? undefined
                            : setTimeout(() => {
                                  if (this.reqs.delete(id)) {
                                      this.counter.decrease();
                                      reject(new Error('jsonrpc timeout'));
                                  }
                              }, timeout),
                });
            }),
        };
    }

    /**
     * Process response message
     * @param param0 Response content
     * @returns Succeed or not
     */
    response({ id, result, error }: JSONRPCResponse): boolean {
        const detail = this.reqs.get(id);
        if (!detail) {
            return false;
        }
        this.counter.decrease();
        this.reqs.delete(id);
        const { resolve, reject, timeout } = detail;
        timeout && clearTimeout(timeout);
        error ? reject(error) : resolve(result);
        return true;
    }

    /**
     * Waiting for all request
     */
    wait() {
        return this.counter.wait();
    }
}
