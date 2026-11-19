const mongoose = require('mongoose');
const { Schema } = mongoose;

// Animal Vaccine Tracker: one document per animal, with its vaccination history embedded.
// Dates are stored as YYYY-MM-DD strings (same convention as appointments / service requests).
const ANIMAL_SPECIES = ['Dog', 'Cat', 'Other'];
const ANIMAL_SEX = ['Male', 'Female', 'Unknown'];

const vaccinationSchema = new Schema({
  vaccine: { type: String, required: true, trim: true, maxlength: 80 },
  dateGiven: { type: String, required: true },          // YYYY-MM-DD
  nextDueDate: { type: String, default: null },         // YYYY-MM-DD, null = one-time / no booster
  batchNo: { type: String, trim: true, maxlength: 60, default: '' },
  administeredBy: { type: String, trim: true, maxlength: 120, default: '' },
  remarks: { type: String, trim: true, maxlength: 300, default: '' },
  recordedByEmail: { type: String, default: '' },
}, { timestamps: { createdAt: 'createdAt', updatedAt: false } });

const animalRecordSchema = new Schema({
  animalCode: { type: String, required: true, unique: true },   // "ANM-####"
  // Owner: linked to a confirmed resident when possible, otherwise typed in.
  ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  ownerResidentId: { type: String, trim: true, maxlength: 40, default: '' },
  ownerName: { type: String, required: true, trim: true, maxlength: 120 },
  ownerContact: { type: String, trim: true, maxlength: 30, default: '' },
  ownerAddress: { type: String, trim: true, maxlength: 250, default: '' },

  name: { type: String, required: true, trim: true, maxlength: 80 },
  species: { type: String, required: true, enum: ANIMAL_SPECIES },
  speciesOther: { type: String, trim: true, maxlength: 60, default: '' },
  breed: { type: String, trim: true, maxlength: 80, default: '' },
  color: { type: String, trim: true, maxlength: 60, default: '' },
  sex: { type: String, enum: ANIMAL_SEX, default: 'Unknown' },
  birthDate: { type: String, default: null },           // YYYY-MM-DD (approximate is fine)

  vaccinations: { type: [vaccinationSchema], default: [] },
  archivedAt: { type: Date, default: null },
  createdByEmail: { type: String, default: '' },
}, { timestamps: true });

animalRecordSchema.index({ archivedAt: 1, createdAt: -1 });
animalRecordSchema.index({ ownerUserId: 1 });

module.exports = {
  AnimalRecord: mongoose.model('AnimalRecord', animalRecordSchema),
  ANIMAL_SPECIES,
  ANIMAL_SEX,
};