import '@synfutures/fx-core';
import type { Handler } from './handler';

declare module '@synfutures/fx-core' {
    interface Plugins {
        Handler: Handler;
    }
}
