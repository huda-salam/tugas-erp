// Pembungkus CLI untuk data contoh. Logikanya ada di src/contoh.js supaya bisa
// dipakai juga oleh wizard penyiapan di layar.
//
//   npm run seed        master data saja
//   npm run seed:demo   master data + satu hari transaksi contoh
//   npm run reset       hapus semua lalu isi ulang dari nol
const S = require('./services');
const C = require('./contoh');

const demo = process.argv.includes('--demo');
const reset = process.argv.includes('--reset');

if (reset) {
  C.kosongkan();
  console.log('· data lama dihapus');
}

if (C.adaMaster()) {
  console.log('Master data sudah ada. Pakai --reset untuk mengulang dari nol.');
  process.exit(0);
}

const A = require('./auth');

const rujukan = C.isiMasterContoh();
console.log('✓ Master data terisi: 3 produk, 7 bahan, resep, 3 supplier, 3 pelanggan');

// Jalur CLI dipakai untuk demo/pengembangan, jadi sekalian siapkan akun bawaan
// supaya aplikasi langsung bisa dibuka tanpa mengulang wizard tiap kali reset.
// Instalasi sungguhan (folder data/ kosong, tanpa seed) tetap lewat wizard.
if (!A.sudahDisiapkan()) {
  A.buatPengguna({ nama: 'Pemilik', username: 'pemilik', sandi: 'pemilik123', peran: 'pemilik' });
  S.setPengaturan('setup_selesai', '1');
  console.log('✓ Akun bawaan dibuat — username: pemilik  ·  sandi: pemilik123');
  console.log('  Ganti sandinya lewat menu Akun setelah masuk.');
}

if (demo) {
  C.isiTransaksiContoh(rujukan);

  const t = S.hariIni();
  const k = S.laporanKeuangan(t, t);
  const angka = (n) => Math.round(n).toLocaleString('id-ID');
  console.log('✓ Transaksi contoh dibuat untuk', t);
  console.log('  Laba bersih :', angka(k.labaRugi.labaBersih));
  console.log('  Total aset  :', angka(k.neraca.totalAset));
  console.log('  Piutang Grab:', angka(k.neraca.piutang), '(belum dicairkan)');
  console.log('  Prive       :', angka(k.neraca.prive));
  console.log('  Waste       :', angka(-k.labaRugi.penyesuaian.waste), '(kerugian)');
  console.log('  Neraca      :', k.neraca.seimbang ? 'SEIMBANG ✓' : 'TIDAK SEIMBANG ✗');
}
