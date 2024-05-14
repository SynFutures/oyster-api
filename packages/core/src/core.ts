/* eslint-disable @typescript-eslint/no-empty-function */
/* eslint-disable @typescript-eslint/no-empty-interface */
/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { debug } from '@synfutures/logger';
import { AsyncEventEmitter } from './asyncEventEmitter';

type Event =
    | string
    | {
          event: string;
          topic?: string;
      };

type Listener = (...args: any[]) => void;

type AsyncListener = (...args: any[]) => Promise<void>;

// extend the type of AbortSignal
declare class AbortSignal extends globalThis.AbortSignal {
    static any(signals: AbortSignal[]): globalThis.AbortSignal;
}

export function combineSignals(signals: globalThis.AbortSignal[]) {
    return AbortSignal.any(signals);
}

function formatEvent(e: Event) {
    return typeof e === 'string' ? e : e.topic ? `${e.event}-${e.topic}` : e.event;
}

class BlockingEvents {
    constructor(public readonly core: Core) {}

    on(event: Event, listener: AsyncListener) {
        this.core.emitter.on(formatEvent(event), listener);
    }

    off(event: Event, listener: AsyncListener) {
        this.core.emitter.off(formatEvent(event), listener);
    }
}

class NonBlockingEvents {
    constructor(public readonly core: Core) {}

    on(event: Event, listener: Listener) {
        this.core.emitter.on(formatEvent(event), listener);
    }

    off(event: Event, listener: Listener) {
        this.core.emitter.off(formatEvent(event), listener);
    }
}

export interface Events {}

type TypedEvent<T extends keyof Events> =
    | T
    | {
          event: T;
          topic?: string;
      };

type AsyncEvents<T extends keyof Events> = (...args: Parameters<Events[T]>) => Promise<void>;

declare interface BlockingEvents {
    on<T extends keyof Events>(event: TypedEvent<T>, listener: AsyncEvents<T>): void;

    off<T extends keyof Events>(event: TypedEvent<T>, listener: AsyncEvents<T>): void;
}

declare interface NonBlockingEvents {
    on<T extends keyof Events>(event: TypedEvent<T>, listener: Events[T]): void;

    off<T extends keyof Events>(event: TypedEvent<T>, listener: Events[T]): void;
}

export abstract class Plugin {
    constructor(public readonly core: Core) {}

    protected get stopped() {
        return this.core.stopped;
    }

    /**
     * Lifecycle function,
     * will be called during initialization
     */
    async onInit() {}

    /**
     * Lifecycle function,
     * will be called when start working
     */
    async onStart() {}

    /**
     * Lifecycle function,
     * will be called when stopped
     */
    async onStop() {}

    /**
     * Lifecycle function,
     * will be called when destroyed
     */
    async onDestroy() {}
}

export interface Plugins {}

export interface PluginConstructor<T extends Plugin> {
    new (core: Core, ...constructorArgs: any[]): T;
}

export interface EmptyPluginConstructor<T extends Plugin> {
    new (core: Core): T;
}

export type CreatePluginOptions<T> = {
    ctor: T;
    pluginName?: string;
};

type PluginType<T> = T extends PluginConstructor<infer P> ? P : never;

type FilterFirstElement<T extends unknown[]> = T extends [unknown, ...infer R] ? R : [];

/**
 * Framework core,
 * used to add plugins and send and listen to events
 */
export class Core {
    readonly emitter = new AsyncEventEmitter();

    readonly blocking = new BlockingEvents(this);
    readonly nonBlocking = new NonBlockingEvents(this);

    readonly plugins = new Map<string, Map<string, Plugin>>();

    private readonly aborter = new AbortController();

    /**
     * Constructor
     * @param name Core instance name
     */
    constructor(public readonly name: string) {}

    /**
     * Get whether it has stopped working
     */
    get stopped() {
        return this.aborter.signal.aborted;
    }

    /**
     * Get abort signal
     */
    get signal() {
        return this.aborter.signal;
    }

    /**
     * Get all plugins
     */
    get allPlugins() {
        return Array.from(this.plugins.values())
            .map((map) => Array.from(map.values()))
            .flat();
    }

    /**
     * Emit event
     * @param event Event name and topic
     * @param args Event args
     */
    emit<T extends keyof Events>(event: TypedEvent<T>, ...args: Parameters<Events[T]>) {
        return this.emitter.emit(formatEvent(event), ...args);
    }

