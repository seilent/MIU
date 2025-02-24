import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import { fileURLToPath } from 'url';

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

    // Stream the file
    const fileStream = fs.createReadStream(artworkPath);
    fileStream.pipe(res);
  } catch (error) {
    console.error('Error serving album artwork:', error);
    res.status(500).json({ error: 'Failed to serve album artwork' });
  }
});

export { router as albumArtRouter }; 