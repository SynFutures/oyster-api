# fx-core

A simple event-driven plugin framework.

## Features

-   Event-driven

-   Plugin

-   Strict type

-   Reusable

## Quick start

### Create a new plugin

Create a new class and inherit `Plugin` to create a new plugin, override lifecycle functions to implement various logic.

```ts
// myPlugin.ts
import { Plugin } from '@synfutures/fx-core';

export class MyPlugin extends Plugin {
    /**
     * Lifecycle function,
     * it will be called when initializing
     */
    async onInit() {
        console.log('init');
    }

    /**
     * Lifecycle function,
     * it will be called when it starts running
     */
    async onStart() {
        await this.core.emit('myEvent', 'myName', 100);
    }

    /**
     * Lifecycle function,
     * it will be called when stopped
     */
    async onStop() {
        console.log('stop');
    }

    /**
     * Lifecycle function,
     * it will be called after stopping to release resources
     */
    async onDestroy() {
        console.log('destroy');
    }
}
```

### Declares events

Extend the `Events` interface to declare new events.

```ts
// typeExtensions.ts
import '@synfutures/fx-core';

declare module '@synfutures/fx-core' {
    interface Events {
        myEvent: (name: string, date: number): void;
    }
}
```

### Install plugin and start running

```ts
// index.ts
import { Core } from '@synfutures/fx-core';
import { MyPlugin } from './myPlugin';

async function main() {
    // create core instance
    const core = new Core('server-name');

    // install plugin
    core.createPlugin(MyPlugin);

    // handle signal
    let exiting = false;
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    process.on('SIGINT', async () => {
        if (!exiting) {
            exiting = true;
            try {
                await core.stop();
                await core.destroy();
            } catch (err) {
                console.log('err:', err);
                process.exit(1);
            }
        }
    });

    // start working...
    try {
        await core.init();
        await core.start();
    } catch (err) {
        console.log('err:', err);
        process.exit(1);
    }
}

main().catch((err) => {
    console.log('err:', err);
});
```

## FAQ

### How to call each other between plugins?

1. Extend the `Plugins` interface to declare new plugin:

```ts
// typeExtensions.ts
import '@synfutures/fx-core';
import type { MyPlugin } from './myPlugin';

declare module '@synfutures/fx-core' {
    interface Plugins {
        myPlugin: MyPlugin;
    }
}
```

2. Get the plugin instance through `getPlugin` method:

```ts
import { Plugin } from '@synfutures/fx-core';

export class MyPlugin2 extends Plugin {
    foo() {
        const myPlugin = this.core.getPlugin('myPlugin');
    }
}
```

### How to customize the construction parameters of the plugin?

1. Add any parameters you want directly to the constructor, but the first parameter must be `Core`:

```ts
// myPlugin2.ts
import { Plugin, Core } from '@synfutures/fx-core';
import type { MyPlugin } from './myPlugin.ts';

export class MyPlugin2 extends Plugin {
    constructor(core: Core, myPlugin: MyPlugin, name: string) {
        super(core);

        // do something...
    }
}
```

2. Pass in the corresponding parameters when creating the plugin:

```ts
// index.ts
import { Core } from '@synfutures/fx-core';
import { MyPlugin } from './myPlugin.ts';
import { MyPlugin2 } from './myPlugin2.ts';

async function main() {
    // create core instance
    const core = new Core('server-name');

    // install plugins
    const myPlugin = core.createPlugin(MyPlugin);
    const myPlugin2 = core.createPlugin(MyPlugin2, myPlugin, 'name');

    // start server....
}

main().catch((err) => {
    console.log('err:', err);
});
```

### How to test?

When designing, each plugin should be as independent as possible, only processing one piece of logic, and the plugins should communicate through events.

So when testing, simulating these events makes it relatively easy to test each plugin.
