const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'erp.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// Menambah kolom yang muncul belakangan ke database yang sudah terbentuk.
// CREATE TABLE IF NOT EXISTS tidak mengubah tabel lama, jadi perlu ALTER manual.
function tambahKolom(tabel, kolom, definisi) {
  const ada = db.prepare(`PRAGMA table_info(${tabel})`).all().some((k) => k.name === kolom);
  if (!ada) {
    db.exec(`ALTER TABLE ${tabel} ADD COLUMN ${kolom} ${definisi}`);
    console.log(`· migrasi: ${tabel}.${kolom} ditambahkan`);
  }
}
tambahKolom('pesanan', 'kanal', "TEXT NOT NULL DEFAULT 'pesanan'");
tambahKolom('pesanan', 'ref_luar', 'TEXT');

module.exports = db;
