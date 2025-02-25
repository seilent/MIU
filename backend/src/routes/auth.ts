import { Router } from 'express';
import { prisma } from '../db.js';
import fetch from 'node-fetch';
import jwt from 'jsonwebtoken';
import { URL } from 'url';
import { Role } from '@prisma/client';
import getEnv from '../utils/env.js';

const router = Router();
const env = getEnv();

// Validate required environment variables
if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET || !process.env.JWT_SECRET) {
  throw new Error('Missing required environment variables for auth routes');
}

const DISCORD_API_URL = 'https://discord.com/api/v10';
const CLIENT_ID = env.getString('DISCORD_CLIENT_ID');
const CLIENT_SECRET = env.getString('DISCORD_CLIENT_SECRET');
const FRONTEND_URL = env.getString('FRONTEND_URL', 'http://localhost:3300');
const REDIRECT_URI = process.env.NEXT_PUBLIC_DISCORD_REDIRECT_URI || `${FRONTEND_URL}/auth/callback`;

// Validate that the redirect URI is a valid URL
try {
  new URL(REDIRECT_URI);
} catch (e) {
  console.error('Invalid redirect URI:', REDIRECT_URI);
  throw new Error('Invalid redirect URI configuration');
}

const JWT_SECRET = env.getString('JWT_SECRET');

if (process.env.NODE_ENV === 'development') {
  console.log(`Auth Configuration: CLIENT_ID=**present**, FRONTEND_URL=${FRONTEND_URL}, REDIRECT_URI=${REDIRECT_URI}, NODE_ENV=${process.env.NODE_ENV}`);
}

function getCookieDomain(req: any): string | undefined {
  if (process.env.NODE_ENV === 'development') {
    return 'localhost';
  }

  const host = req.get('host') || new URL(FRONTEND_URL).host;
  // If it's an IP address, return undefined (browser will handle it)
  if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(host)) {
    return undefined;
  }
  // If it's localhost, return as is
  if (host.includes('localhost')) {
    return 'localhost';
  }
  // For actual domains, include the subdomain
  return host;
}

/**
 * @swagger
 * /api/auth/login:
 *   get:
 *     summary: Initiates Discord OAuth2 login flow
 *     tags: [Auth]
 *     responses:
 *       302:
 *         description: Redirects to Discord OAuth2 authorization page
 */
router.get('/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
  });

  res.redirect(`${DISCORD_API_URL}/oauth2/authorize?${params}`);
});

/**
 * @swagger
 * /api/auth/callback:
 *   get:
 *     summary: Handles Discord OAuth2 code exchange
 *     tags: [Auth]
 *     parameters:
 *       - in: query
 *         name: code
 *         required: true
 *         schema:
 *           type: string
 */
