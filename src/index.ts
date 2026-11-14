import {
  errorMessage,
  getStatus,
  runMinter,
  type RunReport,
} from "./circularity";

function summarize(report: RunReport): string {
  return (["burn", "mint"] as const)
    .map((step) => {
      const result = report[step];
      return result.status === "failed"
        ? `${step} failed: ${result.error}`
        : `${step} ${result.status}`;
    })
    .join("; ");
}

// Compares hashes so the check takes the same time however much of the token
// matches
async function isAuthorized(request: Request, token: string): Promise<boolean> {
  if (!token) return false;
  const encoder = new TextEncoder();
  const [given, expected] = await Promise.all([
    crypto.subtle.digest(
      "SHA-256",
      encoder.encode(request.headers.get("Authorization") ?? ""),
    ),
    crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${token}`)),
  ]);
  return crypto.subtle.timingSafeEqual(given, expected);
}

export default {
  // Runs at 1 AM UTC on the first of every month (see wrangler.jsonc)
  async scheduled(_controller, env) {
    const report = await runMinter(env);
    console.log(JSON.stringify(report));
    // Throwing marks the invocation as failed in the Cron Events dashboard
    if (!report.ok) throw new Error(summarize(report));
  },

  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    try {
      // Read-only view of the contracts and the minter wallet
      if (pathname === "/" && request.method === "GET") {
        return Response.json(await getStatus(env));
      }

      // Manual trigger, e.g. to catch up without waiting for the next cron.
      // Keep the connection open until it responds: it waits for receipts.
      if (pathname === "/run" && request.method === "POST") {
        if (!(await isAuthorized(request, env.RUN_TOKEN))) {
          return new Response("Unauthorized\n", { status: 401 });
        }
        const report = await runMinter(env);
        console.log(JSON.stringify(report));
        return Response.json(report, { status: report.ok ? 200 : 500 });
      }

      return new Response("Not found\n", { status: 404 });
    } catch (error) {
      const message = errorMessage(error, env.RPC_URL);
      console.error(message);
      return Response.json({ error: message }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
