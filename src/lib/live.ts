"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import type { LiveState } from "./types";

const BACKUP_CHECK_MS = 4000;

function withSpread(ms: number): number {
  return ms * (0.7 + Math.random() * 0.6);
}

// The live question: a Realtime signal says something changed, and a backup check catches
// any phone that missed it. A failed check waits longer each time, at a random moment,
// so an outage never turns into a storm of retries.
export function useLive() {
  const [live, setLive] = useState<LiveState | null>(null);
  const [connected, setConnected] = useState(true);
  const [clockOffset, setClockOffset] = useState(0);
  const lastVersion = useRef<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    async function fetchLive(version?: string): Promise<void> {
      const response = await fetch(version ? `/api/live?v=${encodeURIComponent(version)}` : "/api/live");
      if (!response.ok) throw new Error(`live ${response.status}`);
      const state = (await response.json()) as LiveState;
      if (stopped) return;
      setConnected(true);
      failures = 0;
      if (state.v !== lastVersion.current) {
        lastVersion.current = state.v;
        setLive(state);
      }
    }

    async function backupCheck(): Promise<void> {
      try {
        await fetchLive();
      } catch {
        failures += 1;
        if (!stopped) setConnected(false);
      }
      if (stopped) return;
      const wait = failures === 0 ? BACKUP_CHECK_MS : Math.min(4000 * 2 ** failures, 30000);
      timer = setTimeout(backupCheck, withSpread(wait));
    }

    async function syncClock(): Promise<void> {
      try {
        const sent = Date.now();
        const response = await fetch("/api/time");
        const { now } = (await response.json()) as { now: number };
        const received = Date.now();
        if (!stopped) setClockOffset(now - (sent + received) / 2);
      } catch {
        // The countdown then runs on the phone's clock. Scoring never uses it.
      }
    }

    void syncClock();
    void backupCheck();

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const supabase = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
    const channel = supabase
      ?.channel("fake-it")
      .on("broadcast", { event: "changed" }, ({ payload }) => {
        const version = typeof payload?.v === "string" ? payload.v : undefined;
        if (version !== lastVersion.current) fetchLive(version).catch(() => setConnected(false));
      })
      .subscribe();

    return () => {
      stopped = true;
      clearTimeout(timer);
      if (channel) void supabase?.removeChannel(channel);
    };
  }, []);

  return { live, connected, clockOffset };
}

// Seconds on the countdown, recalculated a few times a second.
export function useCountdown(deadlineAt: string | null, clockOffset: number): number {
  const [remainingMs, setRemainingMs] = useState(0);

  useEffect(() => {
    if (!deadlineAt) {
      setRemainingMs(0);
      return;
    }
    const deadline = Date.parse(deadlineAt);
    const tick = () => setRemainingMs(Math.max(0, deadline - (Date.now() + clockOffset)));
    tick();
    const interval = setInterval(tick, 100);
    return () => clearInterval(interval);
  }, [deadlineAt, clockOffset]);

  return Math.ceil(remainingMs / 1000);
}
