// backend/scripts/create-user.js
'use strict';

// Load env vars before importing anything that needs them
require('dotenv').config();

const authService = require('../src/services/auth.service');
const { pool }    = require('../src/config/database');

async function main() {
  const args = process.argv.slice(2);

  // Parse --username and --password from CLI args
  const usernameIdx = args.indexOf('--username');
  const passwordIdx = args.indexOf('--password');
  const roleIdx     = args.indexOf('--role');

  if (usernameIdx === -1 || passwordIdx === -1) {
    console.error('Usage: node scripts/create-user.js --username <name> --password <pass> [--role operator]');
    process.exit(1);
  }

  const username = args[usernameIdx + 1];
  const password = args[passwordIdx + 1];
  const role     = roleIdx !== -1 ? args[roleIdx + 1] : 'operator';

  if (!username || !password) {
    console.error('Both --username and --password values are required.');
    process.exit(1);
  }

  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  try {
    console.log(`Creating user "${username}" with role "${role}"...`);
    const user = await authService.createUser({ username, password, role });
    console.log('');
    console.log('✓ User created successfully:');
    console.log(`  ID:         ${user.id}`);
    console.log(`  Username:   ${user.username}`);
    console.log(`  Role:       ${user.role}`);
    console.log(`  Created at: ${user.created_at}`);
    console.log('');
  } catch (err) {
    console.error('Failed to create user:', err.message);
    process.exit(1);
  } finally {
    // Close the DB pool so the script exits cleanly
    await pool.end();
  }
}

main();