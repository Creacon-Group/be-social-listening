import { Injectable, Logger } from '@nestjs/common';
import { waitUntil } from '@vercel/functions';

/** PORT: run work after the HTTP response has been sent. */
export abstract class BackgroundRunner {
  abstract run(task: Promise<unknown>): void;
}

/** Vercel: keeps the function alive until the task settles (bounded by the function's max duration). */
@Injectable()
export class VercelBackgroundRunner extends BackgroundRunner {
  run(task: Promise<unknown>) {
    waitUntil(task.catch((e: unknown) => new Logger('Background').error(e)));
  }
}

/** Docker / PM2 (VPS): an ordinary long-running process. */
@Injectable()
export class InProcessBackgroundRunner extends BackgroundRunner {
  run(task: Promise<unknown>) {
    task.catch((e: unknown) => new Logger('Background').error(e));
  }
}
