-- Replace FAQ content with English FAQs (resident chatbot)
delete from public.faq_entries;

insert into public.faq_entries (category, question, answer, keywords, sort_order)
values
  (
    'general',
    'What time is the barangay hall open?',
    'Monday to Friday, 9:00 AM to 5:00 PM.',
    ARRAY[
      'open',
      'hours',
      'office hours',
      'schedule',
      'time',
      'barangay hall',
      'mon',
      'fri',
      'monday',
      'friday',
      '9am',
      '5pm'
    ]::text[],
    1
  ),
  (
    'service_request',
    'What requests/services can I do? (Please list all possible requests residents can make.)',
    'Issuance of certifications, Barangay Clearances, Barangay Indigency, Barangay Residency, and Cedula.',
    ARRAY[
      'services',
      'requests',
      'list',
      'certifications',
      'clearance',
      'indigency',
      'residency',
      'cedula',
      'sedula'
    ]::text[],
    2
  ),
  (
    'general',
    'Is there a fee to request services? How much is it?',
    'Yes. The fee is 100.',
    ARRAY[
      'fee',
      'price',
      'cost',
      'how much',
      '100',
      'payment'
    ]::text[],
    3
  ),
  (
    'service_request',
    'How do I track my request? / How will I know if my request is done?',
    'Go to your \"Service Requests\" dashboard. There, you will see the \"Status\" column and you will be able to track your service request.',
    ARRAY[
      'track',
      'status',
      'progress',
      'done',
      'service requests',
      'dashboard'
    ]::text[],
    4
  ),
  (
    'service_request',
    'How do I cancel the request I made?',
    'Click the specific request in your \"Recent Service Requests\" or go to the \"Service Requests\" dashboard. You will see the \"Actions\" column. If the status is still Pending or Request for Revisions, you will see a delete option in the \"Actions\" column. If the request has another status, you must contact the staff directly.',
    ARRAY[
      'cancel',
      'delete',
      'remove',
      'actions',
      'pending',
      'request for revisions'
    ]::text[],
    5
  ),
  (
    'service_request',
    'How can I view my previous requests? / What if I want to repeat a previous request?',
    'By clicking on the \"Request History\" dashboard, you can access your previous services and request again.',
    ARRAY[
      'history',
      'previous',
      'repeat',
      'request again',
      'request history'
    ]::text[],
    6
  );
