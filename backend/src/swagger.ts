import swaggerJsdoc from 'swagger-jsdoc';

// Get API base URL from environment
const API_BASE_URL = process.env.API_URL || 'http://localhost:3000';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'MIU API',
      version: '1.0.0',
      description: 'API documentation for MIU - A Discord Music Bot',
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT',
      },
    },
    servers: [
      {
        url: API_BASE_URL,
        description: 'Development server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        User: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            username: { type: 'string' },
            discriminator: { type: 'string' },
            avatar: { type: 'string' },
            roles: { type: 'array', items: { type: 'string' } },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        Role: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            permissions: { type: 'array', items: { type: 'string' } },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        Track: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            artist: { type: 'string' },
            duration: { type: 'number' },
            url: { type: 'string' },
            thumbnail: { type: 'string' },
          },
        },
        Settings: {
          type: 'object',
          properties: {
            maxQueuePerUser: { type: 'number' },
            requestCooldown: { type: 'number' },
            maxHistorySize: { type: 'number' },
            defaultVolume: { type: 'number' },
            botStatus: { type: 'string' },
            botActivityType: { type: 'string' },
          },
        },
        Error: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
          },
        },
      },
    },
  },
  apis: ['./src/backend/routes/*.ts'], // Path to the API routes
};

export const swaggerSpec = swaggerJsdoc(options);

// Example route documentation (to be added to respective route files):
/**
 * @swagger
 * /api/auth/login:
 *   get:
 *     summary: Initiate Discord OAuth2 login
 *     tags: [Auth]
 *     responses:
 *       302:
 *         description: Redirects to Discord OAuth2 authorization page
 * 
 * /api/auth/callback/discord:
 *   get:
 *     summary: Discord OAuth2 callback
 *     tags: [Auth]
 *     parameters:
 *       - in: query
 *         name: code
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       302:
 *         description: Redirects to frontend with auth token
 *       400:
 *         description: Invalid request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 * 
 * /api/music/search:
 *   get:
 *     summary: Search for tracks
 *     tags: [Music]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Search results
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Track'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 * 
 * /api/admin/settings:
 *   get:
 *     summary: Get bot settings
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Bot settings
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Settings'
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *   put:
 *     summary: Update bot settings
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Settings'
 *     responses:
 *       200:
 *         description: Settings updated
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */ 