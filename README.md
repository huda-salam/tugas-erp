# ERP Mini — Bubur Bayi Procil

Aplikasi ERP sederhana untuk UMKM: pembelian bahan, inventory, produksi, pemesanan,
penjualan (retail / pesanan / GrabFood), dan laporan keuangan.

Stack: **Node.js + Express + EJS + SQLite**. Tanpa build step, tanpa server database.

---

## Menjalankan (3 langkah)

```bash
npm install
npm run seed:demo     # isi master data + 1 hari transaksi contoh
npm start             # buka http://localhost:3000
```

Selesai. Tidak ada MySQL/XAMPP yang perlu dipasang, tidak ada `.env` yang perlu diisi,
tidak ada perintah migrate. Tabel dibuat otomatis saat aplikasi pertama kali jalan.

> **Pakai Node 20 atau lebih baru.** Cek dengan `node -v`.

## Daftar perintah

| Perintah | Fungsi |
|---|---|
| `npm start` | Jalankan aplikasi di port 3000 |
| `npm run dev` | Jalankan dengan auto-restart saat file diubah |
| `npm run seed` | Isi master data saja (produk, bahan, resep, supplier, pelanggan) |
| `npm run seed:demo` | Master data + transaksi contoh satu hari |
| `npm run reset` | Hapus semua data lalu isi ulang dari nol |
| `npm run rebuild` | Perbaiki `better-sqlite3` kalau error saat install |

Ganti port: `PORT=4000 npm start`

---

## Kalau macet saat install

Satu-satunya paket yang bisa rewel adalah `better-sqlite3`, karena dia native module
(ada bagian C++ yang harus cocok dengan versi Node kamu). Biasanya npm mengunduh
binary jadi dan langsung mulus. Kalau tidak:

```bash
npm run rebuild
```

Masih gagal? Hapus dan pasang ulang:

```bash
rm -rf node_modules package-lock.json
npm install
```

Pengguna Windows yang tetap gagal perlu build tools:
`npm install --global windows-build-tools` (jalankan PowerShell sebagai Administrator).

---

## Aturan kerja kelompok

**Jangan pernah commit folder `data/`.** Sudah masuk `.gitignore`, jangan dikeluarkan.

Database SQLite itu satu file biner. Git tidak bisa menggabungkan dua versi file biner,
jadi kalau dua orang sama-sama input transaksi lalu push, hasilnya bukan gabungan —
yang satu menimpa yang lain dan datanya hilang tanpa peringatan.

Tiap anggota pegang database lokal masing-masing. Kalau butuh data yang seragam
untuk latihan atau presentasi, semua orang jalankan `npm run reset` — bukan saling
kirim file `.sqlite`.

Kalau mengubah struktur tabel, edit `src/schema.sql`, lalu beri tahu tim untuk
menjalankan `npm run reset`. Perubahan skema tidak otomatis berlaku di database
yang sudah terbentuk (skema pakai `CREATE TABLE IF NOT EXISTS`).

---

## Struktur folder

```
src/
  server.js      Semua route (Express)
  services.js    Logika bisnis: stok, HPP, kas, laporan  ← inti aplikasi
  schema.sql     Struktur tabel
  db.js          Koneksi SQLite, jalan otomatis saat boot
  seed.js        Data awal & contoh transaksi
views/           Halaman EJS
  partials/      Header & navigasi bersama
public/css/      Satu file CSS untuk semua halaman
desain/          Desain UX asli (referensi, tidak dipakai runtime)
data/            Database lokal — TIDAK di-commit
```

**Kalau mau menambah fitur:** hampir selalu cukup sentuh tiga file —
`services.js` (logikanya), `server.js` (route-nya), dan satu file di `views/`.

---

## Catatan penting soal cara hitung

Beberapa keputusan yang membedakan aplikasi ini dari desain awal, supaya laporannya
konsisten:

- **Stok tidak disimpan sebagai kolom.** Semua pergerakan masuk ke tabel `mutasi_stok`,
  dan stok dihitung sebagai jumlahnya. Jadi stok di layar kasir tidak mungkin berbeda
  dengan kartu stok di menu Inventory.
- **Pembelian bukan HPP.** Belanja bahan menambah persediaan. Beban pokok baru diakui
  saat bahan benar-benar dipakai produksi.
- **HPP pakai rata-rata bergerak.** Harga bahan dirata-rata tiap ada pembelian baru;
  HPP produk = total nilai bahan satu batch dibagi jumlah porsi yang jadi.
- **Penjualan Grab jadi piutang, bukan kas.** Bruto dikurangi komisi platform (default 20%,
  bisa diubah di menu Master). Nilai bersihnya menumpuk sebagai *Piutang GrabFood* dan baru
  masuk kas saat dicairkan lewat menu Kas — sama seperti saldo GrabMerchant sesungguhnya.
  Piutang ini tampil sebagai aset lancar di neraca.
- **Buku kas adalah turunan transaksi,** bukan form input terpisah — supaya tidak bisa
  berbeda dengan laporan penjualan dan pembelian.
- **Prive bukan beban.** Pengambilan pribadi pemilik mengurangi kas dan ekuitas, tapi
  tidak mengurangi laba. Menyamakannya dengan biaya membuat laba usaha terlihat lebih
  kecil dari yang sebenarnya.
- **Waste dan stock opname tidak menyentuh kas.** Produk tidak laku yang dibuang dan
  selisih hasil hitung fisik mengurangi (atau menambah) nilai persediaan, dan langsung
  diakui sebagai kerugian/keuntungan di laba rugi. Uangnya memang sudah keluar saat
  belanja bahan, jadi tidak boleh dicatat sebagai kas keluar lagi.
- **Modal dan prive diturunkan dari mutasi kas,** tidak disimpan sebagai angka terpisah.

Neraca menampilkan status **SEIMBANG / TIDAK SEIMBANG**. Kalau sampai tidak seimbang,
berarti ada logika yang bocor — itu sinyal bug, bukan hal yang wajar.
