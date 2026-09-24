export type Log = (message: string) => void;

/** `undefined` when off, so call sites use `log?.()` and skip even building the message. */
export function logger(on: boolean | undefined): Log | undefined {
  return on
    ? (message) => {
        console.info(`[argos] ${message}`);
      }
    : undefined;
}
