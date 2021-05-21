import { Readable } from 'stream';
import { RethinkDBSocket } from '../connection/socket';
import { isRethinkDBError, RethinkDBError, RethinkDBErrorType } from '../error';
import { ResponseNote, ResponseType } from '../proto/enums';
import type { QueryJson, ResponseJson } from '../types';
import type { RunOptions } from '../connection/types';
import { isPromise } from '../util';
import { parseRawResponse } from './response-parser';

export type RCursorType =
  | 'Atom'
  | 'Cursor'
  | 'Feed'
  | 'AtomFeed'
  | 'OrderByLimitFeed'
  | 'UnionedFeed';

export class Cursor<T = unknown> extends Readable {
  public get profile(): unknown {
    // eslint-disable-next-line no-underscore-dangle
    return this._profile;
  }

  // eslint-disable-next-line camelcase
  private _profile: unknown;

  private position = 0;

  private type: RCursorType = 'Cursor';

  private includeStates = false;

  private closed = false;

  private emitting = false;

  private resolving: Promise<unknown> | undefined;

  private lastError: Error | undefined;

  private results?: unknown[];

  private hasNextBatch?: boolean;

  constructor(
    private socket: RethinkDBSocket,
    private token: number,
    private runOptions: Pick<
      RunOptions,
      'binaryFormat' | 'groupFormat' | 'timeFormat'
    >,
    private query: QueryJson,
  ) {
    super({ objectMode: true });
  }

  public init(): void {
    this.resolving = this.resolve().catch((error) => {
      this.lastError = error;
    });
  }

  // eslint-disable-next-line no-underscore-dangle
  public _read(): void {
    this.emitting = true;
    const push = (row: unknown): void => {
      if (row === null) {
        // eslint-disable-next-line no-underscore-dangle
        this._next().then(push);
      } else {
        this.push(row);
      }
    };
    // eslint-disable-next-line no-underscore-dangle
    this._next()
      .then(push)
      .catch((error) => {
        if (
          (!isRethinkDBError(error) ||
            ![
              RethinkDBErrorType.CURSOR_END,
              RethinkDBErrorType.CANCEL,
            ].includes(error.type)) &&
          this.listenerCount('error') > 0
        ) {
          this.emit('error', error);
        }
        this.push(null);
      });
  }

  public pause(): this {
    this.emitting = false;
    return super.pause();
  }

  public resume(): this {
    // eslint-disable-next-line no-underscore-dangle
    this._read();
    return super.resume();
  }

  public destroy(): void {
    super.destroy();
  }

  // eslint-disable-next-line no-underscore-dangle
  public _destroy(): void {
    this.close();
  }

  public toString(): string {
    return `[object ${this.type}]`;
  }

  public getType(): RCursorType {
    return this.type;
  }

  public async close(): Promise<void> {
    if (!this.closed) {
      if (this.socket.status === 'open') {
        this.socket.stopQuery(this.token);
      }
      this.emitting = false;
      this.closed = true;
    }
  }

  public async next(): Promise<T> {
    if (this.emitting) {
      throw new RethinkDBError(
        'You cannot call `next` once you have bound listeners on the Feed.',
        { type: RethinkDBErrorType.CURSOR },
      );
    }
    if (this.closed) {
      throw new RethinkDBError(
        `You cannot call \`next\` on a closed ${this.type}`,
        { type: RethinkDBErrorType.CURSOR },
      );
    }
    // eslint-disable-next-line no-underscore-dangle
    return this._next();
  }

  public async toArray(): Promise<T[]> {
    if (this.emitting) {
      throw new RethinkDBError(
        'You cannot call `toArray` once you have bound listeners on the Feed.',
        { type: RethinkDBErrorType.CURSOR },
      );
    }
    const all: T[] = [];
    await this.eachAsync(async (row) => {
      if (this.type.endsWith('Feed')) {
        throw new RethinkDBError(
          'You cannot call `toArray` on a change Feed.',
          {
            type: RethinkDBErrorType.CURSOR,
          },
        );
      }
      all.push(row);
    });
    return all;
  }

  public async each(
    cb: (error: RethinkDBError | undefined, row?: unknown) => boolean | void,
    onFinishedCallback?: () => void,
  ): Promise<void> {
    if (this.emitting) {
      throw new RethinkDBError(
        'You cannot call `each` once you have bound listeners on the Feed.',
        { type: RethinkDBErrorType.CURSOR },
      );
    }
    if (this.closed) {
      cb(
        new RethinkDBError(
          'You cannot retrieve data from a cursor that is closed',
          { type: RethinkDBErrorType.CURSOR },
        ),
      );
      if (onFinishedCallback) {
        onFinishedCallback();
      }
      return;
    }
    let resume = true;
    let err: RethinkDBError | undefined;
    let next: unknown;
    while (resume && !this.closed) {
      err = undefined;
      try {
        // eslint-disable-next-line no-await-in-loop
        next = await this.next();
      } catch (error) {
        err = error;
      }
      if (err && err.type === RethinkDBErrorType.CURSOR_END) {
        break;
      }
      resume = cb(err, next) !== false;
    }
    if (onFinishedCallback) {
      onFinishedCallback();
    }
  }

