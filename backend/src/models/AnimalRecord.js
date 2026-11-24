const { AnimalRecord } = require('../db/models');
const ANIMAL_SPECIES = ['Dog', 'Cat', 'Other'];
const ANIMAL_SEX = ['Male', 'Female', 'Unknown'];
module.exports = { AnimalRecord, ANIMAL_SPECIES, ANIMAL_SEX };
