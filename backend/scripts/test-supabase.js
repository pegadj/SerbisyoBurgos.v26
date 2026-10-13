require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");

// Verify Supabase credentials by running a minimal query.
async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error("SUPABASE_URL and key are required. Run `npm run check:env`.");
  }

  const supabase = createClient(url, key);
  const { data, error } = await supabase.from("profiles").select("id").limit(1);

  if (error) {
    throw new Error(`Supabase query failed: ${error.message}`);
  }

  console.log("Supabase connection OK.");
  console.log(`Fetched rows: ${Array.isArray(data) ? data.length : 0}`);
}

// Report connection test failure and exit with a non-zero status code.
main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
