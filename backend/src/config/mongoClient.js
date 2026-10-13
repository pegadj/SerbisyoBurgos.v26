const mongoose = require('mongoose');
const { GridFSBucket } = require('mongodb');
const dns = require('dns');

// Some Windows + recent Node.js combinations fail to resolve the DNS SRV
// records that mongodb+srv:// connection strings depend on, even though
// the network connection itself is fine (shows up as
// "querySrv ECONNREFUSED"). Forcing a public resolver here sidesteps that
// — safe to leave in permanently, it only affects DNS lookups this process
// makes, not your system-wide DNS settings.
dns.setServers(['1.1.1.1', '8.8.8.8']);

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  // Mirrors the old supabaseClient.js behavior of failing loudly and early
  // rather than letting every route fail individually later.
  // eslint-disable-next-line no-console
  console.error('MONGODB_URI is not set. Add it to your .env file.');
}

let gridFsBucket = null;

async function connectMongo() {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  await mongoose.connect(MONGODB_URI, {
    // Keeps the app from hanging forever if Atlas is unreachable, instead
    // of failing fast with a clear error (mirrors the old fail-fast intent).
    serverSelectionTimeoutMS: 10000,
  });

  gridFsBucket = new GridFSBucket(mongoose.connection.db, {
    bucketName: 'uploads',
  });

  // eslint-disable-next-line no-console
  console.log('Connected to MongoDB');
  return mongoose.connection;
}

function getGridFsBucket() {
  if (!gridFsBucket) {
    throw new Error('GridFS bucket not initialized — call connectMongo() first.');
  }
  return gridFsBucket;
}

module.exports = { mongoose, connectMongo, getGridFsBucket };