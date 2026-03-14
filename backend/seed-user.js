const bcrypt = require('bcryptjs');
const { pool } = require('./src/config/database');

async function seed() {
  const hash = await bcrypt.hash('Admin@1234', 12);
  await pool.query(
    `INSERT INTO users (username, password_hash, role)
     VALUES ('admin', $1, 'operator')
     ON CONFLICT (username) DO UPDATE SET password_hash = $1`,
    [hash]
  );
  console.log('Done — username: admin, password: Admin@1234');
  process.exit(0);
}

seed();