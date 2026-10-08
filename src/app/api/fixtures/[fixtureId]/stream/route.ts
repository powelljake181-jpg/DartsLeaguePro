import { getDb } from "@/db/client";
import { onFixtureChanged } from "@/server/events";
import { liveSnapshot } from "@/server/live-service";

/**
 * Public: Server-Sent Events. Sends the full snapshot on connect and after every
 * change, plus a heartbeat so proxies keep the connection open. EventSource
 * reconnects by itself after a dropped connection and gets a fresh snapshot.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/fixtures/[fixtureId]/stream">) {
  const { fixtureId } = await ctx.params;
  const db = await getDb();
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      // The viewer can leave at any moment, including while a snapshot is loading:
      // never write to a closed stream.
      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      let sending = Promise.resolve();
      const send = () => {
        // Serialise sends; a burst of changes still ends with the latest snapshot.
        sending = sending.then(async () => {
          if (closed) return;
          try {
            const snap = await liveSnapshot(db, fixtureId);
            write(`id: ${snap.version}\nevent: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
          } catch {
            write(`event: gone\ndata: {}\n\n`);
          }
        });
      };
      const unsubscribe = onFixtureChanged(fixtureId, send);
      const heartbeat = setInterval(() => write(`: ping\n\n`), 25_000);
      cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {}
      };
      request.signal.addEventListener("abort", cleanup);
      write(`retry: 3000\n\n`);
      send();
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
