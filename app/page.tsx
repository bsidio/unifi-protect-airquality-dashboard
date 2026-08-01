import { redirect } from "next/navigation";

import { Dashboard } from "@/components/dashboard";
import { ensureCollector } from "@/lib/ensure";
import { configIssues, env } from "@/lib/env";

export const dynamic = "force-dynamic";

export default function Page() {
  // A misconfigured install should land on onboarding, not a broken dashboard.
  if (configIssues().length > 0) redirect("/onboarding");
  ensureCollector();
  return <Dashboard appName={env.appName} authEnabled={env.auth.enabled} />;
}
