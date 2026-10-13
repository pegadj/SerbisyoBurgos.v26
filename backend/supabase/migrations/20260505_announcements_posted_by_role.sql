-- Track which portal role posted each announcement so residents can filter admin bulletins separately.
alter table public.community_announcements
  add column if not exists posted_by_role text;

-- Existing rows predated attribution; bulletin copy previously described admin-posted content.
update public.community_announcements
set posted_by_role = 'admin'
where posted_by_role is null;
