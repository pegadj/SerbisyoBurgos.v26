const multer = require('multer');
const { Readable } = require('stream');
const { getGridFsBucket } = require('./mongoClient');

// Old Supabase setup had two buckets: RESIDENT_AVATAR_BUCKET (5MB cap) and
// RESIDENT_ID_BUCKET (10MB cap). GridFS uses one bucket ("uploads") with a
// metadata.category field distinguishing the two, so limits are enforced
// per-route below rather than per-bucket.
const CATEGORY = {
  AVATAR: 'resident-avatar',
  RESIDENT_ID: 'resident-id',
};

const LIMITS_BYTES = {
  [CATEGORY.AVATAR]: 5 * 1024 * 1024,
  [CATEGORY.RESIDENT_ID]: 10 * 1024 * 1024,
};

// multer keeps the file in memory; we stream it into GridFS ourselves.
// This avoids a second multer-gridfs-storage connection lifecycle and gives
// us direct control over metadata (uploadedBy, category) per file.
const memoryUpload = multer({ storage: multer.memoryStorage() });

function uploadMiddleware(category) {
  const limitBytes = LIMITS_BYTES[category];
  return (req, res, next) => {
    memoryUpload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (req.file && req.file.size > limitBytes) {
        return res
          .status(400)
          .json({ error: `File exceeds ${limitBytes / (1024 * 1024)}MB limit` });
      }
      next();
    });
  };
}

// Streams a buffered file (req.file from multer memoryStorage) into GridFS.
// Returns the new file's ObjectId as a string — store this on the
// profile/document instead of Supabase's public URL.
function storeFile(file, { category, uploadedBy }) {
  return new Promise((resolve, reject) => {
    const bucket = getGridFsBucket();
    const uploadStream = bucket.openUploadStream(file.originalname, {
      contentType: file.mimetype,
      metadata: { category, uploadedBy, uploadedAt: new Date() },
    });

    Readable.from(file.buffer)
      .pipe(uploadStream)
      .on('error', reject)
      .on('finish', () => resolve(uploadStream.id.toString()));
  });
}

// Streams a GridFS file back out — use in a GET route, e.g.
// GET /files/:id  ->  streamFile(req.params.id, res)
function streamFile(fileId, res) {
  const bucket = getGridFsBucket();
  const { ObjectId } = require('mongodb');
  const downloadStream = bucket.openDownloadStream(new ObjectId(fileId));

  downloadStream.on('file', (file) => {
    res.set('Content-Type', file.contentType || 'application/octet-stream');
  });
  downloadStream.on('error', () => res.status(404).json({ error: 'File not found' }));
  downloadStream.pipe(res);
}

// Deletes a previous file when replacing an avatar/ID upload — GridFS has
// no "upsert", so old-file cleanup that Supabase Storage did implicitly
// with upsert:true now needs an explicit delete call like this one.
async function deleteFile(fileId) {
  if (!fileId) return;
  const { ObjectId } = require('mongodb');
  const bucket = getGridFsBucket();
  try {
    await bucket.delete(new ObjectId(fileId));
  } catch (err) {
    // Already deleted or never existed — safe to ignore, matches the old
    // "best effort cleanup" behavior around Supabase Storage removals.
  }
}

module.exports = { CATEGORY, uploadMiddleware, storeFile, streamFile, deleteFile };