// Human-readable labels for projects.status — see the state machine in
// supabase/migrations/20260820120000_project_status_workflow.sql.
export const STATUS_LABEL = {
  draft: 'Draft',
  submitted: 'Submitted for review',
  needs_changes: 'Changes requested',
  proof_sent: 'Proof sent — awaiting client',
  approved: 'Approved',
  sent_to_print: 'Sent to print',
};
