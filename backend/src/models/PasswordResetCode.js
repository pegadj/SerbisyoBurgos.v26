const mongoose = require('mongoose');
const { Schema } = mongoose;

// One-time SMS codes for the resident "Forgot password" flow.
// Only a keyed hash of the code is stored (never the code itself). MongoDB deletes expired rows automatically
// (TTL index on expiresAt), so this collection stays small.
const passwordResetCodeSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  codeHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  // wrong guesses so far; the code is thrown away after too many
  attempts: { type: Number, default: 0 },
  requestIp: { type: String, default: null },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: false },
});

passwordResetCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = { PasswordResetCode: mongoose.model('PasswordResetCode', passwordResetCodeSchema) };