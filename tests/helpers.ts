import { buildApp } from "../src/app.js";

export type App = Awaited<ReturnType<typeof buildApp>>;

export async function createApp(): Promise<App> {
  const app = await buildApp({ logger: false });
  await app.ready();
  return app;
}

export async function createAccount(app: App, name = "test", planId?: number) {
  const res = await app.inject({ method: "POST", url: "/accounts", payload: { name, planId } });
  return res.json() as { id: number; name: string; planId: number; apiKey: string };
}

// Small client bound to one API key
export function api(app: App, apiKey: string) {
  const headers = { "x-api-key": apiKey };
  return {
    get: (url: string) => app.inject({ method: "GET", url, headers }),
    post: (url: string, payload?: object) => app.inject({ method: "POST", url, payload, headers }),
    put: (url: string, payload?: object) => app.inject({ method: "PUT", url, payload, headers }),
  };
}
