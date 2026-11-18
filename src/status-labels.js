// Human-readable labels for the per-design status (flag_config.status /
// hole_sign_config.status) — see the state machine in
// supabase/migrations/20260913000000_per_design_status_workflow.sql.
//
// The state machine has six values, but staff/customers only think in five.
// The dividing line for "In Review" is the review link (share_token), not
// who currently holds the ball: `submitted` (customer submitted, staff
// hasn't sent a proof yet) has no link yet, so it groups with `draft` —
// only `proof_sent` (link exists) counts as In Review. `approved` means the
// client has signed off; `sent_to_print` is Completed (handed to print).
// These groups collapse the display (labels, the landing-page filter, pill
// colors) down to those five — every RPC/RLS check elsewhere keeps using
// the granular six.
export const STATUS_GROUPS = {
  draft: { label: 'Draft', statuses: ['draft', 'submitted'] },
  in_review: { label: 'In Review', statuses: ['proof_sent'] },
  needs_edits: { label: 'Revisions', statuses: ['needs_changes'] },
  approved: { label: 'Approved', statuses: ['approved'] },
  completed: { label: 'Completed', statuses: ['sent_to_print'] },
};

export const STATUS_LABEL = Object.fromEntries(
  Object.values(STATUS_GROUPS).flatMap(g => g.statuses.map(s => [s, g.label]))
);

// Email delivery state of the Prestige order email (prestige_orders.delivery_status,
// set by the sendgrid-events webhook). Returns null when there's nothing to show
// (never emailed by the app / pre-tracking orders).
const DELIVERY = {
  pending:   { label: 'Email sending… awaiting delivery confirmation', color: '#b45309', icon: 'fa-clock' },
  deferred:  { label: 'Email delayed — SendGrid is retrying', color: '#b45309', icon: 'fa-clock' },
  delivered: { label: 'Email delivered to Prestige', color: '#2d9d5c', icon: 'fa-circle-check' },
  bounced:   { label: 'Email bounced — Prestige did NOT receive it', color: '#c0392b', icon: 'fa-triangle-exclamation' },
  dropped:   { label: 'Email dropped — Prestige did NOT receive it', color: '#c0392b', icon: 'fa-triangle-exclamation' },
  blocked:   { label: 'Email blocked — Prestige did NOT receive it', color: '#c0392b', icon: 'fa-triangle-exclamation' },
};
export function deliveryLineHtml(order) {
  const d = order && DELIVERY[order.delivery_status];
  if (!d) return null;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const tip = order.delivery_detail ? ` title="${esc(order.delivery_detail)}"` : '';
  return `<span style="color:${d.color}"${tip}><i class="fa-solid ${d.icon}" aria-hidden="true"></i> <strong>${d.label}</strong></span>`;
}
