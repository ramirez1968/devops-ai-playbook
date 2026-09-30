import express from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../database/connection';
import { issueTokens, verifyToken, bearerToken } from '../jwt';

const router = express.Router();

const USER_COLUMNS = 'id, email, first_name, last_name, role, created_at, updated_at';

function toUser(row: any) {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.post('/register', async (req, res) => {
  try {
    const { email, password, firstName, lastName } = req.body;

    if (!email || !password || password.length < 8) {
      return res.status(400).json({ error: 'Email and a password of at least 8 characters are required' });
    }

    const existingUser = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role) VALUES ($1, $2, $3, $4, $5) RETURNING ${USER_COLUMNS}`,
      [email, hashedPassword, firstName, lastName, 'customer']
    );

    const user = result.rows[0];
    res.status(201).json({ user: toUser(user), ...issueTokens(user), message: 'Registration successful' });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await query(`SELECT password_hash, ${USER_COLUMNS} FROM users WHERE email = $1`, [email]);
    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    res.json({ user: toUser(user), ...issueTokens(user), message: 'Login successful' });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Exchange a refresh token for a new access token (called by the frontend on 401).
router.post('/refresh', async (req, res) => {
  const claims = verifyToken(req.body?.refreshToken, 'refresh');
  if (!claims) {
    return res.status(401).json({ error: 'Invalid refresh token' });
  }

  try {
    const result = await query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [claims.userId]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }
    const { token } = issueTokens(result.rows[0]);
    res.json({ token });
  } catch (error) {
    console.error('Refresh error:', error);
    res.status(500).json({ error: 'Refresh failed' });
  }
});

// Tokens are stateless; the client discards them.
router.post('/logout', (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

router.get('/me', async (req, res) => {
  const claims = verifyToken(bearerToken(req.headers.authorization), 'access');
  if (!claims) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  try {
    const result = await query('SELECT id, email, first_name, last_name, role FROM users WHERE id = $1', [claims.userId]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }
    const { createdAt, updatedAt, ...user } = toUser(result.rows[0]);
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get user' });
  }
});

export { router as authRoutes };
