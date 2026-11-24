/**
 * Adds chatbot FAQ entries about how the SerbisyoBurgos portal works, with English + Tagalog keywords.
 *
 * Safe to re-run: an entry is added only if no FAQ with the same question exists, and existing entries
 * (including ones the barangay edited) are never overwritten.
 *
 * Fees, office hours, contact number, services, required documents and processing times are NOT stored here:
 * the chatbot reads those live from the Admin settings and Service Catalog, so they never go out of date.
 *
 * Usage:  node scripts/seed-chatbot-faq.js
 */
require('dotenv').config();
const { connectPg, pool } = require('../src/config/pgClient');
const { FaqEntry } = require('../src/models/FaqEntry');

const ENTRIES = [
  {
    category: 'general',
    question: 'How do I get an account and log in? / Paano magkaroon ng account at mag-login?',
    answer: 'Residents do not sign up online. Visit the barangay hall and the Barangay Secretary will record you and give you a Resident ID (like SB-00001) and a temporary password. Log in with your Resident ID (or email) and password. You will be asked to change the temporary password the first time you log in.',
    keywords: ['account', 'create account', 'sign up', 'register', 'resident id', 'login', 'log in', 'gumawa ng account', 'magkaroon ng account', 'mag-register', 'magrehistro', 'paano mag login', 'paano magkaka account', 'saan kukuha ng account'],
  },
  {
    category: 'general',
    question: 'I forgot my password. What do I do? / Nakalimutan ko ang password ko.',
    answer: 'On the login page, choose "Forgot password?" and enter your Resident ID or email. We will text a 6-digit code to the mobile number the barangay has on file for you (valid for 10 minutes). Enter the code and choose a new password with at least 8 characters. If you have no mobile number on file, no code arrives, or the text option is not available, please visit the barangay hall. The Barangay Secretary can reset your password and give you a temporary one that you must change when you log in.',
    keywords: ['forgot password', 'forgot', 'reset password', 'reset', 'lost password', 'nakalimutan', 'nakalimutan ang password', 'nalimutan', 'nalimutan ang password', 'password', 'di ko alam password', 'walang code', 'verification code', 'code'],
  },
  {
    category: 'general',
    question: 'Why can\'t I log in? / Bakit hindi ako makapag-login?',
    answer: 'Check that you typed your Resident ID (or email) and password correctly. Too many wrong passwords will temporarily lock your account. If you forgot your password, choose "Forgot password?" on the login page. If you still cannot log in, visit or contact the barangay office.',
    keywords: ['cannot login', "can't login", 'cant login', 'login', 'log in', 'locked', 'wrong password', 'invalid', 'hindi makalogin', 'di makalogin', 'hindi ako makapasok', 'ayaw mag login', 'incorrect password'],
  },
  {
    category: 'general',
    question: 'How do I change my password? / Paano palitan ang password?',
    answer: 'After logging in, open your profile and choose the option to change your password. Enter your current password and then your new password.',
    keywords: ['password', 'change password', 'palitan ang password', 'palitan password', 'baguhin password', 'profile'],
  },
  {
    category: 'service_request',
    question: 'How do I submit a service request? / Paano mag-request ng serbisyo o dokumento?',
    answer: 'Log in and open "Service Requests". Choose the service, pick your preferred date and time slot, add a purpose if you like, attach the required documents, and submit. You will get a reference number for your request.',
    keywords: ['request', 'submit', 'apply', 'how to request', 'mag-request', 'magrequest', 'humingi', 'kumuha ng clearance', 'service requests', 'mag apply'],
  },
  {
    category: 'service_request',
    question: 'What documents do I need to attach? / Anong requirements ang kailangan?',
    answer: 'The required documents depend on the service. When you choose a service in "Service Requests", the required documents for that service are shown so you know what to attach.',
    keywords: ['requirements', 'required documents', 'documents', 'attach', 'kailangan', 'requirements ng', 'ano ang kailangan', 'ipasa', 'i-attach'],
  },
  {
    category: 'service_request',
    question: 'What do the request statuses mean? / Ano ang ibig sabihin ng status?',
    answer: 'Pending: waiting for the barangay staff. Processing or In Progress: staff is working on it. Approved: your request was approved. Revision Requested: staff asked you to fix something, so check your request and resubmit. Ready for Pickup: your document is ready at the barangay hall. Completed: finished. Rejected or Cancelled: the request will not continue.',
    keywords: ['status', 'pending', 'processing', 'in progress', 'approved', 'ready for pickup', 'completed', 'rejected', 'revision requested', 'revision', 'ibig sabihin', 'meaning'],
  },
  {
    category: 'general',
    question: 'How do I book an appointment? / Paano mag-book ng appointment?',
    answer: 'Open "Appointments" and choose "Schedule Appointment". Pick the purpose, the date and an available time slot. Each time slot has a limited number of places, so choose another slot if one is full.',
    keywords: ['appointment', 'book', 'schedule', 'slot', 'time slot', 'mag-book', 'magbook', 'iskedyul', 'pickup', 'pick up', 'kunin', 'schedule appointment'],
  },
  {
    category: 'general',
    question: 'How do I cancel an appointment? / Paano i-cancel ang appointment?',
    answer: 'Open "Appointments", find your appointment, and choose "Cancel Appointment". Your time slot will be released for other residents.',
    keywords: ['cancel appointment', 'cancel', 'appointment', 'i-cancel', 'kanselahin', 'ipa-cancel', 'ikansela'],
  },
  {
    category: 'general',
    question: 'Where can I see barangay announcements and notifications? / Saan makikita ang announcements?',
    answer: 'Open the "Bulletin Board" in your resident menu to see barangay announcements and notifications about your requests and appointments.',
    keywords: ['announcement', 'announcements', 'bulletin board', 'bulletin', 'notification', 'notifications', 'balita', 'abiso', 'programa'],
  },
  {
    category: 'general',
    question: 'Will I receive SMS updates? / Makakatanggap ba ako ng text?',
    answer: 'You will see updates in the portal on your "Bulletin Board". The barangay may also send SMS updates to your registered mobile number. SMS may be limited while the system is still being piloted.',
    keywords: ['sms', 'text', 'text message', 'mobile number', 'notify', 'notified', 'makatanggap', 'mag-text'],
  },
  {
    category: 'general',
    question: 'Can I pay online? How do I pay the fee? / Paano magbayad?',
    answer: 'There is no online payment in the portal. Fees are paid in person at the barangay hall.',
    keywords: ['pay', 'payment', 'online payment', 'gcash', 'bayad', 'magbayad', 'paano magbayad', 'fee'],
  },
  {
    category: 'general',
    question: 'How do I install SerbisyoBurgos on my phone? / Paano i-install ang app?',
    answer: 'On Android (Chrome or Edge), use the "Install app" button or the browser menu and choose Install. On iPhone or iPad, open the portal in Safari, tap the Share button, then choose "Add to Home Screen".',
    keywords: ['install', 'app', 'download', 'home screen', 'phone', 'pwa', 'iphone', 'android', 'i-install', 'idownload', 'mag install'],
  },
  {
    category: 'general',
    question: 'Is my personal information safe? / Ligtas ba ang aking personal na impormasyon?',
    answer: 'Your personal information and uploaded ID are handled under the Data Privacy Act of 2012 (RA 10173) and can be seen only by authorized barangay personnel.',
    keywords: ['privacy', 'safe', 'secure', 'personal information', 'data', 'id', 'ligtas', 'datos', 'impormasyon', 'data privacy'],
  },
  {
    category: 'general',
    question: 'What can the SB Assistant help me with? / Ano ang maitutulong ng SB Assistant?',
    answer: 'I can help with SerbisyoBurgos and Barangay Burgos services: how to register and log in, how to request documents, required documents, fees, processing times, appointments, tracking your request, and office hours. I cannot see your personal account or requests.',
    keywords: ['help', 'what can you do', 'who are you', 'ano kaya mo', 'tulong', 'maitutulong', 'assistant', 'sb ai'],
  },
];

