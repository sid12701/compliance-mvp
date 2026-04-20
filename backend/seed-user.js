const bcrypt = require('bcryptjs');
const { pool } = require('./src/config/database');

async function upsertUser({ username, password, role }) {
  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (username) DO UPDATE
     SET password_hash = EXCLUDED.password_hash,
         role = EXCLUDED.role,
         is_active = TRUE`,
    [username, hash, role]
  );
}

async function seed() {
  const users = [
    { username: 'admin', password: 'Admin@1234', role: 'dev' },
    { username: 'admin-secondary', password: 'AdminSecondary@1234', role: 'dev' },
  ];

  for (const user of users) {
    await upsertUser(user);
  }

  console.log('Seeded default admin users:');
  console.log('1. username: admin, password: Admin@1234, role: dev');
  console.log('2. username: admin-secondary, password: AdminSecondary@1234, role: dev');

  await pool.end();
  process.exit(0);
}

seed().catch(async (err) => {
  console.error('Failed to seed users:', err.message);
  await pool.end();
  process.exit(1);
});
