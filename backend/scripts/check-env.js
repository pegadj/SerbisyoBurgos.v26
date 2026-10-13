require("dotenv").config();

const required = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const optional = ["PORT", "CLIENT_ORIGIN", "GROQ_API_KEY", "GROQ_MODEL"];

let hasMissing = false;

console.log("Environment check:");
for (const key of required) {
  if (!process.env[key]) {
    hasMissing = true;
    console.log(`- MISSING: ${key}`);
  } else {
    console.log(`- OK: ${key}`);
  }
}

for (const key of optional) {
  console.log(`- ${process.env[key] ? "OK" : "OPTIONAL (not set)"}: ${key}`);
}

if (hasMissing) {
  process.exitCode = 1;
  console.error("\nSome required environment variables are missing.");
} else {
  console.log("\nAll required environment variables are set.");
}
