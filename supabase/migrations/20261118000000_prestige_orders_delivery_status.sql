-- Email delivery state of the Prestige order email, driven by the SendGrid
-- Event Webhook (sendgrid-events). SendGrid returns 202 on acceptance, so
-- sent_at alone can't tell "delivered" from "bounced".
--   null       -> never emailed by the app (prepared page / sent manually)
--   pending    -> accepted by SendGrid, no delivery event yet
--   deferred   -> temporary failure, SendGrid is retrying
--   delivered  -> recipient server accepted it
--   bounced / dropped / blocked -> not delivered (detail holds the reason)
alter table public.prestige_orders
  add column delivery_status text
    check (delivery_status in ('pending','deferred','delivered','bounced','dropped','blocked')),
  add column delivery_detail text,
  add column delivery_updated_at timestamptz;

-- Existing emailed orders have no tracked outcome; leave them null (unknown).