// Entries from an earlier version of this script that described online sign-up (not how this barangay works).
const RETIRED_QUESTIONS = [
  'How do I create an account? / Paano gumawa ng account?',
  "Why can't I log in after registering? / Bakit hindi ako makapag-login?",
];

async function main() {
  await connectPg();

  const retired = await FaqEntry.deleteMany({ question: { $in: RETIRED_QUESTIONS } });
  if (retired.deletedCount) console.log(`  removed ${retired.deletedCount} outdated sign-up FAQ entr${retired.deletedCount === 1 ? 'y' : 'ies'}`);

  // The portal's status is "Revision Requested"; older FAQ text said "Request for Revisions".
  const stale = await FaqEntry.find({ $or: [{ answer: /Request for Revisions/i }, { keywords: /request for revisions/i }] });
  for (const f of stale) {
    f.answer = f.answer.replace(/Request for Revisions/gi, 'Revision Requested');
    f.keywords = (f.keywords || []).map((k) => k.replace(/request for revisions/gi, 'revision requested'));
    await f.save();
    console.log('  fixed status wording in:', f.question.slice(0, 60));
  }

  const last = await FaqEntry.findOne().sort({ sortOrder: -1 }).lean();
  let order = (last && last.sortOrder ? last.sortOrder : 0) + 1;
  let added = 0;
  for (const entry of ENTRIES) {
    const exists = await FaqEntry.exists({ question: entry.question });
    if (exists) {
      console.log('  skip (already there):', entry.question.slice(0, 60));
      continue;
    }
    await FaqEntry.create({ ...entry, isActive: true, sortOrder: order++ });
    added++;
    console.log('  added:', entry.question.slice(0, 60));
  }
  console.log(`Done. ${added} new FAQ entries added.`);
  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('Seeding failed:', err.message || err);
  try { await pool.end(); } catch (_e) { /* ignore */ }
  process.exit(1);
});