router.get('/callback', async (req, res) => {
  const code = req.query.code as string;

  if (!code) {
    return res.status(400).json({ error: 'Authorization code is required' });
  }

  try {
    // Log minimal request info
    console.log('Auth callback: Request received');

    // Exchange code for access token
    const tokenRequestBody = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    });

    console.log('Auth callback: Exchanging code with Discord');

    const tokenResponse = await fetch(`${DISCORD_API_URL}/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: tokenRequestBody,
    });

    const tokenData = await tokenResponse.text();
    
    let parsedTokenData;
    try {
      parsedTokenData = JSON.parse(tokenData);
      // Only log error information if there is an error
      if (parsedTokenData.error) {
        console.log(`Auth callback: Error in response: error=${parsedTokenData.error}, error_description=${parsedTokenData.error_description}`);
      }
    } catch (e) {
      console.error('Failed to parse token response:', e);
      return res.status(400).json({ error: 'Invalid response from Discord' });
    }

    if (!tokenResponse.ok) {
      // Check if it's an invalid_grant error (used code)
      if (parsedTokenData.error === 'invalid_grant') {
        // Log it at a lower level since it's expected in some cases
        console.log('Token already used:', parsedTokenData.error_description);
        return res.status(400).json({ error: 'Authentication session expired' });
      }
      
      // Log other errors as actual errors
      console.error('Token exchange failed:', tokenData);
      return res.status(400).json({ error: 'Failed to authenticate with Discord' });
    }

    // Get user info from Discord
    const userResponse = await fetch(`${DISCORD_API_URL}/users/@me`, {
      headers: { Authorization: `Bearer ${parsedTokenData.access_token}` },
    });

    if (!userResponse.ok) {
      console.error('Failed to get user info:', await userResponse.text());
      return res.status(400).json({ error: 'Failed to get user info from Discord' });
    }

    const userData = await userResponse.json();

    // Get or create user in database
    let user = await prisma.user.findUnique({
      where: { id: userData.id },
      include: { roles: true },
    });

    if (!user) {
      // Create user with default role
      user = await prisma.user.create({
        data: {
          id: userData.id,
          username: userData.username,
          discriminator: userData.discriminator || '0',
          avatar: userData.avatar,
          roles: {
            connectOrCreate: {
              where: { name: 'user' },
              create: {
                name: 'user',
                permissions: ['play', 'queue', 'history']
              }
            }
          }
        },
        include: { roles: true },
      });
    } else {
      // Just update user info
      user = await prisma.user.update({
        where: { id: userData.id },
        data: {
          username: userData.username,
          discriminator: userData.discriminator || '0',
          avatar: userData.avatar,
        },
        include: { roles: true },
      });
    }

    // Create JWT token
    const token = jwt.sign(
      {
        id: user.id,
        roles: user.roles.map(role => role.name),
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    try {
      // Set both httpOnly and client-accessible cookies
      const cookieDomain = process.env.NODE_ENV === 'production' ? '.gacha.boo' : getCookieDomain(req);
      const cookieOptions: {
        maxAge: number;
        secure: boolean;
        sameSite: 'none' | 'lax' | 'strict';
        domain: string | undefined;
        path: string;
      } = {
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        secure: true,
        sameSite: 'none',
        domain: cookieDomain,
        path: '/'
      };

      // HttpOnly cookie for security
      res.cookie('token', token, {
        ...cookieOptions,
        httpOnly: true
      });

      // Client-accessible cookie for JS
      res.cookie('auth_token', token, {
        ...cookieOptions,
        httpOnly: false
      });

      return res.json({
        token,
        user: {
          id: user.id,
          username: user.username,
          avatar: user.avatar,
          roles: user.roles.map(role => role.name),
        },
      });
    } catch (cookieError) {
      console.error('Failed to set cookies:', cookieError);
      return res.status(500).json({ error: 'Failed to complete authentication' });
    }
  } catch (error) {
    console.error('Auth callback error:', error);
    return res.status(500).json({ error: 'Authentication failed' });
  }
});

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: Logs out the user
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: Successfully logged out
 */
router.post('/logout', (req, res) => {
  const cookieDomain = getCookieDomain(req);
  const cookieOptions = {
    path: '/',
    domain: cookieDomain,
    secure: true,
    sameSite: 'none' as const
  };

  res.clearCookie('token', cookieOptions);
  res.clearCookie('auth_token', cookieOptions);
  
  res.json({ success: true });
});

/**
 * @swagger
 * /api/auth/session:
 *   get:
 *     summary: Gets current session info
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: Current session info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   $ref: '#/components/schemas/User'
 */
router.get('/session', async (req, res) => {
  const token = req.cookies.token;

  if (!token) {
    return res.json({ user: null });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: string };
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      include: { roles: true },
    });

    if (!user) {
      const cookieOptions = {
        path: '/',
        domain: getCookieDomain(req),
        secure: true,
        sameSite: 'none' as const
      };
      
      res.clearCookie('token', cookieOptions);
      res.clearCookie('auth_token', cookieOptions);
      return res.json({ user: null });
    }

    res.json({
      user: {
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        roles: user.roles.map(role => role.name),
      },
    });
  } catch (error) {
    const cookieOptions = {
      path: '/',
      domain: getCookieDomain(req),
      secure: true,
      sameSite: 'none' as const
    };
    
    res.clearCookie('token', cookieOptions);
    res.clearCookie('auth_token', cookieOptions);
    res.json({ user: null });
  }
});

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     summary: Gets current user info
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current user info
 */
router.get('/me', async (req, res) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: string };
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      include: { roles: true },
    });

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    res.json({
      user: {
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        roles: user.roles.map(role => role.name),
      },
    });
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

export { router as authRouter };
