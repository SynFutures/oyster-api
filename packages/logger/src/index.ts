/* eslint-disable @typescript-eslint/no-explicit-any */
import chalk from 'chalk';

function toString(date: Date) {
    const Y = date.getFullYear() + '-';
    const M =
        Number(date.getMonth() + 1)
            .toString()
            .padStart(2, '0') + '-';
    const D = Number(date.getDate()).toString().padStart(2, '0') + ' ';
    const h = Number(date.getHours()).toString().padStart(2, '0') + ':';
    const m = Number(date.getMinutes()).toString().padStart(2, '0') + ':';
    const s = Number(date.getSeconds()).toString().padStart(2, '0');
    return '[' + Y + M + D + h + m + s + ']';
}

export enum LogLevel {
    Silent,
    Info,
    Debug,
}

let logLevel: LogLevel = LogLevel.Silent;

export function setLogLevel(level: LogLevel) {
    logLevel = level;
}

export function _info(from: string, ...args: any[]) {
    return [chalk.green(toString(new Date())), 'INFO: ', chalk.blue(from), ...args];
}

export function _warn(from: string, ...args: any[]) {
    return [chalk.green(toString(new Date())), chalk.yellowBright('WARN: '), chalk.blue(from), ...args];
}

export function _error(from: string, ...args: any[]) {
    return [chalk.green(toString(new Date())), chalk.red('ERROR:'), chalk.blue(from), ...args];
}

export function _debug(from: string, ...args: any[]) {
    return [chalk.green(toString(new Date())), chalk.cyanBright('DEBUG:'), chalk.blue(from), ...args];
}

export function info(from: string, ...args: any[]) {
    if (LogLevel.Info <= logLevel) {
        console.log(..._info(from, ...args));
    }
}

export function warn(from: string, ...args: any[]) {
    if (LogLevel.Info <= logLevel) {
        console.log(..._warn(from, ...args));
    }
}

export function error(from: string, ...args: any[]) {
    if (LogLevel.Info <= logLevel) {
        console.log(..._error(from, ...args));
    }
}

export function debug(from: string, ...args: any[]) {
    if (LogLevel.Debug <= logLevel) {
        console.log(..._debug(from, ...args));
    }
}
