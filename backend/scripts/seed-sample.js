require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");

// Seed sample profile records for local development/testing.
async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || "SBadmin123";
  const staffPassword = process.env.SEED_STAFF_PASSWORD || "SBstaff123";
  const systemAdminPassword = process.env.SEED_SYSTEM_ADMIN_PASSWORD || "SBsysad123";

  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for seeding.");
  }

  const supabase = createClient(url, key);

  const residents = [
    {
      email: "admin@serbisyoburgos.com",
      full_name: "Barangay Admin",
      role: "admin"
    },
    {
      email: "staff@serbisyoburgos.com",
      full_name: "Barangay Staff",
      role: "staff"
    },
    {
      email: "systemadmin@serbisyoburgos.com",
      full_name: "System Administrator",
      role: "system-admin"
    }
  ];

  const credentials = [
    { email: "admin@serbisyoburgos.com", password: adminPassword },
    { email: "staff@serbisyoburgos.com", password: staffPassword },
    { email: "systemadmin@serbisyoburgos.com", password: systemAdminPassword }
  ];

  // Ensure auth users exist and keep seed passwords deterministic for testing.
  for (const account of credentials) {
    const createResult = await supabase.auth.admin.createUser({
      email: account.email,
      password: account.password,
      email_confirm: true
    });

    if (createResult.error) {
      const { data: listedUsers, error: listError } = await supabase.auth.admin.listUsers();
      if (listError) {
        throw new Error(`Seed failed while listing users: ${listError.message}`);
      }

      const existingUser = listedUsers?.users?.find((user) => user.email === account.email);
      if (!existingUser) {
        throw new Error(`Seed failed for ${account.email}: ${createResult.error.message}`);
      }

      const { error: updateError } = await supabase.auth.admin.updateUserById(existingUser.id, {
        password: account.password,
        email_confirm: true
      });
      if (updateError) {
        throw new Error(`Seed failed while updating ${account.email}: ${updateError.message}`);
      }
    }
  }

  const { error } = await supabase.from("profiles").upsert(residents, { onConflict: "email" });

  if (error) {
    throw new Error(`Seed failed: ${error.message}`);
  }

  console.log("Seed complete: sample auth users + profiles inserted/updated.");
  console.log(`Admin login: admin@serbisyoburgos.com / ${adminPassword}`);
  console.log(`Staff login: staff@serbisyoburgos.com / ${staffPassword}`);
  console.log(`System admin login: systemadmin@serbisyoburgos.com / ${systemAdminPassword}`);
}

// Report seed failure and exit with a non-zero status code.
main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
