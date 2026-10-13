-- FAQs for resident chatbot: keyword/database lookup + optional Grok rewrite
create table if not exists public.faq_entries (
  id bigint generated always as identity primary key,
  category text not null
    check (category in ('service_request', 'document', 'general')),
  question text not null,
  answer text not null,
  keywords text[] not null default '{}',
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_faq_entries_category_active_sort
  on public.faq_entries (category, is_active, sort_order);

create index if not exists idx_faq_entries_keywords
  on public.faq_entries using gin (keywords);

drop trigger if exists faq_entries_set_updated_at on public.faq_entries;
create trigger faq_entries_set_updated_at
before update on public.faq_entries
for each row
execute function public.set_updated_at();

alter table public.faq_entries disable row level security;

-- Starter FAQs (runs once when migration is applied; replace copy with barangay-official wording as needed)
insert into public.faq_entries (category, question, answer, keywords, sort_order)
select * from (values
  (
    'service_request'::text,
    'How do I submit a service request?'::text,
    'Log in to the resident portal, open Service Requests, choose the service type, fill in the details, attach any required files, and submit. You will see a reference number and status updates in Request History.'::text,
    array['request', 'submit', 'service', 'online', 'how', 'apply']::text[],
    1
  ),
  (
    'service_request',
    'How long does processing take?',
    'Processing time depends on the service. Many barangay services are completed within 1–2 business days; some may be same-day. The service catalog in the portal lists typical processing times per service.',
    array['processing', 'time', 'how long', 'days', 'duration', 'wait'],
    2
  ),
  (
    'document',
    'What do I need for Barangay Clearance?',
    'Bring or upload a valid government-issued ID and a community tax certificate (cedula) when required. Staff may ask for proof of residency. Exact requirements can vary; check the service details in the portal before submitting.',
    array['clearance', 'barangay clearance', 'cedula', 'valid id', 'requirements', 'documents'],
    3
  ),
  (
    'document',
    'What do I need for a Certificate of Indigency?',
    'Prepare a valid ID and any proof of residence or situation the barangay requires for assessment. Submit through the portal or follow staff instructions. Final requirements are confirmed when your request is reviewed.',
    array['indigency', 'certificate', 'poor', 'requirements', 'documents', 'id'],
    4
  ),
  (
    'general',
    'Where can I see updates about my request?',
    'After logging in, use Request History for status and notes. Important barangay notices may also appear on the resident bulletin.',
    array['status', 'track', 'history', 'update', 'where', 'follow up'],
    5
  ),
  (
    'general',
    'Who can I contact if I need help?',
    'Visit the barangay hall during office hours or use the contact information posted on the official barangay page. For portal account issues, use the support channel provided by your barangay IT or admin.',
    array['contact', 'help', 'office', 'barangay hall', 'support'],
    6
  )
) as v(category, question, answer, keywords, sort_order)
where not exists (select 1 from public.faq_entries limit 1);
