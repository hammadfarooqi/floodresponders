import { watch } from "node:fs";
import { LAYERS_DIR } from "../../layersDir";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Server-sent events: tells the open page which layer files changed, so it can reload only those.
export async function GET(req: Request) {
  const enc = new TextEncoder();
  let close = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const pending = new Set<string>();
      let timer: NodeJS.Timeout | null = null;
      const watcher = watch(LAYERS_DIR, (_evt, file) => {
        if (!file || file.endsWith(".tmp")) return;
        pending.add(String(file));
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { send({ type: "change", files: [...pending] }); pending.clear(); }, 400);
      });
      const beat = setInterval(() => controller.enqueue(enc.encode(": ping\n\n")), 15000);
      send({ type: "hello" });
      close = () => { watcher.close(); clearInterval(beat); if (timer) clearTimeout(timer); };
      req.signal.addEventListener("abort", () => { close(); try { controller.close(); } catch {} });
    },
    cancel() { close(); },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" },
  });
}
