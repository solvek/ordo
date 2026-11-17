// Tells the usage limit of the account from an ordinary failure. A session cut by the limit
// did not fail its task, and the dispatcher must not record it as failed.
import { SessionLimitError } from "./session.ts";

/** What the session host saw in the stream, reduced to what matters for the limit. */
export type LimitSignal =
  /** The account reported that the limit is used up. */
  | { type: "rejected"; resetsAt: Date | undefined }
  /** The account reported that requests are allowed (again). */
  | { type: "allowed" }
  /** A model call was refused because of the rate limit. */
  | { type: "refused" }
  /** A turn ended with an error instead of an answer. */
  | { type: "error-result" };

/**
 * Feed it every signal of one session, in order. It returns the error once the limit has cut
 * the session: a refused model call, or a turn that ended in an error after the limit was
 * reported used up. An error turn with the limit still allowed is some other failure.
 */
export function limitWatch(): (signal: LimitSignal) => SessionLimitError | null {
  let rejected = false;
  let resetsAt: Date | undefined;
  return (signal) => {
    switch (signal.type) {
      case "rejected":
        rejected = true;
        resetsAt = signal.resetsAt;
        return null;
      case "allowed":
        rejected = false;
        resetsAt = undefined;
        return null;
      case "refused":
        return new SessionLimitError(resetsAt);
      case "error-result":
        return rejected ? new SessionLimitError(resetsAt) : null;
    }
  };
}
