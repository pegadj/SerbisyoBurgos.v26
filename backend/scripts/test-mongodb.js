require('dotenv').config();

const { connectMongo, mongoose } = require('../src/config/mongoClient');

// Verify MongoDB credentials by running a minimal query.
async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required. Run `npm run check:env`.');
  }

  await connectMongo();
  const collections = await mongoose.connection.db.listCollections().toArray();

  console.log('MongoDB connection OK.');
  console.log(`Collections found: ${collections.length}`);

  await mongoose.disconnect();
}

// Report connection test failure and exit with a non-zero status code.
main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});