"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity, ArrowRight, CheckCircle2, Circle, Database, Loader2, RefreshCw, Radio, XCircle,
} from "lucide-react";

import { cn } from "@/lib/utils";

type Health = {
  issues: string[];
  store: {
    mode: "clickhouse" | "openaqi" | "both";
    backend: "clickhouse" | "openaqi";
    ok: boolean;
    error?: string;
    version?: string;
    rows?: number;
    station?: { id: string; name: string; firstReading?: string | null };
    remote?: { station: string; readings: number; lastReading: string | null };
  };
  openaqi: {
    enabled: boolean; dryRun: boolean; sent: number; rejected: number;
    pending: number; lastError: string | null; halted: string | null;
  };
  protect: { ok: boolean; error?: string; sensors?: { id: string; name: string; firmware: string }[] };
  collector: {
    running: boolean; connected: boolean; error: string | null;
    received: number; written: number; pending: number; lastWriteError: string | null;
  };
  auth: { enabled: boolean };
};

export default function OnboardingPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      setHealth(await res.json());
    } catch {
      setHealth(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const envOk = (health?.issues.length ?? 1) === 0;
  const storeOk = health?.store.ok ?? false;
  const mode = health?.store.mode ?? "clickhouse";
  const remote = health?.store.backend === "openaqi";
  const upOk = health?.protect.ok ?? false;
  const flowing = (health?.collector.written ?? 0) > 0 || (health?.collector.received ?? 0) > 0;
  const ready = envOk && storeOk && upOk;

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-5 py-12">
      <div className="mb-8 flex items-center gap-3">
        <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Activity className="size-6" />
        </div>
        <div>
          <h1 className="text-xl font-semibold leading-tight">Set up your air quality dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Everything is configured in <code className="rounded bg-muted px-1">.env</code>. This page
            checks each piece and refreshes itself.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Storage:{" "}
            <span className="font-medium text-foreground">
              {mode === "openaqi"
                ? "openaqi — no local database"
                : mode === "both"
                  ? "ClickHouse, also forwarding to openaqi"
                  : "ClickHouse"}
            </span>
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="ml-auto inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm hover:bg-accent"
        >
          <RefreshCw className={cn("size-4", loading && "animate-spin")} /> Recheck
        </button>
      </div>

      <div className="space-y-3">
        <Step
          n={1}
          icon={<Circle className="size-4" />}
          title="Configuration"
          state={loading ? "pending" : envOk ? "ok" : "fail"}
          summary={envOk ? "All required variables are set" : "Some variables are missing"}
        >
          {/* Only ever the names of missing variables — never their values, and
              never the addresses they point at. This page is public when
              AUTH_ENABLED=false. */}
          {health && health.issues.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {health.issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
        </Step>

        <Step
          n={2}
          icon={<Database className="size-4" />}
          title={remote ? "openaqi" : "ClickHouse"}
          state={loading ? "pending" : storeOk ? "ok" : "fail"}
          summary={
            storeOk
              ? remote
                ? `Station "${health?.store.station?.name}" — ${(health?.store.rows ?? 0).toLocaleString()} readings stored for you`
                : `Connected — v${health?.store.version}, ${(health?.store.rows ?? 0).toLocaleString()} rows stored`
              : (health?.store.error ?? "Not reachable")
          }
        >
          {/* The remediation differs entirely by mode, and telling somebody
              running without a database to check their database credentials is
              how a setup screen wastes an evening. */}
          {!storeOk && remote && (
            <p className="text-sm text-muted-foreground">
              Check <code className="rounded bg-muted px-1">OPENAQI_KEY</code>. It must belong to a
              station registered at openaqi.net. There is no local database in this mode — your
              history is read back from openaqi.
            </p>
          )}
          {!storeOk && !remote && (
            <p className="text-sm text-muted-foreground">
              Check <code className="rounded bg-muted px-1">CLICKHOUSE_URL</code>,{" "}
              <code className="rounded bg-muted px-1">CLICKHOUSE_USER</code> and{" "}
              <code className="rounded bg-muted px-1">CLICKHOUSE_PASSWORD</code>. The table is created
              automatically once the credentials work.
            </p>
          )}
          {storeOk && remote && health?.store.station?.firstReading && (
            <p className="text-sm text-muted-foreground">
              Your record starts {new Date(health.store.station.firstReading).toLocaleString()} —
              readings from before forwarding was switched on are not there.
            </p>
          )}
          {/* Enabled is not the same as arriving. This is the line that would
              have caught a key that never reached the process. */}
          {storeOk && mode === "both" && health?.store.remote && (
            <p className="text-sm text-muted-foreground">
              Also forwarding to openaqi — {health.store.remote.readings.toLocaleString()} readings
              received, last{" "}
              {health.store.remote.lastReading
                ? new Date(health.store.remote.lastReading).toLocaleTimeString()
                : "never"}
              .
            </p>
          )}
          {storeOk && mode === "both" && !health?.store.remote && health?.openaqi.enabled && (
            <p className="text-sm text-(--status-warn)">
              Forwarding is switched on but openaqi has not confirmed any readings yet.
            </p>
          )}
        </Step>

        <Step
          n={3}
          icon={<Radio className="size-4" />}
          title="UniFi Protect"
          state={loading ? "pending" : upOk ? "ok" : "fail"}
          summary={
            upOk
              ? `${health?.protect.sensors?.length ?? 0} air quality sensor(s) found`
              : (health?.protect.error ?? "Not reachable")
          }
        >
          {upOk ? (
            <ul className="space-y-1 text-sm">
              {health?.protect.sensors?.map((s) => (
                <li key={s.id} className="flex items-center gap-2">
                  <CheckCircle2 className="size-3.5 text-(--status-good)" />
                  <span className="font-medium">{s.name}</span>
                  {s.firmware && <span className="text-muted-foreground">firmware {s.firmware}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              Needs a <strong>local</strong> console account without MFA. API keys cannot read air
              quality — the data only exists on Protect&apos;s private API, which requires a login
              session.
            </p>
          )}
        </Step>

        <Step
          n={4}
          icon={<Activity className="size-4" />}
          title="Collector"
          state={loading ? "pending" : flowing ? "ok" : ready ? "pending" : "idle"}
          summary={
            flowing
              ? remote
                ? `${health?.collector.received.toLocaleString()} readings received, ${(health?.openaqi.sent ?? 0).toLocaleString()} forwarded to openaqi`
                : `${health?.collector.received.toLocaleString()} readings received, ${health?.collector.written.toLocaleString()} rows written`
              : ready
                ? "Waiting for the first reading…"
                : "Blocked by the checks above"
          }
        >
          {!remote && health?.collector.lastWriteError && (
            <p className="text-sm text-(--status-warning)">
              Write error: {health.collector.lastWriteError}
            </p>
          )}
          {remote && (health?.openaqi.halted || health?.openaqi.lastError) && (
            <p className="text-sm text-(--status-warning)">
              {health.openaqi.halted ?? health.openaqi.lastError}
            </p>
          )}
          {health?.collector.error && (
            <p className="text-sm text-muted-foreground">{health.collector.error}</p>
          )}
        </Step>
      </div>

      <div className="mt-8 flex items-center gap-3">
        <Link
          href="/"
          className={cn(
            "inline-flex h-10 items-center gap-2 rounded-md px-4 text-sm font-medium",
            ready ? "bg-primary text-primary-foreground" : "pointer-events-none border opacity-50",
          )}
        >
          Open dashboard <ArrowRight className="size-4" />
        </Link>
        {!ready && (
          <p className="text-sm text-muted-foreground">
            Fix the checks above — this page updates on its own.
          </p>
        )}
      </div>
    </main>
  );
}

function Step({
  n, icon, title, summary, state, children,
}: {
  n: number;
  icon: React.ReactNode;
  title: string;
  summary: string;
  state: "ok" | "fail" | "pending" | "idle";
  children?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border p-4">
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
            state === "ok" && "bg-(--status-good)/12 text-(--status-good)",
            state === "fail" && "bg-(--status-critical)/12 text-(--status-critical)",
            (state === "pending" || state === "idle") && "bg-muted text-muted-foreground",
          )}
        >
          {state === "ok" ? (
            <CheckCircle2 className="size-4" />
          ) : state === "fail" ? (
            <XCircle className="size-4" />
          ) : state === "pending" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            icon
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">
            <span className="mr-2 text-muted-foreground">{n}</span>
            {title}
          </h2>
          <p className="text-sm text-muted-foreground">{summary}</p>
          {children && <div className="mt-3">{children}</div>}
        </div>
      </div>
    </section>
  );
}
