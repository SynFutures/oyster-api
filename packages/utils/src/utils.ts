import { Limited } from './limited';

/**
 * Get random integer between min and max
 * @param min Minimum
 * @param max Maximum
 * @returns Random integer
 */
export function getRandomIntInclusive(min: number, max: number): number {
    min = Math.ceil(min);
    max = Math.floor(max);
    if (max < min) {
        throw new Error('The maximum value should be greater than the minimum value');
    }
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Execute multiple concurrent
 * @param array Array
 * @param fn Execution function
 * @param limit Concurrency limit
 * @returns Results
 */
export function limitedMap<T, U>(array: T[], fn: (t: T) => Promise<U>, limit: number): Promise<U[]> {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises, no-async-promise-executor
    return new Promise<U[]>(async (resolve, reject) => {
        let failed = false;
        const limited = new Limited(limit);
        const promises: Promise<U>[] = [];
        for (const element of array) {
            if (failed) {
                break;
            }

            const token = await limited.getToken();

            if (failed) {
                limited.put(token);
                break;
            }

            promises.push(
                fn(element)
                    .catch((err) => {
                        failed = true;
                        reject(err);
                    })
                    .finally(() => limited.put(token)) as Promise<U>,
            );
        }
        resolve(await Promise.all(promises));
    });
}
