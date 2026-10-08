import "server-only";
import { ForbiddenError } from "@/domain/permissions";
import { TransitionError } from "@/domain/fixture-state";
import { ScoringError } from "@/domain/scoring";
import { AppError } from "@/server/errors";

/** What a form's server action returns to `useActionState`. */
export interface FormState {
  ok?: boolean;
  error?: string;
  message?: string;
  /** Echo of a value the page needs after success, e.g. an invitation link. */
  value?: string;
}

export const initialFormState: FormState = {};

/**
 * Run a service call from a server action, turning expected errors into a
 * message for the form. Unexpected errors still throw (and are logged).
 * Navigation errors from redirect() must not be caught, so callers redirect
 * after this returns.
 */
export async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: "You don't have permission to do that." };
    if (e instanceof AppError || e instanceof ScoringError || e instanceof TransitionError) {
      return { ok: false, error: sentence(e.message) };
    }
    throw e;
  }
}

const sentence = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? "" : ".") : s);

export const str = (fd: FormData, key: string) => {
  const v = fd.get(key);
  return typeof v === "string" ? v : "";
};
