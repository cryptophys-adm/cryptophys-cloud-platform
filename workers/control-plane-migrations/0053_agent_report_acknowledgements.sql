-- 0053 (ADR-0009 amendment 2026-11-13): an approver acknowledges a critical agent report as handled.
-- The consensus baseline rejects routine actions while a critical report of the last 24 hours is open.
-- A critical report with a row here is no longer open: it stops counting toward that brake. The report
-- itself is kept as it was. One acknowledgement per report, written by the AI Kernel together with its
-- report.acknowledged audit event; the kernel accepts it only from an approver who is a person, and only
-- for a report of severity critical. Additive only: a new table, nothing existing is changed.
CREATE TABLE IF NOT EXISTS agent_report_acknowledgements (
  report_id TEXT PRIMARY KEY REFERENCES agent_reports(report_id),
  acknowledged_by TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  acknowledged_at TEXT NOT NULL
);
