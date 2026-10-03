-- =====================================================================
-- 0003_customer_bot.sql - customer bot, final combined brief (D-106 ...)
--  * hub_consent_log.source: where the customer agreed (bot button, website button, Mini App, customer home settings)
--  * hub_broadcasts.valid_until: a promotion is "active" (shown by the bot's promotion button) until this day
--  * hub_outbox.markup: the inline button a promotion carries ("stop promotions")
-- Forward-only, additive. ASCII only.
-- =====================================================================
alter table hub_consent_log add column if not exists source text check (source in ('bot', 'web', 'miniapp', 'site'));
alter table hub_broadcasts add column if not exists valid_until date;
alter table hub_outbox add column if not exists markup jsonb;
