/// <reference types="node" />
import { Readable } from 'stream';
import { RebirthDBSocket } from '../connection/socket';
import { RebirthDBError } from '../error/error';
import { QueryJson } from '../internal-types';
import { ResponseType } from '../proto/enums';
import { RCursor, RCursorType, RunOptions } from '../types';
export declare class Cursor extends Readable implements RCursor {
    private conn;
    private token;
    private runOptions;
    private query;
    private results;
    private hasNextBatch;
    readonly profile: any;
    private _profile;
    private position;
    private type;
    private includeStates;
    private closed;
    private emitting;
    constructor(conn: RebirthDBSocket, token: number, runOptions: Pick<RunOptions, 'binaryFormat' | 'groupFormat' | 'timeFormat'>, query: QueryJson, results?: any[] | undefined, hasNextBatch?: boolean | undefined);
    _read(): void;
    pause(): this;
    resume(): this;
    _destroy(): void;
    toString(): string;
    getType(): RCursorType;
    close(): Promise<void>;
    next(): Promise<any>;
    toArray(): Promise<any[]>;
    each(callback: (err: RebirthDBError | undefined, row?: any) => boolean, onFinishedCallback?: () => any): Promise<void>;
    eachAsync(rowHandler: (row: any, rowFinished?: (error?: string) => any) => any, final?: (error: any) => any): Promise<void>;
    resolve(): Promise<ResponseType>;
    private handleErrors(response);
    private handleResponseNotes(rType, notes?);
}
export declare function isCursor<T = any>(cursor: any): cursor is RCursor<T>;