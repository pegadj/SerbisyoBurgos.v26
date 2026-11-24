const multer = require('multer');
const { pool } = require('./pgClient');
const { normalizeId } = require('../db/engine');

// Files live in the Postgres `files` table (bytea) — see db/migrations/001_schema.sql.
// The `category` column distinguishes avatars from ID photos; size limits are enforced
// per-route below. If upload volume ever outgrows the database, swap the three functions
// at the bottom for S3/R2 calls — nothing else in the app touches file storage.
const CATEGORY = {
  AVATAR: 'resident-avatar',
  RESIDENT_ID: 'resident-id',
};

const LIMITS_BYTES = {
  [CATEGORY.AVATAR]: 5 * 1024 * 1024,
  [CATEGORY.RESIDENT_ID]: 10 * 1024 * 1024,
};

// multer keeps the file in memory; we write the buffer to Postgres ourselves.
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

// Stores a buffered file (req.file from multer memoryStorage). Returns the new file's id (uuid string)
// — store this on the profile/document.
async function storeFile(file, { category, uploadedBy }) {
  const { rows } = await pool.query(
    `INSERT INTO files (filename, content_type, category, uploaded_by, size_bytes, data)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text AS id`,
    [
      String(file.originalname || 'file').replace(/\u0000/g, ''),
      file.mimetype || null,
      category || null,
      uploadedBy == null ? null : String(uploadedBy),
      file.buffer.length,
      file.buffer,
    ],
  );
  return rows[0].id;
}

// Sends a stored file back out — use in a GET route, e.g. GET /files/:id -> streamFile(req.params.id, res).
// Accepts legacy 24-hex GridFS ids too (they map to the migrated uuids).
async function streamFile(fileId, res) {
  const id = normalizeId(fileId);
  if (!id) return res.status(404).json({ error: 'File not found' });
  try {
    const { rows } = await pool.query('SELECT content_type, size_bytes, data FROM files WHERE id = $1::uuid', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'File not found' });
    res.set('Content-Type', rows[0].content_type || 'application/octet-stream');
    res.set('Content-Length', String(rows[0].data.length));
    return res.end(rows[0].data);
  } catch (err) {
    return res.status(404).json({ error: 'File not found' });
  }
}

// Deletes a previous file when replacing an avatar/ID upload (best effort, like before).
async function deleteFile(fileId) {
  const id = normalizeId(fileId);
  if (!id) return;
  try {
    await pool.query('DELETE FROM files WHERE id = $1::uuid', [id]);
  } catch (err) {
    // Already deleted or never existed — safe to ignore.
  }
}

module.exports = { CATEGORY, uploadMiddleware, storeFile, streamFile, deleteFile };