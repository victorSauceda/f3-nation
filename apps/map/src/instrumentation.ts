import type { Instrumentation } from "next";

// Reduce a request path to a low-cardinality route template before reporting:
// drop the query string and replace dynamic segments (numeric ids, uuids, long
// hashes, email-shaped) with placeholders, so no tokens or PII reach PostHog
// while the route shape stays useful for triage.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function safePath(rawPath: string): string {
  return rawPath
    .split("?")[0]
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      if (seg.includes("@")) return ":email";
      if (UUID.test(seg)) return ":uuid";
      if (/^[0-9a-f]{16,}$/i.test(seg)) return ":hash";
      if (/^\d+$/.test(seg)) return ":id";
      return seg;
    })
    .join("/");
}

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerPostHogErrorReporter } = await import("./posthog-server");
    registerPostHogErrorReporter();
    await import("./orpc/client.server");
  }
}

// Report uncaught server-side request errors to PostHog error tracking.
export const onRequestError: Instrumentation.onRequestError = async (
  err,
  request,
) => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { captureServerException } = await import("./posthog-server");
    await captureServerException(err, {
      path: safePath(request.path),
      method: request.method,
    });
  }
};
