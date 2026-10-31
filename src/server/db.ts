import { createClient } from "@supabase/supabase-js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Tell every phone that something changed. If this fails, phones catch up on their backup
// check within a few seconds, so a failure here must never fail the admin's action.
export async function signalChanged(version: string): Promise<void> {
  try {
    await fetch(`${required("SUPABASE_URL")}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: required("SUPABASE_SERVICE_ROLE_KEY"),
        Authorization: `Bearer ${required("SUPABASE_SERVICE_ROLE_KEY")}`,
      },
      body: JSON.stringify({
        messages: [{ topic: "fake-it", event: "changed", payload: { v: version }, private: false }],
      }),
      signal: AbortSignal.timeout(2000),
    });
  } catch (error) {
    console.error("signal failed", error);
  }
}
