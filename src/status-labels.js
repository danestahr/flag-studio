// Human-readable labels for the per-design status (flag_config.status /
// hole_sign_config.status) — see the state machine in
// supabase/migrations/20260913000000_per_design_status_workflow.sql.
//
// The state machine has six values, but staff/customers only think in four.
// The dividing line for "In Review" is the review link (share_token), not
// who currently holds the ball: `submitted` (customer submitted, staff
// hasn't sent a proof yet) has no link yet, so it groups with `draft` —
// only `proof_sent` (link exists) counts as In Review. `approved` and
// `sent_to_print` both mean the client has signed off (Approved). These
// groups collapse the display (labels, the landing-page filter, pill
// colors) down to those four — every RPC/RLS check elsewhere keeps using
// the granular six.
export const STATUS_GROUPS = {
  draft: { label: 'Draft', statuses: ['draft', 'submitted'] },
  in_review: { label: 'In Review', statuses: ['proof_sent'] },
  needs_edits: { label: 'Revisions', statuses: ['needs_changes'] },
  approved: { label: 'Approved', statuses: ['approved', 'sent_to_print'] },
};

export const STATUS_LABEL = Object.fromEntries(
  Object.values(STATUS_GROUPS).flatMap(g => g.statuses.map(s => [s, g.label]))
);
