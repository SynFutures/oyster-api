import '@synfutures/fx-core';
import type { Handler } from './handler';
import type { Subscriber } from './subscriber';

declare module '@synfutures/fx-core' {
    interface Plugins {
        Handler: Handler;

        Subscriber: Subscriber;
    }
}
