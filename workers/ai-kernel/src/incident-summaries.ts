// Post-incident summaries for the Owner page's Incidents panel (owner 2026-11-19, "ya, buatkan setelah tiga perbaikan
// masuk"). Written by the engineering session after an incident is resolved, reviewed like any change: a summary is a
// merge, never a database write. Keyed by the incident id incidents.ts derives (inc_<report_id> or inc_<request_id>).
// Plain English, no secrets, no email addresses.

export interface IncidentSummary {
  cause: string;
  impact: string;
  fix: string;
  lessons: string[];
  written_by: string;
  written_at: string;
}

export const INCIDENT_SUMMARIES: Readonly<Record<string, IncidentSummary>> = {
  "inc_rpt_60582ed1-8491-478c-b407-bac5f851258f": {
    cause:
      "The native deploy of the Control Plane at bf94be1 (dep_01b18773, 2026-11-18 21:57 UTC) applied D1 migration 0082 and put the AI Kernel's " +
      "Durable Object migration v8 to v9 live, then read the script's migration tag too early (still v8) and failed with do_migration_tag_not_applied. " +
      "Cloudflare refuses a rollback across a Durable Object migration, so the AI Kernel, the Drift Detector and the Policy Engine kept running bf94be1, " +
      "while the registry kept 35954c3 for them. Every later plan compared the target with a version that no longer ran: the native deploy refused " +
      "d1_migrations_mismatch, the GitHub fallback refused github_main_not_mirrored, and the break-glass plan refused binding_set_outside_config (HUB).",
    impact:
      "No data was lost and no trading or funds were touched. For about 7.5 hours the Control Plane could not be deployed: three Workers ran a version " +
      "the registry did not record (persistent drift on the Owner page), the migration 0083 and the fixes that followed waited, and the deploys of the " +
      "other units were held behind the Control Plane's migration.",
    fix:
      "The owner allowed GitHub main to be fast-forwarded to canonical main; the Supervisor's deploy of 47ee2d5 then ran through deploy-control-plane.yml " +
      "(dep_61634e20, 2026-11-19 05:23 to 05:27 UTC), applied 0083, deployed all six Workers and recorded their desired versions; the drift cleared at 05:30. " +
      "Code fixes merged the same morning: the migration tag is read up to 8 times before failing (topology.ts), the native plan accepts a D1 ledger that is " +
      "ahead of the running list (ledgerAhead), the registry records the commit for Workers a failed deploy could not restore (recordNotRestored), and a " +
      "deploy refused on every path is on the Owner page at once (deploy_no_path).",
    lessons: [
      "A failed deploy that cannot restore must leave the registry describing what runs, or every later plan reasons from a false state.",
      "A fix inside the Deployment Orchestrator cannot ship before the Control Plane when main carries a migration its code reads; keep a one-time unblock (GitHub mirror or break-glass) ready.",
      "A deploy refused on every path is an owner item at once, not after the 2-hour stall alarm.",
      "The runbook is docs/OPERATIONS.md, \"Deploy with no path\".",
    ],
    written_by: "engineering session",
    written_at: "2026-11-19T07:00:00Z",
  },
};
