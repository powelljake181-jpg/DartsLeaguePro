"use client";

import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import type { FormState } from "@/lib/action";
import { Button, Notice, buttonStyles } from "./ui";

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

/**
 * A form wired to a server action with inline success / error messages.
 * `resetOnSuccess` clears the inputs after a successful submit (for "add" forms).
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  submitVariant = "primary",
  resetOnSuccess,
  className,
  renderSuccess,
}: {
  action: Action;
  children?: ReactNode;
  submitLabel: string;
  submitVariant?: "primary" | "secondary" | "danger";
  resetOnSuccess?: boolean;
  className?: string;
  renderSuccess?: (state: FormState) => ReactNode;
}) {
  const [state, formAction] = useActionState(action, {});
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok && resetOnSuccess) ref.current?.reset();
  }, [state, resetOnSuccess]);
  return (
    <form ref={ref} action={formAction} className={className ?? "space-y-4"}>
      {children}
      {state.error && (
        <div role="alert">
          <Notice tone="danger">{state.error}</Notice>
        </div>
      )}
      {state.ok && (renderSuccess ? renderSuccess(state) : state.message && <Notice tone="accent">{state.message}</Notice>)}
      <SubmitButton variant={submitVariant}>{submitLabel}</SubmitButton>
    </form>
  );
}

export function SubmitButton({ children, variant = "primary" }: { children: ReactNode; variant?: "primary" | "secondary" | "danger" }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending} className="w-full sm:w-auto">
      {pending ? "Working…" : children}
    </Button>
  );
}

/** A copyable link, e.g. an invitation to share on WhatsApp. */
export function CopyLink({ url, label = "Copy link" }: { url: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const whatsapp = `https://wa.me/?text=${encodeURIComponent(url)}`;
  return (
    <div className="space-y-2">
      <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="block min-h-11 w-full rounded-lg border border-border bg-surface-muted px-3 font-mono text-sm" />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonStyles.secondary}
          onClick={async () => {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? "Copied" : label}
        </button>
        <a className={buttonStyles.secondary} href={whatsapp} target="_blank" rel="noreferrer">
          Share on WhatsApp
        </a>
      </div>
    </div>
  );
}
