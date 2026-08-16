// Akun, sandi, dan sesi.
//
// Sengaja tanpa dependensi baru: sandi memakai scrypt bawaan Node (bukan bcrypt yang
// modul native dan menyulitkan pemasangan di Termux/Android), sesi memakai tabel
// SQLite + cookie sendiri (bukan express-session yang butuh store tambahan).
const crypto = require('crypto');
const db = require('./db');
const S = require('./services');

const NAMA_COOKIE = 'procil_sesi';
const UMUR_SESI_HARI = 30;

// ---------- sandi ----------
function hashSandi(sandi) {
  const garam = crypto.randomBytes(16).toString('hex');
  const kunci = crypto.scryptSync(sandi, garam, 64).toString('hex');
  return `${garam}:${kunci}`;
}

function cocokSandi(sandi, tersimpan) {
  if (!tersimpan || !tersimpan.includes(':')) return false;
  const [garam, kunci] = tersimpan.split(':');
  let uji;
  try { uji = crypto.scryptSync(sandi, garam, 64); } catch { return false; }
  const asli = Buffer.from(kunci, 'hex');
  // panjang harus sama sebelum timingSafeEqual, kalau tidak akan melempar
  if (asli.length !== uji.length) return false;
  return crypto.timingSafeEqual(asli, uji);
}

// ---------- pengguna ----------
const bersihkanUsername = (u) => (u || '').trim().toLowerCase();

function buatPengguna({ nama, username, sandi, peran }) {
  const u = bersihkanUsername(username);
  if (!nama || !nama.trim()) throw new Error('Nama wajib diisi.');
  if (!/^[a-z0-9._-]{3,}$/.test(u)) {
    throw new Error('Username minimal 3 karakter, hanya huruf, angka, titik, garis bawah, atau strip.');
  }
  if (!sandi || sandi.length < 6) throw new Error('Kata sandi minimal 6 karakter.');
  if (db.prepare('SELECT 1 FROM pengguna WHERE username = ?').get(u)) {
    throw new Error(`Username "${u}" sudah dipakai.`);
  }
  const info = db.prepare(
    'INSERT INTO pengguna (nama, username, kata_sandi, peran) VALUES (?,?,?,?)'
  ).run(nama.trim(), u, hashSandi(sandi), peran === 'pemilik' ? 'pemilik' : 'kasir');
  return { id: info.lastInsertRowid, username: u };
}

function gantiSandi(penggunaId, sandiBaru) {
  if (!sandiBaru || sandiBaru.length < 6) throw new Error('Kata sandi minimal 6 karakter.');
  db.prepare('UPDATE pengguna SET kata_sandi = ? WHERE id = ?').run(hashSandi(sandiBaru), penggunaId);
}

const daftarPengguna = () =>
  db.prepare('SELECT id, nama, username, peran, aktif, dibuat_pada FROM pengguna ORDER BY peran, nama').all();

// ---------- sesi ----------
function buatSesi(penggunaId) {
  const token = crypto.randomBytes(32).toString('hex');
  const kedaluwarsa = new Date(Date.now() + UMUR_SESI_HARI * 864e5).toISOString();
  db.prepare('INSERT INTO sesi (id, pengguna_id, kedaluwarsa) VALUES (?,?,?)')
    .run(token, penggunaId, kedaluwarsa);
  return token;
}

function bacaSesi(token) {
  if (!token) return null;
  // sapu sesi yang sudah lewat sekalian, supaya tabel tidak menumpuk
  db.prepare('DELETE FROM sesi WHERE kedaluwarsa < ?').run(new Date().toISOString());
  return db.prepare(`
    SELECT p.id, p.nama, p.username, p.peran
      FROM sesi s JOIN pengguna p ON p.id = s.pengguna_id
     WHERE s.id = ? AND p.aktif = 1`).get(token) || null;
}

const hapusSesi = (token) => { if (token) db.prepare('DELETE FROM sesi WHERE id = ?').run(token); };
const hapusSesiPengguna = (id) => db.prepare('DELETE FROM sesi WHERE pengguna_id = ?').run(id);

// ---------- cookie ----------
function bacaCookie(req, nama) {
  const mentah = req.headers.cookie;
  if (!mentah) return null;
  for (const bagian of mentah.split(';')) {
    const i = bagian.indexOf('=');
    if (i < 0) continue;
    if (bagian.slice(0, i).trim() === nama) return decodeURIComponent(bagian.slice(i + 1).trim());
  }
  return null;
}

function pasangCookie(res, token) {
  const aman = process.env.HTTPS === '1' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${NAMA_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${UMUR_SESI_HARI * 86400}${aman}`);
}

function hapusCookie(res) {
  res.setHeader('Set-Cookie', `${NAMA_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ---------- status penyiapan ----------
function sudahDisiapkan() {
  if (S.pengaturan('setup_selesai', '0') !== '1') return false;
  return !!db.prepare("SELECT 1 FROM pengguna WHERE peran = 'pemilik' AND aktif = 1").get();
}

// Apakah database sudah berisi data usaha? Dipakai wizard supaya tidak menimpa
// instalasi yang sudah berjalan.
function adaDataLama() {
  const n = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  return n('produk') > 0 || n('penjualan') > 0 || n('pembelian') > 0;
}

// ---------- penahan percobaan login ----------
// Cukup di memori: skala aplikasi ini satu proses, dan tujuannya menahan tebakan
// beruntun, bukan menggantikan rate limiter sungguhan.
const gagal = new Map();

function jedaLogin(username) {
  const g = gagal.get(username);
  if (!g || g.n < 5) return 0;
  const sisa = g.sampai - Date.now();
  return sisa > 0 ? Math.ceil(sisa / 1000) : 0;
}

function catatGagal(username) {
  const g = gagal.get(username) || { n: 0, sampai: 0 };
  g.n += 1;
  if (g.n >= 5) g.sampai = Date.now() + Math.min(60, 2 ** (g.n - 5) * 5) * 1000;
  gagal.set(username, g);
}

const resetGagal = (username) => gagal.delete(username);

function masuk(username, sandi) {
  const u = bersihkanUsername(username);
  const sisa = jedaLogin(u);
  if (sisa > 0) throw new Error(`Terlalu banyak percobaan. Coba lagi dalam ${sisa} detik.`);

  const p = db.prepare('SELECT * FROM pengguna WHERE username = ? AND aktif = 1').get(u);
  if (!p || !cocokSandi(sandi || '', p.kata_sandi)) {
    catatGagal(u);
    throw new Error('Username atau kata sandi salah.');
  }
  resetGagal(u);
  return { pengguna: p, token: buatSesi(p.id) };
}

module.exports = {
  NAMA_COOKIE, hashSandi, cocokSandi,
  buatPengguna, gantiSandi, daftarPengguna,
  buatSesi, bacaSesi, hapusSesi, hapusSesiPengguna,
  bacaCookie, pasangCookie, hapusCookie,
  sudahDisiapkan, adaDataLama, masuk,
};