  public async eachAsync(
    rowHandler: (
      row: T,
      rowFinished?: (error?: string) => void,
    ) => void | Promise<void>,
    final?: (error: Error) => void,
  ): Promise<void> {
    if (this.emitting) {
      throw new RethinkDBError(
        'You cannot call `eachAsync` once you have bound listeners on the Feed.',
        { type: RethinkDBErrorType.CURSOR },
      );
    }
    if (this.closed) {
      throw new RethinkDBError(
        'You cannot retrieve data from a cursor that is closed',
        { type: RethinkDBErrorType.CURSOR },
      );
    }
    let nextRow: T;
    try {
      while (!this.closed) {
        // eslint-disable-next-line no-await-in-loop
        nextRow = await this.next();
        if (rowHandler.length > 1) {
          // eslint-disable-next-line no-await-in-loop,no-loop-func
          await new Promise<void>((resolve, reject) => {
            rowHandler(nextRow, (error) => {
              if (error) {
                reject(
                  new RethinkDBError(error, { type: RethinkDBErrorType.USER }),
                );
                return;
              }
              resolve();
            });
          });
        } else {
          const result = rowHandler(nextRow);
          if (result !== undefined && !isPromise(result)) {
            throw result;
          }
          // eslint-disable-next-line no-await-in-loop
          await result;
        }
      }
    } catch (error) {
      let finalError = error;
      if (final) {
        try {
          await final(error);
          return;
        } catch (err) {
          finalError = err;
        }
      }
      if (
        !isRethinkDBError(finalError) ||
        ![RethinkDBErrorType.CURSOR_END, RethinkDBErrorType.CANCEL].includes(
          finalError.type,
        )
      ) {
        throw finalError;
      }
    }
  }

  public async resolve(): Promise<unknown[]> {
    try {
      const response = await this.socket.readNext(this.token);
      const { n: notes, t: type, r: results, p: profile } = response;
      // eslint-disable-next-line no-underscore-dangle
      this._profile = profile;
      this.position = 0;
      const convertedResults = parseRawResponse(results, this.runOptions);
      this.results = convertedResults;
      this.handleResponseNotes(type, notes);
      this.handleErrors(response);
      this.hasNextBatch = type === ResponseType.SUCCESS_PARTIAL;
      return convertedResults;
    } catch (error) {
      this.emitting = false;
      this.closed = true;
      this.results = undefined;
      this.hasNextBatch = false;
      throw error;
    }
  }

  public [Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
    return {
      next: async () => {
        if (this.closed) {
          return { done: true, value: undefined };
        }
        try {
          const value = await this.next();
          return { done: false, value };
        } catch (error) {
          if (
            isRethinkDBError(error) &&
            error.type === RethinkDBErrorType.CANCEL
          ) {
            return { done: true, value: undefined };
          }
          throw error;
        }
      },
    } as AsyncIterableIterator<unknown>;
  }

  // eslint-disable-next-line no-underscore-dangle
  private async _next(): Promise<T> {
    if (this.lastError) {
      this.emitting = false;
      this.closed = true;
      this.results = undefined;
      this.hasNextBatch = false;
      throw this.lastError;
    }
    try {
      if (this.resolving) {
        await this.resolving;
        this.resolving = undefined;
      }
      let results = this.getResults();
      let next = results && results[this.position];
      while (next === undefined && this.hasNextBatch) {
        if (!this.resolving) {
          this.resolving = this.resolve();
          this.socket.continueQuery(this.token);
        }
        // eslint-disable-next-line no-await-in-loop
        await this.resolving;
        this.resolving = undefined;
        results = this.getResults();
        next = results && results[this.position];
      }
      if (!this.hasNextBatch && next === undefined) {
        throw new RethinkDBError('No more rows in the cursor.', {
          type: RethinkDBErrorType.CURSOR_END,
        });
      }
      this.position += 1;
      return next;
    } catch (error) {
      this.closed = true;
      throw error;
    }
  }

  private getResults() {
    return this.results &&
      this.type === 'Atom' &&
      Array.isArray(this.results[0])
      ? this.results[0]
      : this.results;
  }

  private handleErrors(response: ResponseJson) {
    const { t: type, b: backtrace, r: results, e: error } = response;
    switch (type) {
      case ResponseType.CLIENT_ERROR:
      case ResponseType.COMPILE_ERROR:
      case ResponseType.RUNTIME_ERROR:
        throw new RethinkDBError(results[0], {
          responseErrorType: error,
          responseType: type,
          query: this.query,
          backtrace,
        });
      case ResponseType.SUCCESS_ATOM:
      case ResponseType.SUCCESS_PARTIAL:
      case ResponseType.SUCCESS_SEQUENCE:
        break;
      default:
        throw new RethinkDBError('Unexpected return value');
    }
  }

  private handleResponseNotes(rType: ResponseType, notes: ResponseNote[] = []) {
    if (rType === ResponseType.SUCCESS_ATOM) {
      this.includeStates = false;
      this.type = 'Atom';
      return;
    }
    const { type, includeStates } = notes.reduce(
      (acc, next) => {
        switch (next) {
          case ResponseNote.SEQUENCE_FEED:
            acc.type = 'Feed';
            break;
          case ResponseNote.ATOM_FEED:
            acc.type = 'AtomFeed';
            break;
          case ResponseNote.ORDER_BY_LIMIT_FEED:
            acc.type = 'OrderByLimitFeed';
            break;
          case ResponseNote.UNIONED_FEED:
            acc.type = 'UnionedFeed';
            break;
          case ResponseNote.INCLUDES_STATES:
            acc.includeStates = true;
            break;
          default:
            break;
        }
        return acc;
      },
      { type: 'Cursor' as RCursorType, includeStates: true },
    );
    this.type = type;
    this.includeStates = includeStates;
  }
}

export function isCursor<T = unknown>(cursor: unknown): cursor is Cursor<T> {
  return cursor instanceof Cursor;
}
