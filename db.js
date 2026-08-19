// Tiny file-based "database" — good enough for a single dance school's booking
// volume, and needs no database server to set up. If the school outgrows this
// (hundreds of bookings a day), swap this module for a real database like
// Postgres — everything else in server.js talks to it through the functions
// below, so that swap wouldn't touch the rest of the code.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.ACADEMY_DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function readAll(name) {
  const p = filePath(name);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}

function writeAll(name, records) {
  fs.writeFileSync(filePath(name), JSON.stringify(records, null, 2));
}

function insert(name, record) {
  const records = readAll(name);
  records.push(record);
  writeAll(name, records);
  return record;
}

function find(name, predicate) {
  return readAll(name).filter(predicate);
}

function findOne(name, predicate) {
  return readAll(name).find(predicate) || null;
}

module.exports = { readAll, writeAll, insert, find, findOne };
