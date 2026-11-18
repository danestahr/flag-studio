-- Pipedrive stage map: allow a 'not_started' studio status.
--
-- Not a flag_config/hole_sign_config.status value - it means the design has no config row
-- yet (project exists, nobody has started designing). The `pipedrive` edge function treats
-- "no design row" as 'not_started' when looking up the mapped stage. Only
-- pipedrive_stage_map restricts studio_status; pipedrive_sync_log.studio_status is free text.
alter table public.pipedrive_stage_map drop constraint if exists pipedrive_stage_map_studio_status_check;
alter table public.pipedrive_stage_map add constraint pipedrive_stage_map_studio_status_check
  check (studio_status in ('not_started','draft','submitted','needs_changes','proof_sent','approved','sent_to_print'));
