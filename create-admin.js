// Creates an admin account directly in the database. Run this once, from
// the server (or your own machine pointed at the same data files), to get
// your first admin login — after that, admins can create further admin or
// instructor accounts from inside the app (Admin → Staff).
//
// Usage:
//   node create-admin.js "Jane Smith" jane@wearetheacademylondon.co.uk "a-strong-password"

require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./db');

async function main() {
  const [name, email, password] = process.argv.slice(2);
  if (!name || !email || !password) {
    console.error('Usage: node create-admin.js "Full Name" email@example.com "password"');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  if (db.findOne('users', (u) => u.email.toLowerCase() === email.toLowerCase())) {
    console.error('An account with that email already exists.');
    process.exit(1);
  }

  const user = {
    id: 'usr_' + Date.now() + Math.random().toString(36).slice(2, 8),
    role: 'admin',
    name,
    email,
    passwordHash: await bcrypt.hash(password, 10),
    createdAt: new Date().toISOString(),
  };
  db.insert('users', user);
  console.log(`Admin account created for ${name} <${email}>. You can now sign in on the site.`);
}

main();