    /**
     * Whether the plugin exists
     * @param typeName Plugin type name
     * @param pluginName Plugin name, default: "default"
     */
    hasPlugin(typeName: string, pluginName = 'default') {
        const map = this.plugins.get(typeName);
        return map && map.has(pluginName);
    }

    /**
     * Get plugin object
     * @param typeName Plugin type name
     * @param pluginName Plugin name, default: "default"
     * @returns Plugin object if exists
     */
    getPlugin<T extends keyof Plugins>(typeName: T, pluginName = 'default'): Plugins[T] | undefined {
        return this.plugins.get(typeName)?.get(pluginName) as Plugins[T] | undefined;
    }

    /**
     * Add plugin object
     * @param typeName Plugin type name
     * @param pluginName Plugin name, default: "default"
     * @param plugin Plugin object
     */
    addPlugin(typeName: string, pluginName: string, plugin: Plugin) {
        let map = this.plugins.get(typeName);
        if (!map) {
            map = new Map<string, Plugin>();
            this.plugins.set(typeName, map);
        } else if (map.has(pluginName)) {
            throw new Error(`plugin: ${typeName}-${pluginName} already exists`);
        }
        map.set(pluginName, plugin);
    }

    /**
     * Create plugin object and add it to core
     * @param arg0 Plugin constructor or plugin constructor array or {@link CreatePluginOptions}
     * @param constructorArgs Constructor options
     * @returns New plugin object
     */
    createPlugin<P extends Plugin, T extends PluginConstructor<P>>(
        arg0: T,
        ...constructorArgs: FilterFirstElement<ConstructorParameters<T>>
    ): PluginType<T>;
    createPlugin<P extends Plugin, T extends PluginConstructor<P>>(
        arg0: CreatePluginOptions<T>,
        ...constructorArgs: FilterFirstElement<ConstructorParameters<T>>
    ): PluginType<T>;
    createPlugin(arg0: any, ...constructorArgs: any[]): Plugin {
        const ctor = typeof arg0 === 'object' ? arg0.ctor : arg0;
        const pluginName = typeof arg0 === 'object' && arg0.pluginName ? arg0.pluginName : 'default';
        const plugin = new ctor(this, ...constructorArgs);
        this.addPlugin(ctor.name, pluginName, plugin);
        return plugin;
    }

    /**
     * Batch create plugin objects
     * @param ctor Plugin constructor array
     */
    createPlugins<P extends Plugin, T extends EmptyPluginConstructor<P>>(ctor: T[]): void;
    createPlugins(ctor: any[]) {
        ctor.forEach((c) => this.createPlugin(c));
    }

    /**
     * Combine signals with global signal
     * @param signals Abort signals
     * @returns Combined signal
     */
    combineSignals(signals: AbortSignal[] | AbortSignal) {
        return combineSignals([this.signal, ...(Array.isArray(signals) ? signals : [signals])]);
    }

    /**
     * Initialize
     */
    async init() {
        await Promise.all(this.allPlugins.map((plugin) => plugin.onInit()));
    }

    /**
     * Start working
     */
    async start() {
        await Promise.all(this.allPlugins.map((plugin) => plugin.onStart()));
    }

    /**
     * Stop working
     * @param reason Close reason
     */
    async stop(reason: any = new Error('server is closing')) {
        // abort
        this.aborter.abort(reason);

        const workingPlugins = new Map(
            Array.from(this.plugins.entries())
                .map(([typeName, map]) =>
                    Array.from(map.entries()).map(([pluginName, plugin]): [Plugin, string] => [
                        plugin,
                        `${typeName}-${pluginName}`,
                    ]),
                )
                .flat(),
        );

        // print unstopped plugins
        const interval = setInterval(() => {
            debug('Core', 'still working plugins:', Array.from(workingPlugins.values()).join(','));
        }, 3000);

        await Promise.all(
            this.allPlugins.map((plugin) => plugin.onStop().finally(() => workingPlugins.delete(plugin))),
        ).finally(() => clearInterval(interval));
    }

    /**
     * Destroy the instance and release all resources
     */
    async destroy() {
        await Promise.all(this.allPlugins.map((plugin) => plugin.onDestroy()));
    }
}
