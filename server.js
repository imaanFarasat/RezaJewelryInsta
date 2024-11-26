const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const multer = require('multer');
const aws = require('aws-sdk');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const Image = require('./models/image'); // Import the Image model

// Load environment variables from .env
dotenv.config();

// AWS S3 configuration
const s3 = new aws.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID, // Your AWS Access Key
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, // Your AWS Secret Key
  region: process.env.AWS_REGION, // Your AWS Region
});

// Multer configuration for handling file uploads in memory
const storage = multer.memoryStorage(); // Store files in memory before uploading to S3
const upload = multer({ storage: storage });

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies and serve static files
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files (index.html, css, etc.)

// MongoDB connection setup
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connected successfully'))
  .catch((err) => console.error('MongoDB connection error:', err));

// Function to add watermark to an image
async function addWatermarkAndSave(imageBuffer, watermarkText) {
  try {
    const image = sharp(imageBuffer);
    const metadata = await image.metadata();

    const svgFilePath = path.join(__dirname, 'no.svg'); // Path to watermark SVG
    const svgBuffer = fs.readFileSync(svgFilePath);

    let svgString = svgBuffer.toString();
    svgString = svgString.replace('{{PRODUCT_NAME}}', watermarkText);

    const positionBottom = metadata.height - (2 * 96);
    const positionLeft = metadata.width / 2;

    const updatedSvgString = svgString.replace(
      '</svg>',
      `<text x="${positionLeft}" y="${positionBottom}" font-family="NotoSerifDisplay" font-weight="bold" font-size="120" fill="white" text-anchor="middle">
        ${watermarkText}
      </text>
      </svg>`
    );

    const finalSvgBuffer = Buffer.from(updatedSvgString);

    const resizedSvgBuffer = await sharp(finalSvgBuffer)
      .resize(metadata.width, metadata.height)
      .toBuffer();

    const watermarkedImageBuffer = await image
      .composite([{ input: resizedSvgBuffer, top: 0, left: 0 }])
      .jpeg({ quality: 90 })
      .toBuffer();

    return watermarkedImageBuffer;
  } catch (error) {
    console.error('Error processing image:', error.message);
    throw error;
  }
}

// Serve the index.html page for file upload form at /reza path
app.get('/reza', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API route to upload images to S3 and save URLs in MongoDB
app.post('/api/images/upload', upload.array('images', 10), async (req, res) => {
  try {
    const { productName } = req.body; // Extract product name from request body

    // Validate input
    if (!productName || !req.files || req.files.length === 0) {
      console.error('Validation error: Missing product name or files.');
      return res.status(400).json({ error: 'Product name and at least one image are required.' });
    }

    // Upload each file to S3 after adding watermark
    const uploadPromises = req.files.map(async (file) => {
      // Add watermark to the image
      const watermarkedBuffer = await addWatermarkAndSave(file.buffer, productName);

      // Prepare S3 upload parameters
      const params = {
        Bucket: process.env.AWS_S3_BUCKET_NAME, // Your S3 bucket name
        Key: `products/${Date.now()}-${file.originalname}`, // Folder and unique file name
        Body: watermarkedBuffer, // File data with watermark
        ContentType: file.mimetype, // File type
      };

      // Upload to S3
      return s3.upload(params).promise().catch((err) => {
        console.error(`Error uploading file '${file.originalname}' to S3:`, err);
        throw new Error(`S3 upload failed for '${file.originalname}'.`);
      });
    });

    let s3Results;
    try {
      s3Results = await Promise.all(uploadPromises); // Wait for all uploads to complete
    } catch (uploadError) {
      console.error('Error during S3 upload process:', uploadError);
      return res.status(500).json({ error: 'S3 upload failed. Check server logs for details.' });
    }

    const imageUrls = s3Results.map((result) => result.Location); // Extract the file URLs from S3 responses
    console.log('S3 upload successful. Image URLs:', imageUrls);

    // Find the document by product name or create a new one
    let updatedProduct;
    try {
      updatedProduct = await Image.findOneAndUpdate(
        { productName }, // Search by product name
        { $push: { Jewellery: { $each: imageUrls } } }, // Add URLs to the Jewellery field (array)
        { new: true, upsert: true } // Create a new document if not found
      );
    } catch (dbError) {
      console.error('Error updating MongoDB:', dbError);
      return res.status(500).json({ error: 'Failed to save image URLs to the database.' });
    }

    console.log('MongoDB update successful. Updated product:', updatedProduct);

    res.status(201).json({
      message: 'Images uploaded and saved successfully!',
      product: updatedProduct, // Return the updated product data to the client
    });
  } catch (err) {
    console.error('Unexpected error in /api/images/upload:', err);
    res.status(500).json({ error: 'Failed to upload and save images. Check server logs for details.' });
  }
});

// API route to fetch all images for a product
app.get('/api/images/:productName', async (req, res) => {
  try {
    const { productName } = req.params; // Get product name from the URL
    const images = await Image.findOne({ productName: productName }); // Fetch images from the DB
    if (!images) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.status(200).json(images); // Send images as a JSON response
  } catch (err) {
    console.error('Error fetching images:', err);
    res.status(500).json({ error: 'Failed to fetch images' });
  }
});

// Start the server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://imanfarasat.com:${PORT}`);
});