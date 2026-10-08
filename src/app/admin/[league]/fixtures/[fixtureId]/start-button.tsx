"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Notice } from "@/components/ui";
import { startMatchAction } from "@/app/admin/actions";

export function StartMatchButton({ fixtureId }: { fixtureId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-2">
      <Button
        type="button"
        className="w-full sm:w-auto"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await startMatchAction(fixtureId);
            if (!r.ok) setError(r.error);
            else router.push(`/score/${fixtureId}`);
          })
        }
      >
        {pending ? "Starting…" : "Start match and score"}
      </Button>
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}
