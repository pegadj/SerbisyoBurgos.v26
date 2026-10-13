-- Tighten FAQ keywords so overly generic tokens (e.g. "request") do not dominate retrieval.
update public.faq_entries
set keywords = array['submit', 'service', 'online', 'apply', 'portal']
where category = 'service_request'
  and question ilike '%submit a service request%';
