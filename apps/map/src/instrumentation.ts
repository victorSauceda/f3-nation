import type { Instrumentation } from "next";

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
    // Strip the query string before reporting — it can carry emails, tokens, or
    // other PII. The pathname alone is enough to triage the error.
    const path = request.path.split("?")[0];
    await captureServerException(err, {
      path,
      method: request.method,
    });
  }
};
