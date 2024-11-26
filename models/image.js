const mongoose = require('mongoose');

const imageSchema = new mongoose.Schema({
  productName: { type: String, required: true },
  Jewellery: { type: [String], required: true }, // Store image URLs in an array
});

const Image = mongoose.model('Image', imageSchema);

module.exports = Image;
