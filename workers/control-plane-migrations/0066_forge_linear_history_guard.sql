-- 0066 (owner-approved hardening (a), incident 2026-11-14): the Forge's linear-history guard.
-- Change-request branches were updated by merging main into them with main as the SECOND parent. The Forge merges by
-- fast-forwarding main to the request's head, so main's first-parent chain left main's own previous heads: the deployed
-- versions fell off main's first-parent history, the deploy planner stopped planning and every deploy stuck.
-- history_blocked_reason is set when a head contains canonical main only through a second parent
-- ('main_not_first_parent'): its verdict is blocked, it is not checked and it is never proposed for merge, until the
-- branch is rebased or merged with main as the first parent. NULL otherwise. blocked_reason (0052) keeps its meaning
-- (not_based_on_main); a new column instead of a new value there, because widening 0052's CHECK would rebuild the table,
-- which the native migration path refuses as destructive. Additive: every existing row reads NULL.
ALTER TABLE forge_change_requests ADD COLUMN history_blocked_reason TEXT CHECK (history_blocked_reason IS NULL OR history_blocked_reason IN ('main_not_first_parent'));
