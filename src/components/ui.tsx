import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

/** Small, consistent building blocks. Server-safe (no hooks). */

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export function Page({ children, narrow }: { children: ReactNode; narrow?: boolean }) {
  return <main className={cx("mx-auto w-full px-4 py-6 sm:py-8", narrow ? "max-w-md" : "max-w-4xl")}>{children}</main>;
}

export function PageHeader({ title, subtitle, back, actions }: { title: string; subtitle?: ReactNode; back?: { href: string; label: string }; actions?: ReactNode }) {
  return (
    <header className="mb-6">
      {back && (
        <Link href={back.href} className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-foreground">
          <span aria-hidden>‹</span> {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
          {subtitle && <p className="mt-1 text-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function Card({ title, description, children, actions, className }: { title?: string; description?: ReactNode; children?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-xl border border-border bg-surface p-4 shadow-sm sm:p-5", className)}>
      {(title || actions) && (
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-lg font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

const buttonBase =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";
export const buttonStyles = {
  primary: cx(buttonBase, "bg-accent text-on-accent hover:bg-accent-strong"),
  secondary: cx(buttonBase, "border border-border bg-surface text-foreground hover:bg-surface-muted"),
  danger: cx(buttonBase, "border border-danger/40 bg-surface text-danger hover:bg-danger-soft"),
  ghost: cx(buttonBase, "text-muted hover:bg-surface-muted hover:text-foreground"),
};

export function Button({ variant = "primary", className, ...props }: ComponentProps<"button"> & { variant?: keyof typeof buttonStyles }) {
  return <button className={cx(buttonStyles[variant], className)} {...props} />;
}

export function LinkButton({ variant = "primary", className, ...props }: ComponentProps<typeof Link> & { variant?: keyof typeof buttonStyles }) {
  return <Link className={cx(buttonStyles[variant], className)} {...props} />;
}

export const inputStyles =
  "block min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-base text-foreground placeholder:text-muted/70 focus:border-accent focus:outline-2 focus:outline-accent/30";

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cx(inputStyles, className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cx(inputStyles, "pr-8", className)} {...props} />;
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "warning" | "danger" | "live" }) {
  const tones = {
    neutral: "bg-surface-muted text-muted",
    accent: "bg-accent-soft text-accent-strong",
    warning: "bg-warning-soft text-warning",
    danger: "bg-danger-soft text-danger",
    live: "bg-live text-white",
  };
  return <span className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold", tones[tone])}>{children}</span>;
}

export function Notice({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "warning" | "danger" | "accent" }) {
  const tones = {
    neutral: "border-border bg-surface-muted",
    warning: "border-warning/30 bg-warning-soft",
    danger: "border-danger/30 bg-danger-soft",
    accent: "border-accent/30 bg-accent-soft",
  };
  return <div className={cx("rounded-lg border px-3 py-2.5 text-sm", tones[tone])}>{children}</div>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted">{children}</p>;
}

/** A tappable row in a list. */
export function RowLink({ href, title, meta, right }: { href: string; title: ReactNode; meta?: ReactNode; right?: ReactNode }) {
  return (
    <Link href={href} className="flex min-h-14 items-center justify-between gap-3 rounded-lg px-3 py-2.5 hover:bg-surface-muted">
      <div className="min-w-0">
        <div className="truncate font-medium">{title}</div>
        {meta && <div className="truncate text-sm text-muted">{meta}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2 text-muted">
        {right}
        <span aria-hidden>›</span>
      </div>
    </Link>
  );
}

export function List({ children }: { children: ReactNode }) {
  return <div className="-mx-1 divide-y divide-border">{children}</div>;
}

export function formatDate(d: Date | string | null, tz = "Europe/London", opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }) {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(`${d}T12:00:00Z`) : d;
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts }).format(date);
}
