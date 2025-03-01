import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const router = Router();

// Define the root directory path (backend folder)
const ROOT_DIR = process.cwd();

/**
 * @swagger
 * /api/albumart/{id}:
 *   get:
 *     summary: Get album artwork for a track
 *     tags: [AlbumArt]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The YouTube video ID
 *       - in: query
 *         name: square
 *         required: false
 *         schema:
 *           type: string
 *         description: If set to 1, forces the image to be square (for media players)
 *     responses:
 *       200:
 *         description: The album artwork image
 *         content:
 *           image/jpeg:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: Album artwork not found
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { square } = req.query;
    const forceSquare = square === '1';
    const artworkPath = path.join(ROOT_DIR, 'cache', 'albumart', `${id}.jpg`);

    // Check if file exists
    try {
      await fsPromises.access(artworkPath);
    } catch (err) {
      // If artwork doesn't exist, redirect to YouTube thumbnail
      return res.redirect(`https://img.youtube.com/vi/${id}/maxresdefault.jpg`);
    }

    // Set only necessary headers, let CORS middleware handle CORS
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
    res.setHeader('Content-Type', 'image/jpeg');

    // If square parameter is set, process the image to ensure it's square
    if (forceSquare) {
      try {
        // Read the image file
        const imageBuffer = await fsPromises.readFile(artworkPath);
        
        // Process with sharp to make it square
        const image = sharp(imageBuffer);
        const metadata = await image.metadata();
        
        if (metadata.width && metadata.height) {
          // Determine the size for the square crop (use the smaller dimension)
          const size = Math.min(metadata.width, metadata.height);
          
          // Calculate crop position (center crop)
          const left = Math.floor((metadata.width - size) / 2);
          const top = Math.floor((metadata.height - size) / 2);
          
          // Crop to square and output
          const squareImage = await image
            .extract({ left, top, width: size, height: size })
            .jpeg({ quality: 90 })
            .toBuffer();
          
          return res.send(squareImage);
        }
      } catch (sharpError) {
        console.error('Error processing image to square:', sharpError);
        // Fall back to original image if processing fails
      }
    }

    // Stream the file (original image if not square or if processing failed)
    const fileStream = fs.createReadStream(artworkPath);
    fileStream.pipe(res);
  } catch (error) {
    console.error('Error serving album artwork:', error);
    res.status(500).json({ error: 'Failed to serve album artwork' });
  }
});

export { router as albumArtRouter }; 