/**
 * One-shot check that the API is reachable (run while server is up).
 * Usage: node scripts/smoke-health.js
 * Optional: SMOKE_URL=http://127.0.0.1:4000/health
 */
const http = require("http");

const url = process.env.SMOKE_URL || "http://127.0.0.1:4000/health";

http
  .get(url, (res) => {
    let body = "";
    res.on("data", (chunk) => {
      body += chunk;
    });
    res.on("end", () => {
      console.log(`HTTP ${res.statusCode} ${body}`);
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
  })
  .on("error", (err) => {
    console.error("Smoke failed:", err.message);
    console.error("Is the backend running? Try: npm start");
    process.exit(1);
  });
