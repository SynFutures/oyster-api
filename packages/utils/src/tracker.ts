/**
 * Simple tracker to track time usage
 */
export class Tracker {
    private createdAt = Date.now();
    private latest?: number;
    private cumulativePauseTime = 0;
    private pauseTime = 0;
    private pauseAt?: number;

    /**
     * Get the elapsed time since the last call
     * @param isSecond Whether the returned unit is seconds
     * @returns Usage
     */
    usage(inSecond = true) {
        this.resume();
        const now = Date.now();
        let usage = now - (this.latest ? this.latest : this.createdAt);
        if (this.pauseTime > 0) {
            usage -= this.pauseTime;
            this.pauseTime = 0;
        }
        this.latest = now;
        return inSecond ? usage / 1000 : usage;
    }

    /**
     * Pause timing
     */
    pause() {
        this.pauseAt = Date.now();
    }

    /**
     * Resume timing
     */
    resume() {
        if (this.pauseAt) {
            const time = Date.now() - this.pauseAt;
            this.pauseTime += time;
            this.cumulativePauseTime += time;
            this.pauseAt = undefined;
        }
    }

    /**
     * Get the elapsed time since the beginning
     * @param inSecond Whether the returned unit is seconds
     * @returns Usage
     */
    totalUsage(inSecond = true) {
        this.resume();
        const now = Date.now();
        let usage = now - this.createdAt;
        if (this.cumulativePauseTime > 0) {
            usage -= this.cumulativePauseTime;
        }
        this.pauseTime = 0;
        this.latest = now;
        return inSecond ? usage / 1000 : usage;
    }
}
