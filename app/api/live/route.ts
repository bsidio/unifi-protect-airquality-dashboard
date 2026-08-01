import { collectorStatus, latestReadings, subscribe } from "@/lib/collector";
import { ensureCollector } from "@/lib/ensure";

export const dynamic = "force-dynamic";

/** Server-sent events: every reading the collector receives, as it arrives. */
export async function GET(req: Request) {
  ensureCollector();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* client went away mid-write */
        }
      };

      send("status", collectorStatus());
      for (const r of latestReadings()) send("reading", r);

      const unsubscribe = subscribe((r) => send("reading", r));
      const heartbeat = setInterval(() => send("status", collectorStatus()), 10_000);

      const close = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", close, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
