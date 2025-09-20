import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import sharp from 'sharp';
import crypto from 'crypto';

const router = Router();

// Define directories
const ROOT_DIR = process.cwd();
const CACHE_DIR = path.join(ROOT_DIR, 'cache', 'backgrounds');
const ORIGINAL_DIR = path.join(CACHE_DIR, 'original');
const BLURRED_DIR = path.join(CACHE_DIR, 'blurred');

// Ensure cache directories exist
await fsPromises.mkdir(CACHE_DIR, { recursive: true });
await fsPromises.mkdir(ORIGINAL_DIR, { recursive: true });
await fsPromises.mkdir(BLURRED_DIR, { recursive: true });

// Queue for background processing
const processingQueue = new Map<string, Promise<void>>();

/**
 * Generate a consistent filename for an image URL
 */
function generateFilename(url: string, blurAmount: number = 80): string {
  const hash = crypto.createHash('sha256').update(url).digest('hex').substring(0, 16);
  return `${hash}_blur${blurAmount}.jpg`;
}

/**
 * Process image with blur effect
 */
async function processImageWithBlur(
  inputPath: string,
  outputPath: string,
  blurAmount: number = 80,
  quality: number = 85
): Promise<void> {
  try {
    await sharp(inputPath)
      .blur(blurAmount)
      .jpeg({ quality, progressive: true })
      .toFile(outputPath);
  } catch (error) {
    console.error('Error processing image with blur:', error);
    throw error;
  }
}

/**
 * Download and cache original image
 */
async function downloadAndCacheImage(imageUrl: string): Promise<string> {
  const filename = crypto.createHash('sha256').update(imageUrl).digest('hex').substring(0, 16) + '.jpg';
  const filePath = path.join(ORIGINAL_DIR, filename);

  // Check if already cached
  try {
    await fsPromises.access(filePath);
    return filePath;
  } catch {
    // File doesn't exist, download it
  }

  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Save original image
    await fsPromises.writeFile(filePath, buffer);
    return filePath;
  } catch (error) {
    console.error('Error downloading image:', error);
    throw error;
  }
}

/**
 * Get or create blurred background image
 */
async function getOrCreateBlurredImage(imageUrl: string, blurAmount: number = 80): Promise<string> {
  const filename = generateFilename(imageUrl, blurAmount);
  const blurredPath = path.join(BLURRED_DIR, filename);

  // Check if blurred version already exists
  try {
    await fsPromises.access(blurredPath);
    return blurredPath;
  } catch {
    // Blurred version doesn't exist
  }

  // Check if already being processed
  if (processingQueue.has(filename)) {
    await processingQueue.get(filename);
    return blurredPath;
  }

  // Create processing promise
  const processPromise = (async () => {
    try {
      // Download original image
      const originalPath = await downloadAndCacheImage(imageUrl);

      // Process with blur
      await processImageWithBlur(originalPath, blurredPath, blurAmount);
    } catch (error) {
      console.error('Error in background processing:', error);
      throw error;
    } finally {
      processingQueue.delete(filename);
    }
  })();

  processingQueue.set(filename, processPromise);
  await processPromise;

  return blurredPath;
}

/**
 * @swagger
 * /api/background/blur:
 *   get:
 *     summary: Get blurred background image
 *     tags: [Background]
 *     parameters:
 *       - in: query
 *         name: url
 *         required: true
 *         schema:
 *           type: string
 *         description: The original image URL to blur
 *       - in: query
 *         name: blur
 *         required: false
 *         schema:
 *           type: integer
 *           default: 80
 *         description: Blur amount (1-100)
 *       - in: query
 *         name: quality
 *         required: false
 *         schema:
 *           type: integer
 *           default: 85
 *         description: JPEG quality (1-100)
 *     responses:
 *       200:
 *         description: The blurred background image
 *         content:
 *           image/jpeg:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: Missing URL parameter
 *       500:
 *         description: Processing error
 */
router.get('/blur', async (req, res) => {
  try {
    const { url, blur = '80', quality = '85', w, q } = req.query;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        error: 'URL parameter is required',
        received: req.query,
        message: 'Please provide a valid URL parameter'
      });
    }

    const blurAmount = Math.max(1, Math.min(100, parseInt(blur as string, 10) || 80));
    let jpegQuality = Math.max(1, Math.min(100, parseInt(quality as string, 10) || 85));

    // Handle Next.js Image optimization parameters
    if (q && typeof q === 'string') {
      jpegQuality = Math.max(1, Math.min(100, parseInt(q, 10) || jpegQuality));
    }

    try {
      // Decode the URL (might be double-encoded by Next.js Image)
      let decodedUrl = url;
      try {
        decodedUrl = decodeURIComponent(url);
        // If it looks like it's still encoded, decode again
        if (decodedUrl.includes('%')) {
          decodedUrl = decodeURIComponent(decodedUrl);
        }
      } catch (e) {
        // Use original URL if decoding fails
      }

      // Get or create blurred image
      const blurredPath = await getOrCreateBlurredImage(decodedUrl, blurAmount);

      // Set cache headers
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('X-Blur-Amount', blurAmount.toString());
      res.setHeader('X-Cache-Hit', 'true');

      // Stream the file
      const fileStream = fs.createReadStream(blurredPath);
      fileStream.pipe(res);
    } catch (processingError) {
      console.error('Background processing failed:', processingError);

      // Fallback: redirect to original image
      res.setHeader('X-Cache-Hit', 'false');
      res.setHeader('X-Processing-Error', 'true');
      return res.redirect(url);
    }
  } catch (error) {
    console.error('Error in background blur endpoint:', error);
    res.status(500).json({ error: 'Failed to process background image' });
  }
});

/**
 * @swagger
 * /api/background/blur/async:
 *   post:
 *     summary: Queue background image for processing (async)
 *     tags: [Background]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               url:
 *                 type: string
 *                 description: The original image URL to blur
 *               blur:
 *                 type: integer
 *                 default: 80
 *                 description: Blur amount (1-100)
 *               quality:
 *                 type: integer
 *                 default: 85
 *                 description: JPEG quality (1-100)
 *     responses:
 *       202:
 *         description: Processing queued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: processing
 *                 filename:
 *                   type: string
 *                   description: The filename that will be created
 *       400:
 *         description: Missing URL parameter
 */
router.post('/blur/async', async (req, res) => {
  try {
    const { url, blur = 80, quality = 85 } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL parameter is required' });
    }

    const filename = generateFilename(url, blur);
    const blurredPath = path.join(BLURRED_DIR, filename);

    // Start processing in background without waiting
    getOrCreateBlurredImage(url, blur).catch(error => {
      console.error('Async background processing failed:', error);
    });

    res.status(202).json({
      status: 'processing',
      filename,
      url: `/api/background/blur?url=${encodeURIComponent(url)}&blur=${blur}`
    });
  } catch (error) {
    console.error('Error queuing background processing:', error);
    res.status(500).json({ error: 'Failed to queue background processing' });
  }
});

export { router as backgroundRouter };