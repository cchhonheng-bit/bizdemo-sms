-- D-192 (client 29-10): a catalog item's website price can be exact — «$15» instead of «ចាប់ពី $15» (AC cleaning by machine type).
-- The invoice keeps using the item's own price as before. Forward-only, additive. ASCII only.
alter table catalog_items add column if not exists price_fixed boolean not null default false;
